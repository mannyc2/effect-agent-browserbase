/** Derive replay steps from typed action events without parsing rendered descriptions. */
import { targetOf } from "../Action.ts";
import { type Action, type BrowserEvent, type Navigated } from "../BrowserEvent.ts";
import { redacted } from "../Page.ts";
import { Plan, Step } from "./data.ts";

const isStep = (
  event: BrowserEvent,
): event is Action & {
  readonly value: Exclude<Action["value"], { readonly _tag: "Act" }>;
} => event._tag === "Action" && event.ok && event.value._tag !== "Act";

/** A slot named for the field it fills, such as `email`, unique within the plan. */
const slotFor = (taken: Set<string>, field: string | undefined) => {
  const base =
    field
      ?.toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join("-") ?? "input";

  let slot = base;

  for (let count = 2; taken.has(slot); count++) slot = `${base}-${count}`;
  taken.add(slot);

  return slot;
};

/**
 * The walk one page's events record: the completed actions of the page that acted first, in
 * order. `page.recentEvents` gives them, or `browser.events()` read until the walk ends.
 */
export const fromEvents = (events: Iterable<BrowserEvent>): Plan => {
  const all = Array.from(events);
  const page = all.find((event) => event._tag === "Action")?.page;
  const mine = all.filter((event) => "page" in event && event.page === page);
  const steps = mine.filter(isStep);
  const opened = mine.find((event) => event._tag === "PageOpened")?.url ?? "";
  const moves = mine.filter((event): event is Navigated => event._tag === "Navigated");
  const taken = new Set<string>();

  // Where the page was just before a time: the last address it reached by then.
  const before = (time: number) => moves.findLast((move) => move.at <= time)?.url ?? opened;

  return new Plan({
    version: 3,
    steps: steps.map((action, index) => {
      const value = action.value;

      const target = targetOf(value);
      const point = typeof target === "object" ? target : undefined;
      const until = steps[index + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
      const arrival = moves.findLast((move) => move.at > action.at && move.at <= until);

      // Refs are rebound from subjects at replay; typed text is replaced by a caller input slot.
      return new Step({
        action: value._tag === "Type" ? { ...value, text: "" } : value,
        url: arrival?.url ?? action.url ?? before(until),
        subject: action.subject,
        to: action.to,
        box: point === undefined ? undefined : action.box,
        input:
          value._tag === "Type"
            ? slotFor(taken, action.subject?.name)
            : value._tag === "Goto" && value.url.includes(redacted)
              ? slotFor(taken, "address")
              : undefined,
      });
    }),
  });
};
