import { Effect, Redacted, type Scope } from "effect";

import type { OpenOptions } from "./Browser.ts";
import { type AutomationOptions, BrowserPolicy, type Viewport } from "./BrowserData.ts";
import { type BrowserBinding, make as makeRuntime } from "./BrowserRuntime.ts";
import { BrowserError, Reasons, type InitializationError } from "./Errors.ts";
import { fromNativeAttempt, issueBinding, type NativeAttempt } from "./internal/browser/Binding.ts";
import { checked } from "./internal/browser/PublicSession.ts";
import {
  makeScriptedBrowser,
  type EngineTimers,
  type ScriptedBrowser,
} from "./internal/testing/Engine.ts";
import { jpegFrame } from "./internal/testing/Frame.ts";
import { scriptedSource } from "./internal/testing/Lifetime.ts";
import {
  Script,
  ScriptedReference,
  type ScriptedCleanupResult,
  type ScriptedControl,
  type ScriptedSession,
} from "./internal/testing/Script.ts";

export {
  ControlFactsScript,
  ControlScript,
  DocumentScript,
  ScriptableOperation,
  Script,
  ScriptedCleanupIssue,
  ScriptedCleanupResult,
  ScriptedReference,
} from "./internal/testing/Script.ts";

export type {
  BindingReply,
  Gate,
  RecordedCall,
  ScriptedConnection,
  ScriptedControl,
  ScriptedFrame,
  ScriptedOutcome,
  ScriptedSession,
} from "./internal/testing/Script.ts";

/**
 * How a scripted browser is opened. The defaults are the ones a Chromium launch would use: an
 * unrestricted policy of 100 actions, five minutes and 2 MiB, a 1280×720 viewport and a
 * ten-second action timeout.
 */
export interface ScriptedOptions<E = never, R = never> extends OpenOptions<E, R> {
  readonly policy?: BrowserPolicy;
  readonly automation?: AutomationOptions;
  readonly viewport?: Viewport;
  readonly onCleanup?: (result: ScriptedCleanupResult) => Effect.Effect<void>;
}

/**
 * The scripted engine as an opaque binding. Connections to one address reach one browser, so a
 * reconnection finds the pages it left; each browser has one control handle.
 */
export interface ScriptedBinding {
  readonly binding: BrowserBinding;
  /** One control for each browser connected to so far, in first-connection order. */
  readonly browsers: Effect.Effect<ReadonlyArray<ScriptedControl>>;
}

let references = 0;

const makeEngine = Effect.fnUntraced(function* (script: Script) {
  // Time for an in-flight navigation follows the clock this browser was opened under, so a
  // TestClock advances it and nothing real elapses.
  const context = yield* Effect.context<never>();
  const browsers = new Map<string, ScriptedBrowser>();

  const timers: EngineTimers = {
    sleep: (millis) => {
      const controller = new AbortController();

      const done = Effect.runPromiseWith(context)(Effect.sleep(millis), {
        signal: controller.signal,
      });

      void done.catch(() => {});

      return { done, cancel: () => controller.abort() };
    },
  };

  // The provider's address names the browser: the same address reaches the same pages again.
  const attempt: NativeAttempt = async (request) => {
    const address = Redacted.isRedacted(request.connection)
      ? String(Redacted.value(request.connection))
      : String(request.connection);

    let browser = browsers.get(address);

    if (browser === undefined) {
      browser = makeScriptedBrowser(script, timers);
      browsers.set(address, browser);
    }

    return browser.connect(request.options, request.events);
  };

  const binding = issueBinding({ _tag: "BrowserBinding" as const }, fromNativeAttempt(attempt));

  return { binding, controls: () => [...browsers.values()].map((browser) => browser.control) };
});

/**
 * Open one scripted browser in the caller's Scope. The session is the real owner over a
 * scripted native engine: admission, budgets, staleness, dispatch evidence, capture, page holds
 * and typed callbacks are the production code paths. Only the page and its outcomes are scripted.
 */
export const open = Effect.fnUntraced(function* <E = never, R = never>(
  script: Script,
  options: ScriptedOptions<E, R> = {},
): Effect.fn.Return<
  ScriptedSession<E>,
  BrowserError | InitializationError | E,
  Scope.Scope | Exclude<R, Scope.Scope>
> {
  const fixed = yield* checked(Script, script, "configure");

  const policy = yield* checked(
    BrowserPolicy,
    options.policy ?? BrowserPolicy.unrestricted(),
    "configure",
  );

  const engine = yield* makeEngine(fixed);

  const runtime = yield* makeRuntime({
    implementation: "scripted",
    binding: engine.binding,
    ...(options.automation === undefined ? {} : { automation: options.automation }),
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
  });

  const reference = Object.freeze(
    ScriptedReference.make({ provider: "scripted", id: `scripted-${++references}` }),
  );

  const acquired = yield* runtime.acquire(
    policy,
    scriptedSource(reference, options.onCleanup),
    options.bootstrap === undefined ? {} : { bootstrap: options.bootstrap },
  );

  const connection = yield* acquired.connect;
  const control = engine.controls().at(-1);

  if (control === undefined)
    return yield* BrowserError.make({
      operation: "connect",
      reason: Reasons.Provider.make({}),
      outcome: "unknown",
    });

  return Object.assign(connection.session, {
    reference,
    control,
    closeChecked: connection.session.closeChecked.pipe(
      Effect.andThen(acquired.lifetime.closeChecked),
    ),
    close: acquired.close,
    cleanupResult: acquired.lifetime.cleanupResult,
  }) satisfies ScriptedSession<E>;
});

/**
 * The same engine for a provider Layer built on `browser-runtime`, such as
 * `BrowserbaseBrowser.layer` with `BrowserBinding.layer(binding)`. Each address the Layer
 * connects to is one browser with one control handle; reconnecting to it finds its pages.
 */
export const binding = Effect.fnUntraced(function* (
  script: Script,
): Effect.fn.Return<ScriptedBinding, BrowserError> {
  const fixed = yield* checked(Script, script, "configure");
  const engine = yield* makeEngine(fixed);

  return {
    binding: engine.binding,
    browsers: Effect.sync(engine.controls),
  };
});

/** A valid 64×48 JPEG: the default bytes of a scripted capture frame, for a caller's own frames. */
export const jpeg = jpegFrame;
