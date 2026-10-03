// Session-less platform qualification: disposable webhook/certificate lifecycles, decoded
// Agents/Functions lists and one metered Search and Fetch attempt each. Hosted inference,
// Functions deployment/builds/invocation and delivery-origin downloads stay open.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Effect, Redacted } from "effect";
import { BrowserbaseAgents } from "effect-browserbase/agents";
import { BrowserbaseCertificates } from "effect-browserbase/certificates";
import { BrowserbaseFunctions } from "effect-browserbase/functions";
import { BrowserbasePageFetch } from "effect-browserbase/page-fetch";
import { BrowserbaseSearch } from "effect-browserbase/search";
import { BrowserbaseWebhooks } from "effect-browserbase/webhooks";

import { hostedCase } from "./harness.ts";

const h = hostedCase("platform-services");

// The opt-in gate runs before this local process; the throwaway private key goes to /dev/null.
const certificate = spawnSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "/dev/null",
    "-subj",
    "/CN=effect-agent hosted probe CA",
    "-days",
    "1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ],
  { timeout: 10_000, maxBuffer: h.budget.transferBytes },
);

if (certificate.status !== 0 || !certificate.stdout.includes("-----BEGIN CERTIFICATE-----")) {
  throw new Error("OpenSSL could not generate the throwaway CA certificate");
}
if (certificate.stdout.byteLength > h.budget.transferBytes) {
  throw new Error("The throwaway CA certificate is over budget");
}

await h.run(
  Effect.gen(function* () {
    const webhooks = yield* BrowserbaseWebhooks;
    const endpoint = `https://example.com/effect-agent-webhook-probe/${randomUUID()}`;

    const registration = yield* webhooks.create({
      endpoint,
      eventTypes: ["functions.invocations.completed"],
    });

    const id = registration.webhook.webhookId;
    let webhookDeleteAttempted = false;

    const webhook = yield* Effect.gen(function* () {
      const retrieved = yield* webhooks.retrieve(id);
      let found = false;
      let cursor: string | undefined;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const page = yield* webhooks.list({
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });

        if (page.webhooks.some((item) => item.webhookId === id)) {
          found = true;
          break;
        }
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }

      const updated = yield* webhooks.update(id, {
        eventTypes: ["functions.invocations.completed", "functions.invocations.failed"],
      });

      const rotated = yield* webhooks.rotateSecret(id, { revokeImmediately: true });

      // Mark before dispatch: even a lost DELETE reply must never be replayed by cleanup.
      webhookDeleteAttempted = true;
      yield* webhooks
        .delete(id)
        .pipe(Effect.tapError((error) => h.report("webhook-delete-failed", error)));

      const deletion = yield* webhooks.retrieve(id).pipe(
        Effect.as("still-present"),
        Effect.catchTag("PlatformError", (error) =>
          error.reason === "not-found" ? Effect.succeed(error.reason) : Effect.fail(error),
        ),
      );

      const facts = {
        secretRedacted: Redacted.isRedacted(registration.secret),
        retrieved: retrieved.endpoint === endpoint,
        listed: found,
        updated:
          updated.eventTypes.length === 2 &&
          updated.eventTypes.includes("functions.invocations.completed") &&
          updated.eventTypes.includes("functions.invocations.failed"),
        rotatedRedacted: Redacted.isRedacted(rotated),
        deleted: deletion === "not-found",
      };

      yield* h.report("webhook", { ...facts, deletion });
      yield* h.established(facts);

      return facts;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          webhookDeleteAttempted
            ? Effect.void
            : Effect.sync(() => {
                webhookDeleteAttempted = true;
              }).pipe(
                Effect.andThen(webhooks.delete(id)),
                Effect.tapError((error) => h.report("webhook-delete-failed", error)),
                Effect.ignore,
              ),
        ),
      ),
      Effect.tapError((error) => h.report("webhook-failed", error)),
    );

    const certificates = yield* BrowserbaseCertificates;

    const created = yield* certificates.create({
      bytes: certificate.stdout,
      filename: "effect-agent-probe-ca.pem",
      maxBytes: h.budget.transferBytes,
    });

    const certificateId = created.certificateId;
    let certificateDeleteAttempted = false;

    const ca = yield* Effect.gen(function* () {
      const retrieved = yield* certificates.retrieve(certificateId);
      const listed = yield* certificates.list;

      certificateDeleteAttempted = true;
      yield* certificates
        .delete(certificateId)
        .pipe(Effect.tapError((error) => h.report("certificate-delete-failed", error)));

      const deletion = yield* certificates.retrieve(certificateId).pipe(
        Effect.as("still-present"),
        Effect.catchTag("CertificateError", (error) =>
          error.reason === "not-found" ? Effect.succeed(error.reason) : Effect.fail(error),
        ),
      );

      const facts = {
        retrieved:
          retrieved.certificateId === certificateId && retrieved.projectId === created.projectId,
        listed: listed.some((item) => item.certificateId === certificateId),
        deleted: deletion === "not-found",
      };

      yield* h.report("certificate", { ...facts, deletion });
      yield* h.established(facts);

      return facts;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          certificateDeleteAttempted
            ? Effect.void
            : Effect.sync(() => {
                certificateDeleteAttempted = true;
              }).pipe(
                Effect.andThen(certificates.delete(certificateId)),
                Effect.tapError((error) => h.report("certificate-delete-failed", error)),
                Effect.ignore,
              ),
        ),
      ),
      Effect.tapError((error) => h.report("certificate-failed", error)),
    );

    const agents = yield* BrowserbaseAgents;
    const functions = yield* BrowserbaseFunctions;
    const agentList = yield* agents.list({ limit: 1 });
    const functionList = yield* functions.list();

    yield* h.report("lists", {
      agents: agentList.items.length,
      functions: functionList.items.length,
    });
    const search = yield* BrowserbaseSearch;
    const pageFetch = yield* BrowserbasePageFetch;

    // Each is exactly one attempt: rejected/unknown outcomes may still be billed.
    const found = yield* search
      .web({ query: "IANA example domain", numResults: 1 })
      .pipe(
        Effect.tapError((error) =>
          h.report("search-failed", { reason: error.reason, outcome: error.outcome }),
        ),
      );

    yield* h.report("search", { results: found.results.length });

    const fetched = yield* pageFetch
      .fetch({ url: "https://example.com/", format: "raw" })
      .pipe(
        Effect.tapError((error) =>
          h.report("fetch-failed", { reason: error.reason, outcome: error.outcome }),
        ),
      );

    const fetch = {
      statusCode: fetched.statusCode,
      contentType: fetched.contentType,
      exampleDomain:
        typeof fetched.content === "string" && fetched.content.includes("Example Domain"),
    };

    yield* h.report("fetch", fetch);
    yield* h.established({
      webhook: Object.values(webhook).every(Boolean),
      certificate: Object.values(ca).every(Boolean),
      agentsListed: agentList.items.length >= 0,
      functionsListed: functionList.items.length >= 0,
      searchAnswered: found.results.length <= 1,
      fetchAnswered: fetch.statusCode === 200 && fetch.exampleDomain,
    });

    return {
      webhook,
      certificate: ca,
      agents: agentList.items.length,
      functions: functionList.items.length,
      search: found.results.length,
      fetch,
    };
  }),
);
