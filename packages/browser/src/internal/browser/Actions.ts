import { Schema } from "effect";
import type { BrowserContext, Download, ElementHandle, FileChooser, Frame } from "playwright-core";

import type { ObservedElement } from "../../BrowserData.ts";
import { SafeFilename } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { Driver, DriverTarget, NativeFileSelection, NavigationControl } from "./Driver.ts";
import {
  closeWithin,
  failure,
  type NativeFailure,
  safeDecode,
  sanitize,
  timeout,
} from "./NativeCalls.ts";
import type { AdmissionPolicy, Observation } from "./Observation.ts";
import type { Ticket, WaitTicket } from "./Owner.ts";
import type { Entry, Targets } from "./Targets.ts";

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
 * Input to the selected document. A mutation marks its ticket dispatched immediately before the
 * one native command that may change the page; any outcome after that point is uncertain.
 */
export const makeActions = (
  context: BrowserContext,
  targets: Targets,
  observation: Observation,
  isTimeoutError: (error: unknown) => boolean,
) => {
  const { current } = targets;

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

  const postUrl = (target?: DriverTarget) => httpUrl(targets.url(target));

  /**
   * Acts on the exact attached node a target names. The observation seam establishes that it is
   * still the control that was inspected and that the host's policy, if any, admits it. `admit`
   * then sees that node before anything is dispatched, so a refusal it raises is undispatched
   * too, and what it learns reaches the action without the node being resolved a second time.
   */
  const withAdmittedElement = async <Admitted, A>(
    target: string | ObservedElement,
    ticket: Ticket,
    admit: (element: ElementHandle<Element>) => Promise<Admitted>,
    action: (element: ElementHandle<Element>, admitted: Admitted) => Promise<A>,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ): Promise<A> => {
    const { element, kept, check } = await observation.resolve(
      target,
      ticket,
      policy,
      false,
      browserTarget,
    );

    try {
      check();
      const admitted = await admit(element);

      check();
      ticket.check();
      // ElementHandle actions do not re-resolve the selector onto a replacement node.
      ticket.dispatch();

      return await action(element, admitted);
    } finally {
      if (!kept) await closeWithin(() => element.dispose()).catch(() => {});
    }
  };

  const withElement = <A>(
    target: string | ObservedElement,
    ticket: Ticket,
    action: (element: ElementHandle<Element>) => Promise<A>,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ): Promise<A> =>
    withAdmittedElement(target, ticket, async () => {}, action, policy, browserTarget);

  const click: Driver["click"] = (target, ticket, policy, browserTarget) =>
    sanitize(async () => {
      await withElement(
        target,
        ticket,
        (element) => element.click({ timeout: timeout(ticket) }),
        policy,
        browserTarget,
      );
      ticket.check();

      return postUrl(browserTarget);
    });

  /**
   * A file the provider already stores is named to the browser process, which opens it; this
   * client never reads that path. Exactly one main-frame node may match, and exactly one
   * command dispatches. A retained node or child frame is refused rather than approximated.
   */
  const attachStoredFiles = async (
    target: string | ObservedElement,
    paths: ReadonlyArray<string>,
    ticket: Ticket,
  ) => {
    if (typeof target !== "string") throw failure(Reasons.Unsupported.make({}), "undispatched");
    const { entry, frame } = current();

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
      await withElement(
        target,
        ticket,
        (element) => element.fill(value, { timeout: timeout(ticket) }),
        policy,
        browserTarget,
      );
      ticket.check();

      return postUrl(browserTarget);
    });

  const selectOption: Driver["selectOption"] = (target, options, ticket, policy) =>
    sanitize(async () => {
      await withAdmittedElement(
        target,
        ticket,
        (element) => observation.selectOptions(target, options, element, ticket),
        async (element, admitted) => {
          // Only issued native nodes reach this command. Its returned values stay private.
          const values = await element.selectOption(admitted.handles, { timeout: timeout(ticket) });
          const expected = [...admitted.values].sort();

          if (
            values.length !== expected.length ||
            values.sort().some((value, i) => value !== expected[i])
          )
            throw failure(Reasons.Stale.make({}), "unknown");
        },
        policy,
      );
      ticket.check();

      return postUrl();
    });

  const scroll: Driver["scroll"] = (deltaX, deltaY, ticket, target) =>
    sanitize(async () => {
      const { frame } = current(target);

      ticket.dispatch();
      await frame.evaluate(
        ({ x, y }) => window.scrollBy({ left: x, top: y, behavior: "instant" }),
        { x: deltaX, y: deltaY },
      );
      ticket.check();

      return postUrl(target);
    });

  let waitConnectionRetired = false;

  let pendingWait:
    | { readonly entry: Entry; readonly frame: Frame; readonly ticket: WaitTicket }
    | undefined;

  /** Capture native identity before releasing admission; no later read follows live selection. */
  const waitOn = (
    ticket: WaitTicket,
    target: DriverTarget,
    acquire: () => {
      readonly wait: () => Promise<void>;
      readonly check?: () => void;
      readonly dispose: () => Promise<void>;
    },
  ): Promise<void> => {
    ticket.check();
    const { entry, frame } = current(target);
    const epoch = targets.epochOf(frame);
    const resource = acquire();
    const pending = { entry, frame, ticket };

    pendingWait = pending;

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
      try {
        try {
          check();
          await resource.wait();
          check();
        } catch (error) {
          // Lifecycle/deadline evidence wins over a native cancellation or detached-node error.
          check();
          if (isTimeoutError(error)) throw failure(Reasons.Timeout.make({}), "undispatched");
          throw error;
        }
      } finally {
        try {
          // This raw release is observed after caller cancellation, without renewing its deadline.
          await resource.dispose();
          ticket.retire();
        } finally {
          if (pendingWait === pending) pendingWait = undefined;
        }
      }
      check();
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
    waitOn(ticket, target, () => {
      const leased = observation.lease(reference, ticket);

      const attached = async () => {
        leased.check();

        const present = await leased.element.evaluate(
          (node) => node.isConnected && node.ownerDocument === document,
        );

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
            if (state !== "hidden") await attached();
            throw error;
          }
          if (state !== "hidden") await attached();
        },
        dispose: leased.release,
      };
    });

  const clickAndWait: Driver["clickAndWait"] = (target, ticket) =>
    sanitize(async () => {
      const { entry, frame } = current();

      const observer = waitEvent<Frame>(
        (on) => entry.page.on("framenavigated", on),
        (off) => entry.page.off("framenavigated", off),
        ticket,
        (changedFrame) => changedFrame === frame,
      );

      try {
        await click(target, ticket);
        await observer.promise;
        await frame.waitForLoadState("domcontentloaded", { timeout: timeout(ticket) });
        ticket.check();

        return postUrl();
      } finally {
        observer.cancel();
      }
    });

  const clickForDownload: Driver["clickForDownload"] = (target, ticket) =>
    sanitize(async () => {
      const page = current().entry.page;

      const observer = waitEvent<Download>(
        (on) => page.on("download", on),
        (off) => page.off("download", off),
        ticket,
      );

      try {
        await click(target, ticket);
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

  const selectFiles: Driver["selectFiles"] = (target, files, ticket) =>
    sanitize(async () => {
      const selection = nativeSelection(files);

      if (selection._tag === "Remote") await attachStoredFiles(target, selection.paths, ticket);
      else
        await withElement(target, ticket, (element) =>
          element.setInputFiles(selection.payload, { timeout: timeout(ticket) }),
        );
      ticket.check();

      return postUrl();
    });

  const clickForFileSelection: Driver["clickForFileSelection"] = (target, files, ticket) =>
    sanitize(async () => {
      const selection = nativeSelection(files);

      // A chooser is satisfied with bytes this client holds. A provider-stored file is
      // attached to an exact input node instead, where the browser can open the path.
      if (selection._tag === "Remote") throw failure(Reasons.Unsupported.make({}), "undispatched");
      const page = current().entry.page;

      const observer = waitEvent<FileChooser>(
        (on) => page.on("filechooser", on),
        (off) => page.off("filechooser", off),
        ticket,
      );

      try {
        await click(target, ticket);
        const chooser = await observer.promise;

        ticket.check();
        if (!chooser.isMultiple() && selection.payload.length > 1)
          throw failure(Reasons.Unsupported.make({}));
        // Exactly one attachment for this chooser; a second would open another dispatch.
        await chooser.setFiles(selection.payload, { timeout: timeout(ticket) });
        ticket.check();

        return postUrl();
      } finally {
        observer.cancel();
      }
    });

  return {
    withAdmittedElement,
    beginNavigation,
    /** Capture the exact navigation at dialog arrival; acknowledgement never looks it up again. */
    beforeUnload: (pageId: string) => {
      const active = navigationControls.get(pageId);

      return active?.mainFrame === true ? active.control?.beforeUnload() : undefined;
    },
    click,
    fill,
    selectOption,
    scroll,
    waitFor,
    waitForElement,
    waitChanged: (entry: Entry, frame?: Frame) => {
      const pending = pendingWait;

      if (
        pending?.entry === entry &&
        (frame === undefined || frame === pending.frame || frame === entry.page.mainFrame())
      )
        pending.ticket.invalidate();
    },
    retireWait: () => {
      waitConnectionRetired = true;
      pendingWait?.ticket.invalidate();
      pendingWait?.ticket.retire();
      pendingWait = undefined;
    },
    clickAndWait,
    clickForDownload,
    selectFiles,
    clickForFileSelection,
  };
};
