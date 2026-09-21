#!/usr/bin/env node
// Lets a release publish the packages an existing full acceptance run already built and tested
// for the exact tagged commit, instead of repeating that acceptance. Dependency-free, like the
// rest of the release path, and only ever selects evidence; it never publishes.
//
//   release-reuse.mjs find <source-sha>
//     Query Actions for a reusable run and write found/run_id/artifact ids to GITHUB_OUTPUT.
//   release-reuse.mjs verify <acceptance-dir> <tooling-dir> <source-sha>
//     Re-derive, from the downloaded artifacts, the same digests CI records for a full run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyStages } from "./ci-evidence.mjs";
import { releaseSetDigest } from "./package-release.mjs";
import { verifyReleaseSet } from "./verify-release.mjs";

/** Only runs of main itself count; a pull-request run validates a merge candidate, not the tag. */
const TRUSTED_EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);
const ACCEPTANCE_JOB = "Unpaid acceptance";
const REQUIRED_JOBS = [ACCEPTANCE_JOB, "Native release recovery"];
/**
 * Every profile uploads the same artifact name, and a push to main usually runs the focused
 * library profile. Only a full run executes this step, so its success is what separates
 * release evidence from routine feedback before anything is downloaded.
 */
export const FULL_EVIDENCE_STEP = "Record fully tested release-set digest";

/**
 * The newest successful run for exactly `sha` on main whose acceptance and release-tooling jobs
 * both succeeded and whose two artifacts are still retained. A run that is not fully suitable is
 * skipped, never partially used: the caller then builds instead.
 */
export const selectReusableRun = ({ sha, runs, jobs, artifacts }) => {
  const candidates = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "main" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        TRUSTED_EVENTS.has(run.event),
    )
    .toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  for (const run of candidates) {
    const passed = new Map((jobs[run.id] ?? []).map((job) => [job.name, job.conclusion]));

    if (!REQUIRED_JOBS.every((name) => passed.get(name) === "success")) continue;
    const acceptanceSteps = (jobs[run.id] ?? []).find((job) => job.name === ACCEPTANCE_JOB)?.steps;
    const full = (acceptanceSteps ?? []).some(
      (step) => step.name === FULL_EVIDENCE_STEP && step.conclusion === "success",
    );

    if (!full) continue;
    const retained = (name) =>
      (artifacts[run.id] ?? []).find((artifact) => artifact.name === name && !artifact.expired);
    const acceptance = retained(`browserbase-acceptance-${run.id}-${run.run_attempt}`);
    const tooling = retained(`browserbase-release-tooling-${run.id}-${run.run_attempt}`);

    if (acceptance !== undefined && tooling !== undefined) {
      return { runId: run.id, acceptanceArtifactId: acceptance.id, toolingArtifactId: tooling.id };
    }
  }

  return undefined;
};

/** The digests a publisher checks, derived exactly as ci.yml derives them for a full run. */
export const verifyReusable = (acceptanceDirectory, toolingDirectory, sha) => {
  verifyStages(acceptanceDirectory, "full");
  const receipt = JSON.parse(readFileSync(join(acceptanceDirectory, "release-set.json"), "utf8"));
  const source = readFileSync(join(acceptanceDirectory, "source-sha.txt"), "utf8").trim();

  assert.equal(source, sha, "The reusable run tested a different source commit");
  const releaseSet = releaseSetDigest(acceptanceDirectory);

  verifyReleaseSet(acceptanceDirectory, source, `v${receipt.version}`, releaseSet);
  const tooling = createHash("sha256")
    .update(readFileSync(join(toolingDirectory, "release-tooling.tar.gz")))
    .digest("hex");

  return { releaseSet, tooling };
};

const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
  });

  assert.ok(response.ok, `GitHub API ${path} answered ${response.status}`);

  return response.json();
};

const output = (values) => {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);

  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);

  if (command === "find") {
    const [sha] = args;

    assert.match(sha ?? "", /^[0-9a-f]{40}$/, "find needs the exact 40-character source SHA");
    const { workflow_runs: runs } = await api(
      `/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=20`,
    );
    const jobs = {};
    const artifacts = {};

    for (const run of runs) {
      jobs[run.id] = (await api(`/actions/runs/${run.id}/jobs?filter=latest&per_page=50`)).jobs;
      artifacts[run.id] = (await api(`/actions/runs/${run.id}/artifacts?per_page=50`)).artifacts;
    }
    const selected = selectReusableRun({ sha, runs, jobs, artifacts });

    output(
      selected === undefined
        ? { found: "false" }
        : {
            found: "true",
            run_id: selected.runId,
            acceptance_artifact_id: selected.acceptanceArtifactId,
            tooling_artifact_id: selected.toolingArtifactId,
          },
    );
  } else if (command === "verify") {
    const [acceptance, tooling, sha] = args;
    const digests = verifyReusable(acceptance, tooling, sha);

    output({ release_set_sha256: digests.releaseSet, tooling_sha256: digests.tooling });
  } else {
    console.error("usage: release-reuse.mjs find <sha> | verify <acceptance-dir> <tooling-dir> <sha>");
    process.exit(2);
  }
}
