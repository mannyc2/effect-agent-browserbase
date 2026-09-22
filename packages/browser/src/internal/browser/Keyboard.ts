import type { ElementHandle, Page } from "playwright-core";

import type { KeyModifier, ObservedElement } from "../../BrowserData.ts";
import type { makeActions } from "./Actions.ts";
import type { DriverTarget } from "./Driver.ts";
import { failure, sanitize } from "./NativeCalls.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import type { NativeInput } from "./Pointer.ts";
import type { Targets } from "./Targets.ts";

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

  /**
   * Keys reach the focused element of the focused document, so the guard requires both: the
   * element named is that element or holds it, through any open shadow root, and its document
   * has focus. The pinned Chromium clears a frame's active element when focus leaves that
   * frame, which makes the second check redundant wherever that holds. It is kept because that
   * is the browser's bookkeeping, not a guarantee, and where it failed the keys would land in
   * another frame than the one this guard was asked about.
   */
  const requireFocus = async (element: ElementHandle<Element>): Promise<void> => {
    const focused: unknown = await element.evaluate((node) => {
      if (!node.ownerDocument.hasFocus()) return false;
      let active = node.ownerDocument.activeElement;

      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;

      for (let at: Node | null = active; at !== null;) {
        if (at === node) return true;
        at = at.parentNode ?? (at instanceof ShadowRoot ? at.host : null);
      }

      return false;
    });

    if (focused !== true) throw failure("not-focused", "undispatched");
  };

  /** Sends under one dispatch, either to whatever has focus or to the one element that must. */
  const send = async (
    into: string | ObservedElement | undefined,
    ticket: Ticket,
    policy: AdmissionPolicy | undefined,
    keys: (page: Page) => Promise<void>,
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
        requireFocus,
        () => keys(page),
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
    sanitize(() =>
      send(
        into,
        ticket,
        policy,
        async (page) => {
          for (const character of text) {
            // A fence between characters stops the rest; what was already sent stays unknown.
            ticket.check();
            await page.keyboard.type(character);
          }
        },
        browserTarget,
      ),
    );

  return { press, type };
};
