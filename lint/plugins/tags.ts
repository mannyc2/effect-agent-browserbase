// Effect's doc tags on what a published package exports: each export's doc carries `@stability`,
// `@category` and `@since`; a module's opening doc and a barrel's `export * as` entries carry
// `@stability` and `@since`. Public means reachable through the package's exports map.
import { readFileSync } from "node:fs";

import type { RuleTester } from "vite-plus/lint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Visitor = ReturnType<NonNullable<Rule["create"]>>;
type Node = Parameters<NonNullable<Visitor[string]>>[0];
type Exports = { readonly [subpath: string]: Entry };
type Entry = string | null | { readonly [condition: string]: Entry };

/** The categories in use, from Effect's own; a new one is added here on purpose. */
const categories = [
  "combinators",
  "constants",
  "constructors",
  "errors",
  "guards",
  "layers",
  "models",
  "options",
  "predicates",
  "schemas",
  "services",
  "toolkits",
];
const values: Record<string, RegExp> = {
  stability: /^(stable|unstable|experimental)$/,
  category: new RegExp(`^(${categories.join("|")})$`),
  since: /^\d+\.\d+\.\d+$/,
};

// Node's resolution of a subpath through an exports map: the exact key, else the pattern with the
// longest prefix (as tools/check-boundaries.mjs). Null closes a path.
const resolveSubpath = (exports: Exports, subpath: string): Entry | undefined => {
  if (Object.hasOwn(exports, subpath)) return exports[subpath];
  let best: { key: string; prefix: string; match: string } | undefined;

  for (const key of Object.keys(exports)) {
    const [prefix, suffix, extra] = key.split("*");

    if (prefix === undefined || suffix === undefined || extra !== undefined) continue;
    if (
      subpath.length >= key.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (best === undefined ||
        prefix.length > best.prefix.length ||
        (prefix.length === best.prefix.length && key.length > best.key.length))
    )
      best = { key, prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  if (best === undefined) return undefined;
  const { key, match } = best;
  const fill = (entry: Entry): Entry =>
    typeof entry === "string"
      ? entry.replaceAll("*", match)
      : entry &&
        Object.fromEntries(Object.entries(entry).map(([name, inner]) => [name, fill(inner)]));

  return fill(exports[key] ?? null);
};
const targets = (entry: Entry | undefined): ReadonlyArray<string> =>
  typeof entry === "string" ? [entry] : Object.values(entry ?? {}).flatMap(targets);

const published = new Map<string, Exports | undefined>();

/** Whether a file is a published package's public module: its own subpath, or an exact entry, reaches it. */
const isPublic = (filename: string) => {
  const [, root, path] =
    /^(.*\/packages\/[^/]+)\/(src\/.*)\.ts$/.exec(filename.replaceAll("\\", "/")) ?? [];

  if (root === undefined || path === undefined) return false;
  if (!published.has(root)) {
    const manifest: unknown = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));

    published.set(
      root,
      typeof manifest === "object" &&
        manifest !== null &&
        !("private" in manifest && manifest.private === true) &&
        "exports" in manifest &&
        typeof manifest.exports === "object" &&
        manifest.exports !== null
        ? (manifest.exports as Exports)
        : undefined,
    );
  }
  const exports = published.get(root);

  if (exports === undefined) return false;
  const file = `./${path}.ts`;
  const own = path.replace(/^src\//, "").replace(/(^|\/)index$/, "");

  return (
    targets(resolveSubpath(exports, own === "" ? "." : `./${own}`)).includes(file) ||
    Object.entries(exports).some(
      ([key, entry]) => !key.includes("*") && targets(entry).includes(file),
    )
  );
};

const exportedName = (node: Node) =>
  node.type === "Identifier" ? node.name : node.type === "Literal" ? String(node.value) : "";

const tagged = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing:
        "{{what}} is public: its doc needs {{tags}}, as Effect tags its exports (`@stability stable`, `@category <kind>`, `@since 0.3.0`).",
      category: "{{what}}: `@category {{value}}` is not one of {{categories}}.",
      value: "{{what}}: `@{{tag}} {{value}}` is not a valid {{tag}}.",
    },
  },
  create(context) {
    if (!isPublic(context.filename)) return {};
    const { sourceCode } = context;

    return {
      Program(program) {
        const isDoc = (comment: { type: string; value: string }) =>
          comment.type === "Block" && comment.value.startsWith("*");
        const first = sourceCode.getAllComments().find(isDoc);
        const moduleDoc =
          first !== undefined &&
          (program.body[0] === undefined || first.start < program.body[0].start)
            ? first
            : undefined;
        // The doc TypeScript gives a node, unless it is the module's own.
        const docOf = (node: Node) =>
          sourceCode
            .getCommentsBefore(node)
            .findLast((comment) => isDoc(comment) && comment.start !== moduleDoc?.start);
        const check = (
          node: Node,
          what: string,
          doc: { value: string } | undefined,
          wanted: ReadonlyArray<string>,
        ) => {
          const found = new Map(
            [...(doc?.value ?? "").matchAll(/^[ \t]*\*?[ \t]*@(\w+)[ \t]+(.*?)[ \t]*$/gm)].map(
              ([, tag = "", value = ""]) => [tag, value],
            ),
          );
          const missing = wanted.filter((tag) => !found.has(tag));

          if (missing.length > 0)
            context.report({
              node,
              messageId: "missing",
              data: { what, tags: missing.map((tag) => `@${tag}`).join(", ") },
            });
          for (const tag of wanted) {
            const value = found.get(tag);

            if (value === undefined || values[tag]?.test(value) !== false) continue;
            context.report({
              node,
              ...(tag === "category"
                ? {
                    messageId: "category",
                    data: { what, value, categories: categories.join(", ") },
                  }
                : { messageId: "value", data: { what, tag, value } }),
            });
          }
        };
        const all = ["stability", "category", "since"];
        const overloaded = new Set<string>();

        check(program, "This module", moduleDoc, ["stability", "since"]);
        for (const statement of program.body) {
          if (statement.type === "ExportAllDeclaration") {
            const name = statement.exported === null ? "*" : exportedName(statement.exported);

            check(statement, `\`${name}\``, docOf(statement), ["stability", "since"]);
          } else if (statement.type === "ExportNamedDeclaration") {
            const declaration = statement.declaration;

            if (declaration === null) {
              for (const specifier of statement.specifiers)
                check(
                  specifier,
                  `\`${exportedName(specifier.exported)}\``,
                  docOf(specifier) ?? docOf(statement),
                  all,
                );
              continue;
            }
            const name =
              declaration.type === "VariableDeclaration"
                ? declaration.declarations
                    .map(({ id }) => (id.type === "Identifier" ? id.name : sourceCode.getText(id)))
                    .join(", ")
                : "id" in declaration &&
                    declaration.id !== null &&
                    declaration.id.type === "Identifier"
                  ? declaration.id.name
                  : "export";

            // An overloaded function's doc sits on its first signature.
            if (
              declaration.type === "TSDeclareFunction" ||
              declaration.type === "FunctionDeclaration"
            ) {
              if (overloaded.has(name)) continue;
              overloaded.add(name);
            }
            check(statement, `\`${name}\``, docOf(statement), all);
          } else if (statement.type === "ExportDefaultDeclaration")
            check(statement, "The default export", docOf(statement), all);
        }
      },
    };
  },
} satisfies Rule;

export default {
  meta: { name: "tags" },
  rules: { public: tagged },
};
