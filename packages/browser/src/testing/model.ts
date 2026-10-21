/** Seeded structure, without a DOM, layout engine, page scripts or inferred browser effects. */
import { Effect } from "effect";

import {
  Closed,
  type BrowserError,
  InvalidRequest,
  StaleRef,
  undispatched,
} from "../BrowserError.ts";
import type { Box, Subject, DisconnectCause } from "../BrowserEvent.ts";
import type { Frame } from "../Frame.ts";
import type { Sample, Shown, Track } from "../internal/timeline/fold.inpage.ts";
import { match, request } from "../Matching.ts";
import { Found, type ElementState, type FindQuery } from "../Page.ts";
import { Control, Snapshot, type SnapshotOptions } from "../Snapshot.ts";
import * as Url from "../Url.ts";

/** Unsupported browser mechanics stay typed failures instead of inferred successes. */
export const unsupported = (operation: string) =>
  Effect.fail(
    undispatched(
      operation,
      new InvalidRequest({
        detail: "TestPage requires explicit data; browser mechanics are not simulated",
      }),
    ),
  );

export interface Element {
  readonly key: string;
  readonly subject: Subject;
  readonly state?: Partial<ElementState>;
  readonly text?: string;
  readonly box: Box;
  readonly visible?: boolean;
  readonly inViewport?: boolean;
  readonly editable?: boolean;
  readonly secret?: boolean;
  readonly value?: string;
}

export interface ChangeTrack {
  readonly subject: Subject;
  readonly kind: Track["kind"];
  readonly initial: Shown;
  readonly known: number;
  readonly samples: ReadonlyArray<Sample>;
  readonly secret?: boolean;
}

export interface Seed {
  readonly frames?: ReadonlyArray<Frame>;
  readonly changes?: ReadonlyArray<ChangeTrack>;
  readonly ready?: boolean;
  readonly url?: string;
  readonly title?: string;
  readonly elements?: ReadonlyArray<Element>;
  readonly viewport?: { readonly width: number; readonly height: number };
}

export const make = (seed: Seed, closedBy?: () => DisconnectCause | undefined) => {
  let current = { ...seed, url: Url.redact(seed.url ?? "about:blank") };
  let document = 0;
  let next = 0;
  let life: "Open" | "Closed" = "Open";
  const refs = new Map<string, string>();
  const matching = match();

  const ref = (element: Element): string => {
    const existing = refs.get(element.key);

    if (existing !== undefined) return existing;
    const added = `e${++next}`;

    refs.set(element.key, added);

    return added;
  };

  const check = (operation: string): Effect.Effect<void, BrowserError> =>
    Effect.suspend(() =>
      life === "Open" && closedBy?.() === undefined
        ? Effect.void
        : Effect.fail(undispatched(operation, new Closed({ cause: closedBy?.() ?? "page" }))),
    );

  const find = (query: FindQuery = {}) => {
    const asked = request(query, "viewport");
    const matches = matching.compile(asked);

    return (current.elements ?? [])
      .filter(
        (element) =>
          element.visible !== false &&
          (asked.scope === "document" || element.inViewport !== false) &&
          (asked.state !== "enabled" || !element.state?.disabled) &&
          (query.at === undefined ||
            (query.at.x >= element.box.x &&
              query.at.x <= element.box.x + element.box.width &&
              query.at.y >= element.box.y &&
              query.at.y <= element.box.y + element.box.height)) &&
          matches({
            role: element.subject.role,
            name: () => element.subject.name,
            text: () => element.text ?? element.subject.name,
            context: () => element.subject.context,
          }),
      )
      .map(
        (element) =>
          new Found({
            ref: ref(element),
            subject: element.subject,
            box: element.box,
            inViewport: element.inViewport !== false,
            state: { disabled: false, focused: false, ...element.state },
          }),
      );
  };

  const resolve = (target: string | { readonly x: number; readonly y: number }) =>
    Effect.suspend(() => {
      const element = (current.elements ?? []).find((element) =>
        typeof target === "string"
          ? refs.get(element.key) === target
          : target.x >= element.box.x &&
            target.x <= element.box.x + element.box.width &&
            target.y >= element.box.y &&
            target.y <= element.box.y + element.box.height,
      );

      return element === undefined
        ? Effect.fail(
            undispatched(
              "input",
              typeof target === "string"
                ? new StaleRef({ ref: target })
                : new InvalidRequest({ detail: "the seeded point has no element" }),
            ),
          )
        : Effect.succeed({ element, ref: ref(element), subject: element.subject });
    });

  const snapshot = (options: SnapshotOptions = {}) => {
    const elements = (current.elements ?? []).filter(
      (element) => element.visible !== false && (options.full || element.inViewport !== false),
    );

    const controls = elements.map(
      (element) =>
        new Control({
          ref: ref(element),
          kind: element.subject.role ?? "clickable",
          name: element.subject.name,
          value: element.secret ? "••••" : (element.value ?? ""),
          disabled: element.state?.disabled,
          checked: element.state?.checked,
          editable: element.editable,
        }),
    );

    const text = elements
      .map((element) => element.text ?? element.subject.name)
      .filter(
        (text) =>
          options.query === undefined ||
          matching.normalize(text).includes(matching.normalize(options.query)),
      )
      .join("\n");

    const viewport = current.viewport ?? { width: 800, height: 600 };

    return new Snapshot({
      url: current.url ?? "about:blank",
      title: current.title ?? "",
      text: text.slice(0, options.maxChars ?? 12000),
      truncated: text.length > (options.maxChars ?? 12000),
      above: 0,
      below: 0,
      viewport,
      scroll: { y: 0, height: viewport.height },
      controls,
    });
  };

  return {
    find,
    resolve,
    snapshot,
    mark: (found: ReadonlyArray<Found>) =>
      matching.mark(
        found.map((one) => {
          const element = current.elements?.find((element) => refs.get(element.key) === one.ref);
          const { focused: _focused, ...state } = one.state;

          return `${element?.text ?? element?.subject.name ?? ""}\u0000${element?.value ?? ""}\u0000${JSON.stringify(state)}\u0001`;
        }),
      ),
    check,
    get: () => current,
    document: () => document,
    update: (seed: Seed, replace = false) => {
      current = {
        ...(replace ? seed : { ...current, ...seed }),
        url: Url.redact(seed.url ?? (replace ? "about:blank" : current.url)),
      };
      if (replace) {
        document += 1;
        refs.clear();
      }
    },
    isClosed: () => life === "Closed" || closedBy?.() !== undefined,
    close: () => {
      const wasOpen = life === "Open";

      life = "Closed";

      return wasOpen;
    },
  };
};
