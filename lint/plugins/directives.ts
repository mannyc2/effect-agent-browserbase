// A comment that switches a check off says why, after ` -- `, so a reviewer can judge the
// exception where it sits. TypeScript's own directives are `typescript/ban-ts-comment`'s.
import type { RuleTester } from "vite-plus/lint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];

const directive = /^\s*(?:(?:oxlint|eslint)-disable|@effect-diagnostics)\b/;

const requireReason = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      reason: "Say why after ` -- `: `// <directive> -- <why this site is an exception>`.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments())
          if (directive.test(comment.value) && !/ -- \S/.test(comment.value))
            context.report({ loc: comment.loc, messageId: "reason" });
      },
    };
  },
} satisfies Rule;

export default {
  meta: { name: "directives" },
  rules: { "require-reason": requireReason },
};
