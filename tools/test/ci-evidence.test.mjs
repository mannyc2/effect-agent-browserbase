import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compactEvidence, requiredStages } from "../ci-evidence.mjs";

test("compaction metadata failure leaves installed declarations inside retained evidence", (t) => {
  const work = mkdtempSync(join(tmpdir(), "browserbase-ci-compaction-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const out = join(work, "results");
  const declarations = join(out, "consumers/agent/node_modules");
  mkdirSync(declarations, { recursive: true });
  writeFileSync(join(out, "acceptance-profile.txt"), "library\n");
  writeFileSync(join(out, "statuses.txt"), requiredStages("library").map((name) => `${name} 0`).join("\n") + "\n");
  const diagnostic = join(declarations, "diagnostic.d.mts");
  writeFileSync(diagnostic, "retained declaration\n");
  writeFileSync(join(out, "evidence-policy.json"), "existing record\n");

  assert.throws(() => compactEvidence(out), /Refusing to replace evidence/);
  assert.equal(readFileSync(diagnostic, "utf8"), "retained declaration\n");
  assert.equal(readFileSync(join(out, "evidence-policy.json"), "utf8"), "existing record\n");
  assert.equal(existsSync(join(work, "completed-consumer-workspaces")), false);
  assert.equal(existsSync(join(out, "consumer-fixtures.tar.gz")), false);
});
