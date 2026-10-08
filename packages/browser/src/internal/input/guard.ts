/**
 * The input guard's host side. It asks the page what an action would touch, builds the request a
 * policy decides on, binds an approval to the document and targets it saw, and runs the page
 * script's changes in the approved document only.
 */
import { Effect } from "effect";

import { type BrowserError, InvalidRequest, NotActionable, StaleRef } from "../../BrowserError.ts";
import { InputRequest, redacted } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { contextGone, decodeWith, failWith, type PageContext } from "../page/context.ts";
import * as Url from "../page/url.ts";
import * as Script from "./guard.inpage.ts";

export interface Approval {
  readonly contextId: number;
  readonly check: (options?: Script.ValidationOptions) => Effect.Effect<void, BrowserError>;
}

export interface PolicyPlan {
  readonly request: InputRequest;
  readonly validate: Effect.Effect<Approval, BrowserError>;
}

// A ref that names nothing is stale on every path, named by the target that failed.
export const inputFailure = (
  operation: string,
  targets: Script.InputPlan["targets"],
  failure: Script.InputFailure,
) => {
  const target = failure.index === undefined ? undefined : targets[failure.index];

  return failWith(
    operation,
    failure.error === "outside"
      ? new InvalidRequest({ detail: failure.detail })
      : failure.error === "stale" && typeof target === "string"
        ? new StaleRef({ ref: target })
        : new NotActionable({ detail: failure.detail }),
  );
};

export const editFailure = (
  operation: string,
  ref: string,
  failure: { readonly error: string; readonly stale?: boolean | undefined },
) =>
  failWith(
    operation,
    failure.stale === true ? new StaleRef({ ref }) : new NotActionable({ detail: failure.error }),
  );

export const make = (page: PageContext, bridge: Bridge) => {
  const { id } = page;
  const { current, evaluateIn, evaluateWithContext } = bridge;

  const preparePolicy = (
    action: string,
    info: { readonly target?: string | undefined; readonly text?: string | undefined },
    targets: Script.InputPlan["targets"],
    flags: {
      readonly submit?: boolean;
      readonly keys?: string;
      readonly destination?: string;
    } = {},
  ): Effect.Effect<PolicyPlan, BrowserError> =>
    Effect.gen(function* () {
      for (const target of targets) {
        if (typeof target === "string" && !/^e\d+$/.test(target))
          return yield* failWith(
            action,
            new InvalidRequest({ detail: `"${target}" is not a ref; refs look like e12` }),
          );
        if (
          target !== null &&
          typeof target !== "string" &&
          (!Number.isFinite(target.x) || !Number.isFinite(target.y))
        )
          return yield* failWith(
            action,
            new InvalidRequest({ detail: "point coordinates must be finite" }),
          );
      }

      const input: Script.InputPlan = {
        action,
        targets,
        submit: flags.submit ?? false,
        keys: flags.keys ?? null,
        destination: flags.destination ?? null,
      };

      const { contextId, value } = yield* evaluateWithContext(
        action,
        scriptCall("prepareInput", input),
      );

      const prepared = yield* decodeWith(action, Script.PreparedInputResultSchema)(value);

      if ("error" in prepared) return yield* inputFailure(action, targets, prepared);
      const first = prepared.targets[0];
      const target = targets[0];
      const { title, description, dialog, heading, nearby, form } = prepared.evidence;

      // A guard may hand the request to a judge's model, so its addresses keep no secrets.
      const request = new InputRequest({
        page: id,
        url: Url.redact(prepared.url),
        title,
        action,
        target: info.target,
        text:
          info.text !== undefined && action === "type" && first?.secret === true
            ? redacted
            : info.text,
        element: first?.element,
        role: first?.role,
        name: first?.name,
        description,
        href: first?.href === undefined ? undefined : Url.redact(first.href),
        point: target !== null && typeof target === "object" ? target : undefined,
        destination:
          prepared.destination === undefined ? undefined : Url.redact(prepared.destination),
        facts: prepared.facts,
        context: { dialog, heading, nearby },
        form,
      });

      const check = (options: Script.ValidationOptions = {}) =>
        evaluateIn(action, scriptCall("validateInput", input, prepared, options), contextId).pipe(
          Effect.catchIf(contextGone, () =>
            failWith(
              action,
              new NotActionable({ detail: "the page changed while input policy was pending" }),
            ),
          ),
          Effect.flatMap(decodeWith(action, Script.ValidatedInputResultSchema)),
          Effect.flatMap((result) =>
            "error" in result ? inputFailure(action, targets, result) : Effect.void,
          ),
        );

      const validate = check().pipe(
        Effect.as<Approval>({
          contextId,
          check,
        }),
      );

      return { request, validate };
    });

  // `mayHaveRun` hears of a failure the script may have started before: without its context or
  // the library's API in it, the call never ran.
  const mutate = (
    operation: string,
    call: string,
    approval: Approval | undefined,
    mayHaveRun: Effect.Effect<void> = Effect.void,
  ) =>
    (approval === undefined ? current(operation) : Effect.succeed(approval.contextId)).pipe(
      Effect.flatMap((contextId) =>
        evaluateIn(operation, call, contextId).pipe(
          Effect.tapError((error) =>
            error.reason._tag === "Failed" &&
            /Cannot find context|__effectBrowser/i.test(error.reason.detail)
              ? Effect.void
              : mayHaveRun,
          ),
        ),
      ),
      Effect.catchIf(contextGone, () =>
        failWith(
          operation,
          new NotActionable({ detail: "the page changed before the approved input could run" }),
        ),
      ),
    );

  return { preparePolicy, mutate };
};

export type Guard = ReturnType<typeof make>;
