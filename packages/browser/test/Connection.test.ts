// A provider session and target survive reconnects; document evidence belongs to one connection.
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Option, Random, Schema, Stream } from "effect";

import * as Cdp from "../src/Cdp.ts";
import { Frame } from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";
import { behindProxy } from "./protocol.ts";

const html = (title: string) => `data:text/html,${encodeURIComponent(`<h1>${title}</h1>`)}`;

const first = (page: Page) =>
  page
    .screencast()
    .pipe(Stream.runHead, Effect.map(Option.getOrThrow), Effect.timeout("5 seconds"));

it.live("reattachment gives document evidence a fresh connection identity", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();

    const one = yield* Cdp.open({ endpoint: proxy.endpoint, id: "same-session" }).pipe(
      Random.withSeed("reconnect"),
    );

    const page = yield* one.firstPage;

    yield* page.goto(html("one"));
    yield* page.goto(html("two"));
    const before = yield* first(page);

    const two = yield* Cdp.open({ endpoint: proxy.endpoint, id: "same-session" }).pipe(
      Random.withSeed("reconnect"),
    );

    const reattached = Option.getOrThrow(yield* two.page(page.id));
    const after = yield* first(reattached);
    const screenshot = yield* reattached.frame();

    assert.isString(one.connection);
    assert.isAbove(one.connection.length, 0);
    assert.notStrictEqual(one.connection, two.connection);
    assert.strictEqual(one.id, two.id);
    assert.strictEqual(before.page, after.page);
    assert.strictEqual(before.session, after.session);
    assert.isAbove(before.document, after.document, "each connection counts its documents anew");
    assert.strictEqual(before.connection, one.connection);
    assert.strictEqual(after.connection, two.connection);
    assert.strictEqual(screenshot.connection, two.connection);

    const wire = yield* Schema.encodeEffect(Frame)(after);
    const json = Schema.fromJsonString(Schema.toCodecJson(Frame));
    const serialized = yield* Schema.encodeEffect(json)(after);
    const decoded = yield* Schema.decodeEffect(json)(serialized);

    assert.deepStrictEqual(
      [decoded.connection, decoded.page, decoded.document],
      [two.connection, page.id, after.document],
    );
    const { connection: _connection, ...ambiguous } = wire;

    assert.isTrue(
      Exit.isFailure(yield* Schema.decodeUnknownEffect(Frame)(ambiguous).pipe(Effect.exit)),
    );
  }),
);
