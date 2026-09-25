import { NodeCrypto } from "@effect/platform-node";
import { Effect } from "effect";

import { Viewport } from "../../src/BrowserData.ts";
import { type ConnectRequest, fromNativeAttempt } from "../../src/internal/browser/Binding.ts";
import type { Bindings } from "../../src/internal/browser/Bindings.ts";
import type {
  CaptureSource,
  Driver,
  DriverEvents,
  NativeNavigation,
  ReadinessState,
} from "../../src/internal/browser/Driver.ts";
import type { Ticket } from "../../src/internal/browser/Owner.ts";
import { acquireSession } from "../../src/internal/browser/Session.ts";
import { makeScriptedBrowser, type EngineTimers } from "../../src/internal/testing/Engine.ts";
import { scriptedSource } from "../../src/internal/testing/Lifetime.ts";
import {
  type ControlScript,
  type Script,
  type ScriptedCleanupResult,
  ScriptedReference,
} from "../../src/internal/testing/Script.ts";

export const gate = <A>() => {
  let resolve: (value: A) => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
};

const controls: ReadonlyArray<ControlScript> = [
  "act",
  "action",
  "button",
  "next",
  "other",
  "ready",
  "scout",
  "target",
  "must-not-dispatch",
].map((id) => ({ id, kind: "button" as const, label: id }));

const addresses = ["", "slow", "first", "second", "next", "other"];

/**
 * Every address the owner tests navigate to shows the same page, so a test is about the owner's
 * decisions rather than about any one document.
 */
export const ownerScript: Script = {
  documents: addresses.map((path) => ({
    url: `https://example.test/${path}`,
    text: "initial",
    controls,
  })),
};

export interface OwnerOptions {
  readonly script?: Script;
  readonly keepAlive?: boolean;
  readonly lifetimeMillis?: number;
  readonly actionMillis?: number;
  readonly maxActions?: number;
  readonly maxHostReads?: number;
  readonly disconnectFails?: boolean;
  readonly captureSource?: CaptureSource;
  readonly onDisconnect?: () => void;
  readonly onClick?: (ticket: Ticket) => Promise<string>;
  /** Script a navigation that stays in flight: the test settles or stops it. */
  readonly onNavigate?: (url: string, pageId: string) => NativeNavigation;
  readonly onObserve?: (events: DriverEvents) => Promise<void>;
  readonly onConnect?: (driver: Driver, events: DriverEvents) => Promise<Driver>;
  /** Script the document-readiness state the owner must respect before dependent work. */
  readonly readiness?: () => ReadinessState;
  readonly connectBindings?: Bindings<never>["connect"];
}

/**
 * The real owner over the scripted engine, with native behaviour a test replaces where the
 * engine offers no script for it. The lifetime is the scripted one: no provider is involved.
 */
export const fixture = Effect.fnUntraced(function* (options: OwnerOptions = {}) {
  const reports: Array<ScriptedCleanupResult> = [];
  const context = yield* Effect.context<never>();

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

  const browser = makeScriptedBrowser(options.script ?? ownerScript, timers);

  const state = {
    connects: 0,
    localCloses: 0,
    readinessChecks: 0,
    /** Clicks the engine dispatched and completed; a test's own `onClick` counts its own. */
    clicks: 0,
    /** Every native input command the owner dispatched, in order, without typed text. */
    input: [] as Array<string>,
    get releases() {
      return reports.length;
    },
  };

  const attempt = async (request: ConnectRequest) => {
    state.connects++;
    const engine = browser.connect(request.options, request.events);
    const { events } = request;

    const driver: Driver = {
      ...engine,
      click:
        options.onClick === undefined
          ? async (...args) => {
              const url = await engine.click(...args);

              state.clicks++;

              return url;
            }
          : async (_target, ticket, capture) => {
              let url = "";

              const input = await capture(
                async () => {
                  url = await options.onClick!(ticket);
                },
                { position: null },
              );

              return { url, input };
            },
      ...(options.onNavigate === undefined
        ? {}
        : {
            beginNavigation: async (url, _timeoutMillis, ticket) => {
              ticket.dispatch();
              events.invalidate("target-changed");

              return options.onNavigate!(url, engine.selected().pageId);
            },
          }),
      observe: async (...args) => {
        await options.onObserve?.(events);

        return engine.observe(...args);
      },
      documentReadiness: async (ticket, target) => {
        ticket.check();
        state.readinessChecks++;

        return options.readiness?.() ?? engine.documentReadiness(ticket, target);
      },
      pointerMove: async (to, ticket, target) => {
        const result = await engine.pointerMove(to, ticket, target);

        state.input.push(`move ${engine.selected().pageId} ${to.x},${to.y}`);

        return result;
      },
      hover: async (element, ticket, policy, target) => {
        const result = await engine.hover(element, ticket, policy, target);

        state.input.push(`hover ${engine.selected().pageId}`);

        return result;
      },
      wheel: async (deltaX, deltaY, at, ticket, target) => {
        const result = await engine.wheel(deltaX, deltaY, at, ticket, target);

        state.input.push(`wheel ${engine.selected().pageId} ${deltaX},${deltaY}`);

        return result;
      },
      press: async (key, modifiers, into, ticket, policy, target) => {
        const result = await engine.press(key, modifiers, into, ticket, policy, target);

        state.input.push(`press ${engine.selected().pageId} ${[...modifiers, key].join("+")}`);

        return result;
      },
      type: async (text, into, ticket, policy, target) => {
        const result = await engine.type(text, into, ticket, policy, target);

        state.input.push(`type ${engine.selected().pageId} ${[...text].length}`);

        return result;
      },
      ...(options.captureSource === undefined
        ? {}
        : {
            capture: async (target) => ({
              ...(await engine.capture(target)),
              source: options.captureSource!,
            }),
          }),
      disconnect: async () => {
        state.localCloses++;
        options.onDisconnect?.();
        await engine.disconnect();
        if (options.disconnectFails) throw new Error("PRIVATE-DISCONNECT");
      },
    };

    return options.onConnect === undefined ? driver : options.onConnect(driver, events);
  };

  const reference = ScriptedReference.make({ provider: "scripted", id: "owner-1" });

  const lifetime = scriptedSource(reference, (result) =>
    Effect.sync(() => {
      reports.push(result);
    }),
  );

  const acquisition = acquireSession(
    {
      maxActions: options.maxActions ?? 20,
      maxHostReads: options.maxHostReads ?? 10_000,
      maxElapsedMillis: options.lifetimeMillis ?? 5000,
      actionTimeoutMillis: options.actionMillis ?? 1000,
    },
    {
      implementation: "scripted",
      engine: fromNativeAttempt((request) => attempt(request)),
      // Reconnection is verified by the lifetime; a scripted browser is always still there.
      remote: (cleanup, deadline) =>
        lifetime(cleanup, deadline).pipe(
          Effect.map((lease) => ({ ...lease, verifyReconnect: Effect.void })),
        ),
      keepAlive: options.keepAlive ?? false,
      maxReturnedBytes: 65536,
      driver: {
        viewport: Viewport.make({ width: 640, height: 480 }),
        popupPolicy: "retain",
        dialogPolicy: "dismiss",
        maxPages: 10,
      },
      ...(options.connectBindings === undefined
        ? {}
        : { connectBindings: options.connectBindings }),
    },
  ).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.flatMap((acquired) =>
      Effect.cached(acquired.connect).pipe(
        Effect.map((connected) => ({
          ...acquired,
          rawConnect: acquired.connect,
          connect: connected,
        })),
      ),
    ),
  );

  return {
    acquisition,
    control: browser.control,
    reports,
    state,
  };
});
