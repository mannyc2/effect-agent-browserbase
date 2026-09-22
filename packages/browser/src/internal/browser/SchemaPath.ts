import type { Schema, SchemaIssue } from "effect";

/** Report only a top-level key declared by the failed schema, never an input key or value. */
export const schemaPath = (error: Schema.SchemaError): { readonly path?: string } => {
  let issue: SchemaIssue.Issue = error.issue;
  let remaining = 32;

  while (remaining-- > 0 && (issue._tag === "Encoding" || issue._tag === "Filter")) {
    issue = issue.issue;
  }
  if (issue._tag !== "Composite" || issue.ast._tag !== "Objects") return {};
  const first = issue.issues[0];

  if (first._tag !== "Pointer" || first.path.length === 0) return {};
  const key = first.path[0];

  if (typeof key !== "string" || key.length > 512) return {};
  const declared = issue.ast.propertySignatures.find((property) => property.name === key);

  return declared === undefined ? {} : { path: key };
};
