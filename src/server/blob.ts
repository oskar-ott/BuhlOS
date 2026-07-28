import { list, put } from "@vercel/blob";

/**
 * TypeScript blob helper for server components / route handlers.
 *
 * The legacy `api/*.js` Vercel functions persist via `api/_lib/blob.js`, which
 * TypeScript cannot import. This is the smallest TS equivalent — read/write a
 * JSON blob by key over `@vercel/blob`, mirroring that module's `put`
 * conventions (`access: public`, JSON content type, no random suffix, the
 * `BLOB_READ_WRITE_TOKEN`). It is intentionally minimal: no cache layer, no
 * store abstraction. It does NOT replace `api/_lib/blob.js` and changes no
 * existing route.
 *
 * It arrived with the job-control runtime boundary and outlived it: the gut
 * pass (docs/product/02-lean-reset.md) deleted job-control, and the ServiceM8
 * command-centre card is now the only reader. Before any real production write
 * lands, register the key in `api/_lib/backup-manifest.js` and decide whether
 * to port the #157 write guards or route the write through the JS layer.
 */

const token = (): string | undefined => process.env.BLOB_READ_WRITE_TOKEN;

/**
 * True when Blob storage is configured (a write token is present). Lets a route
 * report storage availability without a network round-trip — safe in preview,
 * CI and tests where no token is set.
 */
export function isBlobConfigured(): boolean {
  return Boolean(token());
}

/**
 * Read a JSON blob by its exact key. Mirrors `api/_lib/blob.js#readBlob`: list
 * by the key prefix, match the exact pathname, fetch the blob and parse it.
 * Returns `fallback` (default `null`) when the key does not exist or is
 * unreadable — never throws on a missing blob.
 */
export async function readJsonBlob<T>(key: string, fallback: T | null = null): Promise<T | null> {
  const { blobs } = await list({ prefix: key, token: token() });
  const match = blobs.find((b) => b.pathname === key);
  if (!match) return fallback;
  const res = await fetch(match.url, { cache: "no-store" });
  if (!res.ok) return fallback;
  return (await res.json()) as T;
}

/**
 * Write a JSON blob by its exact key. Mirrors `api/_lib/blob.js#writeBlob`'s
 * `put` call (minus the in-process cache and the #157 write guards, which live
 * in the JS layer). For L0/L1 producers — not used by the runtime-check route.
 */
export async function writeJsonBlob(key: string, data: unknown): Promise<void> {
  await put(key, JSON.stringify(data), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    token: token(),
  });
}
