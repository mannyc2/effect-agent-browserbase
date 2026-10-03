import { Result, Schema } from "effect";
import type {
  BrowserContext,
  Download,
  ElementHandle,
  FileChooser,
  Frame,
  Page,
} from "playwright-core";

import { type InputReceipt, SafeFilename } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type {
  Driver,
  DriverTarget,
  ElementTarget,
  InputCapture,
  NativeFileSelection,
  NavigationControl,
} from "./Driver.ts";
import { makeElementAccess } from "./ElementAccess.ts";
import { makeKeyboard } from "./Keyboard.ts";
import {
  closeWithin,
  failure,
  type NativeFailure,
  safeDecode,
  sanitize,
  timeout,
} from "./NativeCalls.ts";
import { isPerformed, ownerPacing, type PerformedTicket } from "./NativePacing.ts";
import { holdsChecked, type Observation, readFieldState } from "./Observation.ts";
import type { Ticket, WaitTicket } from "./Owner.ts";
import { scroll as scrollSchedule, type KeySchedule } from "./Performance.ts";
import { makePointer } from "./Pointer.ts";
import { makeSettledResource } from "./Settled.ts";
import type { Entry, Targets } from "./Targets.ts";

/**
 * Input types whose whole value is assigned, as Playwright's fill does, rather than typed key by
 * key. A fill checks each on a detached probe; performed typing cannot produce any of them.
 */
const AssignedInputTypes: ReadonlyArray<string> = [
  "color",
  "date",
  "time",
  "datetime-local",
  "month",
  "range",
  "week",
];

/** Refuses, undispatched, performed typing into a control whose value can only be assigned. */
const refusePerformedTyping = (inputType: string | undefined) => {
  if (inputType !== undefined && AssignedInputTypes.includes(inputType))
    throw failure(Reasons.Unsupported.make({}), "undispatched");
};

/**
 * What Playwright's own input would refuse only after dispatch, checked before it: a node it
 * would wait for until the deadline, or text it would not put into this control. Either way the
 * wait or the thrown error would be an unknown outcome that fences the owner. It mirrors
 * Playwright's visible, enabled and editable checks and its fill rules for the control and text.
 * Runs in the page, so it is self-contained and receives the assigned input types from the host.
 */
const inputRefusal = (
  node: Element,
  { text, assigned }: { readonly text?: string; readonly assigned: ReadonlyArray<string> },
): "not-visible" | "disabled" | "unsupported" | null => {
  const style = getComputedStyle(node);

  if (style.display !== "contents") {
    const rect = node.getBoundingClientRect();

    if (
      ("checkVisibility" in node && !node.checkVisibility()) ||
      style.visibility !== "visible" ||
      !(rect.width > 0 && rect.height > 0)
    )
      return "not-visible";
  }
  if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") return "disabled";
  if (text === undefined) return null;
  if (node instanceof HTMLInputElement) {
    const type = node.type.toLowerCase();
    const typed = ["", "email", "number", "password", "search", "tel", "text", "url"];

    if (node.readOnly || (!typed.includes(type) && !assigned.includes(type))) return "unsupported";
    if (type === "number" && Number.isNaN(Number(text.trim()))) return "unsupported";
    if (assigned.includes(type)) {
      // A fresh detached control with the same constraints shows whether this one would keep
      // the value; nothing is written to the page's own node or announced to the page.
      const probe = document.createElement("input");
      const value = type === "color" ? text.trim().toLowerCase() : text.trim();

      probe.type = type;
      for (const name of ["min", "max", "step"]) {
        const constraint = node.getAttribute(name);

        if (constraint !== null) probe.setAttribute(name, constraint);
      }
      probe.value = value;
      if (probe.value !== value) return "unsupported";
    }

    return null;
  }
  if (node instanceof HTMLTextAreaElement) return node.readOnly ? "unsupported" : null;

  return node instanceof HTMLElement && node.isContentEditable ? null : "unsupported";
};

/**
 * Lets the page's own handlers run after a form step: two animation frames when the page renders
 * them, then `millis`. A hidden page renders no frames, so the host bounds the wait as well; the
 * wait is never a failure of a step that already dispatched. Runs in the page.
 */
const settleInPage = (_node: Element, millis: number) =>
  new Promise<void>((resolve) => {
    let rendered = false;
    let elapsed = false;

    const finish = () => {
      if (rendered && elapsed) resolve();
    };

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        rendered = true;
        finish();
      }),
    );
    setTimeout(() => {
      elapsed = true;
      finish();
    }, millis);
  });

/**
 * The round trips a performed click is charged before dispatch. Over relays adding 18 to 70 ms
 * each way, Playwright 1.63's positioned click took 17 to 23 round trips in all, 14 to 19 of them
 * checking the node before its first input event. A deadline inside those checks closes the Page
 * over input never sent, while a refusal leaves it open, so the charge covers the most checking
 * measured, at the cost of refusing a click that had a few round trips to spare.
 */
const performedClickRoundTrips = 20;

/**
 * What a performed click is charged besides its round trips. Playwright's stability check waits
 * for the node across animation frames, which no round trip measures: without a relay, a whole
 * click took 57 ms.
 */
const performedClickFloorMillis = 100;

/** A step that already dispatched reads back within a bounded wait, and never fails for it. */
const bounded = async <A>(work: Promise<A>, millis: number, fallback: A): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  void work.catch(() => {});

  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<A>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(0, millis));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const waitEvent = <A>(
  add: (listener: (value: A) => void) => void,
  remove: (listener: (value: A) => void) => void,
  ticket: Ticket,
  accepts: (value: A) => boolean = () => true,
) => {
  let done = false;
  let resolve: (value: A) => void = () => {};
  let reject: (error: NativeFailure) => void = () => {};

  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  // Attach a rejection observer immediately, even while the action is still running.
  void promise.catch(() => {});

  const cleanup = () => {
    remove(listener);
    ticket.signal.removeEventListener("abort", abort);
    clearTimeout(timer);
  };

  const abort = () => {
    if (!done) {
      done = true;
      cleanup();
      reject(failure(Reasons.Interrupted.make({})));
    }
  };

  const listener = (value: A) => {
    if (!done && accepts(value)) {
      done = true;
      cleanup();
      resolve(value);
    }
  };

  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      cleanup();
      reject(failure(Reasons.Timeout.make({})));
    }
  }, ticket.remainingMillis());

  add(listener);
  ticket.signal.addEventListener("abort", abort, { once: true });
  if (ticket.signal.aborted) abort();

  return { promise, cancel: abort };
};

interface NavigationStopPort {
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Native stop setup may yield while the navigation completes. Recheck its owner immediately
 * before dispatch, while the caller still holds the browser-owner permit.
 */
export const dispatchNavigationStop = async (
  ticket: Ticket,
  pending: () => boolean,
  onDispatch: () => void,
  open: () => Promise<NavigationStopPort>,
  retainSetup: () => () => void,
): Promise<"dispatched" | "settled"> => {
  ticket.check();
  const retired = retainSetup();
  let port: NavigationStopPort | undefined;

  try {
    port = await open();
    ticket.check();
    if (!pending()) return "settled";
    // No await may separate this admission check from dispatch.
    ticket.check();
    ticket.dispatch();
    onDispatch();
    await port.stop();
    ticket.check();

    return "dispatched";
  } finally {
    // The owner's Effect bounds the caller's wait. A timeout or rejection of native detach
    // does not prove retirement and must not allow another setup to consume this slot.
    if (port !== undefined) await port.close();
    retired();
  }
};

/**
 * In-memory bytes and provider-stored paths reach the page by different mechanisms and are
 * never mixed: the first is streamed from this client, the second is opened by the browser
 * process itself. A mixed request is a configuration error, not a native surprise later.
 */
export const nativeSelection = (
  files: ReadonlyArray<NativeFileSelection>,
):
  | {
      readonly _tag: "Inline";
      readonly payload: Array<{ name: string; mimeType: string; buffer: Buffer }>;
    }
  | { readonly _tag: "Remote"; readonly paths: Array<string> } => {
  if (files.length === 0) throw failure(Reasons.Configuration.make({}), "undispatched");
  const inline = files.filter((file) => file._tag === "Inline");
  const remote = files.filter((file) => file._tag === "Remote");

  // The maintained native API encodes a Node Buffer; this lazily loaded driver already
  // requires the Node-only Playwright peer, so the conversion belongs here and nowhere else.
  if (inline.length === files.length) {
    return {
      _tag: "Inline",
      payload: inline.map((file) => ({
        name: file.name,
        mimeType: file.mediaType,
        buffer: Buffer.from(file.bytes),
      })),
    };
  }
  if (remote.length === files.length)
    return { _tag: "Remote", paths: remote.map((file) => file.path) };
  throw failure(Reasons.Configuration.make({}), "undispatched");
};

/**
 * Input to one exact document. Each native mutation marks dispatch before it starts and records
 * its acknowledgement before follow-up reads, which may fail after the mutation was performed.
 */
export const makeActions = (
  context: BrowserContext,
  targets: Targets,
  observation: Observation,
  isTimeoutError: (error: unknown) => boolean,
) => {
  const { current } = targets;
  // Built in dependency order: exact-node admission, then the pointer and keyboard drivers that
  // use it, then the actions that use all three.
  const elements = makeElementAccess(observation);
  const { targetFor, withAdmittedElement, withElement } = elements;
  const pointer = makePointer(targets, elements);
  const keyboard = makeKeyboard(targets, elements, pointer.receipt);

  const navigationControls = new Map<
    string,
    {
      readonly control: NavigationControl | undefined;
      readonly mainFrame: boolean;
    }
  >();

  let downloadSerial = 0;

  /** A result URL is only ever an http(s) address without credentials. */
  const httpUrl = (value: string) => {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw failure(Reasons.Malformed.make({}));
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw failure(Reasons.Malformed.make({}));

    return value;
  };

  const reportable = (value: string): string | undefined => {
    try {
      const url = new URL(value);

      return value.length <= 8192 &&
        ["http:", "https:"].includes(url.protocol) &&
        url.hostname !== "" &&
        !url.username &&
        !url.password
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };

  const ownHttpAddress = (value: string): boolean => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  };

  /**
   * The frame's own http(s) address or, for a document without one (srcdoc, about:blank, data:),
   * its nearest ancestor's. An http(s) address that cannot be reported (longer than 8,192
   * characters, or carrying credentials) is never replaced by an ancestor's, which belongs to a
   * different document: it yields nothing.
   */
  const addressOf = (frame: Frame): string | undefined => {
    for (let at: Frame | null = frame; at !== null; at = at.parentFrame()) {
      const value = at.url();

      if (ownHttpAddress(value)) return reportable(value);
    }

    return undefined;
  };

  /**
   * The address an action reports, read from the host's frame tree and never from the page. A
   * document without an http(s) URL of its own (`about:srcdoc`, `about:blank`, `data:`) reports
   * its nearest ancestor frame's, which is also its base URL. It is resolved before dispatch, so
   * an action never fails over its URL after its input landed: a target with no reportable
   * address, including one whose own http(s) address is too long or carries credentials, is
   * refused unsent, and afterwards the address read before dispatch stands in when the action
   * left none, including when the action removed its own frame or closed its page.
   */
  const resultUrl = (target: DriverTarget) => {
    const { frame } = current(target);
    const before = addressOf(frame);

    if (before === undefined) throw failure(Reasons.Unsupported.make({}), "undispatched");

    return () => (frame.isDetached() ? before : (addressOf(frame) ?? before));
  };

  /** Refuses, undispatched, what `inputRefusal` finds on this exact node right now. */
  const refuseInput = async (element: ElementHandle<Element>, text?: string) => {
    const refusal: unknown = await element.evaluate(inputRefusal, {
      ...(text === undefined ? {} : { text }),
      assigned: AssignedInputTypes,
    });

    if (refusal === "not-visible") throw failure(Reasons.NotVisible.make({}), "undispatched");
    if (refusal === "disabled") throw failure(Reasons.Disabled.make({}), "undispatched");
    if (refusal === "unsupported") throw failure(Reasons.Unsupported.make({}), "undispatched");
    if (refusal !== null) throw failure(Reasons.Malformed.make({}), "undispatched");
  };

  /** What is left of a step's deadline for reading back, keeping a margin for the owner. */
  const readBack = (ticket: Ticket, wanted: number) =>
    Math.min(wanted, Math.max(0, ticket.remainingMillis() - 250));

  const nativeClick = async (
    element: ElementHandle<Element>,
    options: Parameters<ElementHandle<Element>["click"]>[0],
  ): Promise<void> => {
    try {
      await element.click(options);
    } catch (error) {
      // The native timer can win the shared deadline before the owner's Effect timer.
      // Its exact error class keeps the same reason; the owner still decides dispatch outcome.
      if (isTimeoutError(error)) throw failure(Reasons.Timeout.make({}));
      throw error;
    }
  };

  const clickElement = (
    page: Page,
    element: ElementHandle<Element>,
    ticket: Ticket,
    capture?: InputCapture,
    check: () => void = () => ticket.check(),
    readmit?: () => Promise<void>,
  ): Promise<InputReceipt | undefined> => {
    if (isPerformed(ticket)) {
      return pointer.preparePress(page, element, ticket, check).then(async (prepared) => {
        // The round trip is measured here to charge the click; it is not part of the receipt.
        const { roundTripNanos, ...planned } = prepared;

        await readmit?.();
        check();

        const dispatch = async () => {
          check();
          // Dispatch is marked before Playwright's click, whose own node checks then precede its
          // first input event. A deadline inside them would report an unknown outcome for input
          // never sent, so the click must fit the deadline at this page's measured round trip.
          ownerPacing(ticket).requireDuration(
            performedClickFloorMillis + (performedClickRoundTrips * Number(roundTripNanos)) / 1e6,
          );
          ticket.dispatch();
          // The click moves the pointer where it aimed; the next glide starts there.
          pointer.invalidate(page, planned.intended.position);
          await nativeClick(element, {
            timeout: timeout(ticket),
            scroll: "none",
            position: planned.intended.relativePosition,
          });
          ticket.acknowledge?.();
          ticket.followUp?.();
        };

        return capture === undefined
          ? dispatch().then(() => undefined)
          : capture(dispatch, planned);
      });
    }

    const dispatch = async () => {
      pointer.invalidate(page);
      await nativeClick(element, { timeout: timeout(ticket) });
      ticket.acknowledge?.();
      ticket.followUp?.();
    };

    return capture === undefined
      ? dispatch().then(() => undefined)
      : capture(dispatch, { position: null });
  };

  const click: Driver["click"] = (target, ticket, capture, policy, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);
      const { page } = current(browserTarget).entry;

      const input = await withAdmittedElement(
        target,
        ticket,
        (element) => (ticket.performance === undefined ? Promise.resolve() : refuseInput(element)),
        (element, _admitted, check, readmit) =>
          clickElement(page, element, ticket, capture, check, readmit),
        policy,
        browserTarget,
        false,
        ticket.performance === undefined,
      );

      ticket.check();

      if (input === undefined) throw failure(Reasons.Malformed.make({}));

      return { url: url(), input };
    });

  const clickWithoutReceipt = async (
    target: ElementTarget,
    ticket: Ticket,
    browserTarget: DriverTarget,
  ): Promise<string> => {
    browserTarget = targetFor(target, browserTarget);
    const url = resultUrl(browserTarget);
    const { page } = current(browserTarget).entry;

    await withElement(
      target,
      ticket,
      (element, _admitted, check, readmit) =>
        clickElement(page, element, ticket, undefined, check, readmit),
      undefined,
      browserTarget,
      ticket.performance === undefined,
    );
    ticket.check();

    return url();
  };

  /**
   * A file the provider already stores is named to the browser process, which opens it; this
   * client never reads that path. Exactly one main-frame node may match, and exactly one
   * command dispatches. A retained node or child frame is refused rather than approximated.
   */
  const attachStoredFiles = async (
    target: ElementTarget,
    paths: ReadonlyArray<string>,
    ticket: Ticket,
    browserTarget: DriverTarget,
  ) => {
    if (typeof target !== "string") throw failure(Reasons.Unsupported.make({}), "undispatched");
    const { entry, frame } = current(browserTarget);

    if (frame !== entry.page.mainFrame())
      throw failure(Reasons.Unsupported.make({}), "undispatched");
    const cdp = await context.newCDPSession(entry.page);

    try {
      ticket.check();

      const root = safeDecode(
        Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Int }) }),
        await cdp.send("DOM.getDocument", { depth: 0 }),
      );

      const matched = safeDecode(
        Schema.Struct({ nodeIds: Schema.Array(Schema.Int).check(Schema.isMaxLength(64)) }),
        await cdp.send("DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: target }),
      );

      ticket.check();
      const nodeId = matched.nodeIds[0];

      if (matched.nodeIds.length !== 1 || nodeId === undefined)
        throw failure(
          matched.nodeIds.length === 0 ? Reasons.NotFound.make({}) : Reasons.Ambiguous.make({}),
          "undispatched",
        );
      ticket.dispatch();
      await cdp.send("DOM.setFileInputFiles", { files: [...paths], nodeId });
      ticket.acknowledge?.();
      ticket.followUp?.();
    } finally {
      await closeWithin(() => cdp.detach()).catch(() => {});
    }
  };

  const beginNavigation: Driver["beginNavigation"] = (
    url,
    timeoutMillis,
    ticket,
    target,
    control,
  ) =>
    sanitize(async () => {
      const { entry, frame } = current(target);
      const active = { control, mainFrame: frame === entry.page.mainFrame() };

      ticket.dispatch();
      navigationControls.set(entry.id, active);
      targets.navigating.begin(entry.id);

      // Not awaited here: the permit that dispatched it is released while the browser loads.
      const settled = sanitize(async () => {
        try {
          await frame.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMillis });
        } catch (error) {
          // Preserve the installed engine's exact timeout identity before generic sanitization.
          if (isTimeoutError(error)) throw failure(Reasons.Timeout.make({}), "unknown");
          throw error;
        } finally {
          // A stop may have admitted a successor before this old goto finally rejects.
          if (navigationControls.get(entry.id) === active) {
            navigationControls.delete(entry.id);
            targets.navigating.end(entry.id);
          }
        }

        // The frame that navigated, not whatever is selected by the time it finishes.
        return httpUrl(targets.urlOf(frame));
      });

      // Whoever awaits it sees the failure; a caller that never does raises nothing unhandled.
      void settled.catch(() => {});

      return {
        pageId: entry.id,
        mainFrame: active.mainFrame,
        settled,
        stop: (stopTicket, pending, onDispatch, retainSetup) =>
          sanitize(async () => {
            return dispatchNavigationStop(
              stopTicket,
              pending,
              onDispatch,
              async () => {
                const cdp = await context.newCDPSession(entry.page);

                return {
                  stop: async () => {
                    await cdp.send("Page.stopLoading");
                  },
                  close: () => cdp.detach(),
                };
              },
              retainSetup,
            );
          }),
      };
    });

  const fill: Driver["fill"] = (target, value, ticket, policy, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);

      await withAdmittedElement(
        target,
        ticket,
        async (element, facts) => {
          await refuseInput(element, value);
          if (!isPerformed(ticket)) return undefined;
          refusePerformedTyping(facts?.inputType);

          return { ticket, schedule: keyboard.prepareKeys(value, ticket) };
        },
        (element, performed, check, readmit) =>
          performed === undefined
            ? element.fill(value, { timeout: timeout(ticket) })
            : keyboard.fillElement(
                current(browserTarget).entry.page,
                element,
                performed.schedule,
                performed.ticket,
                check,
                readmit,
              ),
        policy,
        browserTarget,
        false,
        ticket.performance === undefined,
      );
      ticket.check();

      return url();
    });

  /**
   * One form step on an exact observed node, which may have become enabled since it was
   * observed. Text is filled and the control is then left, as a person moving on would, so what
   * the page does on blur belongs to this step. A toggle is clicked only when it is not already
   * in the requested state, and a native radio is never asked to clear itself. Options are the
   * issued nodes of the same observation, exactly as `selectOption` sends them.
   */
  const formStep: Driver["formStep"] = (
    target,
    field,
    ticket,
    policy,
    settleMillis,
    capture,
    browserTarget,
  ) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);

      const {
        element,
        reference: leasedReference,
        check,
        readmit,
        facts,
        capture: sampled,
        release,
      } = await observation.resolve(
        target,
        ticket,
        policy,
        false,
        browserTarget,
        true,
        ticket.performance !== undefined,
      );

      try {
        check();
        if (facts === undefined) throw failure(Reasons.Malformed.make({}), "undispatched");
        let act: (() => Promise<unknown>) | undefined;
        let input: InputReceipt | undefined;

        if (field.options !== undefined) {
          const admitted = await observation.selectOptions(
            target,
            field.options,
            element,
            ticket,
            true,
            browserTarget,
          );

          act = async () => {
            const values = await element.selectOption(admitted.handles, {
              timeout: timeout(ticket),
            });

            ticket.acknowledge?.();
            ticket.followUp?.();
            const expected = [...admitted.values].sort();

            if (
              values.length !== expected.length ||
              values.sort().some((value, i) => value !== expected[i])
            )
              throw failure(Reasons.Stale.make({}));
          };
        } else if (field.checked !== undefined) {
          if (facts.checked === undefined)
            throw failure(Reasons.Unsupported.make({}), "undispatched");
          if (facts.checked !== field.checked) {
            if (!field.checked && facts.inputType === "radio")
              throw failure(Reasons.Unsupported.make({}), "undispatched");
            await refuseInput(element);
            act = async () => {
              input = await clickElement(
                current(browserTarget).entry.page,
                element,
                ticket,
                capture,
                check,
                readmit,
              );
            };
          }
        } else {
          const text = field.value ?? "";

          await refuseInput(element, text);

          let performed:
            | { readonly ticket: PerformedTicket; readonly schedule: KeySchedule }
            | undefined;

          if (isPerformed(ticket)) {
            refusePerformedTyping(facts.inputType);
            performed = { ticket, schedule: keyboard.prepareKeys(text, ticket) };
          }
          act = async () => {
            if (performed === undefined) await element.fill(text, { timeout: timeout(ticket) });
            else
              await keyboard.fillElement(
                current(browserTarget).entry.page,
                element,
                performed.schedule,
                performed.ticket,
                check,
                readmit,
              );
            ticket.acknowledge?.({ subphase: "key-burst", logicalComplete: false });
            check();
            ticket.dispatch();
            await element.evaluate((node) => {
              if (node instanceof HTMLElement && node.ownerDocument.activeElement === node)
                node.blur();
            });
            ticket.acknowledge?.();
            ticket.followUp?.();
          };
        }
        check();
        ticket.check();
        ticket.captureTarget?.(target, sampled);
        if (act !== undefined) {
          // ElementHandle actions do not re-resolve onto a replacement node.
          if (ticket.performance === undefined || field.options !== undefined) ticket.dispatch();
          await act();
          if (settleMillis > 0)
            await bounded(
              observation.passiveRead(
                leasedReference ?? target,
                ticket,
                () => element.evaluate(settleInPage, settleMillis),
                browserTarget,
              ),
              readBack(ticket, settleMillis + 250),
              undefined,
            );
        }

        const state = await bounded(
          observation.passiveRead(
            leasedReference ?? target,
            ticket,
            () => readFieldState(element),
            browserTarget,
          ),
          readBack(ticket, 1000),
          undefined,
        );

        ticket.check();

        return {
          status: act === undefined ? "unchanged" : "set",
          reached:
            field.checked === undefined ||
            state === undefined ||
            holdsChecked(state, field.checked),
          state,
          url: url(),
          ...(input === undefined ? {} : { input }),
        };
      } finally {
        await closeWithin(release).catch(() => {});
      }
    });

  /** The one submit click, on an exact observed node that may have become enabled. */
  const formSubmit: Driver["formSubmit"] = (target, ticket, capture, policy, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);
      const { page } = current(browserTarget).entry;

      const input = await withAdmittedElement(
        target,
        ticket,
        (element) => refuseInput(element),
        (element, _admitted, check, readmit) =>
          clickElement(page, element, ticket, capture, check, readmit),
        policy,
        browserTarget,
        true,
        ticket.performance === undefined,
      );

      ticket.check();

      if (input === undefined) throw failure(Reasons.Malformed.make({}));

      return { url: url(), input };
    });

  const selectOption: Driver["selectOption"] = (target, options, ticket, policy, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);

      await withAdmittedElement(
        target,
        ticket,
        (element) =>
          observation.selectOptions(target, options, element, ticket, false, browserTarget),
        async (element, admitted) => {
          // Only issued native nodes reach this command. Its returned values stay private.
          const values = await element.selectOption(admitted.handles, { timeout: timeout(ticket) });

          ticket.acknowledge?.();
          ticket.followUp?.();
          const expected = [...admitted.values].sort();

          if (
            values.length !== expected.length ||
            values.sort().some((value, i) => value !== expected[i])
          )
            throw failure(Reasons.Stale.make({}));
        },
        policy,
        browserTarget,
      );
      ticket.check();

      return url();
    });

  const scroll: Driver["scroll"] = (deltaX, deltaY, ticket, target) =>
    sanitize(async () => {
      const { frame } = current(target);
      const url = resultUrl(target);

      if (isPerformed(ticket)) {
        const pacing = ownerPacing(ticket);
        const planned = scrollSchedule(ticket.performance.plan, deltaX, deltaY);

        if (Result.isFailure(planned)) throw planned.failure;
        pacing.requireDuration(planned.success.durationMillis);
        const epoch = targets.epochOf(frame);
        const started = pacing.now();

        for (const sample of planned.success.samples) {
          await pacing.pauseUntil(started + BigInt(Math.round(sample.offsetMillis * 1e6)));
          ticket.check();
          if (current(target).frame !== frame || targets.epochOf(frame) !== epoch)
            throw failure(Reasons.Stale.make({}), "undispatched");
          const requested = pacing.now();

          ticket.dispatch();
          await frame.evaluate(
            ({ x, y }) => window.scrollBy({ left: x, top: y, behavior: "instant" }),
            { x: sample.deltaX, y: sample.deltaY },
          );
          ticket.acknowledge?.({ subphase: "scroll-burst", logicalComplete: false });
          ticket.recordScroll?.({
            target,
            x: sample.deltaX,
            y: sample.deltaY,
            startedMonotonicNanos: requested,
            completedMonotonicNanos: pacing.now(),
          });
        }
        ticket.acknowledge?.();
        ticket.followUp?.();
        ticket.check();

        return url();
      }
      ticket.dispatch();
      await frame.evaluate(
        ({ x, y }) => window.scrollBy({ left: x, top: y, behavior: "instant" }),
        { x: deltaX, y: deltaY },
      );
      ticket.acknowledge?.();
      ticket.followUp?.();
      ticket.check();

      return url();
    });

  const scrollTo: Driver["scrollTo"] = (target, ticket, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);

      await withElement(
        target,
        ticket,
        (element) =>
          element.evaluate((node) =>
            node.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }),
          ),
        undefined,
        browserTarget,
      );
      ticket.check();

      return url();
    });

  let waitConnectionRetired = false;

  const pendingWaits = new Map<Entry, { readonly frame: Frame; readonly ticket: WaitTicket }>();

  /** Capture native identity before releasing admission; no later read follows live selection. */
  const waitOn = <A>(
    ticket: WaitTicket,
    target: DriverTarget,
    acquire: () => {
      readonly wait: () => Promise<A>;
      readonly check?: () => void;
      readonly dispose: () => Promise<void>;
    },
  ): Promise<A> => {
    ticket.check();
    const { entry, frame } = current(target);

    if (waitConnectionRetired) throw failure(Reasons.Closed.make({}), "undispatched");
    // One native wait per exact Page, including canceled waits whose disposal has not been
    // confirmed. The aggregate remains finite even when closed caller fibers leave work behind.
    if (pendingWaits.has(entry) || pendingWaits.size >= 32)
      throw failure(Reasons.Busy.make({}), "undispatched");
    const epoch = targets.epochOf(frame);
    const resource = acquire();
    const pending = { frame, ticket };

    pendingWaits.set(entry, pending);

    const check = () => {
      ticket.check();
      const resolved = current(target);

      if (
        waitConnectionRetired ||
        resolved.entry !== entry ||
        resolved.frame !== frame ||
        targets.epochOf(frame) !== epoch
      )
        throw failure(Reasons.Stale.make({}), "undispatched");
      resource.check?.();
    };

    return sanitize(async () => {
      let result: A;

      try {
        try {
          check();
          result = await resource.wait();
          check();
        } catch (error) {
          // Lifecycle/deadline evidence wins over a native cancellation or detached-node error.
          check();
          if (isTimeoutError(error)) throw failure(Reasons.Timeout.make({}), "undispatched");
          throw error;
        }
      } finally {
        // This raw release is observed after caller cancellation, without renewing its deadline.
        // A rejected disposal proves no retirement, so keep that Page's native capacity until
        // positive Page or connection closure. Old completion never frees a successor's slot.
        await resource.dispose();
        ticket.retire();
        if (pendingWaits.get(entry) === pending) pendingWaits.delete(entry);
      }
      check();

      return result;
    });
  };

  const waitFor: Driver["waitFor"] = (selector, state, ticket, target) =>
    waitOn(ticket, target, () => {
      const { frame } = current(target);
      let node: ElementHandle<Element> | null | undefined;

      return {
        wait: async () => {
          node = await frame.waitForSelector(selector, {
            state,
            strict: true,
            timeout: timeout(ticket),
            signal: ticket.signal,
          });
        },
        dispose: async () => {
          if (!waitConnectionRetired) await node?.dispose();
        },
      };
    });

  const waitForElement: Driver["waitForElement"] = (reference, state, ticket, target) =>
    waitOn(ticket, targetFor(reference, target) ?? target, () => {
      target = targetFor(reference, target) ?? target;
      const leased = observation.lease(reference, ticket, target);

      /** A node that can no longer be read, because its document is gone, is not attached. */
      const attached = async () => {
        leased.check();

        const present = await leased.element
          .evaluate((node) => node.isConnected && node.ownerDocument === document)
          .catch(() => false);

        leased.check();
        if (present !== true) throw failure(Reasons.Stale.make({}), "undispatched");
      };

      return {
        check: leased.check,
        wait: async () => {
          try {
            await leased.element.waitForElementState(state, {
              timeout: timeout(ticket),
              signal: ticket.signal,
            });
          } catch (error) {
            // A replaced document can reject the native wait before the navigation event
            // advances its epoch, so ask the node itself. A hidden wait needs asking only then:
            // a node removed from a live document already satisfies it.
            if (state !== "hidden" || !(isTimeoutError(error) || ticket.signal.aborted))
              await attached();
            throw error;
          }
          // A hidden node may have left its document; any other state needs it attached.
          if (state !== "hidden") await attached();
        },
        dispose: leased.release,
      };
    });

  const settled: Driver["settled"] = (options, ticket, target) =>
    waitOn(ticket, target, () => makeSettledResource(current(target).frame, ticket, options));

  const clickAndWait: Driver["clickAndWait"] = (target, ticket, capture, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);
      const { entry, frame } = current(browserTarget);

      const observer = waitEvent<Frame>(
        (on) => entry.page.on("framenavigated", on),
        (off) => entry.page.off("framenavigated", off),
        ticket,
        (changedFrame) => changedFrame === frame,
      );

      try {
        const clicked = await click(target, ticket, capture, undefined, browserTarget);

        await observer.promise;
        await frame.waitForLoadState("domcontentloaded", { timeout: timeout(ticket) });
        ticket.check();

        return { url: url(), input: clicked.input };
      } finally {
        observer.cancel();
      }
    });

  const clickForDownload: Driver["clickForDownload"] = (target, ticket, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const page = current(browserTarget).entry.page;

      const observer = waitEvent<Download>(
        (on) => page.on("download", on),
        (off) => page.off("download", off),
        ticket,
      );

      try {
        await clickWithoutReceipt(target, ticket, browserTarget);
        const download = await observer.promise;

        const filename = safeDecode(SafeFilename, download.suggestedFilename());

        const error = await download.failure();

        ticket.check();

        return {
          downloadId: `native-download-${++downloadSerial}`,
          filename,
          state: error === null ? "completed" : "failed",
        };
      } finally {
        observer.cancel();
      }
    });

  const selectFiles: Driver["selectFiles"] = (target, files, ticket, browserTarget) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);
      const selection = nativeSelection(files);

      if (selection._tag === "Remote")
        await attachStoredFiles(target, selection.paths, ticket, browserTarget);
      else
        await withElement(
          target,
          ticket,
          (element) => element.setInputFiles(selection.payload, { timeout: timeout(ticket) }),
          undefined,
          browserTarget,
        );
      ticket.check();

      return url();
    });

  const clickForFileSelection: Driver["clickForFileSelection"] = (
    target,
    files,
    ticket,
    browserTarget,
  ) =>
    sanitize(async () => {
      browserTarget = targetFor(target, browserTarget);
      const url = resultUrl(browserTarget);
      const selection = nativeSelection(files);

      // A chooser is satisfied with bytes this client holds. A provider-stored file is
      // attached to an exact input node instead, where the browser can open the path.
      if (selection._tag === "Remote") throw failure(Reasons.Unsupported.make({}), "undispatched");
      const page = current(browserTarget).entry.page;

      const observer = waitEvent<FileChooser>(
        (on) => page.on("filechooser", on),
        (off) => page.off("filechooser", off),
        ticket,
      );

      try {
        await clickWithoutReceipt(target, ticket, browserTarget);
        const chooser = await observer.promise;

        ticket.check();
        if (!chooser.isMultiple() && selection.payload.length > 1)
          throw failure(Reasons.Unsupported.make({}));
        // Exactly one attachment for this chooser; a second would open another dispatch.
        ticket.dispatch();
        await chooser.setFiles(selection.payload, { timeout: timeout(ticket) });
        ticket.acknowledge?.();
        ticket.followUp?.();
        ticket.check();

        return url();
      } finally {
        observer.cancel();
      }
    });

  return {
    pointer,
    keyboard,
    withAdmittedElement,
    targetFor,
    beginNavigation,
    /** Capture the exact navigation at dialog arrival; acknowledgement never looks it up again. */
    beforeUnload: (pageId: string) => {
      const active = navigationControls.get(pageId);

      return active?.mainFrame === true ? active.control?.beforeUnload() : undefined;
    },
    click,
    fill,
    formStep,
    formSubmit,
    selectOption,
    scroll,
    scrollTo,
    settled,
    waitFor,
    waitForElement,
    waitChanged: (entry: Entry, frame?: Frame) => {
      const pending = pendingWaits.get(entry);

      if (
        pending !== undefined &&
        (frame === undefined || frame === pending.frame || frame === entry.page.mainFrame())
      )
        pending.ticket.invalidate();
    },
    retireWaitPage: (entry: Entry) => {
      const pending = pendingWaits.get(entry);

      if (pending === undefined) return;
      pending.ticket.invalidate();
      pending.ticket.retire();
      if (pendingWaits.get(entry) === pending) pendingWaits.delete(entry);
    },
    retireWait: () => {
      waitConnectionRetired = true;
      for (const pending of pendingWaits.values()) {
        pending.ticket.invalidate();
        pending.ticket.retire();
      }
      pendingWaits.clear();
    },
    clickAndWait,
    clickForDownload,
    selectFiles,
    clickForFileSelection,
  };
};
