/**
 * `Array.isArray` narrows to `any[]`, which erases a readonly array's element type. This keeps
 * the same runtime check and the declared element type.
 */
export const isList = <T>(value: T): value is Extract<T, ReadonlyArray<unknown>> =>
  Array.isArray(value);
