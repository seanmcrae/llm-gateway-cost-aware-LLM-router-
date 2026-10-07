import { createHash } from "node:crypto";

/** Deterministic value in [0, 1) derived from the given parts. Stable across runs and platforms. */
export function hashUnit(...parts: (string | number)[]): number {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type Random = () => number;

/** mulberry32: small, fast seeded PRNG, good enough for backoff jitter and simulations. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
