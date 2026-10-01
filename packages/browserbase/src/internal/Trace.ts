import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Option,
  References,
  Schema,
  Stream,
  Tracer,
} from "effect";

import {
  AllocationError,
  ArtifactError,
  CertificateError,
  ClientError,
  ContextError,
  ExtensionError,
  FileError,
  PlatformError,
  ProjectError,
  SessionError,
} from "../Errors.ts";

const Failure = Schema.Union([
  AllocationError,
  ArtifactError,
  CertificateError,
  ClientError,
  ContextError,
  ExtensionError,
  FileError,
  PlatformError,
  ProjectError,
  SessionError,
]);

/** Causality crosses ownership boundaries as ids and sampling, never a live caller context. */
export const capture = Effect.gen(function* () {
  const current = yield* Effect.serviceOption(Tracer.ParentSpan);
  const enabled = yield* References.TracerEnabled;

  return yield* Effect.sync(() => {
    try {
      let parent = Option.getOrUndefined(current);

      while (parent !== undefined && Context.get(parent.annotations, Tracer.DisablePropagation))
        parent = parent._tag === "Span" ? Option.getOrUndefined(parent.parent) : undefined;

      return {
        enabled,
        parent:
          parent === undefined
            ? undefined
            : Object.freeze(
                Tracer.externalSpan({
                  traceId: parent.traceId,
                  spanId: parent.spanId,
                  sampled: parent.sampled,
                }),
              ),
      };
    } catch {
      // A broken tracer identity cannot turn causal capture into an operation defect.
      return { enabled: false, parent: undefined };
    }
  });
});

export type Identity = Effect.Success<typeof capture>;

/** A native page callback has no observable Tool caller. It starts a linked, sampling-aware root. */
export const autonomous = (identity: Identity): Tracer.SpanOptionsNoTrace => ({
  root: true,
  links: identity.parent === undefined ? [] : [{ span: identity.parent, attributes: {} }],
  ...(identity.parent?.sampled === false ? { sampled: false } : {}),
});

export interface Started {
  readonly span: Tracer.Span;
  readonly end: (exit: Exit.Exit<unknown, unknown>, attributes?: Record<string, unknown>) => void;
}

/** Only finite, library-owned facts are passed here; exporter pressure loses telemetry only. */
export const annotate = (attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!(yield* References.TracerEnabled)) return;
    const current = yield* Effect.serviceOption(Tracer.ParentSpan);

    if (Option.isNone(current) || current.value._tag !== "Span") return;
    const span = current.value;

    yield* Effect.sync(() => {
      try {
        for (const [key, value] of Object.entries(attributes)) span.attribute(key, value);
      } catch {
        // Result construction and cleanup must not depend on exporter health.
      }
    });
  });

/**
 * Library spans export neither successful values nor original causes/stacks. Tracer failures
 * cannot suppress dispatch or alter its result. Sampling metadata is available in annotations
 * at creation: rc.117 applies SpanOptions.attributes only after Tracer.span has returned.
 */
export const start = Effect.fnUntraced(function* (
  name: string,
  options: Tracer.SpanOptionsNoTrace = {},
): Effect.fn.Return<Started | undefined> {
  const identity = yield* capture;

  if (!identity.enabled) return undefined;
  const clock = yield* Clock.Clock;
  const timing = yield* References.TracerTimingEnabled;
  const attributes = options.attributes ?? {};

  const parent = options.parent ?? (options.root === true ? undefined : identity.parent);

  const created = yield* Effect.makeSpan(name, {
    ...options,
    attributes: undefined,
    parent,
    root: options.root ?? parent === undefined,
    annotations: Context.make(References.TracerSpanAnnotations, attributes),
  }).pipe(
    Effect.provideService(References.TracerSpanAnnotations, {}),
    Effect.provideService(References.TracerSpanLinks, []),
    Effect.exit,
  );

  if (Exit.isFailure(created)) return undefined;

  return yield* Effect.sync((): Started => {
    const span = created.value;
    let ended = false;

    try {
      for (const [key, value] of Object.entries(attributes)) span.attribute(key, value);
    } catch {
      // Retain the allocated span for one termination even if its attributes were refused.
    }

    return {
      span,
      end: (exit, extra = {}) => {
        if (ended) return;
        ended = true;
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

        try {
          const failure = Exit.isFailure(exit)
            ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            : undefined;

          const known = Schema.is(Failure)(failure) ? failure : undefined;

          for (const [key, value] of Object.entries(extra)) span.attribute(key, value);
          span.attribute(
            "browser.status",
            Exit.isSuccess(exit) ? "success" : interrupted ? "interrupted" : "failure",
          );
          if (known !== undefined) {
            span.attribute("browser.reason", known.reason);
            if ("outcome" in known && known.outcome !== undefined)
              span.attribute("browser.outcome", known.outcome);
          }
        } catch {
          // Exporter pressure and shutdown are telemetry loss, never an operation failure.
        }
        try {
          span.end(
            timing ? clock.currentTimeNanosUnsafe() : 0n,
            Exit.isSuccess(exit)
              ? Exit.void
              : Exit.fail(interrupted ? "Operation interrupted" : "Operation failed"),
          );
        } catch {
          // An exporter is allowed to fail after accepting a span; never retry its termination.
        }
      },
    };
  });
});

export const span =
  (name: string, options: Tracer.SpanOptionsNoTrace = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      start(name, options).pipe(
        Effect.flatMap((started) =>
          started === undefined
            ? restore(effect)
            : restore(effect).pipe(
                Effect.provideService(Tracer.ParentSpan, started.span),
                Effect.onExit((exit) => Effect.sync(() => started.end(exit))),
              ),
        ),
      ),
    );

/** One span per consumption; end after setup, pulls and the original channel scope's finalizers. */
export const stream =
  (name: string, options: Tracer.SpanOptionsNoTrace = {}) =>
  <A, E, R>(source: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    Stream.suspend(() => {
      let terminal: Exit.Exit<unknown, unknown> | undefined;

      return Stream.unwrap(
        Effect.uninterruptible(
          start(name, options).pipe(
            Effect.flatMap((value) => {
              return value === undefined
                ? Effect.succeed(source)
                : Effect.addFinalizer((exit) =>
                    Effect.sync(() => value.end(terminal ?? exit)),
                  ).pipe(
                    Effect.as(source.pipe(Stream.provideService(Tracer.ParentSpan, value.span))),
                  );
            }),
          ),
        ),
      ).pipe(
        Stream.onExit((exit) =>
          Effect.sync(() => {
            terminal = exit;
          }),
        ),
      );
    });
