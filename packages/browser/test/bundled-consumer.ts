/** A consumer of the shipped public entry points, executed after a second bundler transforms it. */
import { Effect, Result } from "effect";
import { Browser } from "effect-browser";
import { Subject } from "effect-browser/BrowserEvent";
import * as Chromium from "effect-browser/Chromium";
import * as Stillness from "effect-browser/Stillness";
import { TestPage } from "effect-browser/testing";

const form = `data:text/html,${encodeURIComponent(`<title>Bundled page</title>
<h1>Bundled page</h1><label>Note <input id="note"></label>
<label>Choice <select><option>A</option><option>B</option></select></label>
<fieldset disabled><legend><button>Legend</button></legend><button>Blocked</button><input aria-label="Blocked field"></fieldset>
<label>Color <input type="color"></label><label>File <input type="file"></label>
<button onclick="setTimeout(() => document.querySelector('#status').textContent = 'Saved', 50)">Save</button>
<p id="status" role="status">Waiting</p>`)}`;

export const run = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const seeded = yield* TestPage.make({
        elements: [
          {
            key: "save",
            subject: new Subject({ role: "button", name: "Save", tag: "button", context: {} }),
            box: { x: 0, y: 0, width: 20, height: 20 },
          },
        ],
      });

      const seededRef = (yield* seeded.page.find({ name: " save " }))[0]?.ref ?? "";

      yield* seeded.page.perform({ _tag: "Click", target: seededRef });

      const seededAction = (yield* seeded.page.recentEvents).find(
        (event) => event._tag === "Action",
      );

      const browser = yield* Browser.Browser;
      const page = yield* browser.newPage(form);
      const snapshot = yield* page.snapshot();
      const buttons = yield* page.find({ role: "button", name: "Save" });
      const text = yield* page.text();
      const blocked = (yield* page.find({ name: "Blocked" }))[0];
      const blockedInput = yield* page.click(blocked?.ref ?? "").pipe(Effect.result);

      const disabledWait = yield* page.until(
        { selector: "fieldset > button", state: "enabled" },
        "some",
        20,
      );

      const note = snapshot.controls.find(({ name }) => name === "Note")?.ref ?? "";
      const choice = snapshot.controls.find(({ name }) => name === "Choice")?.ref ?? "";

      yield* page.changes();
      yield* page.type("bundled", { into: note });
      yield* page.select(choice, ["B"]);
      const changes = yield* page.changes();
      const typed = yield* page.text({ unmask: true });
      const point = (yield* page.find({ name: "Note" }))[0]?.box;

      if (point !== undefined)
        yield* page.click({ x: point.x + point.width / 2, y: point.y + point.height / 2 });
      yield* page.perform({ _tag: "Click", target: buttons[0]?.ref ?? "" });
      const outcome = (yield* page.until({ text: "Saved" }, "some", 1000)).met ? "Done" : "NotDone";

      yield* page.until({ selector: "#status", text: "Saved" }, "some", 1000);
      yield* Stillness.wait(page, { still: "foreground", quietMillis: 100, timeout: "5 seconds" });
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

      const moving = yield* Stillness.wait(page, {
        still: "foreground",
        quietMillis: 300,
        timeout: "1200 millis",
      }).pipe(Effect.result);

      // The registered source must also work from the start of the next document.
      yield* page.goto("data:text/html,<title>Next document</title><h1>Next document</h1>");
      const next = yield* page.snapshot();

      yield* Stillness.wait(page, { still: "foreground", quietMillis: 100, timeout: "5 seconds" });

      yield* page.goto(
        "data:text/html,<button style='width:100px;height:100px'>New control</button>",
      );
      yield* page.click({ x: 20, y: 20 });
      const oldRef = yield* page.click(note).pipe(Effect.result);

      return {
        seededAction: seededAction?._tag === "Action" ? seededAction.value?._tag : undefined,
        outline: snapshot.text,
        controls: snapshot.controls,
        disabled: blocked?.state.disabled,
        disabledWait: disabledWait.met,
        blockedInput: Result.isFailure(blockedInput) ? blockedInput.failure.reason._tag : "clicked",
        typed: typed.text,
        changeCount: changes.changes.length,
        oldRef: Result.isFailure(oldRef) ? oldRef.failure.reason._tag : "clicked",
        found: buttons.map(({ subject }) => subject.name),
        text: text.text,
        outcome,
        saved: saved.text,
        moving: Result.isFailure(moving) ? moving.failure.reason._tag : "Ready",
        next: next.text,
      };
    }).pipe(Effect.provide(Chromium.layer({ guard: () => Effect.void })), Effect.scoped),
  );
