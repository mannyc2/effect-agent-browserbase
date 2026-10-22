/** Owned CDP faults selected by method/session and canonical operation labels. */
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import type { BrowserContext, CDPSession, Page as NativePage } from "playwright-core";

import * as Port from "../../src/internal/page/port.ts";

export class Fault extends Data.TaggedError("TestCdpFault")<{ readonly cause: unknown }> {}

const Native = Context.Reference<
  | { readonly sessions: Set<Port.Session>; readonly contexts: Map<string, BrowserContext> }
  | undefined
>("effect-browser/test/Native", { defaultValue: () => undefined });

export interface Match {
  readonly channel?: Port.Session["channel"] | undefined;
  readonly page?: string | undefined;
  readonly method?: string | { readonly prefix: string } | undefined;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  readonly operation?: string | undefined;
  readonly script?: string | undefined;
}

export interface Call extends Port.Event {
  readonly session: Port.Session;
  readonly operation: string | undefined;
  readonly script: string | undefined;
  readonly at: number;
}

export type Action =
  | { readonly _tag: "Delay"; readonly duration: Duration.Input }
  | { readonly _tag: "Hold"; readonly gate: Deferred.Deferred<void> | Effect.Effect<void, Fault> }
  | { readonly _tag: "Drop"; readonly acknowledge?: boolean }
  | { readonly _tag: "Reply"; readonly value: unknown }
  | { readonly _tag: "Fail"; readonly error: Error }
  | { readonly _tag: "Transform"; readonly reply: (value: unknown) => unknown };

interface Rule {
  readonly match: Match;
  readonly action: Action;
  readonly phase: "before" | "after" | "event";
  remaining: number;
  readonly until: number | undefined;
}

const matches = (match: Match, call: Call) =>
  (match.channel === undefined || match.channel === call.session.channel) &&
  (match.page === undefined || match.page === call.session.page) &&
  (match.method === undefined ||
    (typeof match.method === "string"
      ? match.method === call.method
      : call.method.startsWith(match.method.prefix))) &&
  (match.params === undefined ||
    (typeof call.params === "object" &&
      call.params !== null &&
      Object.entries(match.params).every(([key, value]) =>
        Object.is(Reflect.get(call.params!, key), value),
      ))) &&
  (match.operation === undefined || match.operation === call.operation) &&
  (match.script === undefined || match.script === call.script);

type EventName = Parameters<CDPSession["on"]>[0];

const Target = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) });

// The test adapter owns event delivery; it subscribes to named events supported by every provider.
const pageAdapter = (session: Port.Session, native: CDPSession, hooks: Port.Hooks): CDPSession => {
  const listeners = new Map<string | symbol, Set<(value: unknown) => void>>();

  const emit = (method: string, params: unknown) => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };

  const deliver = ({ method, params }: Port.Event) => {
    const run = ({ method, params }: Port.Event) => {
      emit(method, params);
    };

    if (hooks.event === undefined) run({ method, params });
    else hooks.event(session, { method, params }, run);
  };

  const nativeListeners = new Map<EventName, (params: unknown) => void>();
  const released = hooks.opened?.(session, ({ method, params }) => emit(method, params));

  const cleanup = () => {
    for (const [name, listener] of nativeListeners) native.off(name, listener);
    nativeListeners.clear();
    listeners.clear();
    released?.();
  };

  const sending = hooks.send?.(session, native.send.bind(native)) ?? native.send.bind(native);

  const send: CDPSession["send"] = async (method, params) => {
    const result = await sending(method, params);

    if (method === "Target.getTargetInfo" && session.channel === "page")
      Option.match(Schema.decodeUnknownOption(Target)(result), {
        onNone: () => {},
        onSome: ({ targetInfo }) => {
          session.page = targetInfo.targetId;
        },
      });

    return result;
  };

  let proxy: CDPSession;

  const on = (name: EventName, listener: (value: unknown) => void) => {
    const registered = listeners.get(name) ?? new Set();

    registered.add(listener);
    listeners.set(name, registered);
    if (!nativeListeners.has(name)) {
      const receive = (params: unknown) => deliver({ method: String(name), params });

      nativeListeners.set(name, receive);
      native.on(name, receive);
    }

    return proxy;
  };

  const off = (name: EventName, listener: (value: unknown) => void) => {
    listeners.get(name)?.delete(listener);

    return proxy;
  };

  proxy = new Proxy(native, {
    get(target, key, receiver): unknown {
      if (key === "send") return send;
      if (key === "on" || key === "addListener") return on;
      if (key === "off" || key === "removeListener") return off;
      if (key === "once")
        return (name: EventName, listener: (value: unknown) => void) => {
          const once = (value: unknown) => {
            off(name, once);
            listener(value);
          };

          return on(name, once);
        };
      if (key === "detach") return () => native.detach().finally(cleanup);

      return Reflect.get(target, key, receiver);
    },
  });

  return proxy;
};

export const make = Effect.fnUntraced(function* () {
  const context = yield* Effect.context<never>();
  const clock = yield* Clock.Clock;
  const signal = yield* Effect.abortSignal;
  const outer = yield* Native;
  const nativeSessions = outer?.sessions ?? new Set<Port.Session>();
  const nativeContexts = outer?.contexts ?? new Map<string, BrowserContext>();
  const registry = { sessions: nativeSessions, contexts: nativeContexts };
  const ownedNative = new Set<Port.Session>();
  const ownedContexts = new Map<string, BrowserContext>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of ownedNative) nativeSessions.delete(session);
      for (const [id, context] of ownedContexts)
        if (nativeContexts.get(id) === context) nativeContexts.delete(id);
    }),
  );
  const senders = new Map<Port.Session, CDPSession["send"]>();

  const observers: Array<
    (
      call: Call,
      phase: "before" | "received" | "after" | "settled" | "event",
      reply: unknown,
    ) => void
  > = [];

  const rules: Array<Rule> = [];
  const calls: Array<Call> = [];
  const sessions = new Map<Port.Session, (event: Port.Event) => void>();
  let changed = Deferred.makeUnsafe<void>();

  const pulse = () => {
    Deferred.doneUnsafe(changed, Effect.void);
    changed = Deferred.makeUnsafe();
  };

  const record = (call: Call) => {
    calls.push(call);
    pulse();
  };

  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseExitWith(context)(effect, { signal }).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.squash(exit.cause);

      throw failure instanceof Fault ? failure.cause : failure;
    });

  const apply = (call: Call, phase: Rule["phase"], value: unknown) =>
    Effect.gen(function* () {
      let reply = value;

      for (const rule of rules) {
        if (
          rule.remaining === 0 ||
          (rule.until !== undefined && call.at >= rule.until) ||
          rule.phase !== phase ||
          !matches(rule.match, call)
        )
          continue;
        rule.remaining--;
        switch (rule.action._tag) {
          case "Delay":
            yield* Effect.sleep(rule.action.duration);
            break;
          case "Hold":
            yield* Effect.isEffect(rule.action.gate)
              ? rule.action.gate
              : Deferred.await(rule.action.gate);
            break;
          case "Drop": {
            const sessionId =
              typeof call.params === "object" && call.params !== null
                ? Reflect.get(call.params, "sessionId")
                : undefined;

            const send = senders.get(call.session);

            if (
              rule.action.acknowledge &&
              call.method === "Page.screencastFrame" &&
              typeof sessionId === "number" &&
              send !== undefined
            )
              yield* Effect.tryPromise({
                try: () => send("Page.screencastFrameAck", { sessionId }),
                catch: (cause) => new Fault({ cause }),
              });

            return yield* Effect.never;
          }
          case "Reply":
            return rule.action.value;
          case "Fail":
            return yield* new Fault({ cause: rule.action.error });
          case "Transform":
            reply = rule.action.reply(reply);
            break;
        }
      }

      return reply;
    });

  const command = (
    session: Port.Session,
    method: string,
    params: unknown,
    send: () => Promise<unknown>,
  ) => {
    const call = {
      session,
      method,
      params,
      at: Number(session.clock.monotonicTimeNanosUnsafe()) / 1e6,
      ...Port.labels(),
    };

    record(call);
    for (const observe of observers) observe(call, "before", undefined);

    return run(
      Effect.gen(function* () {
        const supplied = yield* apply(call, "before", undefined);

        const reply =
          supplied === undefined
            ? yield* Effect.tryPromise({ try: send, catch: (cause) => new Fault({ cause }) })
            : supplied;

        for (const observe of observers) observe(call, "received", reply);
        const result = yield* apply(call, "after", reply);

        for (const observe of observers) observe(call, "after", result);

        return result;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const observe of observers) observe(call, "settled", undefined);
          }),
        ),
        Effect.provideService(Clock.Clock, session.clock),
      ),
    );
  };

  const hooks: Port.Hooks = {
    page: (session, native) => pageAdapter(session, native, hooks),
    query: (session, method, run) => command(session, method, undefined, run),
    native: <A>(
      page: string,
      method: "keyboard.down" | "keyboard.up" | "goto",
      params: Readonly<Record<string, unknown>>,
      send: () => Promise<A>,
    ): Promise<A> => {
      const session = [...nativeSessions].find((session) => session.page === page);

      if (session === undefined) throw new Error("native call has no registered session");

      return command(session, method, params, send) as Promise<A>;
    },
    browser: (connection, context) => {
      nativeContexts.set(connection, context);
      ownedContexts.set(connection, context);

      return () => {};
    },
    beforeOpen: (session) =>
      command(session, "$open", undefined, () => Promise.resolve()).then(() => undefined),
    send: (session, send) => {
      senders.set(session, send);

      return ((method, params) =>
        command(session, method, params, () => send(method, params))) as CDPSession["send"];
    },
    capture: (session, send) => (method, params) =>
      command(session, method, params, () => send(method, params)),
    event: (session, event, deliver) => {
      const call = {
        session,
        ...event,
        at: Number(session.clock.monotonicTimeNanosUnsafe()) / 1e6,
        ...Port.labels(),
      };

      record(call);
      for (const observe of observers) observe(call, "event", event.params);
      void run(
        apply(call, "event", event.params).pipe(Effect.provideService(Clock.Clock, session.clock)),
      ).then(
        (params) => {
          if (!signal.aborted) deliver({ ...event, params });
        },
        (error: unknown) => {
          if (!signal.aborted) deliver({ method: "close", params: error });
        },
      );
    },
    opened: (session, inject) => {
      sessions.set(session, inject);
      nativeSessions.add(session);
      ownedNative.add(session);
      pulse();

      return () => {
        sessions.delete(session);
        senders.delete(session);
        pulse();
      };
    },
  };

  const waitUntil = (predicate: (calls: ReadonlyArray<Call>) => boolean): Effect.Effect<void> =>
    Effect.suspend(() =>
      predicate(calls)
        ? Effect.void
        : Deferred.await(changed).pipe(Effect.andThen(waitUntil(predicate))),
    );

  const nativePage = (page: string) =>
    [...nativeSessions].find((session) => session.page === page && session.nativePage !== undefined)
      ?.nativePage;

  return {
    hooks,
    registry,
    nativePage,
    observe: (observer: (typeof observers)[number]) => {
      observers.push(observer);
    },
    calls,
    rule: (
      match: Match,
      action: Action,
      options: {
        readonly phase?: Rule["phase"];
        readonly times?: number;
        readonly duration?: Duration.Input;
      } = {},
    ) => {
      const rule: Rule = {
        match,
        action,
        phase: options.phase ?? "before",
        remaining: options.times ?? Infinity,
        until:
          options.duration === undefined
            ? undefined
            : Number(clock.monotonicTimeNanosUnsafe()) / 1e6 +
              Duration.toMillis(Duration.fromInputUnsafe(options.duration)),
      };

      rules.push(rule);

      return () => {
        rule.remaining = 0;
      };
    },
    waitUntil,
    injectUnsafe: (match: Pick<Match, "channel" | "page">, event: Port.Event) => {
      for (const [session, inject] of sessions)
        if (matches(match, { session, ...event, operation: undefined, script: undefined, at: 0 }))
          inject(event);
    },
    inject: (match: Pick<Match, "channel" | "page">, event: Port.Event) =>
      Effect.sync(() => {
        for (const [session, inject] of sessions)
          if (matches(match, { session, ...event, operation: undefined, script: undefined, at: 0 }))
            inject(event);
      }),
    native: (page: string): Effect.Effect<NativePage, Fault> =>
      Effect.suspend(() => {
        const native = nativePage(page);

        return native === undefined
          ? Effect.fail(new Fault({ cause: `no native fixture for page ${page}` }))
          : Effect.succeed(native);
      }),
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Port.Current, hooks),
        Effect.provideService(Native, registry),
      ),
  };
});

export const isolated = <A, E, R>(
  body: (handle: Effect.Success<ReturnType<typeof make>>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* make();

      return yield* handle.provide(body(handle));
    }),
  );

export class TestCdp extends Context.Service<TestCdp, Effect.Success<ReturnType<typeof make>>>()(
  "effect-browser/test/TestCdp",
) {}

export const nativePage = (page: { readonly id: string }): NativePage => {
  const native = [...(Fiber.getCurrent()?.getRef(Native)?.sessions ?? [])].find(
    (session) => session.page === page.id,
  )?.nativePage;

  if (native === undefined)
    throw new Error(`no native fixture for page ${page.id}; provide TestCdp.layer or withCdp`);

  return native;
};

export const nativeContext = (browser: { readonly connection: string }): BrowserContext => {
  const context = Fiber.getCurrent()?.getRef(Native)?.contexts.get(browser.connection);

  if (context === undefined)
    throw new Error("no native context fixture; provide TestCdp.layer or withCdp");

  return context;
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const handle = yield* make();

    return Layer.mergeAll(
      Layer.succeed(TestCdp, handle),
      Layer.succeed(Port.Current, handle.hooks),
      Layer.succeed(Native, handle.registry),
    );
  }),
);

export const nativeOf = Effect.fnUntraced(function* (page: { readonly id: string }) {
  return yield* (yield* TestCdp).native(page.id);
});

export const withCdp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const present = yield* Effect.serviceOption(TestCdp);

      if (Option.isSome(present))
        return yield* effect.pipe(Effect.provideService(TestCdp, present.value));
      const handle = yield* make();

      return yield* handle.provide(effect.pipe(Effect.provideService(TestCdp, handle)));
    }),
  );

/** Preserve one owned fixture registry while the provider acquires its pages. */
export const provideLayer = <A, E, R>(provider: Layer.Layer<A, E, R>) =>
  Layer.provideMerge(provider, layer);
