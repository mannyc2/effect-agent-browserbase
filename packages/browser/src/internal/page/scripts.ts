/** Main-world scripts with the page lane, document binding, policy and dispatch accounting. */
import { Effect, Schema } from "effect";

import { Current } from "../../Action.ts";
import {
  undispatched,
  Failed,
  NotActionable,
  Threw,
  failWith,
  refuse,
} from "../../BrowserError.ts";
import { InputRequest, type Page } from "../../Page.ts";
import * as Url from "../../Url.ts";
import type { Input } from "../input/actions.ts";
import type { Bridge } from "./bridge.ts";
import type { PageContext } from "./context.ts";

export const make = (page: PageContext, bridge: Bridge, input: Input) => {
  const document = () => bridge.frameTag().document;

  const changed = (operation: string) =>
    failWith(operation, new NotActionable({ detail: "the script's document changed" }));

  const evaluate = <Arg>(operation: string, script: (arg: Arg) => unknown, arg: Arg) =>
    page
      .native(operation, () =>
        Promise.resolve<unknown>(
          Reflect.apply(page.playwright.evaluate.bind(page.playwright), undefined, [script, arg]),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          error.reason._tag === "Failed" ? undispatched(operation, new Threw({})) : error,
        ),
      );

  const decode = <A>(operation: string, result: Schema.Codec<A, unknown>, value: unknown) =>
    Schema.decodeUnknownEffect(result)(value).pipe(
      Effect.mapError(() =>
        undispatched(operation, new Failed({ detail: "script result did not match its schema" })),
      ),
    );

  const read: Page["read"] = (script, options) =>
    page.lane
      .read("read")(
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = document();
            const value = yield* Effect.result(evaluate("read", script, options.arg));

            if (document() !== before) continue;
            if (value._tag === "Failure") return yield* value.failure;

            return {
              value: yield* decode("read", options.result, value.success),
              document: before,
              connection: page.connection,
            };
          }

          return yield* changed("read");
        }).pipe(page.within("read")),
      )
      .pipe(page.span("Page.read"), page.owned);

  const act: Page["act"] = (script, options) =>
    Effect.suspend(() => {
      if (!Number.isSafeInteger(options.document) || options.document < 0)
        return refuse("act", "document must be a nonnegative safe integer");

      const same = Effect.suspend(() =>
        document() === options.document &&
        (options.connection === undefined || options.connection === page.connection)
          ? Effect.void
          : changed("act"),
      );

      // Scripts have no DOM target. An opaque scripted request must still pass the guard; neither
      // source nor arguments are evidence for a judge or material for the event history.
      const prepare = same.pipe(
        Effect.as({
          request: new InputRequest({
            page: page.id,
            url: Url.redact(page.playwright.url()),
            title: "",
            action: { _tag: "Act", document: options.document },
            facts: ["scripted", "opaque"],
            context: {},
          }),
          validate: same.pipe(Effect.as({ contextId: 0, check: () => same })),
        }),
      );

      return input
        .perform("act", {}, page.settings.actionTimeout, prepare, (marks) =>
          same.pipe(
            Effect.andThen(marks.sent),
            Effect.andThen(evaluate("act", script, options.arg)),
            Effect.flatMap((value) =>
              same.pipe(Effect.andThen(decode("act", options.result, value))),
            ),
          ),
        )
        .pipe(Effect.provideService(Current, { _tag: "Act", document: options.document }));
    });

  return { read, act };
};
