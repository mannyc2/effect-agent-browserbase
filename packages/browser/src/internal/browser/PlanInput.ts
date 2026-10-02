import { Effect, Predicate, Schema, type SchemaAST } from "effect";

import { ObservedElement, ViewportPoint, ViewportRect } from "../../BrowserData.ts";
import { Limits } from "../../PlanData.ts";

const utf8 = new TextEncoder();
const maximumNodes = 16384;
const maximumDepth = 16;
const maximumKeys = 4096;

const dataPrototypes = new Set<object | null>([
  null,
  Object.prototype,
  ObservedElement.prototype,
  ViewportPoint.prototype,
  ViewportRect.prototype,
]);

/** Cost admission precedes the semantic decoder; refinements alone run after child parsing. */
export const boundedInput = (value: unknown): boolean => {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();

  const add = (count: number): boolean => {
    bytes += count;

    return bytes <= Limits.encodedBytes;
  };

  const string = (text: string): boolean =>
    text.length <= Limits.encodedBytes && add(utf8.encode(JSON.stringify(text)).byteLength);

  const visit = (input: unknown, depth: number): boolean => {
    if (++nodes > maximumNodes || depth > maximumDepth) return false;
    if (input === null) return add(4);
    if (typeof input === "string") return string(input);
    if (typeof input === "boolean") return add(input ? 4 : 5);
    if (typeof input === "number")
      return Number.isFinite(input) && add(JSON.stringify(input).length);
    if (!Predicate.isObjectKeyword(input) || ancestors.has(input)) return false;
    ancestors.add(input);

    if (Array.isArray(input)) {
      if (input.length > Limits.steps || !add(2 + Math.max(0, input.length - 1))) return false;
      const keys = Reflect.ownKeys(input);

      // Dense JSON arrays have precisely their indices and the intrinsic length member.
      if (keys.length !== input.length + 1) return false;
      for (let index = 0; index < input.length; index++) {
        const property = Object.getOwnPropertyDescriptor(input, String(index));

        if (property === undefined || !("value" in property) || !visit(property.value, depth + 1))
          return false;
      }
    } else {
      const prototype: unknown = Object.getPrototypeOf(input);

      if (
        (prototype !== null && !Predicate.isObjectKeyword(prototype)) ||
        !dataPrototypes.has(prototype)
      )
        return false;
      const keys = Reflect.ownKeys(input);

      if (keys.length > maximumKeys || !add(2 + Math.max(0, keys.length - 1))) return false;
      for (const key of keys) {
        if (typeof key !== "string") return false;
        const property = Object.getOwnPropertyDescriptor(input, key);

        if (
          property === undefined ||
          !property.enumerable ||
          !("value" in property) ||
          !string(key) ||
          !add(1) ||
          !visit(property.value, depth + 1)
        )
          return false;
      }
    }
    ancestors.delete(input);

    return true;
  };

  try {
    if (Predicate.isObject(value)) {
      const steps = Object.getOwnPropertyDescriptor(value, "steps");

      if (
        steps !== undefined &&
        (!("value" in steps) || (Array.isArray(steps.value) && steps.value.length > Limits.steps))
      )
        return false;
    }

    return visit(value, 0);
  } catch {
    return false;
  }
};

const CostBound = Schema.Unknown.check(
  Schema.makeFilter(boundedInput, { title: "bounded finite JSON plan/input data" }),
);

/** This shared boundary never traverses an oversized step array in the semantic decoder. */
export const guardedDecode = <S extends Schema.Constraint>(schema: S) => {
  const admit = Schema.decodeUnknownEffect(CostBound);
  const decode = Schema.decodeUnknownEffect(schema);

  return (value: unknown, options?: SchemaAST.ParseOptions) =>
    admit(value).pipe(Effect.flatMap((input) => decode(input, options)));
};
