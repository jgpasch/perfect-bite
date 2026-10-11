// A cheap content hash, so data bundled with the app (the catalog seed) can tell when it changed.
// Pure.

/** 32-bit FNV-1a over the JSON of `value`, as an unsigned integer. */
export function fingerprint(value: unknown): number {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
