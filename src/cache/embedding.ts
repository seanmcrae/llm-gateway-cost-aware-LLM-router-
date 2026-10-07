/** Turns text into a unit vector. Swap in a real embedding model behind this interface. */
export interface Embedder {
  embed(text: string): Float32Array;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Feature-hashed bag of word unigrams and bigrams. Offline and deterministic, it catches
 * rephrasings that reuse most of the same words (casing, punctuation, a polite prefix) but
 * not true paraphrases. It is the default because it needs no model and no network; the
 * semantic cache's false-hit risk is measured in the benchmark either way.
 */
export class HashingEmbedder implements Embedder {
  constructor(private readonly dimensions = 1024) {}

  embed(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const add = (feature: string, weight: number) => {
      const hash = fnv1a(feature);
      const slot = hash % this.dimensions;
      // The top bit picks the sign, which keeps hash collisions from always adding up.
      vector[slot] = (vector[slot] ?? 0) + (hash & 0x80000000 ? -weight : weight);
    };
    words.forEach((word, i) => {
      add(word, 1);
      if (i > 0) add(`${words[i - 1] ?? ""} ${word}`, 1);
    });
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
    return vector;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
