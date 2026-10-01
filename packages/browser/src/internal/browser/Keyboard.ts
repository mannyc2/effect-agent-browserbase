import { Result } from "effect";
import type { CDPSession, ElementHandle, Page } from "playwright-core";

import type { KeyModifier } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { makeActions } from "./Actions.ts";
import type { DriverTarget, ElementTarget } from "./Driver.ts";
import { failure, sanitize } from "./NativeCalls.ts";
import { ownerPacing } from "./NativePacing.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import { keys as keySchedule, type KeySchedule, type Stroke } from "./Performance.ts";
import type { NativeInput } from "./Pointer.ts";
import type { Targets } from "./Targets.ts";

// Printable US keys match the pinned Playwright layout. Uppercase and shifted punctuation
// carry their literal text without holding Shift, just as Keyboard.type does. Other Unicode
// code points use Chromium's native insertText; neither path manufactures DOM events.
const punctuation: ReadonlyArray<readonly [string, string, number]> = [
  ["`~", "Backquote", 192],
  ["1!", "Digit1", 49],
  ["2@", "Digit2", 50],
  ["3#", "Digit3", 51],
  ["4$", "Digit4", 52],
  ["5%", "Digit5", 53],
  ["6^", "Digit6", 54],
  ["7&", "Digit7", 55],
  ["8*", "Digit8", 56],
  ["9(", "Digit9", 57],
  ["0)", "Digit0", 48],
  ["-_", "Minus", 189],
  ["=+", "Equal", 187],
  ["\\|", "Backslash", 220],
  ["[{", "BracketLeft", 219],
  ["]}", "BracketRight", 221],
  [";:", "Semicolon", 186],
  ["'\"", "Quote", 222],
  [",<", "Comma", 188],
  [".>", "Period", 190],
  ["/?", "Slash", 191],
  [" ", "Space", 32],
];

const keyDescription = (
  key: string,
): { readonly code: string; readonly keyCode: number } | undefined => {
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();

    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }

  const named: ReadonlyArray<readonly [string, string, number]> = [
    ["Enter", "Enter", 13],
    ["Tab", "Tab", 9],
    ["Backspace", "Backspace", 8],
    ["Delete", "Delete", 46],
    ["Escape", "Escape", 27],
    ["ArrowLeft", "ArrowLeft", 37],
    ["ArrowRight", "ArrowRight", 39],
    ["ArrowUp", "ArrowUp", 38],
    ["ArrowDown", "ArrowDown", 40],
    ["Home", "Home", 36],
    ["End", "End", 35],
    ["PageUp", "PageUp", 33],
    ["PageDown", "PageDown", 34],
  ];

  const special = named.find(([name]) => name === key);

  if (special !== undefined) return { code: special[1], keyCode: special[2] };
  const description = punctuation.find(([characters]) => characters.includes(key));

  return description === undefined ? undefined : { code: description[1], keyCode: description[2] };
};

/** At most sixteen complete strokes / thirty-two replies live at once. */
const typeWindow = async (port: CDPSession, characters: ReadonlyArray<string>, ticket: Ticket) => {
  const pending: Array<Promise<void>> = [];
  let failed = false;
  let firstFailure: unknown;

  const reject = (error: unknown) => {
    if (!failed) {
      failed = true;
      firstFailure = error;
    }
  };

  const submit = (command: () => Promise<unknown>) => {
    ticket.check();
    ticket.dispatch();
    // Observe every reply immediately, including a rejection arriving after caller cancellation.
    pending.push(command().then(() => {}, reject));
  };

  try {
    for (const key of characters) {
      const description = keyDescription(key);

      if (description === undefined) submit(() => port.send("Input.insertText", { text: key }));
      else {
        const { code, keyCode } = description;

        submit(() =>
          port.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            modifiers: 0,
            windowsVirtualKeyCode: keyCode,
            code,
            commands: [],
            key,
            text: key,
            unmodifiedText: key,
            autoRepeat: false,
            location: 0,
            isKeypad: false,
          }),
        );
        // An authority loss during keydown leaves this unsent; cleanup never repairs input.
        submit(() =>
          port.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            modifiers: 0,
            key,
            windowsVirtualKeyCode: keyCode,
            code,
            location: 0,
          }),
        );
      }
    }
  } catch (error) {
    reject(error);
  }
  await Promise.all(pending);
  if (failed) throw firstFailure;
  ticket.acknowledge?.();
};

/**
 * Real key input to the selected page. Every stroke is one the browser would receive from a
 * keyboard, so handlers see trusted `keydown` and `keyup`, and the browser itself decides what
 * has focus. Nothing here focuses, paces or retries: a caller that wants a cadence sends its keys.
 */
export const makeKeyboard = (
  targets: Targets,
  actions: ReturnType<typeof makeActions>,
  receipt: (page: Page) => NativeInput,
) => {
  const { current } = targets;

  // A port whose run drained every reply stays attached, idle, for the next run on its page:
  // attaching and detaching cost three serial round trips, more than a one-character run.
  type Slot = { release?: () => void; idle?: CDPSession };

  // The native Page object is the authority for its port. Retiring the caller's permit does
  // not retire setup, input replies or failed detach, so those slots remain independently.
  const typing = new Map<Page, Slot>();

  const retirePage = (page: Page) => {
    const slot = typing.get(page);

    slot?.release?.();
    if (typing.get(page) === slot) typing.delete(page);
  };

  const retire = () => {
    for (const page of typing.keys()) retirePage(page);
  };

  // Only the acknowledgement, a close event, or positive connection retirement returns
  // capacity; a failed close does not.
  const detach = async (slot: Slot, port: CDPSession) => {
    await port.detach();
    slot.release?.();
  };

  const withTypingPort = async <A>(
    page: Page,
    ticket: Ticket,
    action: (port: CDPSession) => Promise<A>,
  ) => {
    ticket.check();
    const previous = typing.get(page);

    if (previous !== undefined && previous.idle === undefined)
      throw failure(Reasons.Busy.make({}), "undispatched");
    if (previous === undefined && typing.size >= 32)
      throw failure(Reasons.Busy.make({}), "undispatched");
    // Reserve before attachment: a canceled waiter cannot admit more native setup or input.
    const slot: Slot = previous ?? {};
    let port = slot.idle;

    slot.idle = undefined;
    typing.set(page, slot);

    let result:
      | { readonly _tag: "Success"; readonly value: A }
      | { readonly _tag: "Failure"; readonly error: unknown };

    try {
      if (port === undefined) {
        port = await page.context().newCDPSession(page);
        const attached = port;

        const release = () => {
          attached.off("close", release);
          if (typing.get(page) === slot) typing.delete(page);
        };

        slot.release = release;
        if (typing.get(page) === slot) attached.on("close", release);
      }
      ticket.check();
      if (typing.get(page) !== slot) throw failure(Reasons.Closed.make({}), "undispatched");

      result = { _tag: "Success", value: await action(port) };
    } catch (error) {
      result = { _tag: "Failure", error };
      // A terminal constructor rejection returned no owned port and has no pending setup.
      // Cancellation alone never reaches here while that constructor is still unresolved.
      if (port === undefined && typing.get(page) === slot) typing.delete(page);
    }
    if (port !== undefined && typing.get(page) === slot) {
      // Drained input replies precede detach; a failed run never leaves its port for reuse.
      if (result._tag === "Success") slot.idle = port;
      else await detach(slot, port).catch(() => {});
    }
    if (result._tag === "Failure") throw result.error;

    return result.value;
  };

  /**
   * Keys reach the focused element of the focused document, so the guard requires both: the
   * element named is that element or holds it, through any open shadow root, and its document
   * has focus. The pinned Chromium clears a frame's active element when focus leaves that
   * frame, which makes the second check redundant wherever that holds. It is kept because that
   * is the browser's bookkeeping, not a guarantee, and where it failed the keys would land in
   * another frame than the one this guard was asked about.
   */
  const requireFocus = async (
    element: ElementHandle<Element>,
    outcome: "undispatched" | "unknown" = "undispatched",
  ): Promise<void> => {
    const focused: unknown = await element.evaluate((node) => {
      if (!node.isConnected || node.ownerDocument !== document || !node.ownerDocument.hasFocus())
        return false;
      let active = node.ownerDocument.activeElement;

      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;

      for (let at: Node | null = active; at !== null;) {
        if (at === node) return true;
        at = at.parentNode ?? (at instanceof ShadowRoot ? at.host : null);
      }

      return false;
    });

    if (focused !== true) throw failure(Reasons.NotFocused.make({}), outcome);
  };

  const planKeys = (text: string, ticket: Ticket): KeySchedule => {
    const performance = ticket.performance;

    ownerPacing(ticket);
    if (performance === undefined) throw failure(Reasons.Unsupported.make({}), "undispatched");
    const planned = keySchedule(performance.plan, text, performance.fieldIndex);

    if (Result.isFailure(planned)) throw planned.failure;

    return planned.success;
  };

  const prepareKeys = (text: string, ticket: Ticket): KeySchedule => {
    const schedule = planKeys(text, ticket);

    ownerPacing(ticket).requireDuration(schedule.durationMillis);

    return schedule;
  };

  /** One paired native stroke remains unresolved until its key and modifiers are all released. */
  const pacedStroke = async (
    port: CDPSession,
    stroke: Stroke,
    ticket: Ticket,
    check: () => void,
    element?: ElementHandle<Element>,
    modifiers: ReadonlyArray<KeyModifier> = [],
    typed = true,
  ) => {
    const pacing = ownerPacing(ticket);

    pacing.requireDuration(stroke.holdMillis);
    // Focus is required once, before the stroke's first command. The key's own default action
    // may move it (Tab, an Enter that submits, an auto-advancing field), and the releases still
    // belong to this stroke: like plain typing's, they are fenced by the ticket alone.
    check();
    if (element !== undefined) await requireFocus(element);
    check();

    const submit = async (command: () => Promise<unknown>) => {
      check();
      ticket.dispatch();
      // The one current reply is observed before another command can be submitted.
      await command();
    };

    const description = keyDescription(stroke.key);

    if (description === undefined) {
      await submit(() => port.send("Input.insertText", { text: stroke.key }));
      ticket.acknowledge?.({ subphase: "key-burst", logicalComplete: true });
      if (stroke.holdMillis > 0)
        await pacing.pauseUntil(pacing.now() + BigInt(Math.round(stroke.holdMillis * 1e6)));

      return;
    }
    const held = [...modifiers];

    if (typed && /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/u.test(stroke.key) && !held.includes("Shift"))
      held.push("Shift");

    const modifierFacts: Record<
      KeyModifier,
      { readonly code: string; readonly keyCode: number; readonly mask: number }
    > = {
      Shift: { code: "ShiftLeft", keyCode: 16, mask: 8 },
      Control: { code: "ControlLeft", keyCode: 17, mask: 2 },
      Alt: { code: "AltLeft", keyCode: 18, mask: 1 },
      Meta: { code: "MetaLeft", keyCode: 91, mask: 4 },
    };

    let mask = 0;

    for (const modifier of held) {
      const facts = modifierFacts[modifier];

      mask |= facts.mask;
      await submit(() =>
        port.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          modifiers: mask,
          key: modifier,
          code: facts.code,
          windowsVirtualKeyCode: facts.keyCode,
          location: 1,
          autoRepeat: false,
        }),
      );
    }

    const text =
      (mask & ~8) !== 0
        ? ""
        : stroke.key === "Enter"
          ? "\r"
          : stroke.key.length === 1
            ? stroke.key
            : "";

    const unmodifiedText = /^[A-Z]$/u.test(stroke.key) ? stroke.key.toLowerCase() : stroke.key;

    await submit(() =>
      port.send("Input.dispatchKeyEvent", {
        type: text.length > 0 ? "keyDown" : "rawKeyDown",
        modifiers: mask,
        windowsVirtualKeyCode: description.keyCode,
        code: description.code,
        key: stroke.key,
        text,
        unmodifiedText: text.length > 0 ? (stroke.key === "Enter" ? "\r" : unmodifiedText) : "",
        commands: [],
        autoRepeat: false,
        location: 0,
        isKeypad: false,
      }),
    );
    if (stroke.holdMillis > 0)
      await pacing.pauseUntil(pacing.now() + BigInt(Math.round(stroke.holdMillis * 1e6)));
    await submit(() =>
      port.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: mask,
        key: stroke.key,
        windowsVirtualKeyCode: description.keyCode,
        code: description.code,
        location: 0,
      }),
    );
    for (const modifier of held.toReversed()) {
      const facts = modifierFacts[modifier];

      mask &= ~facts.mask;
      await submit(() =>
        port.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers: mask,
          key: modifier,
          code: facts.code,
          windowsVirtualKeyCode: facts.keyCode,
          location: 1,
        }),
      );
    }
    ticket.acknowledge?.({ subphase: "key-burst", logicalComplete: true });
  };

  const pacedKeys = async (
    port: CDPSession,
    schedule: KeySchedule,
    ticket: Ticket,
    check: () => void,
    element?: ElementHandle<Element>,
  ) => {
    const pacing = ownerPacing(ticket);

    pacing.requireDuration(schedule.durationMillis);

    for (const stroke of schedule.strokes) {
      check();
      if (stroke.intervalMillis > 0)
        await pacing.pauseUntil(pacing.now() + BigInt(Math.round(stroke.intervalMillis * 1e6)));
      await pacedStroke(port, stroke, ticket, check, element);
    }
  };

  /** Focus/select happens only for Fill, on its already admitted exact node. */
  const fillElement = (
    page: Page,
    element: ElementHandle<Element>,
    schedule: KeySchedule,
    ticket: Ticket,
    check: () => void,
    readmit?: () => Promise<void>,
  ) =>
    withTypingPort(page, ticket, async (port) => {
      check();
      ownerPacing(ticket).requireDuration(schedule.durationMillis);
      ticket.dispatch();
      await element.selectText({ timeout: ticket.remainingMillis() });
      ticket.acknowledge?.({ subphase: "focus", logicalComplete: false });
      await readmit?.();
      check();
      await requireFocus(element, ticket.dispatched ? "unknown" : "undispatched");
      check();
      ticket.dispatch();
      await page.keyboard.press("Backspace");
      ticket.acknowledge?.({ subphase: "key-burst", logicalComplete: false });
      if (schedule.strokes.length > 0) await readmit?.();
      check();
      await pacedKeys(port, schedule, ticket, check, element);
    });

  /** Sends under one dispatch, either to whatever has focus or to the one element that must. */
  const send = async (
    into: ElementTarget | undefined,
    ticket: Ticket,
    policy: AdmissionPolicy | undefined,
    keys: (page: Page, element?: ElementHandle<Element>, check?: () => void) => Promise<void>,
    browserTarget?: DriverTarget,
  ): Promise<NativeInput> => {
    if (into !== undefined) browserTarget = actions.targetFor(into, browserTarget);
    const { page } = current(browserTarget).entry;

    if (into === undefined) {
      if (ticket.performance === undefined) ticket.dispatch();
      await keys(page, undefined, () => ticket.check());
      ticket.acknowledge?.();
      ticket.followUp?.();
    } else
      await actions.withAdmittedElement(
        into,
        ticket,
        (element) => requireFocus(element),
        (element, _admitted, check) => keys(page, element, check),
        policy,
        browserTarget,
        false,
        ticket.performance === undefined,
      );
    ticket.check();

    return receipt(page);
  };

  const press = (
    key: string,
    modifiers: ReadonlyArray<KeyModifier>,
    into: ElementTarget | undefined,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) =>
    sanitize(async () => {
      if (ticket.performance !== undefined) {
        const schedule = planKeys(" ", ticket);
        const planned = schedule.strokes[0];

        if (planned === undefined) throw failure(Reasons.Malformed.make({}), "undispatched");
        ownerPacing(ticket).requireDuration(planned.holdMillis);
        if (into !== undefined) browserTarget = actions.targetFor(into, browserTarget);
        const { page } = current(browserTarget).entry;

        return withTypingPort(page, ticket, (port) =>
          send(
            into,
            ticket,
            policy,
            (_page, element, check) =>
              pacedStroke(
                port,
                { ...planned, key },
                ticket,
                check ?? (() => ticket.check()),
                element,
                modifiers,
                false,
              ),
            browserTarget,
          ),
        );
      }

      // Both halves are closed vocabularies by now, so the engine's `+` syntax is only ever ours.
      return send(
        into,
        ticket,
        policy,
        (page) => page.keyboard.press([...modifiers, key].join("+")),
        browserTarget,
      );
    });

  const type = (
    text: string,
    into: ElementTarget | undefined,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) =>
    sanitize(async () => {
      if (into !== undefined) browserTarget = actions.targetFor(into, browserTarget);
      const { page } = current(browserTarget).entry;
      const schedule = ticket.performance === undefined ? undefined : prepareKeys(text, ticket);

      return withTypingPort(page, ticket, async (port) => {
        if (current(browserTarget).entry.page !== page)
          throw failure(Reasons.Stale.make({}), "undispatched");

        return send(
          into,
          ticket,
          policy,
          async (_page, element, check) => {
            if (schedule !== undefined) {
              await pacedKeys(port, schedule, ticket, check ?? (() => ticket.check()), element);

              return;
            }
            const characters = [...text];

            for (let start = 0; start < characters.length; start += 16) {
              ticket.check();
              if (start > 0 && element !== undefined) {
                // Keep the exact admitted node; resolving a selector again could redirect input.
                await requireFocus(element, "unknown");
                ticket.check();
              }
              await typeWindow(port, characters.slice(start, start + 16), ticket);
            }
          },
          browserTarget,
        );
      });
    });

  return {
    press,
    type,
    prepareKeys,
    fillElement,
    retire,
    retirePage,
    drained: () => [...typing.values()].every((slot) => slot.idle !== undefined),
  };
};
