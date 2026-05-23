/**
 * Truly global types only. Domain shapes live in src/domains/<domain>/types.ts.
 */

export type AsyncResult<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export type ISODateString = string & { readonly __brand: "ISODateString" };

export type Nominal<T, Brand extends string> = T & { readonly __brand: Brand };
