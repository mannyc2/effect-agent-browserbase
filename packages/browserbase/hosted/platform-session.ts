// Platform reads for one logged session, narrowed to decoded replies and observed download facts.
// Agent/Function runs, download streaming and log retention/expiry stay open. No Live View URL,
// project listing, log payload or download content is written to the record.
import { createHash, randomUUID } from "node:crypto";

import { Effect, Redacted } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { ClickRequest, NavigateRequest } from "effect-browser/browser-data";
import { BrowserbaseDownloads } from "effect-browserbase/downloads";
import { recipe } from "effect-browserbase/launch";
import { BrowserbaseProjects } from "effect-browserbase/projects";
import { BrowserbaseSessions } from "effect-browserbase/sessions";

import { hostedCase } from "./harness.ts";

const h = hostedCase("platform-session");
const payload = `effect-agent hosted download probe ${randomUUID()}\n`;
const expectedSha256 = createHash("sha256").update(payload, "utf8").digest("hex");
const filename = "effect-agent-probe.txt";

const bootstrap = Bootstrap.init({
  id: "platform-download",
  origins: ["https://example.com"],
  content: `document.addEventListener("DOMContentLoaded", () => {
  const link = document.createElement("a");
  link.id = "effect-agent-download";
  link.download = ${JSON.stringify(filename)};
  link.href = ${JSON.stringify(`data:text/plain;charset=utf-8,${encodeURIComponent(payload)}`)};
  link.textContent = "Download probe";
  document.body.append(link);
});`,
});

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* BrowserbaseSessions;
      const projects = yield* BrowserbaseProjects;
      const downloads = yield* BrowserbaseDownloads;
      const session = yield* h.open({ bootstrap });
      const page = session.initialPage;

      yield* page.navigate(NavigateRequest.make({ url: "https://example.com/" }));
      yield* page.waitFor({ selector: "#effect-agent-download", state: "attached" });

      const view = yield* sessions.liveUrls(session.reference, 60);
      const live = { redacted: Redacted.isRedacted(view.session), pages: view.pages.length };

      yield* h.report("live-view", live);
      const project = yield* projects.retrieve;
      const usage = yield* projects.usage;
      const listed = yield* projects.list;
      const projectListed = listed.some((item) => item.projectId === session.reference.projectId);

      yield* h.report("project", {
        retrieved: project.projectId === session.reference.projectId,
        count: listed.length,
        includesOwn: projectListed,
        browserMinutes: usage.browserMinutes,
        proxyBytes: usage.proxyBytes,
      });

      const before = yield* downloads.list(session.reference);

      const event = yield* session.clickForDownload(
        page,
        ClickRequest.make({ selector: "#effect-agent-download" }),
      );

      const fresh = yield* downloads
        .waitForNew(
          session.reference,
          before.downloads.map((item) => item.id),
          30_000,
        )
        .pipe(
          Effect.catchTag("FileError", (error) =>
            error.reason === "timeout" ? Effect.succeed([]) : Effect.fail(error),
          ),
        );

      // Only the check's exact filename can be claimed or deleted; native event IDs are not
      // provider identities. An absent provider file is an observation, not proof of storage.
      const file = fresh.find((item) => item.filename === filename);
      let filterFound = false;
      let checksumMatches = false;
      let deleted = false;

      if (file !== undefined) {
        let deleteAttempted = false;

        yield* Effect.gen(function* () {
          const filtered = yield* downloads.list(session.reference, { filename });
          const metadata = yield* downloads.metadata(session.reference, file.id);

          filterFound = filtered.downloads.some((item) => item.id === file.id);
          checksumMatches = metadata.checksum.toLowerCase() === expectedSha256;
          deleteAttempted = true;
          yield* downloads
            .delete(session.reference, file.id)
            .pipe(Effect.tapError((error) => h.report("download-delete-failed", error)));
          deleted = !(yield* downloads.list(session.reference)).downloads.some(
            (item) => item.id === file.id,
          );
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              deleteAttempted
                ? Effect.void
                : Effect.sync(() => {
                    deleteAttempted = true;
                  }).pipe(
                    Effect.andThen(downloads.delete(session.reference, file.id)),
                    Effect.tapError((error) => h.report("download-delete-failed", error)),
                    Effect.ignore,
                  ),
            ),
          ),
        );
      }

      const download = {
        event: event.state,
        stored: file !== undefined,
        filterFound,
        checksumMatches,
        deleted,
      };

      yield* h.report("download", download);
      const cleanup = yield* session.closeChecked;

      // Only passive GETs repeat while the provider assembles logs; the wait is bounded.
      const logs = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 31; attempt += 1) {
          const entries = yield* sessions.logs(session.reference);

          if (entries.length > 0) return entries;
          yield* Effect.sleep(2000);
        }

        return yield* Effect.fail({ _tag: "LogsUnavailable" as const });
      }).pipe(Effect.timeout(60_000));

      const payloads = yield* sessions.logs(session.reference, { includePayloads: true }).pipe(
        Effect.map((entries) => ({
          payloads: "decoded" as const,
          payloadEntries: entries.length,
          payloadJsonBytes: Buffer.byteLength(JSON.stringify(entries), "utf8"),
        })),
        Effect.catchTag("SessionError", (error) =>
          error.reason === "limit"
            ? Effect.succeed({ payloads: "over 1 MiB" as const })
            : Effect.fail(error),
        ),
      );

      const log = { entries: logs.length, ...payloads };

      yield* h.report("logs", log);
      yield* h.established({
        liveUrlsRedacted: live.redacted,
        projectRetrieved: project.projectId === session.reference.projectId,
        projectListed,
        usageDecoded: usage.projectId === session.reference.projectId,
        downloadsListed: before.total >= 0,
        downloadCompleted: event.state === "completed",
        filterFound: !download.stored || filterFound,
        checksumMatches: !download.stored || checksumMatches,
        deleted: !download.stored || deleted,
        released: cleanup.remote === "confirmed",
        logsDecoded: logs.length > 0,
        payloadLogsObserved: payloads.payloads === "decoded" || payloads.payloads === "over 1 MiB",
      });

      return { live, projectListed, download, log, cleanup };
    }).pipe(
      Effect.provide(
        h.browser({
          launch: recipe({
            provider: { browserSettings: { logSession: true } },
            remoteTimeoutSeconds: h.budget.browserSeconds,
          }),
        }),
      ),
    ),
  ),
);
