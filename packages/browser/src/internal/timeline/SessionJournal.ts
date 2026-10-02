import { Effect, Result, Schema, Stream } from "effect";

import type { PageStatus } from "../../Browser.ts";
import type { Timeline } from "../../Timeline.ts";
import {
  PagesInventory,
  TimelineLimit,
  TimelineMalformed,
  type CachedPage,
  type Event,
  type PageEvent,
  type Terminal,
  type TimelineError,
} from "../../TimelineData.ts";
import type { NativeCachedPage } from "../browser/Driver.ts";
import type { makeStore, Subscription, View } from "./Store.ts";

type Store = ReturnType<typeof makeStore>;

interface Attachment {
  readonly inventory: PagesInventory;
  readonly subscription: Subscription;
}

const decodeInventory = Schema.decodeResult(PagesInventory);

const lifecycle = (value: Event): boolean => {
  switch (value.event._tag) {
    case "Lifecycle":
    case "PageOpened":
    case "PageClosed":
    case "DisplayChanged":
    case "MetadataChanged":
    case "Navigated":
    case "Terminal":
    case "MetadataOmitted":
      return true;
    case "Planned":
    case "Prepared":
    case "Dispatched":
    case "Acknowledged":
    case "FollowUp":
    case "Pointer":
    case "Press":
    case "Keys":
    case "Scroll":
    case "Glide":
    case "FirstFrame":
    case "Capture":
    case "CaptureBoundary":
    case "Picture":
    case "Settled":
    case "Contained":
    case "Failed":
    case "Cancelled":
      return false;
  }
};

const viewTimeline = (store: Store, view?: View): Timeline => ({
  snapshot: (options) => store.snapshot(options, view),
  events: (from) =>
    Stream.unwrap(
      store
        .subscribe({
          ...(from === undefined ? {} : { from }),
          ...(view === undefined ? {} : { view }),
        })
        .pipe(Effect.map((subscription) => Stream.fromPull(Effect.succeed(subscription.pull)))),
    ),
  now: Effect.sync(store.now),
});

/** The original registry and one journal attach atomically; no metadata refresh issues authority. */
export const makeJournal = (configuration: {
  readonly store: () => Store;
  readonly cachedPages: () => ReadonlyArray<NativeCachedPage>;
  readonly pageStatus: (pageId: string) => Pick<PageStatus, "phase" | "containment"> | undefined;
  readonly generation: () => number;
}) => {
  const timeline: Timeline = {
    snapshot: (options) => Effect.suspend(() => configuration.store().snapshot(options)),
    events: (from) => Stream.suspend(() => viewTimeline(configuration.store()).events(from)),
    now: Effect.sync(() => configuration.store().now()),
  };

  const forPage = (
    store: Store,
    pageId: string,
    generation: number,
    terminal: () => Terminal | null,
  ): Timeline => viewTimeline(store, { pageId, generation, terminal });

  const attachInventory = (): Result.Result<Attachment, TimelineError> => {
    const store = configuration.store();
    const native = configuration.cachedPages();

    if (native.length > 32)
      return Result.fail(new TimelineLimit({ maximum: 32, observed: native.length }));
    const generation = configuration.generation();

    const pages: CachedPage[] = native.map((page) => {
      const status = configuration.pageStatus(page.pageId);
      const urlOmitted = page.url !== null && page.url.length > 8192;
      const titleOmitted = page.title !== null && page.title.length > 512;

      return {
        identity: {
          generation,
          pageId: page.pageId,
          frameId: page.frameId,
          document: page.documentEpoch,
        },
        targetId: page.targetId,
        url: urlOmitted ? null : page.url,
        urlQualification: urlOmitted
          ? "Omitted"
          : page.url === null && page.urlQualification !== "Omitted"
            ? "Unread"
            : page.urlQualification,
        title: titleOmitted ? null : page.title,
        titleQualification: titleOmitted
          ? "Omitted"
          : page.title === null && page.titleQualification === "ObservedCached"
            ? "Unread"
            : page.titleQualification,
        selected: page.selected,
        displayState: page.displayState === "suspended" ? "held" : page.displayState,
        phase: status?.phase ?? (page.displayState === "suspended" ? "paused" : "open"),
        containment: status?.containment ?? { _tag: "NotRequired" },
      };
    });

    const decoded = decodeInventory(
      { _tag: "Inventory", pages, resumeAfter: store.cursor() },
      { onExcessProperty: "error" },
    );

    if (Result.isFailure(decoded)) return Result.fail(new TimelineMalformed({ path: "Inventory" }));
    const inventory = decoded.success;

    for (const page of inventory.pages) {
      Object.freeze(page.identity);
      Object.freeze(page.containment);
      Object.freeze(page);
    }
    Object.freeze(inventory.pages);
    Object.freeze(inventory.resumeAfter);
    Object.freeze(inventory);
    const attached = store.attach({ from: inventory.resumeAfter });

    return Result.isFailure(attached)
      ? Result.fail(attached.failure)
      : Result.succeed({ inventory, subscription: attached.success });
  };

  const acquire = Effect.sync(attachInventory).pipe(Effect.flatMap(Effect.fromResult));

  const pageEvents: Stream.Stream<PageEvent, TimelineError> = Stream.unwrap(
    Effect.acquireRelease(acquire, (value) => Effect.sync(value.subscription.release)).pipe(
      Effect.map(({ inventory, subscription }) =>
        Stream.concat(
          Stream.succeed(inventory),
          Stream.fromPull(Effect.succeed(subscription.pull)).pipe(Stream.filter(lifecycle)),
        ),
      ),
    ),
  );

  return { timeline, forPage, pageEvents };
};
