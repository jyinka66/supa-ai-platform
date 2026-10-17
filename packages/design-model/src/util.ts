/**
 * DeepReadonly — makes every property of T readonly (recursively).
 * Used by the `apply()` function to enforce immutability of the input doc.
 */
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T extends object ? DeepReadonly<T[K]> : T[K];
};
