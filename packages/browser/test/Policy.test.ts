import { assert, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";

import { Browser, make as makeBrowser, type Options as BrowserOptions } from "../src/Browser.ts";
import { type BrowserError, PolicyDenied } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { InputRequest, Page } from "../src/Page.ts";
import type { Snapshot } from "../src/Snapshot.ts";
import * as Tools from "../src/Tools.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const refOf = (snapshot: Snapshot, role: string, name: string): string => {
  const ref = new RegExp(role + ' "' + name + '"[^\\n]*?\\[ref=(e\\d+)\\]').exec(
    snapshot.text,
  )?.[1];

  assert.isDefined(ref, "missing " + role + " " + name);

  return ref ?? "";
};

const setup = Effect.fnUntraced(function* (options: BrowserOptions) {
  const host = yield* Browser;
  const native = host.context.browser();

  if (native === null) return yield* Effect.die("the fixture requires a launched Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 1280, height: 720 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const browser = yield* makeBrowser(context, { id: "policy-test", provider: "test" }, options);
  const page = yield* browser.newPage();
  const url = (yield* Site).url("/form");

  // Fixture loading bypasses the policy so denied navigation remains independently testable.
  yield* Effect.promise(() => page.playwright.goto(url));

  return { browser, page };
});

const failure = <R>(operation: Effect.Effect<unknown, BrowserError, R>) =>
  operation.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed({ tag: error.reason._tag, dispatched: error.dispatched }),
      onSuccess: () => Effect.die("expected the operation to fail before dispatch"),
    }),
  );

const valueOf = (page: Page, selector: string) =>
  Effect.promise(() => page.playwright.locator(selector).inputValue());

const outcome = (page: Page) =>
  Effect.promise(() => page.playwright.locator("#outcome").textContent());

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Policy", (it) => {
  it.effect("classifies submissions, consequential controls, origins and files before input", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { page } = yield* setup({
        guard: (request) =>
          Effect.sync(() => requests.push(request)).pipe(
            Effect.andThen(Effect.fail(new PolicyDenied({ detail: "inspection only" }))),
          ),
      });

      const external = new URL((yield* Site).url("/next"));

      external.hostname = "localhost";
      yield* Effect.promise(() =>
        page.playwright.setContent(
          [
            '<form action="/next"><label>Amount <input id="amount" value="10"></label><button type="submit">Submit form</button><label>Notes <textarea id="notes"></textarea></label></form>',
            '<button type="button">Buy now</button><button type="button">Pay now</button><button type="button">Place order</button>',
            '<button type="button">Delete item</button><button type="button">Confirm transfer</button><button type="button">Ordinary action</button>',
            '<a href="' +
              external.href +
              '">External destination</a><a href="/asset" download>Save file</a>',
            '<label>Upload file <input type="file"></label>',
          ].join(""),
        ),
      );
      const snapshot = yield* page.snapshot();

      for (const [role, name, expected] of [
        ["button", "Submit form", ["form-submit"]],
        ["button", "Buy now", ["purchase"]],
        ["button", "Pay now", ["purchase"]],
        ["button", "Place order", ["purchase"]],
        ["button", "Delete item", ["delete"]],
        ["button", "Confirm transfer", ["confirm"]],
        ["button", "Ordinary action", []],
        ["link", "External destination", ["cross-origin"]],
        ["link", "Save file", ["download"]],
        ["textbox", "Upload file", ["upload"]],
      ] as const) {
        assert.deepStrictEqual(yield* failure(page.click(refOf(snapshot, role, name))), {
          tag: "PolicyDenied",
          dispatched: false,
        });
        const request = requests.at(-1)!;

        assert.strictEqual(request.role, role);
        assert.strictEqual(request.name, name);
        assert.deepStrictEqual(
          [...request.classifications].sort((left, right) => left.localeCompare(right)),
          [...expected].sort((left, right) => left.localeCompare(right)),
        );
      }

      const buy = yield* Effect.promise(() =>
        page.playwright.getByRole("button", { name: "Buy now", exact: true }).boundingBox(),
      );

      assert.isNotNull(buy);
      if (buy === null) return;
      const point = { x: buy.x + buy.width / 2, y: buy.y + buy.height / 2 };

      yield* failure(page.click(point));
      assert.strictEqual(requests.at(-1)!.name, "Buy now");
      assert.deepStrictEqual(requests.at(-1)!.point, point);
      assert.include(requests.at(-1)!.classifications, "purchase");

      yield* Effect.promise(() => page.playwright.locator("#amount").focus());
      yield* failure(page.press("Enter"));
      assert.include(requests.at(-1)!.classifications, "form-submit");
      assert.strictEqual(requests.at(-1)!.name, "Amount");
      yield* failure(page.type("25", { into: refOf(snapshot, "textbox", "Amount"), submit: true }));
      assert.include(requests.at(-1)!.classifications, "form-submit");
      yield* failure(page.press("ArrowLeft"));
      assert.notInclude(requests.at(-1)!.classifications, "form-submit");
      yield* Effect.promise(() => page.playwright.locator("#notes").focus());
      yield* failure(page.press("Enter"));
      assert.notInclude(requests.at(-1)!.classifications, "form-submit");
      yield* failure(
        page.type("text", { into: refOf(snapshot, "textbox", "Notes"), submit: true }),
      );
      assert.notInclude(requests.at(-1)!.classifications, "form-submit");
      yield* failure(page.goto(external.href));
      assert.include(requests.at(-1)!.classifications, "cross-origin");
      assert.strictEqual(requests.at(-1)!.destination, external.href);
      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
    }),
  );

  it.effect("classifies the first image submitter when Enter implicitly submits a form", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { page } = yield* setup({
        guard: (request) =>
          Effect.sync(() => requests.push(request)).pipe(
            Effect.andThen(Effect.fail(new PolicyDenied({ detail: "inspection only" }))),
          ),
      });

      const external = new URL((yield* Site).url("/next"));

      external.hostname = "localhost";
      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<form action="/next"><label>Amount <input id="amount" value="10"></label>' +
            '<input type="image" aria-label="Image submit" formaction="' +
            external.href +
            '">' +
            '<button type="submit">Ordinary submit</button></form>',
        ),
      );
      yield* Effect.promise(() => page.playwright.locator("#amount").focus());

      assert.deepStrictEqual(yield* failure(page.press("Enter")), {
        tag: "PolicyDenied",
        dispatched: false,
      });
      assert.strictEqual(requests.at(-1)!.destination, external.href);
      assert.includeMembers([...requests.at(-1)!.classifications], ["form-submit", "cross-origin"]);
      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
    }),
  );

  it.effect("classifies what a click activates: SVG links, map areas and submitter children", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { page } = yield* setup({
        guard: (request) =>
          Effect.sync(() => requests.push(request)).pipe(
            Effect.andThen(Effect.fail(new PolicyDenied({ detail: "inspection only" }))),
          ),
      });

      const external = new URL((yield* Site).url("/next"));

      external.hostname = "localhost";
      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0"><svg width="300" height="100" style="display:block"><a href="' +
            external.href +
            '"><rect width="300" height="100" fill="red"></rect></a></svg>' +
            '<img usemap="#map" width="300" height="100" style="display:block" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="><map name="map"><area shape="rect" coords="0,0,300,100" href="' +
            external.href +
            '" download></map>' +
            '<form action="' +
            external.href +
            '"><input name="q" value="1"><button style="display:block;width:300px;height:60px"><span onclick="void 0" style="display:inline-block;width:280px;height:50px">Continue</span></button></form></body>',
        ),
      );
      const continueAt = yield* Effect.promise(() => page.playwright.locator("span").boundingBox());

      assert.isNotNull(continueAt);
      if (continueAt === null) return;

      for (const [target, expected] of [
        [{ x: 150, y: 50 }, ["cross-origin"]],
        [{ x: 150, y: 150 }, ["cross-origin", "download"]],
        [
          { x: continueAt.x + continueAt.width / 2, y: continueAt.y + continueAt.height / 2 },
          ["cross-origin", "form-submit"],
        ],
        [refOf(yield* page.snapshot(), "clickable", "Continue"), ["cross-origin", "form-submit"]],
      ] as const) {
        assert.deepStrictEqual(yield* failure(page.click(target)), {
          tag: "PolicyDenied",
          dispatched: false,
        });
        assert.deepStrictEqual(
          [...requests.at(-1)!.classifications].sort((left, right) => left.localeCompare(right)),
          [...expected],
        );
        assert.strictEqual(requests.at(-1)!.destination, external.href);
      }
    }),
  );

  it.effect("leaves hover and scroll unclassified over consequential controls", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { page } = yield* setup({
        guard: (request) => Effect.sync(() => requests.push(request)),
      });

      const external = new URL((yield* Site).url("/next"));

      external.hostname = "localhost";
      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0;height:3000px"><a href="' +
            external.href +
            '">Docs</a><button style="position:absolute;left:540px;top:330px;width:200px;height:60px">Delete</button></body>',
        ),
      );
      const snapshot = yield* page.snapshot();

      yield* page.hover(refOf(snapshot, "link", "Docs"));
      yield* page.scroll({ at: refOf(snapshot, "button", "Delete"), dy: 100 });

      assert.deepStrictEqual(
        requests.map((request) => [request.action, request.classifications, request.destination]),
        [
          ["hover", [], undefined],
          ["scroll", [], undefined],
        ],
      );
    }),
  );

  it.effect("refuses typing into a control before asking, and classifies Enter on toggles", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { page } = yield* setup({
        guard: (request) =>
          Effect.sync(() => requests.push(request)).pipe(
            Effect.andThen(Effect.fail(new PolicyDenied({ detail: "inspection only" }))),
          ),
      });

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<form action="/next"><input name="q" value="1"><input type="checkbox" id="checkbox">' +
            '<input type="radio" id="radio" name="r"><input type="range" id="range"><button id="go">Go</button></form>',
        ),
      );
      yield* Effect.promise(() => page.playwright.locator("#go").focus());
      assert.deepStrictEqual(yield* failure(page.type("a b")), {
        tag: "NotActionable",
        dispatched: false,
      });
      assert.isEmpty(requests);

      for (const id of ["checkbox", "radio", "range"]) {
        yield* Effect.promise(() => page.playwright.locator("#" + id).focus());
        assert.deepStrictEqual(yield* failure(page.press("Enter")), {
          tag: "PolicyDenied",
          dispatched: false,
        });
        assert.include(requests.at(-1)!.classifications, "form-submit");
      }
    }),
  );

  it.effect("binds a held approval to controls, not to page text that keeps changing", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { page } = yield* setup({
        guard: (request) =>
          Effect.sync(() => requests.push(request)).pipe(
            Effect.andThen(Effect.sleep("300 millis")),
          ),
      });

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0;height:3000px"><p>Updated <span id="clock">0</span></p>' +
            '<table style="position:absolute;top:300px;left:500px"><tr><td id="price" style="width:300px;height:120px">64,210</td></tr></table>' +
            "<script>let tick = 0; setInterval(() => { clock.textContent = String(++tick); price.textContent = String(64210 + tick); }, 50)</script></body>",
        ),
      );

      yield* page.press("ArrowDown");
      yield* page.scroll({ dy: 400 });
      assert.strictEqual(requests.at(-1)?.action, "scroll");
      assert.isUndefined(requests.at(-1)?.element);
    }),
  );

  it.effect("submits only to the approved field after typing moved focus", () =>
    Effect.gen(function* () {
      const { page } = yield* setup({ guard: () => Effect.void });

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<input id="query" aria-label="Search"><button id="remove" onclick="document.body.dataset.removed=\'yes\'">Remove all</button>' +
            '<script>query.addEventListener("input", () => { if (query.value.length >= 3) remove.focus(); });</script>',
        ),
      );

      assert.deepStrictEqual(
        yield* failure(
          page.type("abc", {
            into: refOf(yield* page.snapshot(), "textbox", "Search"),
            submit: true,
          }),
        ),
        { tag: "NotActionable", dispatched: true },
      );
      assert.isUndefined(
        yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.removed)),
      );
    }),
  );

  for (const humanize of [false, true]) {
    const mode = humanize ? "humanized" : "plain";

    it.effect("stops typing before a newly focused control receives keys, " + mode, () =>
      Effect.gen(function* () {
        const { page } = yield* setup({
          humanize,
          guard: (request) =>
            request.classifications.some((kind) => kind === "delete" || kind === "form-submit")
              ? Effect.fail(new PolicyDenied({ detail: "deletion and submission are denied" }))
              : Effect.void,
        });

        // Approval for a text field must not authorize Space on a control its input handler focuses.
        yield* Effect.promise(() =>
          page.playwright.setContent(
            "<form onsubmit=\"event.preventDefault(); document.body.dataset.submitted='yes'\">" +
              '<label>Query <input id="query"></label><button id="remove">Delete order</button></form>' +
              '<script>query.addEventListener("input", () => remove.focus());' +
              "remove.addEventListener(\"keydown\", () => document.body.dataset.activated='yes');</script>",
          ),
        );

        const result = yield* page
          .type("a b", { into: refOf(yield* page.snapshot(), "textbox", "Query") })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ tag: error.reason._tag, dispatched: error.dispatched }),
              onSuccess: () => undefined,
            }),
          );

        const effects = yield* Effect.promise(() =>
          page.playwright.evaluate(() => ({
            submitted: document.body.dataset.submitted,
            activated: document.body.dataset.activated,
          })),
        );

        assert.deepStrictEqual(
          { result, typed: yield* valueOf(page, "#query"), ...effects },
          {
            result: { tag: "NotActionable", dispatched: true },
            typed: "a",
            submitted: undefined,
            activated: undefined,
          },
        );
      }),
    );

    it.effect("stops a double-click before pressing a replacement control, " + mode, () =>
      Effect.gen(function* () {
        const { page } = yield* setup({
          humanize,
          guard: (request) =>
            request.classifications.some((kind) => kind === "delete" || kind === "form-submit")
              ? Effect.fail(new PolicyDenied({ detail: "deletion and submission are denied" }))
              : Effect.void,
        });

        // A second press must still hit the approved control after its first click changes the DOM.
        yield* Effect.promise(() =>
          page.playwright.setContent(
            "<style>button{position:absolute;left:10px;top:10px;width:150px;height:60px}</style>" +
              '<button id="first" type="button" onclick="this.remove(); document.getElementById(\'remove\').hidden=false">Continue</button>' +
              "<form onsubmit=\"event.preventDefault(); document.body.dataset.submitted='yes'\">" +
              '<button id="remove" hidden onpointerdown="document.body.dataset.activated=\'yes\'">Delete order</button></form>',
          ),
        );

        const result = yield* page
          .click(refOf(yield* page.snapshot(), "button", "Continue"), { clickCount: 2 })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ tag: error.reason._tag, dispatched: error.dispatched }),
              onSuccess: () => undefined,
            }),
          );

        const effects = yield* Effect.promise(() =>
          page.playwright.evaluate(() => ({
            firstPresent: document.getElementById("first") !== null,
            submitted: document.body.dataset.submitted,
            activated: document.body.dataset.activated,
          })),
        );

        assert.deepStrictEqual(
          { result, ...effects },
          {
            result: { tag: "NotActionable", dispatched: true },
            firstPresent: false,
            submitted: undefined,
            activated: undefined,
          },
        );
      }),
    );
  }

  it.effect("consults one policy for every supported input and navigation", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { browser, page } = yield* setup({
        guard: (request) =>
          Effect.sync(() => {
            requests.push(request);
          }),
      });

      const site = yield* Site;
      const snapshot = yield* page.snapshot();
      const checkbox = refOf(snapshot, "checkbox", "I agree");

      yield* page.hover(checkbox);
      yield* page.scroll({ at: checkbox, dy: 0 });
      yield* page.click(checkbox);
      yield* page.type("25", { into: refOf(snapshot, "textbox", "Amount") });
      yield* page.press("ArrowRight");
      yield* page.select(refOf(snapshot, "combobox", "Coin"), ["eth"]);
      const slider = yield* Effect.promise(() => page.playwright.locator("#slider").boundingBox());

      assert.isNotNull(slider);
      if (slider === null) return;
      yield* page.drag(
        { x: slider.x + 4, y: slider.y + slider.height / 2 },
        { x: slider.x + slider.width / 2, y: slider.y + slider.height / 2 },
      );
      yield* page.goto(site.url("/next"));
      yield* page.back;
      yield* page.reload;
      yield* browser.newPage(site.url("/next"));

      assert.deepStrictEqual(
        requests.map((request) => request.action),
        [
          "hover",
          "scroll",
          "click",
          "type",
          "press",
          "select",
          "drag",
          "navigate",
          "back",
          "reload",
          "navigate",
        ],
      );
      assert.deepStrictEqual(
        requests.slice(-4).map((request) => request.destination),
        [site.url("/next"), site.url("/form"), site.url("/form"), site.url("/next")],
      );
    }),
  );

  it.effect("reports denial through tools and records an undispatched action", () =>
    Effect.gen(function* () {
      const { browser, page } = yield* setup({
        guard: () => Effect.fail(new PolicyDenied({ detail: "test policy refused" })),
      });

      const tools = yield* Tools.make().pipe(Effect.provideService(Browser, browser));
      const submit = refOf(yield* page.snapshot(), "button", "Submit");
      const refused = yield* tools.handlers.browser_click({ ref: submit }).pipe(Effect.flip);

      assert.include(refused, "test policy refused");
      assert.notInclude(refused, "may have taken effect");
      assert.strictEqual(yield* outcome(page), "Not ordered");

      const action = (yield* browser.recentEvents)
        .filter((event) => event._tag === "Action")
        .at(-1);

      assert.strictEqual(action?.name, "click");
      assert.isFalse(action?.ok);
      assert.isFalse(action?.dispatched);
    }),
  );

  it.effect("denies navigation and closes a new tab whose navigation was refused", () =>
    Effect.gen(function* () {
      const { browser, page } = yield* setup({
        guard: () => Effect.fail(new PolicyDenied({ detail: "navigation refused" })),
      });

      const site = yield* Site;
      const before = (yield* browser.pages).length;

      for (const navigate of [
        page.goto(site.url("/next")),
        page.back,
        page.reload,
        browser.newPage(site.url("/next")),
      ]) {
        assert.deepStrictEqual(yield* failure(navigate), {
          tag: "PolicyDenied",
          dispatched: false,
        });
      }
      assert.strictEqual(yield* page.url, site.url("/form"));
      assert.strictEqual((yield* browser.pages).length, before);
    }),
  );

  it.effect("closes a new tab when its held navigation is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();

      const { browser } = yield* setup({
        guard: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });

      const before = (yield* browser.pages).length;
      const held = yield* browser.newPage((yield* Site).url("/next")).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      assert.strictEqual((yield* browser.pages).length, before + 1);
      yield* Fiber.interrupt(held);
      assert.strictEqual((yield* browser.pages).length, before);
    }),
  );

  it.effect("holds outside the action timeout and leaves the page lock available", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const { page } = yield* setup({
        actionTimeout: Duration.millis(350),
        policyTimeout: Duration.seconds(3),
        guard: (request) =>
          request.action === "click"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released)))
            : Effect.void,
      });

      const snapshot = yield* page.snapshot();
      const held = yield* page.click(refOf(snapshot, "button", "Submit")).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      yield* page
        .hover(refOf(snapshot, "checkbox", "I agree"))
        .pipe(Effect.timeout(Duration.seconds(1)));

      const elapsed = yield* Effect.promise(() =>
        page.playwright.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const started = performance.now();

              window.setTimeout(() => resolve(performance.now() - started), 500);
            }),
        ),
      );

      assert.isAtLeast(elapsed, 350);
      assert.strictEqual(yield* outcome(page), "Not ordered");
      yield* Deferred.succeed(released, undefined);
      yield* Fiber.join(held);
      assert.strictEqual(yield* outcome(page), "Ordered 10 btc");
    }),
  );

  it.effect("bounds a held policy separately and records a timeout before dispatch", () =>
    Effect.gen(function* () {
      const { browser, page } = yield* setup({
        policyTimeout: Duration.millis(40),
        guard: () => Effect.never,
      });

      const submit = refOf(yield* page.snapshot(), "button", "Submit");

      assert.deepStrictEqual(yield* failure(page.click(submit)), {
        tag: "PolicyTimeout",
        dispatched: false,
      });
      assert.strictEqual(yield* outcome(page), "Not ordered");

      const action = (yield* browser.recentEvents)
        .filter((event) => event._tag === "Action")
        .at(-1);

      assert.strictEqual(action?.name, "click");
      assert.isFalse(action?.ok);
      assert.isFalse(action?.dispatched);
    }),
  );

  it.effect("refuses a target replaced while its click policy was held", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const { page } = yield* setup({
        guard: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
      });

      const submit = refOf(yield* page.snapshot(), "button", "Submit");
      const held = yield* failure(page.click(submit)).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          const button = document.getElementById("submit");

          if (button !== null) button.replaceWith(button.cloneNode(true));
        }),
      );
      yield* Deferred.succeed(released, undefined);

      assert.deepStrictEqual(yield* Fiber.join(held), { tag: "StaleRef", dispatched: false });
      assert.strictEqual(yield* outcome(page), "Not ordered");
    }),
  );

  // A control that appears under the pointer when it arrives, as a hover menu might, must not
  // receive a press the policy approved for the control underneath.
  const hoverTrap =
    '<body style="margin:0"><button id="target" style="position:absolute;left:100px;top:100px;width:200px;height:60px" onmousedown="document.body.dataset.target=\'pressed\'">Settings</button>' +
    '<input id="field" aria-label="Notes" style="position:absolute;left:100px;top:300px;width:200px;height:40px">' +
    '<script>for (const id of ["target", "field"]) document.getElementById(id).addEventListener("mouseover", () => {' +
    'if (document.getElementById("danger")) return; const danger = document.createElement("button");' +
    'danger.id = "danger"; danger.textContent = "Delete account"; danger.style.cssText = "position:fixed;inset:0;z-index:10";' +
    'danger.onmousedown = () => (document.body.dataset.deleted = "yes"); document.body.append(danger); });</script>';

  for (const [label, humanize, act] of [
    [
      "clicking a ref",
      false,
      (page: Page, snapshot: Snapshot) => page.click(refOf(snapshot, "button", "Settings")),
    ],
    ["clicking a point", false, (page: Page) => page.click({ x: 200, y: 130 })],
    [
      "a humanized click",
      true,
      (page: Page, snapshot: Snapshot) => page.click(refOf(snapshot, "button", "Settings")),
    ],
    [
      "humanized typing",
      true,
      (page: Page, snapshot: Snapshot) =>
        page.type("12", { into: refOf(snapshot, "textbox", "Notes") }),
    ],
    [
      "a drag",
      false,
      (page: Page, snapshot: Snapshot) =>
        page.drag(refOf(snapshot, "button", "Settings"), refOf(snapshot, "textbox", "Notes")),
    ],
  ] as const) {
    it.effect("refuses " + label + " when the pointer's arrival covers the approved target", () =>
      Effect.gen(function* () {
        const requests: Array<InputRequest> = [];

        const { page } = yield* setup({
          humanize,
          guard: (request) => Effect.sync(() => requests.push(request)),
        });

        yield* Effect.promise(() => page.playwright.setContent(hoverTrap));

        // The pointer travelled, but nothing was pressed: the action cannot have taken effect.
        assert.deepStrictEqual(yield* failure(act(page, yield* page.snapshot())), {
          tag: "NotActionable",
          dispatched: false,
        });
        assert.lengthOf(requests, 1);
        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            page.playwright.evaluate(() => ({ ...document.body.dataset })),
          ),
          {},
        );
        assert.strictEqual(yield* valueOf(page, "#field"), "");
      }),
    );
  }

  // A control that appears inside the approved target, rather than over it, must not receive the
  // press either: the approval classified the target, not the link or button now under the pointer.
  // The inserted controls are aria-hidden so the target's name and fingerprint stay unchanged.
  const nestedTrap =
    '<body style="margin:0"><div role="listbox" aria-label="Reports">' +
    '<div id="row" role="option" tabindex="0" style="position:absolute;left:100px;top:100px;width:300px;height:60px">Quarterly report</div></div>' +
    '<div id="mail" onclick="document.body.dataset.opened=\'yes\'" style="position:absolute;left:100px;top:300px;width:300px;height:60px">Invoice 42</div>' +
    '<script>row.addEventListener("mouseover", () => { if (document.getElementById("away")) return;' +
    'const away = document.createElement("a"); away.id = "away"; away.href = "https://elsewhere.invalid/";' +
    'away.setAttribute("aria-hidden", "true"); away.style.cssText = "position:absolute;inset:0";' +
    'away.onmousedown = () => (document.body.dataset.followed = "yes");' +
    'away.onclick = (event) => { event.preventDefault(); document.body.dataset.followed = "yes"; }; row.append(away); });' +
    'mail.addEventListener("mouseover", () => { if (document.getElementById("remove")) return;' +
    'const remove = document.createElement("button"); remove.id = "remove"; remove.textContent = "Delete";' +
    'remove.setAttribute("aria-hidden", "true"); remove.style.cssText = "position:absolute;inset:0";' +
    'remove.onmousedown = () => (document.body.dataset.deleted = "yes"); mail.append(remove); });</script>';

  for (const [label, humanize, act] of [
    [
      "clicking a ref",
      false,
      (page: Page, snapshot: Snapshot) => page.click(refOf(snapshot, "option", "Quarterly report")),
    ],
    [
      "a humanized click",
      true,
      (page: Page, snapshot: Snapshot) => page.click(refOf(snapshot, "option", "Quarterly report")),
    ],
    ["clicking a point", false, (page: Page) => page.click({ x: 250, y: 330 })],
    ["a humanized point click", true, (page: Page) => page.click({ x: 250, y: 330 })],
  ] as const) {
    it.effect(
      "refuses " + label + " when the pointer's arrival nests a control in the target",
      () =>
        Effect.gen(function* () {
          const requests: Array<InputRequest> = [];

          const { page } = yield* setup({
            humanize,
            guard: (request) => Effect.sync(() => requests.push(request)),
          });

          yield* Effect.promise(() => page.playwright.setContent(nestedTrap));

          assert.deepStrictEqual(yield* failure(act(page, yield* page.snapshot())), {
            tag: "NotActionable",
            dispatched: false,
          });
          assert.lengthOf(requests, 1);
          assert.deepStrictEqual(
            yield* Effect.promise(() =>
              page.playwright.evaluate(() => ({ ...document.body.dataset })),
            ),
            {},
          );
        }),
    );
  }

  it.effect("presses a target whose press lands on its containing option", () =>
    Effect.gen(function* () {
      const requests: Array<InputRequest> = [];

      const { page } = yield* setup({
        guard: (request) => Effect.sync(() => requests.push(request)),
      });

      // The hit is the option around the button, a container the button's own approval covers;
      // only controls nested inside the target are refused.
      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0"><div role="option" aria-label="Report" onclick="document.body.dataset.opened=\'yes\'"' +
            ' style="position:absolute;left:100px;top:100px;width:300px;height:60px">' +
            '<button style="pointer-events:none;width:100%;height:100%">Open</button></div></body>',
        ),
      );

      yield* page.click(refOf(yield* page.snapshot(), "button", "Open"));

      assert.lengthOf(requests, 1);
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.opened)),
        "yes",
      );
    }),
  );

  for (const change of ["label", "href", "pixel target"] as const) {
    it.effect("refuses a held click after its " + change + " changes", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();

        const { page } = yield* setup({
          guard: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
        });

        yield* Effect.promise(() =>
          page.playwright.setContent(
            '<body><a id="target" href="#first" style="position:absolute;left:40px;top:40px;width:120px;height:50px" onclick="document.body.dataset.clicked=\'yes\'">Continue</a>' +
              '<a id="other" href="#other" style="position:absolute;left:300px;top:40px;width:120px;height:50px" onclick="document.body.dataset.clicked=\'yes\'">Other</a>',
          ),
        );

        const target =
          change === "pixel target"
            ? { x: 70, y: 60 }
            : refOf(yield* page.snapshot(), "link", "Continue");

        const held = yield* failure(page.click(target)).pipe(Effect.forkChild);

        yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
        yield* Effect.promise(() =>
          page.playwright.evaluate((change) => {
            const target = document.getElementById("target")!;
            const other = document.getElementById("other")!;

            if (change === "label") target.textContent = "Buy now";
            else if (change === "href") target.setAttribute("href", "/next");
            else {
              target.style.left = "300px";
              other.style.left = "40px";
            }
          }, change),
        );
        yield* Deferred.succeed(released, undefined);

        assert.deepStrictEqual(yield* Fiber.join(held), {
          tag: "NotActionable",
          dispatched: false,
        });
        assert.isUndefined(
          yield* Effect.promise(() =>
            page.playwright.evaluate(() => document.body.dataset.clicked),
          ),
        );
      }),
    );
  }

  for (const destinationOwner of ["form", "submitter"] as const) {
    it.effect("refuses a held submit after the " + destinationOwner + " destination changes", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();

        const { page } = yield* setup({
          guard: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
        });

        const site = yield* Site;

        yield* Effect.promise(() =>
          page.playwright.setContent(
            '<form id="form" action="/next"><input value="10"><button id="submit">Continue</button></form>',
          ),
        );
        const target = refOf(yield* page.snapshot(), "button", "Continue");
        const held = yield* failure(page.click(target)).pipe(Effect.forkChild);

        yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
        yield* Effect.promise(() =>
          page.playwright.evaluate((owner) => {
            if (owner === "form") document.getElementById("form")?.setAttribute("action", "/chart");
            else document.getElementById("submit")?.setAttribute("formaction", "/chart");
          }, destinationOwner),
        );
        yield* Deferred.succeed(released, undefined);

        assert.deepStrictEqual(yield* Fiber.join(held), {
          tag: "NotActionable",
          dispatched: false,
        });
        assert.strictEqual(yield* page.url, site.url("/form"));
      }),
    );
  }

  it.effect("does not scroll an offscreen ref before a denied policy", () =>
    Effect.gen(function* () {
      const { page } = yield* setup({
        guard: () => Effect.fail(new PolicyDenied({ detail: "refused before scrolling" })),
      });

      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          const button = document.createElement("button");

          button.textContent = "Delete below";
          button.style.cssText = "position:absolute;left:20px;top:2500px";
          document.body.append(button);
        }),
      );
      const target = refOf(yield* page.snapshot({ full: true }), "button", "Delete below");

      assert.deepStrictEqual(yield* failure(page.click(target)), {
        tag: "PolicyDenied",
        dispatched: false,
      });
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => window.scrollY)),
        0,
      );
    }),
  );

  it.effect("refuses held back navigation after its previous history entry changes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const { page } = yield* setup({
        guard: (request) =>
          request.action === "back"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released)))
            : Effect.void,
      });

      const site = yield* Site;

      yield* Effect.promise(() => page.playwright.goto(site.url("/next")));
      const held = yield* failure(page.back).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          history.replaceState({}, "", "/chart");
          history.pushState({}, "", "/next");
        }),
      );
      yield* Deferred.succeed(released, undefined);

      assert.deepStrictEqual(yield* Fiber.join(held), { tag: "NotActionable", dispatched: false });
      assert.strictEqual(yield* page.url, site.url("/next"));
    }),
  );

  it.effect("refuses a held ref after its iframe navigates to another document", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const { page } = yield* setup({
        guard: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
      });

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<iframe name="child" srcdoc="<button>Frame action</button>"></iframe>',
        ),
      );
      const frame = page.playwright.frame({ name: "child" });

      assert.isNotNull(frame);
      if (frame === null) return;
      const target = refOf(yield* page.snapshot(), "button", "Frame action");
      const held = yield* failure(page.click(target)).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      const destination = (yield* Site).url("/next");

      yield* Effect.promise(() => frame.goto(destination));
      yield* Effect.promise(() =>
        frame.evaluate(() => {
          document.body.dataset.clicked = "no";
          document.addEventListener("click", () => {
            document.body.dataset.clicked = "yes";
          });
        }),
      );
      yield* Deferred.succeed(released, undefined);

      assert.deepStrictEqual(yield* Fiber.join(held), { tag: "StaleRef", dispatched: false });
      assert.strictEqual(
        yield* Effect.promise(() => frame.evaluate(() => document.body.dataset.clicked)),
        "no",
      );
    }),
  );

  it.effect(
    "refuses back before asking when there is nothing behind, and leaves frame history",
    () =>
      Effect.gen(function* () {
        const requests: Array<InputRequest> = [];

        const { browser, page } = yield* setup({
          guard: (request) => Effect.sync(() => requests.push(request)),
        });

        const fresh = yield* browser.newPage();

        requests.splice(0);
        assert.deepStrictEqual(yield* failure(fresh.back), { tag: "NotFound", dispatched: false });
        assert.isEmpty(requests);

        const site = yield* Site;

        yield* Effect.promise(() =>
          page.playwright.setContent(`<iframe name="child" src="${site.url("/next")}"></iframe>`),
        );
        const child = page.playwright.frame({ name: "child" });

        assert.isNotNull(child);
        if (child === null) return;
        yield* Effect.promise(() => child.waitForLoadState());
        yield* Effect.promise(() => child.goto(site.url("/chart")));
        yield* page.back.pipe(Effect.timeout(Duration.seconds(5)));
        assert.strictEqual(child.url(), site.url("/next"));
        assert.deepStrictEqual(
          requests.map((request) => request.action),
          ["back"],
        );
      }),
  );

  it.effect("names the stale target, and refuses a selection undispatched, on every path", () =>
    Effect.gen(function* () {
      const staleness = (error: BrowserError) =>
        error.reason._tag === "StaleRef"
          ? { ref: error.reason.ref, dispatched: error.dispatched }
          : { tag: error.reason._tag, dispatched: error.dispatched };

      for (const guarded of [false, true]) {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();

        const { page } = yield* setup(
          guarded
            ? {
                guard: (request) =>
                  request.action === "click"
                    ? Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(released)),
                      )
                    : Effect.void,
              }
            : {},
        );

        yield* Effect.promise(() =>
          page.playwright.setContent(
            '<button id="first">First</button><button id="second">Second</button>' +
              '<select id="coin" aria-label="Coin"><option>Bitcoin</option></select>',
          ),
        );
        const snapshot = yield* page.snapshot();
        const first = refOf(snapshot, "button", "First");
        const second = refOf(snapshot, "button", "Second");
        const coin = refOf(snapshot, "combobox", "Coin");

        yield* Effect.promise(() =>
          page.playwright.evaluate(() => document.getElementById("second")?.remove()),
        );
        assert.deepStrictEqual(staleness(yield* Effect.flip(page.drag(first, second))), {
          ref: second,
          dispatched: false,
        });
        assert.deepStrictEqual(yield* failure(page.select(coin, ["Dogecoin"])), {
          tag: "NotActionable",
          dispatched: false,
        });
        assert.deepStrictEqual(yield* failure(page.select(first, ["Bitcoin"])), {
          tag: "NotActionable",
          dispatched: false,
        });

        if (guarded) {
          // A ref removed while its approval was held is stale, as it is without a guard.
          const held = yield* Effect.flip(page.click(first)).pipe(Effect.forkChild);

          yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
          yield* Effect.promise(() =>
            page.playwright.evaluate(() => document.getElementById("first")?.remove()),
          );
          yield* Deferred.succeed(released, undefined);
          assert.deepStrictEqual(staleness(yield* Fiber.join(held)), {
            ref: first,
            dispatched: false,
          });
        }
      }
    }),
  );

  // Scroll-spy documentation and feeds record where the reader is in the URL fragment.
  const scrollSpy =
    '<body style="margin:0"><h1>Top</h1><div style="height:2500px"></div>' +
    '<button id="act" onclick="this.textContent=\'clicked\'">Act</button><div style="height:2500px"></div>' +
    '<form onsubmit="event.preventDefault(); document.body.dataset.sent = \'yes\'"><input name="q"><button>Send</button></form>' +
    '<div style="height:2500px"></div>' +
    '<script>addEventListener("scroll", () => history.replaceState(null, "", "#y" + Math.round(scrollY / 500)))</script></body>';

  for (const [label, options] of [
    ["unguarded", {}],
    ["guarded", { guard: () => Effect.void }],
    ["guarded and humanized", { guard: () => Effect.void, humanize: true }],
  ] as const) {
    it.effect("follows a scroll-spy fragment to an off-screen control, " + label, () =>
      Effect.gen(function* () {
        const { page } = yield* setup(options);

        yield* Effect.promise(() => page.playwright.setContent(scrollSpy));
        const snapshot = yield* page.snapshot({ full: true });

        yield* page.click(refOf(snapshot, "button", "Act"));
        yield* page.click(refOf(snapshot, "button", "Send"));
        assert.strictEqual(
          yield* Effect.promise(() => page.playwright.locator("#act").textContent()),
          "clicked",
        );
        assert.strictEqual(
          yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.sent)),
          "yes",
        );
      }),
    );
  }

  it.effect("refuses a held click after its page's hash route changes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const { page } = yield* setup({
        guard: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
      });

      // A hash router's route selects what a persistent control acts on.
      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<button onclick="document.body.dataset.removed = location.hash">Remove item</button>' +
            '<script>history.replaceState(null, "", "#/items/1")</script>',
        ),
      );

      const held = yield* failure(
        page.click(refOf(yield* page.snapshot(), "button", "Remove item")),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      yield* Effect.promise(() => page.playwright.evaluate(() => (location.hash = "#/items/2")));
      yield* Deferred.succeed(released, undefined);

      assert.deepStrictEqual(yield* Fiber.join(held), { tag: "NotActionable", dispatched: false });
      assert.isUndefined(
        yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.removed)),
      );
    }),
  );

  it.effect("counts a selection dispatched only when its script may have run", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      if (native === null) return yield* Effect.die("the fixture requires a launched Chromium");

      for (const guarded of [false, true])
        for (const [failure, dispatched] of [
          ["Cannot find context with specified id", false],
          ["Execution context was destroyed.", true],
        ] as const) {
          const context = yield* Effect.acquireRelease(
            Effect.promise(() => native.newContext()),
            (context) => Effect.promise(() => context.close()),
          );

          const createSession = context.newCDPSession.bind(context);

          // The selection script's own evaluation fails as a vanished or destroyed context would.
          context.newCDPSession = async (target) => {
            const cdp = await createSession(target);
            const send = cdp.send.bind(cdp);

            cdp.send = ((method, params) =>
              method === "Runtime.evaluate" &&
              (params as { readonly expression?: string } | undefined)?.expression?.startsWith(
                "globalThis.__effectBrowser.select(",
              ) === true
                ? Promise.reject(new Error("Protocol error (Runtime.evaluate): " + failure))
                : send(method, params)) as typeof cdp.send;

            return cdp;
          };

          const browser = yield* makeBrowser(
            context,
            { id: "select-test", provider: "test" },
            guarded ? { guard: () => Effect.void } : {},
          );

          const page = yield* browser.newPage();

          yield* Effect.promise(() =>
            page.playwright.setContent(
              '<select aria-label="Coin"><option>Bitcoin</option><option>Ether</option></select>',
            ),
          );

          const error = yield* Effect.flip(
            page.select(refOf(yield* page.snapshot(), "combobox", "Coin"), ["Ether"]),
          );

          assert.strictEqual(error.reason._tag, "NotActionable");
          assert.strictEqual(error.dispatched, dispatched, failure);
        }
    }),
  );

  it.effect("finishes allowed back navigation between entries with the same URL", () =>
    Effect.gen(function* () {
      const { page } = yield* setup({ guard: () => Effect.void });
      const url = yield* page.url;

      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          history.replaceState({ entry: "first" }, "", location.href);
          history.pushState({ entry: "second" }, "", location.href);
        }),
      );
      yield* page.back;

      assert.strictEqual(
        yield* Effect.promise(() =>
          page.playwright.evaluate(() => (history.state as { entry: string }).entry),
        ),
        "first",
      );
      assert.strictEqual(yield* page.url, url);
    }),
  );

  it.effect("refuses typing when focus changed while the policy was held", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const { page } = yield* setup({
        guard: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
      });

      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          const other = document.createElement("input");

          other.id = "other";
          other.value = "unchanged";
          document.body.append(other);
        }),
      );
      yield* Effect.promise(() => page.playwright.locator("#amount").focus());
      const held = yield* failure(page.type("changed")).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      yield* Effect.promise(() => page.playwright.locator("#other").focus());
      yield* Deferred.succeed(released, undefined);

      assert.deepStrictEqual(yield* Fiber.join(held), { tag: "NotActionable", dispatched: false });
      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
      assert.strictEqual(yield* valueOf(page, "#other"), "unchanged");
    }),
  );

  it.effect("refuses navigation when the page changed while the policy was held", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();

      const { page } = yield* setup({
        guard: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
      });

      const site = yield* Site;
      const held = yield* failure(page.goto(site.url("/next"))).pipe(Effect.forkChild);

      yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(1)));
      yield* Effect.promise(() => page.playwright.goto(site.url("/chart")));
      yield* Deferred.succeed(released, undefined);

      assert.deepStrictEqual(yield* Fiber.join(held), { tag: "NotActionable", dispatched: false });
      assert.strictEqual(yield* page.url, site.url("/chart"));
    }),
  );

  it.effect("requires a finite positive policy timeout", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;

      for (const policyTimeout of [Duration.zero, Duration.millis(-1), Duration.infinity]) {
        assert.deepStrictEqual(
          yield* failure(
            makeBrowser(
              browser.context,
              { id: "invalid-policy", provider: "test" },
              { policyTimeout },
            ),
          ),
          { tag: "InvalidRequest", dispatched: false },
        );
      }
    }),
  );
});
