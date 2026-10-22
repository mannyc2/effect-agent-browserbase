/** Scoped protocol interception at the owned session boundary; native is the default. */
import { Clock, Context, Effect, Fiber } from "effect";
import type { BrowserContext, CDPSession, Page as NativePage } from "playwright-core";

import type { CaptureSource } from "../../Browser.ts";
import { call } from "../../BrowserError.ts";

export const Operation = Context.Reference<string | undefined>("effect-browser/ProtocolOperation", {
  defaultValue: () => undefined,
});

export const Script = Context.Reference<string | undefined>("effect-browser/ProtocolScript", {
  defaultValue: () => undefined,
});

export interface Session {
  readonly channel: "page" | "capture" | "browser";
  readonly clock: Clock.Clock;
  page: string | undefined;
  readonly nativePage?: NativePage | undefined;
}

export interface Event {
  readonly method: string;
  readonly params: unknown;
}

export type CaptureSend = Effect.Success<ReturnType<CaptureSource["attach"]>>;

export interface Hooks {
  readonly query?:
    | ((session: Session, method: string, run: () => Promise<unknown>) => Promise<unknown>)
    | undefined;
  readonly page?: ((session: Session, native: CDPSession) => CDPSession) | undefined;
  readonly native?:
    | (<A>(
        page: string,
        method: "keyboard.down" | "keyboard.up" | "goto",
        params: Readonly<Record<string, unknown>>,
        run: () => Promise<A>,
      ) => Promise<A>)
    | undefined;
  readonly browser?: ((connection: string, context: BrowserContext) => () => void) | undefined;
  readonly beforeOpen?: ((session: Session) => Promise<void>) | undefined;
  readonly send?: ((session: Session, send: CDPSession["send"]) => CDPSession["send"]) | undefined;
  readonly capture?: ((session: Session, send: CaptureSend) => CaptureSend) | undefined;
  readonly event?:
    | ((session: Session, event: Event, deliver: (event: Event) => void) => void)
    | undefined;
  readonly opened?: ((session: Session, inject: (event: Event) => void) => () => void) | undefined;
}

export const Current = Context.Reference<Hooks>("effect-browser/ProtocolPort", {
  defaultValue: () => ({}),
});

export const labels = () => ({
  operation: Fiber.getCurrent()?.getRef(Operation),
  script: Fiber.getCurrent()?.getRef(Script),
});

/** The provider owns creation and passes its session to an optional scoped test adapter. */
export const openSession = Effect.fnUntraced(function* (
  open: () => Promise<CDPSession>,
  nativePage?: NativePage,
  channel: "page" | "browser" = "page",
) {
  const hooks = yield* Current;

  const session: Session = {
    channel,
    clock: yield* Clock.Clock,
    page: undefined,
    nativePage,
  };

  const beforeOpen = hooks.beforeOpen;
  const operation = channel === "browser" ? "requests" : "newPage";

  if (beforeOpen !== undefined)
    yield* call(
      operation,
      () => beforeOpen(session),
      () => "connection",
    );
  const native = yield* call(operation, open, () => "connection");

  return hooks.page?.(session, native) ?? native;
});

/** The dedicated capture connection uses the same interception and injection rules. */
export const openCapture = Effect.fnUntraced(function* (
  page: string,
  source: CaptureSource,
  handlers: Parameters<CaptureSource["attach"]>[1],
) {
  const hooks = yield* Current;
  const session: Session = { channel: "capture", page, clock: yield* Clock.Clock };
  const beforeOpen = hooks.beforeOpen;

  if (beforeOpen !== undefined)
    yield* call(
      "screencast",
      () => beforeOpen(session),
      () => "connection",
    );

  const deliver = ({ method, params }: Event) => {
    const run = ({ method, params }: Event) => handlers.event(method, params);

    if (hooks.event === undefined) run({ method, params });
    else hooks.event(session, { method, params }, run);
  };

  const release = hooks.opened?.(session, ({ method, params }) => handlers.event(method, params));

  yield* Effect.addFinalizer(() => Effect.sync(() => release?.()));

  const send = yield* source.attach(page, {
    ...handlers,
    event: (method, params) => deliver({ method, params }),
  });

  return hooks.capture?.(session, send) ?? send;
});
