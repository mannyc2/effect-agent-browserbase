/** Packaging owns page code as a closed source string, before any consumer transforms it. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";
import { rolldown } from "vite/rolldown";
import { parseSync } from "vite/rolldown/utils";

const bridge = fileURLToPath(new URL("./src/internal/page/bridge.ts", import.meta.url));
const clock = fileURLToPath(new URL("./src/internal/page/clock.inpage.ts", import.meta.url));
// The two shared internals whose page-safe definitions the bridge also uses.
const url = fileURLToPath(new URL("./src/internal/url.ts", import.meta.url));
const matching = fileURLToPath(new URL("./src/internal/matching.ts", import.meta.url));
const shared = (path: string) => path === url || path === matching;

// Each source the bridge exports, and what its frozen expression evaluates to: the installed API,
// and the page clock's function.
const sources = {
  installSource: `import { install, parts } from ${JSON.stringify(bridge)}; export default install(parts);`,
  clockSource: `import { clock } from ${JSON.stringify(clock)}; import { clockParts } from ${JSON.stringify(bridge)}; export default clock(clockParts);`,
};

const exported = (code: string, id: string, name: string) => {
  const declaration = parseSync(id, code)
    .program.body.flatMap((node) =>
      node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration"
        ? node.declaration.declarations
        : [],
    )
    .find(({ id: binding }) => binding.type === "Identifier" && binding.name === name);

  if (declaration?.init === undefined || declaration.init === null)
    throw new Error(`The bridge must export its ${name} expression.`);

  return declaration.init;
};

// Page factories use only parameters, DOM globals and their own definitions. Keep those
// definitions and their import names; host-only schemas and effects never enter this bundle.
const pageDefinitions = (code: string, id: string) => {
  const definitions = parseSync(id, code)
    .program.body.filter((node) => {
      if (node.type === "ImportDeclaration")
        return (
          id === bridge &&
          (node.source.value.endsWith(".inpage.ts") ||
            shared(resolve(dirname(bridge), node.source.value)))
        );
      const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;

      return (
        declaration?.type === "FunctionDeclaration" ||
        (declaration?.type === "VariableDeclaration" &&
          declaration.declarations.every(
            ({ id: binding, init }) =>
              binding.type === "Identifier" &&
              (id === bridge
                ? ["install", "parts", "clockParts"].includes(binding.name)
                : id === url
                  ? binding.name === "addresses"
                  : init?.type === "ArrowFunctionExpression"),
          ))
      );
    })
    .map((node) => code.slice(node.start, node.end))
    .join("\n");

  return definitions;
};

// One closed JavaScript expression that evaluates to what `entry` exports by default.
const closed = async (entry: string) => {
  const name = "\0effect-browser-page-script";

  const bundle = await rolldown({
    input: name,
    treeshake: { moduleSideEffects: false },
    plugins: [
      {
        name: "effect-browser-page-definitions",
        resolveId: (asked) => (asked === name ? name : undefined),
        load: (asked) => (asked === name ? entry : undefined),
        transform: (source, asked) =>
          asked === bridge || asked.endsWith(".inpage.ts") || shared(asked)
            ? pageDefinitions(source, asked)
            : undefined,
      },
    ],
  });

  try {
    const { output } = await bundle.generate({ format: "iife", name: "pageScript" });
    const [chunk] = output;

    if (output.length !== 1 || chunk?.type !== "chunk" || chunk.imports.length !== 0)
      throw new Error("The page script must be one closed JavaScript expression.");

    return `(() => {${chunk.code}\nreturn pageScript;})()`;
  } finally {
    await bundle.close();
  }
};

export const pageScript = (): Plugin => ({
  name: "effect-browser-page-script",
  enforce: "pre",
  async transform(code, id) {
    if (id !== bridge) return;
    let frozen = code;

    // The later expression first, so the earlier one's offsets still hold.
    const replacements = await Promise.all(
      Object.entries(sources).map(async ([name, entry]) => ({
        expression: exported(code, id, name),
        source: await closed(entry),
      })),
    );

    for (const { expression, source } of replacements.toSorted(
      (one, other) => other.expression.start - one.expression.start,
    ))
      frozen =
        frozen.slice(0, expression.start) + JSON.stringify(source) + frozen.slice(expression.end);

    return { code: frozen, map: null };
  },
});
