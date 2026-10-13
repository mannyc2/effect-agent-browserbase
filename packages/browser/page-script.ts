/** Packaging owns page code as a closed source string, before any consumer transforms it. */
import { fileURLToPath } from "node:url";

import { type Plugin, rolldown } from "vite/rolldown";
import { parseSync } from "vite/rolldown/utils";

const bridge = fileURLToPath(new URL("./src/internal/page/bridge.ts", import.meta.url));

const installExpression = (code: string, id: string) => {
  const declaration = parseSync(id, code)
    .program.body.flatMap((node) =>
      node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration"
        ? node.declaration.declarations
        : [],
    )
    .find(({ id: binding }) => binding.type === "Identifier" && binding.name === "installSource");

  if (declaration?.init === undefined || declaration.init === null)
    throw new Error("The bridge must export its installSource expression.");

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
          (node.source.value.endsWith(".inpage.ts") || node.source.value === "./url.ts")
        );
      const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;

      return (
        declaration?.type === "FunctionDeclaration" ||
        (declaration?.type === "VariableDeclaration" &&
          declaration.declarations.every(
            ({ id: binding, init }) =>
              binding.type === "Identifier" &&
              (id === bridge
                ? binding.name === "install" || binding.name === "parts"
                : id.endsWith("/page/url.ts")
                  ? binding.name === "addresses"
                  : init?.type === "ArrowFunctionExpression"),
          ))
      );
    })
    .map((node) => code.slice(node.start, node.end))
    .join("\n");

  if (id !== bridge) return definitions;
  const expression = installExpression(code, id);
  const call = expression.type === "TemplateLiteral" ? expression.expressions[1] : undefined;

  const factories =
    call?.type === "CallExpression" &&
    call.callee.type === "MemberExpression" &&
    call.callee.object.type === "ArrayExpression"
      ? call.callee.object
      : undefined;

  if (factories === undefined) throw new Error("The bridge must serialize its page factory array.");

  return `${definitions}\nexport const parts = ${code.slice(factories.start, factories.end)};`;
};

export const pageScript = (): Plugin => ({
  name: "effect-browser-page-script",
  async transform(code, id) {
    if (id !== bridge) return;
    const entry = "\0effect-browser-page-script";

    const bundle = await rolldown({
      input: entry,
      treeshake: { moduleSideEffects: false },
      plugins: [
        {
          name: "effect-browser-page-definitions",
          resolveId: (name) => (name === entry ? entry : undefined),
          load: (name) =>
            name === entry
              ? `import { install, parts } from ${JSON.stringify(bridge)}; export default install(...parts);`
              : undefined,
          transform: (source, name) =>
            name === bridge || name.endsWith(".inpage.ts") || name.endsWith("/page/url.ts")
              ? pageDefinitions(source, name)
              : undefined,
        },
      ],
    });

    try {
      const { output } = await bundle.generate({ format: "iife", name: "pageScript" });
      const [chunk] = output;

      if (output.length !== 1 || chunk?.type !== "chunk" || chunk.imports.length !== 0)
        throw new Error("The page script must be one closed JavaScript expression.");
      const source = `(() => {${chunk.code}\nreturn pageScript;})()`;

      const expression = installExpression(code, id);

      return {
        code: code.slice(0, expression.start) + JSON.stringify(source) + code.slice(expression.end),
        map: null,
      };
    } finally {
      await bundle.close();
    }
  },
});
