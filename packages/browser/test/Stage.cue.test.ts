// Native capture ownership and event-time commits, including a deliberately withheld new paint.
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Option, Schedule, Scope, Stream } from "effect";

import { Browser } from "../src/Browser.ts";
import { Closed, consequence } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Frame } from "../src/Frame.ts";
import * as Stage from "../src/Stage.ts";

const animated = `data:text/html,${encodeURIComponent(`<canvas id=c width=200 height=200></canvas><script>
const g=c.getContext('2d'); (function draw(t){g.fillStyle='hsl('+t%360+',80%,50%)';g.fillRect(0,0,200,200);requestAnimationFrame(draw)})(0)
</script>`)}`;

const eventually = (check: Effect.Effect<boolean>) =>
  check.pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("10 seconds"),
  );

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Stage cues",
  (it) => {
    // #282: a prepared still page must enter the output at the cut, preserving its older capture.
    it.effect("stamps the output time of a prepared reveal independently of capture time", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const onAir = yield* browser.newPage(animated);
        const revealed = yield* browser.newPage("data:text/html,<h1>Prepared reveal</h1>");
        const stage = yield* Stage.make();
        const seen: Array<Stage.Shown> = [];
        const frames: Array<Frame> = [];

        yield* stage.shown({ hold: "100 millis" }).pipe(
          Stream.runForEach((value) => Effect.sync(() => void seen.push(value))),
          Effect.forkScoped,
        );
        yield* stage.frames.pipe(
          Stream.runForEach((frame) => Effect.sync(() => void frames.push(frame))),
          Effect.forkScoped,
        );
        const initial = yield* stage.present(onAir);
        const cue = yield* stage.cue(revealed);

        yield* cue.ready;
        yield* Effect.sleep("300 millis");
        const presented = yield* cue.commit();

        yield* eventually(
          Effect.sync(() =>
            seen.some((value) => value._tag === "Still" && value.frame.page === revealed.id),
          ),
        );
        const paints = seen.filter((value) => value._tag === "Painted");
        const first = paints.find((value) => value.frame.page === revealed.id);
        const outgoing = paints.filter((value) => value.frame.page === onAir.id);

        assert.strictEqual(outgoing[0]?.at, initial.at);
        assert.isAtLeast(outgoing.length, 3);
        assert.strictEqual(first?.at, presented.at);
        assert.isBelow(first?.frame.hostTime ?? Infinity, outgoing.at(-1)?.frame.hostTime ?? 0);
        assert.strictEqual(
          frames.find((frame) => frame.page === revealed.id),
          first?.frame,
        );
        for (let index = 1; index < seen.length; index++) {
          const current = seen[index];
          const previous = seen[index - 1];

          assert.isAtLeast(current?.at ?? -Infinity, previous?.at ?? Infinity);
          if (
            current?._tag === "Painted" &&
            current.frame.page === onAir.id &&
            current.frame.hostTime >= (previous?.at ?? Infinity)
          )
            assert.strictEqual(current.at, current.frame.hostTime);
        }
      }),
    );

    it.effect("warms now and transfers capture ownership only when its event commits", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const page = yield* browser.newPage(animated);
        const stage = yield* Stage.make();
        const owner = yield* Scope.fork(yield* Effect.scope);
        const cue = yield* stage.cue(page).pipe(Scope.provide(owner));

        yield* cue.ready;
        assert.isTrue(Option.isNone(yield* stage.current));
        const sentAt = yield* browser.now;
        const presented = yield* cue.commit({ at: sentAt });

        assert.isAtLeast(presented.at, sentAt);
        yield* Scope.close(owner, Exit.void);
        const frame = yield* stage.frames.pipe(Stream.runHead, Effect.timeout("5 seconds"));

        assert.strictEqual(Option.getOrThrow(frame).page, page.id);
        assert.deepStrictEqual(yield* stage.current, Option.some(page));
      }),
    );

    it.effect("an interrupted commit leaves output unchanged and its cue can commit later", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const first = yield* browser.newPage(animated);
        const second = yield* browser.newPage(animated);
        const stage = yield* Stage.make();

        yield* stage.present(first);
        const cue = yield* stage.cue(second);

        yield* cue.ready;
        const at = (yield* browser.now) + 1000;
        const committing = yield* cue.commit({ at }).pipe(Effect.forkScoped);

        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(committing);
        assert.deepStrictEqual(yield* stage.current, Option.some(first));
        yield* cue.commit();
        assert.deepStrictEqual(yield* stage.current, Option.some(second));
      }),
    );

    // #284: giving up a cue must not tell its consumer that a healthy session was lost.
    it.effect("closing an uncommitted cue stops capture without reporting a lost session", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const onAir = yield* browser.newPage("data:text/html,<title>On air</title>");
        const page = yield* browser.newPage(animated);
        const stage = yield* Stage.make();

        yield* stage.present(onAir);
        const closing = yield* browser.newPage("data:text/html,<title>Closing</title>");
        const closingCue = yield* stage.cue(closing);

        yield* closing.close;
        const pageGone = yield* Effect.flip(closingCue.commit());

        assert.deepStrictEqual(pageGone.reason, new Closed({ cause: "page" }));
        assert.deepStrictEqual(consequence(pageGone), { lost: "page", repeat: "safe" });
        const owner = yield* Scope.fork(yield* Effect.scope);
        const cue = yield* stage.cue(page).pipe(Scope.provide(owner));

        yield* cue.ready;
        yield* Scope.close(owner, Exit.void);
        yield* Effect.sleep("100 millis");
        const before = yield* page.captureStats();

        yield* Effect.sleep("200 millis");
        assert.strictEqual((yield* page.captureStats()).received, before.received);
        const failure = yield* Effect.flip(cue.commit());

        assert.deepStrictEqual(yield* stage.current, Option.some(onAir));
        assert.strictEqual(yield* onAir.title, "On air");
        assert.strictEqual((yield* stage.present(page)).page, page.id);
        assert.deepStrictEqual(consequence(failure), { lost: "nothing", repeat: "pointless" });
        assert.notInclude(failure.message, "browser was released");
        assert.isFalse(failure.dispatched);
      }),
    );

    it.effect("a prepared frame cannot commit after its document changes without a new frame", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        let withheld = false;
        const create = browser.context.newCDPSession.bind(browser.context);

        browser.context.newCDPSession = async (target) => {
          const cdp = await create(target);

          const emitter = cdp as unknown as {
            emit: (event: string, ...args: Array<unknown>) => boolean;
          };

          const emit = emitter.emit.bind(emitter);

          emitter.emit = (event, ...args) => {
            if (event !== "Page.screencastFrame" || !withheld) return emit(event, ...args);
            const [frame] = args as [{ readonly sessionId: number }];

            // Withhold delivery at the native boundary while allowing Chromium to keep painting.
            void cdp
              .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
              .catch(() => undefined);

            return true;
          };

          return cdp;
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            browser.context.newCDPSession = create;
          }),
        );
        const watched = yield* browser.newPage(animated);

        const stage = yield* Stage.make({ firstFrame: "500 millis" });
        const cue = yield* stage.cue(watched);

        yield* cue.ready;
        withheld = true;
        yield* watched.goto(`${animated}#new`);
        yield* watched.reload;
        const failure = yield* Effect.flip(cue.commit());

        assert.strictEqual(failure.reason._tag, "Timeout");
        assert.isTrue(Option.isNone(yield* stage.current));
        withheld = false;
        yield* cue.commit();
        assert.deepStrictEqual(yield* stage.current, Option.some(watched));
      }),
    );

    it.effect("confirms still paint, emits Gone once on close, then observes the next commit", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const page = yield* browser.newPage("data:text/html,<h1>Still</h1>");
        const next = yield* browser.newPage("data:text/html,<h1>Next</h1>");
        const stage = yield* Stage.make();
        const seen: Array<Stage.Shown> = [];

        yield* stage.shown({ hold: "100 millis" }).pipe(
          Stream.runForEach((value) => Effect.sync(() => void seen.push(value))),
          Effect.forkScoped,
        );
        yield* stage.present(page);
        yield* eventually(Effect.sync(() => seen.some((value) => value._tag === "Still")));
        yield* page.close;
        yield* eventually(Effect.sync(() => seen.some((value) => value._tag === "Gone")));
        const goneAt = seen.length;

        yield* Effect.sleep("300 millis");
        assert.strictEqual(seen.length, goneAt);
        yield* stage.present(next);
        yield* eventually(
          Effect.sync(() =>
            seen.some((value) => value._tag === "Painted" && value.frame.page === next.id),
          ),
        );
      }),
    );
  },
);
