import type { CDPSession, ElementHandle, Page } from "playwright-core";

import type { KeyModifier, ObservedElement } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { makeActions } from "./Actions.ts";
import type { DriverTarget } from "./Driver.ts";
import { failure, sanitize } from "./NativeCalls.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
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
  let typing: { release?: () => void } | undefined;

  const retire = () => {
    typing?.release?.();
    typing = undefined;
  };

  const withTypingPort = async <A>(
    page: Page,
    ticket: Ticket,
    action: (port: CDPSession) => Promise<A>,
  ) => {
    ticket.check();
    if (typing !== undefined) throw failure(Reasons.Busy.make({}), "undispatched");
    // Reserve before attachment: a canceled waiter cannot admit more native setup or input.
    const slot: { release?: () => void } = {};

    typing = slot;
    let port: CDPSession | undefined;

    let result:
      | { readonly _tag: "Success"; readonly value: A }
      | { readonly _tag: "Failure"; readonly error: unknown };

    try {
      port = await page.context().newCDPSession(page);
      const attached = port;

      const release = () => {
        attached.off("close", release);
        if (typing === slot) typing = undefined;
      };

      slot.release = release;
      if (typing === slot) attached.on("close", release);
      ticket.check();
      if (typing !== slot) throw failure(Reasons.Closed.make({}), "undispatched");

      result = { _tag: "Success", value: await action(attached) };
    } catch (error) {
      result = { _tag: "Failure", error };
      // A terminal constructor rejection returned no owned port and has no pending setup.
      // Cancellation alone never reaches here while that constructor is still unresolved.
      if (port === undefined && typing === slot) typing = undefined;
    }
    if (port !== undefined && typing === slot)
      try {
        // Drained input replies precede detach. Only its acknowledgement, a close event,
        // or positive connection retirement returns capacity; a failed close does not.
        await port.detach();
        slot.release?.();
      } catch (error) {
        if (result._tag === "Success") result = { _tag: "Failure", error };
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

  /** Sends under one dispatch, either to whatever has focus or to the one element that must. */
  const send = async (
    into: string | ObservedElement | undefined,
    ticket: Ticket,
    policy: AdmissionPolicy | undefined,
    keys: (page: Page, element?: ElementHandle<Element>) => Promise<void>,
    browserTarget?: DriverTarget,
  ): Promise<NativeInput> => {
    const { page } = current(browserTarget).entry;

    if (into === undefined) {
      ticket.dispatch();
      await keys(page);
    } else
      await actions.withAdmittedElement(
        into,
        ticket,
        (element) => requireFocus(element),
        (element) => keys(page, element),
        policy,
        browserTarget,
      );
    ticket.check();

    return receipt(page);
  };

  const press = (
    key: string,
    modifiers: ReadonlyArray<KeyModifier>,
    into: string | ObservedElement | undefined,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) =>
    sanitize(() =>
      // Both halves are closed vocabularies by now, so the engine's `+` syntax is only ever ours.
      send(
        into,
        ticket,
        policy,
        (page) => page.keyboard.press([...modifiers, key].join("+")),
        browserTarget,
      ),
    );

  const type = (
    text: string,
    into: string | ObservedElement | undefined,
    ticket: Ticket,
    policy?: AdmissionPolicy,
    browserTarget?: DriverTarget,
  ) =>
    sanitize(async () => {
      const { page } = current(browserTarget).entry;

      return withTypingPort(page, ticket, async (port) => {
        if (current(browserTarget).entry.page !== page)
          throw failure(Reasons.Stale.make({}), "undispatched");

        return send(
          into,
          ticket,
          policy,
          async (_page, element) => {
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

  return { press, type, retire };
};
