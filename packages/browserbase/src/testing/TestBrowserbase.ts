/**
 * An in-memory Browserbase API for tests. It is the `HttpClient` the real `BrowserbaseClient` runs
 * on, so the client and the provider above it run as they would against Browserbase, and nothing
 * leaves the process. Sessions run until released, or until their timeout on the Effect `Clock`,
 * so `TestClock` drives their end. A `Script` decides how creates, releases and session reads
 * answer, in turn, so a test can lose a create, leave a release pending or fail status reads.
 *
 * It keeps sessions and stored contexts and nothing else: any other endpoint fails the test with a
 * defect. It doesn't model regions, quotas or billing, and a context is only a record, with no
 * browser state. Every session hands out the script's `connectUrl`, such as the DevTools address
 * of a local Chromium. Its ids are UUIDs, as Browserbase's are, and as Browserbase does, it refuses
 * a session id of any other shape as invalid, where it answers an unknown one as not found.
 *
 * @category testing
 * @since 0.3.0
 */
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { type BrowserbaseClient, layer as clientLayer } from "../BrowserbaseClient.ts";

const Refusal = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }));

/** How a session create answers. */
export const Create = Schema.Union([
  /** The session is made, and runs. */
  Schema.TaggedStruct("Accept", {}),
  /** Refused with `status`, and nothing is made. */
  Schema.TaggedStruct("Reject", {
    status: Refusal,
    retryAfterSeconds: Schema.optional(Schema.Int),
  }),
  /** The session is made, but the answer holds only its id. */
  Schema.TaggedStruct("Malformed", {}),
  /** The session is made, but no answer arrives. */
  Schema.TaggedStruct("Lost", {}),
]);

/** How a release answers. */
export const Release = Schema.Union([
  /** The session ends at once. */
  Schema.TaggedStruct("Ends", {}),
  /** Accepted, but the session runs on for `millis`, or without them until its timeout. */
  Schema.TaggedStruct("Pending", { millis: Schema.optional(Schema.Finite) }),
  /** Refused with `status`; the session runs on. */
  Schema.TaggedStruct("Refused", { status: Refusal }),
  /** The session ends, but no answer arrives. */
  Schema.TaggedStruct("Lost", {}),
]);

/** How a session read answers. */
export const Read = Schema.Union([
  Schema.TaggedStruct("Answer", {}),
  Schema.TaggedStruct("Refused", { status: Refusal }),
  Schema.TaggedStruct("Lost", {}),
]);

export const Script = Schema.Struct({
  /** How creates answer, in turn; once these run out, each is accepted. */
  creates: Schema.optional(Schema.Array(Create)),
  /** How releases answer, in turn; once these run out, each ends its session. */
  releases: Schema.optional(Schema.Array(Release)),
  /** How session reads answer, in turn; once these run out, each answers. */
  reads: Schema.optional(Schema.Array(Read)),
  /** The DevTools address each session hands out. Without it, sessions have none. */
  connectUrl: Schema.optional(Schema.String),
});

export type Script = typeof Script.Type;

/** A session as the fake keeps it, with how many releases it was asked. */
export interface Kept {
  readonly id: string;
  readonly status: string;
  readonly userMetadata: Readonly<Record<string, unknown>> | undefined;
  readonly releases: number;
}

export interface Handle {
  /** Every request, oldest first, as `METHOD /path?query`. */
  readonly requests: Effect.Effect<ReadonlyArray<string>>;
  /** Each session as Browserbase would describe it now, oldest first. */
  readonly sessions: Effect.Effect<ReadonlyArray<Kept>>;
  /** End a session as Browserbase does on its own, as when its browser fails. */
  readonly end: (id: string) => Effect.Effect<void>;
}

/** The fake's handle, beside the `BrowserbaseClient` that `layer` runs on it. */
export class TestBrowserbase extends Context.Service<TestBrowserbase, Handle>()(
  "effect-browserbase/testing/TestBrowserbase",
) {}

/** The API key the fake takes; any other is unauthorized. */
export const apiKey = "test-browserbase-key";

const CreateBody = Schema.fromJsonString(
  Schema.Struct({
    timeout: Schema.optional(Schema.Finite),
    keepAlive: Schema.optional(Schema.Boolean),
    userMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    browserSettings: Schema.optional(
      Schema.Struct({ context: Schema.optional(Schema.Struct({ id: Schema.String })) }),
    ),
  }),
);

const ReleaseBody = Schema.fromJsonString(
  Schema.Struct({ status: Schema.Literal("REQUEST_RELEASE") }),
);

interface Row {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly keepAlive: boolean;
  readonly userMetadata: Readonly<Record<string, unknown>> | undefined;
  readonly contextId: string | undefined;
  /** How and when it ends, unless its timeout comes first. */
  ends: { readonly status: string; readonly at: number } | undefined;
  releases: number;
}

/** Everything one fake keeps. */
interface Fake {
  readonly now: () => number;
  readonly connectUrl: string | undefined;
  readonly pending: {
    readonly creates: Array<typeof Create.Type>;
    readonly releases: Array<typeof Release.Type>;
    readonly reads: Array<typeof Read.Type>;
  };
  readonly requests: Array<string>;
  readonly sessions: Map<string, Row>;
  readonly contexts: Map<string, number>;
  /** How many sessions and contexts it has made, together, for their ids. */
  readonly made: { count: number };
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The next id, a UUID as Browserbase's are, counted so that every run hands out the same. */
const nextId = (fake: Fake) =>
  `00000000-0000-4000-8000-${(++fake.made.count).toString(16).padStart(12, "0")}`;

/** How the session ended by now, or undefined while it runs. */
const endOf = (fake: Fake, row: Row) => {
  const end =
    row.ends !== undefined && row.ends.at <= row.expiresAt
      ? row.ends
      : { status: "TIMED_OUT", at: row.expiresAt };

  return end.at <= fake.now() ? end : undefined;
};

/** The session as Browserbase answers it; only creates and reads hand out its address. */
const describe = (fake: Fake, row: Row, connect: boolean) => {
  const end = endOf(fake, row);

  return {
    id: row.id,
    createdAt: iso(row.createdAt),
    updatedAt: iso(end?.at ?? row.createdAt),
    startedAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    projectId: "test-project",
    status: end?.status ?? "RUNNING",
    proxyBytes: 0,
    keepAlive: row.keepAlive,
    region: "us-west-2",
    ...(end === undefined ? {} : { endedAt: iso(end.at) }),
    ...(row.contextId === undefined ? {} : { contextId: row.contextId }),
    ...(row.userMetadata === undefined ? {} : { userMetadata: row.userMetadata }),
    ...(connect && fake.connectUrl !== undefined ? { connectUrl: fake.connectUrl } : {}),
    ...(connect
      ? {
          seleniumRemoteUrl: `https://connect.browserbase.test/webdriver/${row.id}`,
          signingKey: `signing-key-${row.id}`,
        }
      : {}),
  };
};

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? (request.body.text ?? new TextDecoder().decode(request.body.body))
    : "";

/** A metadata query in Browserbase's one form, `user_metadata['a']['b']:'value'`, as a test. */
const metadataQuery = (query: string) => {
  const parsed = /^user_metadata((?:\['[^']*'\])+):'([^']*)'$/.exec(query);

  if (parsed === null) return undefined;
  const path = [...(parsed[1] ?? "").matchAll(/\['([^']*)'\]/g)].map((part) => part[1] ?? "");

  return (metadata: unknown) =>
    path.reduce<unknown>(
      (value, key) => (Predicate.isObject(value) ? Reflect.get(value, key) : undefined),
      metadata,
    ) === parsed[2];
};

const unsupported = (detail: string) => Effect.die(new Error(`TestBrowserbase ${detail}`));

/** Answer one request as Browserbase would, after the script's say. */
const serve = (fake: Fake, request: HttpClientRequest.HttpClientRequest, url: URL) => {
  const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      ),
    );

  const lost = Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "TestBrowserbase lost this answer, as its script said",
      }),
    }),
  );

  const refused = (status: number) => answer(status, { message: "refused, as the script said" });
  const [, version, kind, id, rest] = url.pathname.split("/");
  const row = id === undefined ? undefined : fake.sessions.get(id);

  fake.requests.push(`${request.method} ${url.pathname}${url.search}`);
  if (request.headers["x-bb-api-key"] !== apiKey)
    return answer(401, { message: "Invalid API key" });
  if (version !== "v1") return unsupported(`serves only /v1, not ${url.pathname}`);
  // Browserbase refuses a session id that is not a UUID before it looks for the session.
  if (kind === "sessions" && id !== undefined && !uuid.test(id))
    return answer(400, { message: "Invalid Session ID" });

  switch (
    `${request.method} ${kind}${id === undefined ? "" : " id"}${rest === undefined ? "" : ` ${rest}`}`
  ) {
    case "POST sessions": {
      const reply = fake.pending.creates.shift() ?? { _tag: "Accept" };

      if (reply._tag === "Reject")
        return answer(
          reply.status,
          { message: "refused, as the script said" },
          reply.retryAfterSeconds === undefined
            ? {}
            : { "retry-after": `${reply.retryAfterSeconds}` },
        );
      const body = Option.getOrUndefined(Schema.decodeOption(CreateBody)(bodyText(request)));
      const createdAt = fake.now();

      const created: Row = {
        id: nextId(fake),
        createdAt,
        expiresAt: createdAt + (body?.timeout ?? 300) * 1000,
        keepAlive: body?.keepAlive ?? false,
        userMetadata: body?.userMetadata,
        contextId: body?.browserSettings?.context?.id,
        ends: undefined,
        releases: 0,
      };

      fake.sessions.set(created.id, created);
      if (reply._tag === "Lost") return lost;

      return answer(
        201,
        reply._tag === "Malformed" ? { id: created.id } : describe(fake, created, true),
      );
    }
    case "GET sessions": {
      const status = url.searchParams.get("status");
      const query = url.searchParams.get("q");
      const matches = query === null ? () => true : metadataQuery(query);

      if (matches === undefined) return unsupported(`cannot read the query ${query}`);

      return answer(
        200,
        [...fake.sessions.values()]
          .filter(
            (kept) =>
              (status === null || (endOf(fake, kept)?.status ?? "RUNNING") === status) &&
              matches(kept.userMetadata),
          )
          .map((kept) => describe(fake, kept, false)),
      );
    }
    case "GET sessions id": {
      const reply = fake.pending.reads.shift() ?? { _tag: "Answer" };

      if (reply._tag === "Refused") return refused(reply.status);
      if (reply._tag === "Lost") return lost;

      return row === undefined
        ? answer(404, { message: "Session not found" })
        : answer(200, describe(fake, row, true));
    }
    case "POST sessions id": {
      if (row === undefined) return answer(404, { message: "Session not found" });
      if (Option.isNone(Schema.decodeOption(ReleaseBody)(bodyText(request))))
        return answer(400, { message: "status must be REQUEST_RELEASE" });
      row.releases += 1;
      const reply = fake.pending.releases.shift() ?? { _tag: "Ends" };

      if (reply._tag === "Refused") return refused(reply.status);
      // Releasing a session that has ended changes nothing, and succeeds.
      if (
        endOf(fake, row) === undefined &&
        (reply._tag !== "Pending" || reply.millis !== undefined)
      )
        row.ends = {
          status: "COMPLETED",
          at: fake.now() + (reply._tag === "Pending" ? (reply.millis ?? 0) : 0),
        };

      return reply._tag === "Lost" ? lost : answer(200, describe(fake, row, false));
    }
    case "POST contexts": {
      const created = nextId(fake);

      fake.contexts.set(created, fake.now());

      return answer(201, {
        id: created,
        publicKey: "test-public-key",
        cipherAlgorithm: "AES-256-CBC",
        initializationVectorSize: 16,
      });
    }
    case "GET contexts id": {
      const createdAt = id === undefined ? undefined : fake.contexts.get(id);

      return createdAt === undefined
        ? answer(404, { message: "Context not found" })
        : answer(200, {
            id,
            createdAt: iso(createdAt),
            updatedAt: iso(createdAt),
            projectId: "test-project",
          });
    }
    case "DELETE contexts id":
      return id !== undefined && fake.contexts.delete(id)
        ? answer(204)
        : answer(404, { message: "Context not found" });
    default:
      return unsupported(`does not implement ${request.method} ${url.pathname}`);
  }
};

/** The fake as an `HttpClient`, with its handle. */
export const make = Effect.fnUntraced(function* (script: Script = {}) {
  const clock = yield* Clock.Clock;
  const decoded = yield* Effect.orDie(Schema.decodeEffect(Script)(script));

  const fake: Fake = {
    now: () => clock.currentTimeMillisUnsafe(),
    connectUrl: decoded.connectUrl,
    pending: {
      creates: [...(decoded.creates ?? [])],
      releases: [...(decoded.releases ?? [])],
      reads: [...(decoded.reads ?? [])],
    },
    requests: [],
    sessions: new Map(),
    contexts: new Map(),
    made: { count: 0 },
  };

  const handle: Handle = {
    requests: Effect.sync(() => [...fake.requests]),
    sessions: Effect.sync(() =>
      [...fake.sessions.values()].map((row) => ({
        id: row.id,
        status: endOf(fake, row)?.status ?? "RUNNING",
        userMetadata: row.userMetadata,
        releases: row.releases,
      })),
    ),
    end: (id) =>
      Effect.sync(() => {
        const row = fake.sessions.get(id);

        if (row !== undefined && endOf(fake, row) === undefined)
          row.ends = { status: "ERROR", at: fake.now() };
      }),
  };

  return { http: HttpClient.make((request, url) => serve(fake, request, url)), handle };
});

/** The real `BrowserbaseClient` over the fake, and the fake's handle. */
export const layer = (script: Script = {}): Layer.Layer<BrowserbaseClient | TestBrowserbase> =>
  Layer.unwrap(
    Effect.map(make(script), ({ http, handle }) =>
      Layer.merge(
        clientLayer({
          apiKey: Redacted.make(apiKey),
          baseUrl: "https://api.browserbase.test",
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
        Layer.succeed(TestBrowserbase, handle),
      ),
    ),
  );
