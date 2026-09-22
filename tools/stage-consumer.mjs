import assert from "node:assert/strict";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { regularFile } from "./packages.mjs";

const approved = /^packages\/(?:browser|browserbase|agent-browser)\/(?:(?:test|examples|hosted)\/[^\\\n]+|vite\.native\.config\.ts)$/;
const extension = /\.(?:ts|mts|js|mjs|json|html)$/;
const literalImports = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)(["'])([^"']+)\1/g;

/** Copy only the literal, test/example dependency closure, retaining package layout.
 * This intentionally is not a general JS resolver. Unsupported dynamic fixtures
 * must be made explicit instead of making production source visible to a consumer.
 */
export function stageConsumer(tree, destination, entries) {
  const root = realpathSync(tree), targetRoot = resolve(destination), seen = new Set();
  assert.ok(Array.isArray(entries) && entries.length > 0, "Consumer must have maintained entrypoints");
  const copy = (path) => {
    const absolute = resolve(root, path), name = relative(root, absolute).split(sep).join("/");
    assert.match(name, approved, `Dependency escapes approved test/example roots: ${name}`);
    assert.match(name, extension, "Unsupported staged fixture type");
    assert.ok(!name.split("/").some((part) => part === "node_modules" || part === "dist" || part === "src" || part.startsWith(".")), "Production, hidden or installed files cannot be staged");
    regularFile(absolute);
    assert.equal(realpathSync(absolute), absolute, "Fixture symlink cannot cross a source boundary");
    for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) assert.ok(!lstatSync(parent).isSymbolicLink(), "Fixture parent cannot be a symlink");
    if (seen.has(name)) return;
    seen.add(name);
    const target = resolve(targetRoot, name);
    assert.ok(target.startsWith(targetRoot + sep));
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(absolute, target);
    if (!/\.(?:ts|mts|js|mjs)$/.test(name)) return;
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(literalImports)) {
      const specifier = match[2];
      if (specifier.startsWith(".")) copy(relative(root, resolve(dirname(absolute), specifier)));
      else assert.ok(!specifier.startsWith("/") && !specifier.startsWith("file:") && !specifier.startsWith("#"), "No absolute, file or workspace-alias imports in installed consumers");
    }
  };
  for (const entry of entries) copy(entry);
  return [...seen].sort();
}
