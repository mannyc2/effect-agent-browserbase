import { Result } from "effect";
import type { CDPSession, ElementHandle, Page } from "playwright-core";

import type { KeyModifier } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { DriverTarget, ElementTarget } from "./Driver.ts";
import type { ElementAccess } from "./ElementAccess.ts";
import { failure, sanitize } from "./NativeCalls.ts";
import {
  isPerformed,
  ownerPacing,
  type PerformedTicket,
  roundTripOf,
  timedRoundTrip,
} from "./NativePacing.ts";
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

/** Performed text holds Shift for uppercase and shifted punctuation, as a person would. */
const heldModifiers = (
  key: string,
  modifiers: ReadonlyArray<KeyModifier>,
  typed: boolean,
): ReadonlyArray<KeyModifier> =>
  typed && /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/u.test(key) && !modifiers.includes("Shift")
    ? [...modifiers, "Shift"]
    : modifiers;

const nanos = (milliseconds: number) => BigInt(Math.round(milliseconds * 1e6));

/** The commands a stroke submits: inserted text, or its key and held modifiers down and up. */
const commandsOf = (stroke: Stroke, modifiers: ReadonlyArray<KeyModifier>, typed: boolean) =>
  keyDescription(stroke.key) === undefined
    ? 1
    : 2 * (1 + heldModifiers(stroke.key, modifiers, typed).length);

/**
 * The measured pace of one performed key run. Strokes start at their absolute schedule offsets,
 * and each key is held from its key-down's submission. Before a stroke's first command, the rest
 * of the schedule must still fit the original deadline at the pace the browser has kept, so a
 * stroke that could not finish is refused whole, never cut between a key and its release.
 *
 * A stroke's commands share their round trip, but a renderer handles them one at a time. So a
 * stroke is charged its hold and the drain, from its last submission to its last reply, of
 * strokes with as many commands. More commands never finish sooner: a larger stroke's drain
 * bounds a smaller one's, and a smaller one's is scaled up by command count, which overcharges
 * latency only until a stroke of this size has drained. The next stroke is charged their mean
 * drain. Every later one is charged their fastest once two have drained, and the Page's fastest
 * round trip before that, so a renderer that is slow for every stroke refuses the run early,
 * while one stalled reply cannot refuse the strokes after it when the run still has time.
 */
const makePace = (
  pacing: ReturnType<typeof ownerPacing>,
  page: object,
  strokes: ReadonlyArray<Stroke>,
  started: bigint,
  focus: boolean,
  modifiers: ReadonlyArray<KeyModifier>,
  typed: boolean,
) => {
  const drained = new Map<number, { total: bigint; fastest: bigint; count: number }>();

  /** The nearest measured stroke size's drains, scaled to `commands`, in milliseconds. */
  const measured = (commands: number) => {
    let bound: number | undefined;
    let below: number | undefined;

    for (const size of drained.keys()) {
      if (size >= commands && (bound === undefined || size < bound)) bound = size;
      if (size < commands && (below === undefined || size > below)) below = size;
    }
    const size = bound ?? below;
    const drains = size === undefined ? undefined : drained.get(size);

    if (size === undefined || drains === undefined) return undefined;
    const scale = (size < commands ? commands / size : 1) / 1e6;

    return {
      mean: Number(drains.total / BigInt(drains.count)) * scale,
      fastest: Number(drains.fastest) * scale,
      count: drains.count,
    };
  };

  return {
    observeDrain: (commands: number, nanos: bigint) => {
      const drains = drained.get(commands);

      if (drains === undefined) drained.set(commands, { total: nanos, fastest: nanos, count: 1 });
      else {
        drains.total += nanos;
        if (nanos < drains.fastest) drains.fastest = nanos;
        drains.count++;
      }
    },
    /** Called after stroke `from`'s focus check, before its first command. */
    require: (from: number) => {
      const roundTrip = roundTripOf(page);
      let at = Number(pacing.now() - started) / 1e6;

      for (let index = from; index < strokes.length; index++) {
        const stroke = strokes[index];

        if (stroke === undefined) break;
        const commands = commandsOf(stroke, modifiers, typed);
        const drains = measured(commands);

        // This stroke has already paid for its focus check; a later one pays at least a round trip.
        const down =
          Math.max(at, stroke.offsetMillis) + (index === from || !focus ? 0 : roundTrip.fastest);

        // Before any stroke has drained, the Page's round trips are the best estimate there is.
        const drain =
          index === from
            ? (drains?.mean ?? roundTrip.typical * Math.max(1, commands / 2))
            : drains !== undefined && drains.count >= 2
              ? drains.fastest
              : roundTrip.fastest;

        // A key's releases are submitted once it has been held; inserted text holds after it lands.
        at =
          keyDescription(stroke.key) === undefined
            ? down + Math.max(drain, stroke.holdMillis)
            : down + stroke.holdMillis + drain;
      }
      pacing.requireBy(started + nanos(at));
    },
  };
};

/**
 * Native commands submitted in order without awaiting each reply, as one burst the caller drains.
 * Every reply is observed as it arrives, including a rejection after a refusal. Once a command or
 * a fence has failed, nothing more is sent and nothing is repaired; draining waits for every
 * command already submitted and then fails with the first failure.
 */
const makeBurst = (ticket: Ticket) => {
  const pending: Array<Promise<void>> = [];
  let failed = false;
  let firstFailure: unknown;

  const reject = (error: unknown) => {
    if (!failed) {
      failed = true;
      firstFailure = error;
    }
  };

  return {
    /** `fence` decides whether this command may still be sent; the ticket's own check always runs. */
    submit: (fence: () => void, command: () => Promise<unknown>) => {
      if (failed) throw firstFailure;
      fence();
      ticket.dispatch();
      pending.push(command().then(() => {}, reject));
    },
    reject,
    /** Resolves with the number of replies once every one arrived, or fails with the first failure. */
    drain: async () => {
      await Promise.all(pending);
      if (failed) throw firstFailure;

      return pending.length;
    },
  };
};

/** At most sixteen complete strokes / thirty-two replies live at once. */
const typeWindow = async (port: CDPSession, characters: ReadonlyArray<string>, ticket: Ticket) => {
  const burst = makeBurst(ticket);
  const fence = () => ticket.check();

  try {
    for (const key of characters) {
      const description = keyDescription(key);

      if (description === undefined)
        burst.submit(fence, () => port.send("Input.insertText", { text: key }));
      else {
        const { code, keyCode } = description;

        burst.submit(fence, () =>
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
        burst.submit(fence, () =>
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
    burst.reject(error);
  }
  await burst.drain();
  ticket.acknowledge?.();
};

/**
 * Real key input to the exact target page. Every stroke is one the browser would receive from a
 * keyboard, so handlers see trusted `keydown` and `keyup`, and the browser itself decides what
 * has focus. Nothing here focuses, paces or retries: a caller that wants a cadence sends its keys.
 */
export const makeKeyboard = (
  targets: Targets,
  elements: ElementAccess,
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
  const requireFocus = async (element: ElementHandle<Element>): Promise<void> => {
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

    // Nothing more is sent; the owner keeps whatever earlier input it acknowledged.
    if (focused !== true) throw failure(Reasons.NotFocused.make({}), "undispatched");
  };

  const planKeys = (text: string, ticket: PerformedTicket): KeySchedule => {
    const { performance } = ticket;
    const planned = keySchedule(performance.plan, text, performance.fieldIndex);

    if (Result.isFailure(planned)) throw planned.failure;

    return planned.success;
  };

  const prepareKeys = (text: string, ticket: PerformedTicket): KeySchedule => {
    const schedule = planKeys(text, ticket);

    ownerPacing(ticket).requireDuration(schedule.durationMillis);

    return schedule;
  };

  /**
   * One paired native stroke remains unresolved until its key and modifiers are all released.
   * Playwright's own keyboard builds each event, so a performed stroke carries exactly what a
   * plain `press` sends, including the editing commands Chromium on macOS needs for Backspace,
   * Delete, the arrows, Home and End. Like plain typing's windows, a stroke submits its commands
   * in order without waiting for each reply, so a key is held for its planned time rather than for
   * its key-down's round trip, and a held modifier adds no round trip of its own. A stroke has at
   * most ten replies outstanding, its key and up to four modifiers each down and up, and drains
   * them all before it resolves.
   */
  const pacedStroke = async (
    page: Page,
    stroke: Stroke,
    ticket: PerformedTicket,
    check: () => void,
    pace: ReturnType<typeof makePace>,
    index: number,
    element?: ElementHandle<Element>,
    modifiers: ReadonlyArray<KeyModifier> = [],
    typed = true,
  ) => {
    const pacing = ownerPacing(ticket);
    const { keyboard } = page;

    pacing.requireDuration(stroke.holdMillis);
    // Focus is required once, before the stroke's first command. The key's own default action
    // may move it, or replace the document (Tab, an Enter that submits, an auto-advancing
    // field), and the releases still belong to this stroke: like plain typing's, they are fenced
    // by the ticket alone, never by the element or the document the key was sent to.
    check();
    if (element !== undefined) await timedRoundTrip(page, pacing.now, () => requireFocus(element));
    check();
    pace.require(index);

    const burst = makeBurst(ticket);
    const release = () => ticket.check();
    let submitted = pacing.now();

    const submit = (fence: () => void, command: () => Promise<unknown>) => {
      burst.submit(fence, command);
      submitted = pacing.now();
    };

    const drain = async () => {
      const commands = await burst.drain();

      pace.observeDrain(commands, pacing.now() - submitted);
      ticket.acknowledge?.({ subphase: "key-burst", logicalComplete: false });
    };

    // A character the US layout cannot produce is committed as text, as plain typing does.
    if (keyDescription(stroke.key) === undefined) {
      const first = pacing.now();

      submit(check, () => keyboard.insertText(stroke.key));
      await drain();
      await pacing.pauseUntil(first + nanos(stroke.holdMillis));

      return;
    }
    const held = heldModifiers(stroke.key, modifiers, typed);

    try {
      for (const modifier of held) submit(check, () => keyboard.down(modifier));
      const down = pacing.now();

      submit(check, () => keyboard.down(stroke.key));
      // The hold runs from the key-down's submission, whether or not its reply has arrived.
      await pacing.pauseUntil(down + nanos(stroke.holdMillis));
      submit(release, () => keyboard.up(stroke.key));
      for (const modifier of held.toReversed()) submit(release, () => keyboard.up(modifier));
    } catch (error) {
      burst.reject(error);
    }
    await drain();
  };

  const pacedKeys = async (
    page: Page,
    schedule: KeySchedule,
    ticket: PerformedTicket,
    check: () => void,
    element?: ElementHandle<Element>,
  ) => {
    const pacing = ownerPacing(ticket);

    pacing.requireDuration(schedule.durationMillis);
    const started = pacing.now();
    const pace = makePace(pacing, page, schedule.strokes, started, element !== undefined, [], true);

    for (const [index, stroke] of schedule.strokes.entries()) {
      check();
      // Absolute offsets: a slow reply delays the stroke after it, never every later one.
      await pacing.pauseUntil(started + nanos(stroke.offsetMillis));
      await pacedStroke(page, stroke, ticket, check, pace, index, element);
    }
  };

  /** Focus/select happens only for Fill, on its already admitted exact node. */
  const fillElement = (
    page: Page,
    element: ElementHandle<Element>,
    schedule: KeySchedule,
    ticket: PerformedTicket,
    check: () => void,
    readmit?: () => Promise<void>,
  ) =>
    withTypingPort(page, ticket, async () => {
      const pacing = ownerPacing(ticket);

      check();
      pacing.requireDuration(schedule.durationMillis);
      ticket.dispatch();
      await element.selectText({ timeout: ticket.remainingMillis() });
      ticket.acknowledge?.({ subphase: "focus", logicalComplete: false });
      await readmit?.();
      check();
      await timedRoundTrip(page, pacing.now, () => requireFocus(element));

      // The erase is a plain press, a key-down and a key-up each awaited, and every stroke must
      // fit before the old value goes.
      const erase = nanos(2 * roundTripOf(page).typical);

      makePace(pacing, page, schedule.strokes, pacing.now() + erase, true, [], true).require(0);
      check();
      ticket.dispatch();
      await page.keyboard.press("Backspace");
      ticket.acknowledge?.({ subphase: "key-burst", logicalComplete: false });
      if (schedule.strokes.length > 0) await readmit?.();
      check();
      await pacedKeys(page, schedule, ticket, check, element);
    });

  /** Sends under one dispatch, either to whatever has focus or to the one element that must. */
  const send = async (
    into: ElementTarget | undefined,
    ticket: Ticket,
    policy: AdmissionPolicy | undefined,
    keys: (page: Page, element?: ElementHandle<Element>, check?: () => void) => Promise<void>,
    browserTarget: DriverTarget,
  ): Promise<NativeInput> => {
    if (into !== undefined) browserTarget = elements.targetFor(into, browserTarget);
    const { page } = current(browserTarget).entry;

    if (into === undefined) {
      if (ticket.performance === undefined) ticket.dispatch();
      await keys(page, undefined, () => ticket.check());
      ticket.acknowledge?.();
      ticket.followUp?.();
    } else
      await elements.withAdmittedElement(
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
    policy: AdmissionPolicy | undefined,
    browserTarget: DriverTarget,
  ) =>
    sanitize(async () => {
      if (isPerformed(ticket)) {
        const performed = ticket;
        const schedule = planKeys(" ", performed);
        const planned = schedule.strokes[0];

        if (planned === undefined) throw failure(Reasons.Malformed.make({}), "undispatched");
        ownerPacing(performed).requireDuration(planned.holdMillis);
        if (into !== undefined) browserTarget = elements.targetFor(into, browserTarget);
        const { page } = current(browserTarget).entry;

        return withTypingPort(page, ticket, () =>
          send(
            into,
            ticket,
            policy,
            (_page, element, check) => {
              const stroke = { ...planned, key };
              const pacing = ownerPacing(performed);

              return pacedStroke(
                page,
                stroke,
                performed,
                check ?? (() => performed.check()),
                makePace(
                  pacing,
                  page,
                  [stroke],
                  pacing.now(),
                  element !== undefined,
                  modifiers,
                  false,
                ),
                0,
                element,
                modifiers,
                false,
              );
            },
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
    policy: AdmissionPolicy | undefined,
    browserTarget: DriverTarget,
  ) =>
    sanitize(async () => {
      if (into !== undefined) browserTarget = elements.targetFor(into, browserTarget);
      const { page } = current(browserTarget).entry;

      const performed = isPerformed(ticket)
        ? { ticket, schedule: prepareKeys(text, ticket) }
        : undefined;

      return withTypingPort(page, ticket, async (port) => {
        if (current(browserTarget).entry.page !== page)
          throw failure(Reasons.Stale.make({}), "undispatched");

        return send(
          into,
          ticket,
          policy,
          async (_page, element, check) => {
            if (performed !== undefined) {
              await pacedKeys(
                page,
                performed.schedule,
                performed.ticket,
                check ?? (() => ticket.check()),
                element,
              );

              return;
            }
            const characters = [...text];

            for (let start = 0; start < characters.length; start += 16) {
              ticket.check();
              if (start > 0 && element !== undefined) {
                // Keep the exact admitted node; resolving a selector again could redirect input.
                await requireFocus(element);
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
    /** A typing slot on a `quarantined` page waits for its operator, not for a handoff drain. */
    drained: (quarantined: (page: Page) => boolean = () => false) =>
      [...typing].every(([page, slot]) => slot.idle !== undefined || quarantined(page)),
  };
};
