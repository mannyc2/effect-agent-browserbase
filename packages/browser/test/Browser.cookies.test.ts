// 1d6d7c7 reported an expired native cookie deadline as Failed instead of Timeout.
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { behindProxy } from "../../../tools/testing/cdp-proxy.ts";
import * as Cdp from "../src/providers/Cdp.ts";

it.live("cookie query reports its actual native timeout", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint, actionTimeout: "100 millis" });

    proxy.hold = (command) => (command.method.endsWith("Cookies") ? 500 : 0);

    const failure = yield* browser
      .hasCookie({ name: "missing", url: "https://example.test" })
      .pipe(Effect.flip);

    assert.isTrue(proxy.commands.some((command) => command.method.endsWith("Cookies")));
    assert.strictEqual(failure.reason._tag, "Timeout");
    if (failure.reason._tag === "Timeout") assert.strictEqual(failure.reason.millis, 100);
    assert.isFalse(failure.dispatched);
  }).pipe(Effect.scoped),
);
