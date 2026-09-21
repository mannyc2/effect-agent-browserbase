import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `Contract.ts` records the reviewed session-create subset by hand. This check re-derives
// that inventory from the exact upstream revision it cites, so a transcription slip, or a
// revision that no longer serves the bytes it was read from, is a failure rather than a
// belief. It needs network and is therefore run deliberately: ordinary acceptance stays
// offline, and a newer upstream release is reported for review rather than auto-adopted.

/** Remove comments so a brace inside documentation cannot close a declaration early. */
export const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Body of the first `header` block, delimited by brace depth rather than indentation. */
export function blockBody(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `Upstream source no longer declares: ${header.trim()}`);
  let depth = 0;
  for (let index = start + header.length - 1; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start + header.length, index);
  }
  return assert.fail(`Unterminated declaration: ${header.trim()}`);
}

/** Members declared directly in a block, ignoring anything nested inside one. */
export function declaredFields(body) {
  const fields = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    const match = depth === 0 ? /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line) : null;
    if (match) fields.push(match[1]);
    for (const character of line) {
      if (character === "{") depth++;
      else if (character === "}") depth--;
    }
  }
  return fields;
}

const settingsPrefix = "browserSettings.";

const excludedSettings = (deliberatelyExcluded) =>
  deliberatelyExcluded.filter((entry) => entry.startsWith(settingsPrefix)).map((entry) => entry.slice(settingsPrefix.length));

/** Lines under a key path, delimited by indentation. A bounded reader for one known subtree, not a YAML parser. */
export function specBlock(lines, path) {
  for (const key of path) {
    const index = lines.findIndex((line) => line.trim() === `${key}:` || line.trim() === `${JSON.stringify(key)}:`);
    assert.notEqual(index, -1, `The specification no longer declares: ${path.join(" > ")}`);
    const indent = lines[index].length - lines[index].trimStart().length;
    const body = [];
    for (let next = index + 1; next < lines.length; next++) {
      if (lines[next].trim() === "") continue;
      if (lines[next].length - lines[next].trimStart().length <= indent) break;
      body.push(lines[next]);
    }
    lines = body;
  }
  return lines;
}

/** Keys declared at the shallowest indentation of a block, ignoring anything nested under one. */
export function specKeys(lines) {
  assert.ok(lines.length > 0, "Expected a non-empty specification block");
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  return lines
    .filter((line) => line.length - line.trimStart().length === indent)
    .map((line) => /^\s*"?([A-Za-z_][\w]*)"?\s*:/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

const specProperties = ["paths", "/v1/sessions", "post", "requestBody", "content", "application/json", "schema", "properties"];

/**
 * The published specification is the wire contract and is not pinned: a field Browserbase
 * adds becomes a failing check here rather than a silent gap. It also states the request
 * field directly, which is what makes the SDK's differing argument name a rename and not a
 * disagreement between two authorities.
 */
export function checkOpenApiContract(spec, contract) {
  const lines = spec.split("\n");
  const create = specKeys(specBlock(lines, specProperties));
  assert.deepEqual([...create].sort(), [...contract.sessionCreateFields].sort(), "Session create fields drifted from the published specification");
  const settings = specKeys(specBlock(lines, [...specProperties, "browserSettings", "properties"]));
  assert.deepEqual([...settings].sort(), [...contract.browserSettingsFields, ...excludedSettings(contract.deliberatelyExcluded)].sort(), "Browser settings fields drifted from the published specification");
  return { create, settings };
}

/** Pure comparison, so the parsing rules are covered offline against synthetic sources. */
export function checkLaunchContract(source, digest, contract) {
  const { contractSource, sessionCreateFields, browserSettingsFields, deliberatelyExcluded, sessionCreateRenames } = contract;
  assert.equal(digest, contractSource.sha256, `Pinned ${contractSource.resource} no longer hashes to its recorded digest`);
  const stripped = stripComments(source);
  // The SDK spells one argument differently from the wire field it sends; the rename is
  // declared alongside the inventory rather than inferred from a near-matching name.
  const create = declaredFields(blockBody(stripped, "export interface SessionCreateParams {")).map(
    (field) => sessionCreateRenames[field] ?? field,
  );
  assert.deepEqual([...create].sort(), [...sessionCreateFields].sort(), "Session create fields drifted from the pinned upstream resource");
  const settings = declaredFields(
    blockBody(blockBody(stripped, "export namespace SessionCreateParams {"), "export interface BrowserSettings {"),
  );
  const excluded = excludedSettings(deliberatelyExcluded);
  assert.deepEqual([...settings].sort(), [...browserSettingsFields, ...excluded].sort(), "Browser settings fields drifted from the pinned upstream resource");
  return { create, settings, excluded };
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "effect-agent-browserbase-launch-contract" } });
  assert.ok(response.ok, `Could not read ${url}: HTTP ${response.status}`);
  return await response.text();
}

export async function verifyLaunchContract({ requireCurrent = false } = {}) {
  const contract = await import(new URL("../packages/browserbase/src/internal/provider/Contract.ts", import.meta.url).href);
  const { repository, revision, resource, version, spec } = contract.contractSource;
  const source = await fetchText(`https://raw.githubusercontent.com/${repository}/${revision}/${resource}`);
  const digest = createHash("sha256").update(source).digest("hex");
  const { create, settings, excluded } = checkLaunchContract(source, digest, contract);
  checkOpenApiContract(await fetchText(spec), contract);
  // A matching transcription of a pinned revision says nothing about later releases, so
  // staleness is reported separately and an unreachable release API never masks a match.
  let latest = "unknown";
  try {
    latest = JSON.parse(await fetchText(`https://api.github.com/repos/${repository}/releases/latest`)).tag_name ?? "unknown";
  } catch (error) {
    latest = `unavailable: ${error.message}`;
  }
  const current = latest === `v${version}`;
  if (!current) {
    process.stderr.write(`Notice: pinned ${repository} v${version}; latest release reports ${latest}. Review before adopting.\n`);
    assert.ok(!requireCurrent, `Pinned ${repository} v${version} is not the latest release (${latest})`);
  }
  return { resource: `${repository}@${revision}:${resource}`, digest, spec, version, latest, current, sessionCreateFields: create.length, browserSettingsFields: settings.length, excluded, result: "committed launch contract matches the pinned upstream resource and the published specification" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyLaunchContract({ requireCurrent: process.argv.includes("--require-current") })));
}
