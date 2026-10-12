import { describe, expect, it as test } from "@effect/vitest";
// The site's routes: which page a URL shows, the players a page starts, links to files and
// headings, and what each page renders.
import type * as Markdown from "@foldkit/markdown";
import { Option } from "effect";
import * as Scene from "foldkit/scene";
import { Command, given, message, model, story } from "foldkit/story";
import { fromString } from "foldkit/url";

import { documentOf } from "../src/docs.ts";
import {
  AppRoute,
  CopyCode,
  ElapseNotice,
  LoadExternal,
  Message,
  Model,
  NavigateInternal,
  ScrollTo,
  update,
  view,
} from "../src/main.ts";
import * as Try from "../src/page/try.ts";
import { pages } from "../src/pages.ts";
import * as Player from "../src/player/player.ts";

const at = (route: AppRoute) =>
  Model.make({
    route,
    players: {},
    tryPage: Try.init().model,
    examples: {},
    notice: Option.none(),
    notices: 0,
  });

const url = (path: string) =>
  Option.getOrThrowWith(fromString(`http://localhost${path}`), () => new Error(path));

const missing = Player.Message.FailedLoadReplay({ reason: "polymarket has not been recorded yet" });

describe("update", () => {
  test("a docs path shows its page and starts the replays its prose places", () => {
    story(
      update,
      given(at(AppRoute.Home())),
      message(Message.ChangedUrl({ url: url("/docs/moments-and-narration") })),
      Command.resolve(Player.LoadReplay, missing),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
      model((model) => {
        expect(model.route).toEqual(AppRoute.Doc({ slug: "moments-and-narration" }));
        expect(Object.keys(model.players)).toEqual(["casino"]);
        expect(model.players.casino?.load._tag).toBe("Missing");
      }),
    );
  });

  test("the demo plays the featured replay, and leaving it drops the player", () => {
    story(
      update,
      given(at(AppRoute.Home())),
      message(Message.ChangedUrl({ url: url("/demo") })),
      Command.resolve(Player.LoadReplay, missing),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
      model((model) => expect(Object.keys(model.players)).toEqual(["polymarket"])),
      message(Message.ChangedUrl({ url: url("/docs/get-started") })),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
      model((model) => expect(model.players).toEqual({})),
    );
  });

  test("a link to a heading on the same page scrolls to it and keeps the page's players", () => {
    story(
      update,
      given(at(AppRoute.Home())),
      message(Message.ChangedUrl({ url: url("/replay/chart-trade-luna") })),
      Command.resolve(Player.LoadReplay, missing),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
      message(Message.ChangedUrl({ url: url("/replay/chart-trade-luna#result") })),
      Command.expectExact(ScrollTo),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
      model((model) => expect(model.players["chart-trade-luna"]?.load._tag).toBe("Missing")),
    );
  });

  test("links to pages navigate in the app; links to files load from the server", () => {
    story(
      update,
      given(at(AppRoute.Home())),
      message(
        Message.ClickedLink({ request: { _tag: "Internal", url: url("/docs/browserbase") } }),
      ),
      Command.resolve(NavigateInternal, Message.CompletedNavigateInternal()),
      message(Message.ClickedLink({ request: { _tag: "Internal", url: url("/llms.txt") } })),
      Command.expectExact(LoadExternal),
      Command.resolve(LoadExternal, Message.CompletedLoadExternal()),
    );
  });

  test("the Try page looks for the local runner once, and keeps its take across pages", () => {
    story(
      update,
      given(at(AppRoute.Home())),
      message(Message.ChangedUrl({ url: url("/try") })),
      Command.resolve(Try.LoadStatus, Try.Message.FailedLoadStatus()),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
      model((model) => expect(model.tryPage.runner._tag).toBe("Remote")),
      message(Message.ChangedUrl({ url: url("/docs/get-started") })),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
      message(Message.ChangedUrl({ url: url("/try") })),
      Command.expectExact(ScrollTo),
      Command.resolve(ScrollTo, Message.CompletedScroll()),
    );
  });

  test("a copy shows a notice that only its own timer clears", () => {
    story(
      update,
      given(at(AppRoute.Doc({ slug: "get-started" }))),
      message(Message.ClickedCopyCode({ text: "bun install" })),
      Command.resolve(CopyCode, Message.CompletedCopy({ notice: "Copied" })),
      model((model) => expect(model.notice).toEqual(Option.some("Copied"))),
      Command.resolve(ElapseNotice, Message.ElapsedNotice({ notices: 1 })),
      model((model) => expect(model.notice).toEqual(Option.none())),
    );
  });
});

describe("view", () => {
  test("the home page leads to the demo, the docs and the Try page", () => {
    Scene.scene(
      { update, view },
      Scene.given(at(AppRoute.Home())),
      Scene.expect(
        Scene.role("heading", {
          name: "Browser automation for Effect agents, built to be watched.",
        }),
      ).toExist(),
      Scene.expect(Scene.role("link", { name: "Watch the demo" })).toHaveAttr("href", "/demo"),
      Scene.expect(Scene.role("link", { name: "Run it yourself" })).toHaveAttr("href", "/try"),
      Scene.expect(Scene.role("link", { name: "GitHub repository" })).toExist(),
    );
  });

  test("a docs page renders its prose, its markdown links and the next page", () => {
    Scene.scene(
      { update, view },
      Scene.given(at(AppRoute.Doc({ slug: "get-started" }))),
      Scene.expect(Scene.role("heading", { name: "Get started", level: 1 })).toExist(),
      Scene.expect(Scene.role("heading", { name: "Install" })).toExist(),
      Scene.expect(Scene.role("link", { name: "View as Markdown" })).toHaveAttr(
        "href",
        "/docs/get-started.md",
      ),
      Scene.expect(Scene.role("button", { name: "Copy page as Markdown" })).toExist(),
      Scene.expect(Scene.text("Run the demo yourself", { exact: false })).toExist(),
    );
  });

  test("a docs example shows its code, and what running it printed on request", () => {
    Scene.scene(
      { update, view },
      Scene.given(at(AppRoute.Doc({ slug: "watched-browsing" }))),
      Scene.expect(Scene.role("tab", { name: "Code" })).toHaveAttr("aria-selected", "true"),
      Scene.expect(
        Scene.text("on air, 1 ms after the time asked for", { exact: false }),
      ).not.toExist(),
      Scene.click(Scene.role("tab", { name: "Result" })),
      Scene.expect(Scene.role("tab", { name: "Result" })).toHaveAttr("aria-selected", "true"),
      Scene.expect(Scene.text("on air, 1 ms after the time asked for", { exact: false })).toExist(),
    );
  });

  test("an unknown docs page and an unknown path are not found", () => {
    Scene.scene(
      { update, view },
      Scene.given(at(AppRoute.Doc({ slug: "nope" }))),
      Scene.expect(Scene.role("heading", { name: "Nothing here" })).toExist(),
    );
    Scene.scene(
      { update, view },
      Scene.given(at(AppRoute.NotFound({ path: "/elsewhere" }))),
      Scene.expect(Scene.text("No page at /elsewhere.", { exact: false })).toExist(),
    );
  });
});

/** The blocks in `blocks`, at any depth, outside `:::Example` directives, and the directives. */
const outside = (
  blocks: ReadonlyArray<Markdown.Block>,
): ReadonlyArray<Markdown.Block | Markdown.Island> =>
  blocks.flatMap((block) =>
    block._tag === "Island"
      ? block.name === "Example"
        ? [block]
        : outside(block.blocks)
      : block._tag === "List"
        ? block.items.flatMap((item) => outside(item.blocks))
        : block._tag === "Blockquote"
          ? outside(block.blocks)
          : [block],
  );

const isOutput = (block: Markdown.Block) =>
  block._tag === "CodeBlock" &&
  Option.exists(block.maybeMeta, (meta) => meta.split(/\s+/).includes("output"));

describe("docs", () => {
  test("every code block is an example, followed by what running it printed", () => {
    const blocks = pages.flatMap((page) =>
      outside(Option.getOrThrow(documentOf(page)).blocks).map((block) => ({
        page: page.slug,
        block,
      })),
    );

    const examples = blocks.flatMap(({ page, block }) =>
      block._tag === "Island" ? [{ page, island: block }] : [],
    );

    expect(
      blocks.filter(({ block }) => block._tag === "CodeBlock").map(({ page }) => page),
    ).toEqual([]);
    expect(
      examples
        .filter(
          ({ island }) =>
            island.blocks[0]?._tag !== "CodeBlock" || !island.blocks.slice(1).some(isOutput),
        )
        .map(({ page }) => page),
    ).toEqual([]);
    expect(examples.length).toBeGreaterThan(0);
  });
});
