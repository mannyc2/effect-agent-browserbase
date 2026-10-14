/** A consumer of the shipped public entry points, executed after a second bundler transforms it. */
import { Effect, Result } from "effect";
import { Browser, Chromium, Expect } from "effect-browser";

const form = `data:text/html,${encodeURIComponent(`<title>Bundled page</title>
<h1>Bundled page</h1><label>Note <input></label>
<button onclick="setTimeout(() => document.querySelector('#status').textContent = 'Saved', 50)">Save</button>
<p id="status" role="status">Waiting</p>`)}`;

export const run = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const browser = yield* Browser.Browser;
      const page = yield* browser.newPage(form);
      const snapshot = yield* page.snapshot();
      const buttons = yield* page.find({ role: "button", name: "Save" });
      const text = yield* page.text();
      const saving = yield* Expect.attempt(page, Expect.appeared({ text: "Saved" }));

      const outcome = yield* saving.run(page, (page) => page.click(buttons[0]?.ref ?? ""));

      yield* page.waitFor({ selector: "#status", text: "Saved" });
      yield* page.ready({ still: "foreground", quietMillis: 100, timeout: "5 seconds" });
      const saved = yield* page.text();

      yield* page.goto(
        `data:text/html,${encodeURIComponent(`<title>Moving pixels</title>
<canvas id="paint" width="800" height="400"></canvas><script>
const context = paint.getContext('2d');
context.fillStyle = 'rgb(255,0,0)'; context.fillRect(0, 0, 800, 400);
let green = false;
setInterval(() => { green = !green; context.fillStyle = green ? 'rgb(0,255,0)' : 'rgb(255,0,0)'; context.fillRect(0, 0, 800, 400); }, 50);
</script>`)}`,
      );

      const moving = yield* page
        .ready({ still: "foreground", quietMillis: 300, timeout: "1200 millis" })
        .pipe(Effect.result);

      // The registered source must also work from the start of the next document.
      yield* page.goto("data:text/html,<title>Next document</title><h1>Next document</h1>");
      const next = yield* page.snapshot();

      yield* page.ready({ still: "foreground", quietMillis: 100, timeout: "5 seconds" });

      return {
        outline: snapshot.text,
        controls: snapshot.controls.map(({ name }) => name),
        found: buttons.map(({ subject }) => subject.name),
        text: text.text,
        outcome,
        saved: saved.text,
        moving: Result.isFailure(moving) ? moving.failure.reason._tag : "Ready",
        next: next.text,
      };
    }).pipe(Effect.provide(Chromium.layer()), Effect.scoped),
  );
