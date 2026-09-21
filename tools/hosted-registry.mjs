#!/usr/bin/env node
// Reads the hosted-check registry for tools/hosted-run.sh. Dependency-free, so it runs on the
// pinned Node before anything is installed. The registry is TypeScript with erasable types
// only, which Node strips on import.
//
//   hosted-registry.mjs select <checks.ts> <name>...   validate names and settings, print plan
//   hosted-registry.mjs verify <checks.ts> <name> <record.jsonl>   check a finished run's record
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const loadRegistry = async (path) => import(pathToFileURL(resolve(path)).href);

/** Every refusal happens here, before any check allocates. */
export const select = ({ checks, ceiling }, names, env) => {
  if (names.length === 0) throw new Error("Name at least one hosted check");
  if (new Set(names).size !== names.length) throw new Error("A hosted check is named twice");
  return names.map((name) => {
    const check = Object.hasOwn(checks, name) ? checks[name] : undefined;

    if (check === undefined) {
      throw new Error(`Unknown hosted check ${name}; known: ${Object.keys(checks).join(", ")}`);
    }
    for (const [key, limit] of Object.entries(ceiling)) {
      if (!(check.budget[key] <= limit)) throw new Error(`${name} exceeds the ${key} ceiling`);
    }
    const missing = check.env.filter((key) => !env[key]);

    if (missing.length > 0) throw new Error(`${name} requires ${missing.join(", ")}`);
    if (check.operator && env.CI !== undefined) {
      throw new Error(`${name} needs an operator at a terminal and never runs in CI`);
    }
    return { name, media: check.media, sessions: check.budget.sessions };
  });
};

/** A record that allocated more than its budget, or never completed, fails the run. */
export const verify = ({ checks }, name, text) => {
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const own = lines.filter((line) => line.check === name);
  const allocated = own.filter((line) => line.phase === "allocated").length;
  const budget = checks[name].budget.sessions;

  if (allocated > budget) throw new Error(`${name} allocated ${allocated} of ${budget} sessions`);
  if (own.at(-1)?.phase !== "complete") throw new Error(`${name} did not complete`);
  return { name, allocated };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, registryPath, ...rest] = process.argv.slice(2);

  try {
    const registry = await loadRegistry(registryPath);

    if (command === "select") {
      for (const item of select(registry, rest, process.env)) {
        console.log(`${item.name}\t${item.media ? "media" : "-"}`);
      }
    } else if (command === "verify") {
      console.error(JSON.stringify(verify(registry, rest[0], readFileSync(rest[1], "utf8"))));
    } else {
      throw new Error("usage: hosted-registry.mjs select|verify <checks.ts> ...");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
