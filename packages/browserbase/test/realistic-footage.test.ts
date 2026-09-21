import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Random, Schema } from "effect";
import { InputReceipt, Target } from "effect-browserbase/browser-data";
import { type CapturedFrame, CaptureSummary } from "effect-browserbase/capture";
import { TestClock } from "effect/testing";

import { Cue, PollMillis, type Stage } from "../examples/realistic-footage/Cues.ts";
import { Director } from "../examples/realistic-footage/Director.ts";
import * as Humanize from "../examples/realistic-footage/Humanize.ts";
import * as Reel from "../examples/realistic-footage/Reel.ts";
import { Storyboard } from "../examples/realistic-footage/Storyboard.ts";
import { clockOffset, distribution, Telemetry } from "../examples/realistic-footage/Telemetry.ts";

const seeded = <A>(effect: Effect.Effect<A>, seed = "footage") =>
  Effect.runSync(effect.pipe(Random.withSeed(seed)));

const stage: Stage = {
  pointer: { x: 10, y: 10 },
  viewport: { width: 1280, height: 720 },
  scroll: { top: 0, maximumTop: 0 },
};

it("one seed performs one film: the same path, keys and scroll every time", () => {
  const performance = Effect.all([
    Humanize.pointerPath({ x: 40, y: 600 }, { x: 1100, y: 90 }, 32),
    Humanize.keystrokes("Sleep through the border"),
    Humanize.scrollTrack(0, 1400),
  ]);

  expect(seeded(performance)).toEqual(seeded(performance));
  expect(seeded(performance, "another")).not.toEqual(seeded(performance));
});

it("a pointer path ends on its target, never stalls in time and takes longer for harder reaches", () => {
  const to = { x: 1100, y: 90 };
  const path = seeded(Humanize.pointerPath({ x: 40, y: 600 }, to, 32));
  const last = path[path.length - 1]!;

  expect(last.x).toBeCloseTo(to.x, 6);
  expect(last.y).toBeCloseTo(to.y, 6);
  expect(
    path.every((point, index) => index === 0 || point.atMillis > path[index - 1]!.atMillis),
  ).toBe(true);
  // The cue schema is what the page will actually be sent.
  expect(Schema.is(Cue)({ _tag: "Glide", id: 1, path })).toBe(true);

  expect(Humanize.fittsMillis(800, 20)).toBeGreaterThan(Humanize.fittsMillis(800, 200));
  expect(Humanize.fittsMillis(800, 40)).toBeGreaterThan(Humanize.fittsMillis(100, 40));
});

it("a click is aimed inside the control and off its exact centre", () => {
  const box = { x: 100, y: 200, width: 240, height: 48 };

  for (const seed of ["a", "b", "c", "d", "e", "f"]) {
    const aim = seeded(Humanize.aimPoint(box), seed);

    expect(aim.x).toBeGreaterThanOrEqual(box.x + box.width * Humanize.Pointer.aimInset);
    expect(aim.x).toBeLessThanOrEqual(box.x + box.width * (1 - Humanize.Pointer.aimInset));
    expect(aim.y).toBeGreaterThanOrEqual(box.y + box.height * Humanize.Pointer.aimInset);
    expect(aim.y).toBeLessThanOrEqual(box.y + box.height * (1 - Humanize.Pointer.aimInset));
    expect(aim).not.toEqual({ x: 220, y: 224 });
  }
});

it("typing always arrives at the text, one key at a time, and a slip is taken back", () => {
  const text = "Where do you want to wake up";
  const careful = seeded(Humanize.keystrokes(text, { typoChance: 0 }));

  // A careful typist presses exactly the keys of the text, and never Backspace.
  expect(careful.map((stroke) => (stroke._tag === "Character" ? stroke.character : "⌫"))).toEqual(
    Array.from(text),
  );
  expect(careful.every((stroke) => stroke.afterMillis >= Humanize.Typing.floorMillis)).toBe(true);

  const clumsy = seeded(Humanize.keystrokes(text, { typoChance: 1 }));

  expect(Humanize.typedText(clumsy)).toBe(text);
  expect(clumsy.length).toBeGreaterThan(careful.length);

  // A slip is a wrong key, a Backspace once it is noticed, then the key that was meant.
  const takenBack = clumsy.flatMap((stroke, index) =>
    stroke._tag === "Backspace" ? [[clumsy[index - 1], clumsy[index + 1]] as const] : [],
  );

  expect(takenBack.length).toBeGreaterThan(0);
  for (const [slip, meant] of takenBack) {
    expect(slip?._tag).toBe("Character");
    expect(meant?._tag).toBe("Character");
    expect(slip).not.toEqual(meant);
  }
});

it("Shift is held for the keys a keyboard only produces with it", () => {
  for (const shifted of ["V", "Z", "!", "?", "_", '"'])
    expect(Humanize.needsShift(shifted)).toBe(true);
  // A space, a digit, a lower-case letter, and a capital no US key produces.
  for (const plain of ["v", "1", " ", "-", "É"]) expect(Humanize.needsShift(plain)).toBe(false);
});

it("a scroll is several eased flicks that land exactly, in either direction", () => {
  for (const [from, to] of [
    [0, 1400],
    [900, 120],
  ] as const) {
    const track = seeded(Humanize.scrollTrack(from, to));
    const direction = Math.sign(to - from);

    expect(track[track.length - 1]!.top).toBeCloseTo(to, 6);
    expect(
      track.every(
        (sample, index) => index === 0 || (sample.top - track[index - 1]!.top) * direction >= 0,
      ),
    ).toBe(true);
    // A pause between flicks shows as a gap longer than one display frame.
    expect(
      track.some((sample, index) => index > 0 && sample.atMillis - track[index - 1]!.atMillis > 60),
    ).toBe(true);
  }

  expect(seeded(Humanize.scrollTrack(300, 300))).toEqual([]);
});

it("the reel holds a still page and keeps only the newest picture in a slot", () => {
  const picture = (label: number) => new Uint8Array([label]);
  let reel: Reel.Reel | undefined;
  const film: Array<number> = [];

  // 30 fps: slots are 33⅓ms wide. Two frames share slot 0; then the page is still for a second.
  for (const [label, sourceTimeMillis] of [
    [1, 1_000],
    [2, 1_020],
    [3, 1_040],
    [4, 2_040],
  ] as const) {
    const [next, settled] = Reel.expose(reel, { bytes: picture(label), sourceTimeMillis }, 30);

    reel = next;
    film.push(...settled.map((bytes) => bytes[0]!));
  }
  film.push(...Reel.cut(reel, 500).map((bytes) => bytes[0]!));

  expect(film[0]).toBe(2);
  expect(film.filter((label) => label === 3)).toHaveLength(30);
  expect(film.filter((label) => label === 4)).toHaveLength(16);
  // 1,540ms of source time at thirty frames per second.
  expect(film).toHaveLength(47);
  expect(Reel.cut(undefined, 500)).toEqual([]);
});

it.effect("the director hands a cue over until it is answered, and idles a quiet poll", () =>
  Effect.gen(function* () {
    const director = yield* Director;

    const performing = yield* director
      .perform({ _tag: "Locate", selector: "#hold" })
      .pipe(Effect.forkChild);

    // A call left behind by a replaced document takes the cue without consuming it.
    const abandoned = yield* director.exchange({ _tag: "Waiting", stage });
    const delivered = yield* director.exchange({ _tag: "Waiting", stage });

    expect(abandoned).toEqual({ _tag: "Locate", id: 1, selector: "#hold" });
    expect(delivered).toEqual(abandoned);

    const polling = yield* director
      .exchange({ _tag: "Located", id: 1, box: { x: 0, y: 0, width: 80, height: 40 }, stage })
      .pipe(Effect.forkChild);

    expect((yield* Fiber.join(performing))._tag).toBe("Located");

    yield* TestClock.adjust(PollMillis);
    expect(yield* Fiber.join(polling)).toEqual({ _tag: "Idle" });
  }).pipe(Effect.provide(Director.layer)),
);

it.effect("a cue no page answers fails as a silent stagehand and is withdrawn", () =>
  Effect.gen(function* () {
    const director = yield* Director;

    const performing = yield* director
      .perform({ _tag: "Caption", text: "unanswered" })
      .pipe(Effect.flip, Effect.forkChild);

    yield* TestClock.adjust("30 seconds");
    expect((yield* Fiber.join(performing)).reason).toBe("stagehand-silent");

    const polling = yield* director.exchange({ _tag: "Waiting", stage }).pipe(Effect.forkChild);

    yield* TestClock.adjust(PollMillis);
    expect(yield* Fiber.join(polling)).toEqual({ _tag: "Idle" });
  }).pipe(Effect.provide(Director.layer)),
);

it("a storyboard is decoded before it is performed", () => {
  const accepts = Schema.is(Storyboard);

  expect(accepts([{ _tag: "Click", selector: "#hold" }])).toBe(true);
  expect(accepts([])).toBe(false);
  expect(accepts([{ _tag: "Click", selector: "" }])).toBe(false);
  expect(accepts([{ _tag: "Evaluate", script: "alert(1)" }])).toBe(false);
  // Typed text is held to the library's own rule: a line break would press Enter, so it is
  // refused while the storyboard is decoded rather than halfway through a film.
  expect(accepts([{ _tag: "Type", selector: "#q", text: "Venice" }])).toBe(true);
  expect(accepts([{ _tag: "Type", selector: "#q", text: "Venice\n" }])).toBe(false);
  expect(accepts([{ _tag: "Type", selector: "#q", text: "" }])).toBe(false);
});

it("two clocks are compared from the tightest exchange, and its round trip bounds the error", () => {
  // The browser's clock runs 250ms ahead of the host's. One exchange crossed a slow network.
  const exchange = (pageSentMillis: number, outbound: number, held: number, inbound: number) => ({
    pageSentMillis,
    hostReceivedMillis: pageSentMillis - 250 + outbound,
    hostRepliedMillis: pageSentMillis - 250 + outbound + held,
    pageReceivedMillis: pageSentMillis + outbound + held + inbound,
  });

  const measured = clockOffset([exchange(10_000, 40, 9_000, 90), exchange(20_000, 6, 3_000, 4)]);

  // A long-held poll costs nothing: only the time in flight counts as round trip.
  expect(measured).toEqual({ offsetMillis: -249, uncertaintyMillis: 5, samples: 2 });
  expect(Math.abs(-250 - measured!.offsetMillis)).toBeLessThanOrEqual(measured!.uncertaintyMillis);
  expect(clockOffset([])).toBeNull();
});

it("quantiles are nearest-rank, and nothing measured is reported as nothing", () => {
  expect(distribution([])).toBeNull();
  expect(distribution([5])).toEqual({ count: 1, p50: 5, p95: 5, p99: 5, max: 5 });
  expect(distribution(Array.from({ length: 100 }, (_, index) => 100 - index))).toEqual({
    count: 100,
    p50: 50,
    p95: 95,
    p99: 99,
    max: 100,
  });
});

it.effect("a completed action is timed, and a failed one stays the caller's failure", () =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;

    yield* telemetry.action("click", TestClock.adjust("40 millis"));
    const failed = yield* telemetry.action("fill", Effect.fail("stale" as const)).pipe(Effect.flip);

    const metrics = yield* telemetry.metrics;

    expect(failed).toBe("stale");
    expect(metrics.control.actionMillis.click).toMatchObject({ count: 1 });
    // Only completed actions have a duration; a failed one is the caller's error to report.
    expect(metrics.control.actionMillis.fill).toBeUndefined();
    // No frames and no clock comparison yet: latency is absent, not zero.
    expect(metrics.capture.latencyMillis).toBeNull();
    expect(metrics.capture.interval).toBeNull();
    // A film always has an opening document, and knows nothing about it until it is told.
    expect(metrics.documents).toEqual([
      { document: 0, url: null, committedAtMillis: null, heldMillis: null },
    ]);
  }).pipe(Effect.provide(Telemetry.layer)),
);

const target = Target.make({ generation: 0, pageId: "page-1", frameId: "frame-1" });

const frameAt = (document: number, sourceTimeMillis: number, sequence: number): CapturedFrame => ({
  bytes: new Uint8Array([255, 216, 255, 217]),
  mediaType: "image/jpeg",
  target,
  sequence,
  document,
  sourceTimeMillis,
  sourceClock: "presentation-unix-millis",
  receivedMonotonicNanos: BigInt(sequence) * 10_000_000n,
  width: 64,
  height: 48,
  viewportWidth: 64,
  viewportHeight: 48,
});

it.effect("native input is timed by its own receipt, not by the wait around it", () =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;

    const receipt = InputReceipt.make({
      target,
      kind: "type",
      position: null,
      startedMonotonicNanos: 5_000_000_000n,
      completedMonotonicNanos: 5_012_000_000n,
    });

    // Forty milliseconds pass waiting to be admitted; the native command itself took twelve.
    yield* telemetry.input("key", TestClock.adjust("40 millis").pipe(Effect.as(receipt)));
    const metrics = yield* telemetry.metrics;

    expect(metrics.control.inputMillis.key).toEqual({
      count: 1,
      p50: 12,
      p95: 12,
      p99: 12,
      max: 12,
    });
    expect(metrics.control.actionMillis.key).toBeUndefined();
  }).pipe(Effect.provide(Telemetry.layer)),
);

it.effect("each document gets the library's address and commit, and this layer's held time", () =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;

    yield* telemetry.frame(frameAt(0, 1_000, 0));
    yield* telemetry.frame(frameAt(0, 1_033, 1));
    // While the film runs, the frames alone say a second document began and how long it held.
    yield* telemetry.frame(frameAt(1, 1_203, 2));
    const during = yield* telemetry.metrics;

    expect(during.documents).toEqual([
      { document: 0, url: null, committedAtMillis: null, heldMillis: null },
      { document: 1, url: null, committedAtMillis: null, heldMillis: 170 },
    ]);
    // Pacing is measured inside a document, so the hold across a navigation is not counted twice.
    expect(during.capture.interFrameMillis).toMatchObject({ count: 1, max: 33 });

    yield* telemetry.captureEnded(
      CaptureSummary.make({
        target,
        reason: "stopped",
        received: 3,
        delivered: 3,
        dropped: 0,
        duplicates: 0,
        late: 0,
        peakBufferedFrames: 1,
        peakBufferedBytes: 4,
        bufferedFrames: 0,
        bufferedBytes: 0,
        sourceFirstMillis: 1_000,
        sourceLastMillis: 1_203,
        initialUrl: "https://rail.example/",
        documentBoundaries: [
          {
            document: 1,
            observedMonotonicNanos: 15_000_000n,
            afterSequence: 1,
            url: "https://rail.example/routes/vienna-venice",
          },
        ],
        documentBoundariesTruncated: false,
        nativeStop: "confirmed",
        upstreamDrops: "unknown",
      }),
    );
    const after = yield* telemetry.metrics;

    expect(after.documents.map((document) => document.url)).toEqual([
      "https://rail.example/",
      "https://rail.example/routes/vienna-venice",
    ]);
    expect(after.documents[0]?.committedAtMillis).toBeNull();
    expect(after.documents[1]?.committedAtMillis).not.toBeNull();
    expect(after.documents[1]?.heldMillis).toBe(170);
    expect(after.capture.interval).toMatchObject({ reason: "stopped", dropped: 0 });
  }).pipe(Effect.provide(Telemetry.layer)),
);
