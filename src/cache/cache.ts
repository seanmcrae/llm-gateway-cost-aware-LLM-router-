import type { ChatRequest, FinishReason, Usage } from "../api/schema.js";
import type { GatewayConfig } from "../config/schema.js";
import type { Clock } from "../core/clock.js";
import { sha256Hex } from "../core/random.js";
import { cosine, HashingEmbedder, type Embedder } from "./embedding.js";

export interface CachedResponse {
  content: string;
  finishReason: FinishReason;
  usage: Usage;
  modelId: string;
  /** Request id of the call that produced this response. */
  sourceRequestId: string;
}

export interface CacheHit {
  kind: "exact" | "semantic";
  response: CachedResponse;
  similarity: number;
}

type CacheConfig = GatewayConfig["cache"];

interface Entry {
  response: CachedResponse;
  expiresAt: number;
}

interface SemanticEntry extends Entry {
  /** Everything but the final user message must match exactly. */
  contextKey: string;
  vector: Float32Array;
}

/**
 * The parts of a request that must match for a cached answer to be reusable: tenant,
 * requested model or policy, sampling parameters and the conversation. Responses are never
 * shared across tenants.
 */
function contextKey(tenantId: string, request: ChatRequest, messages: ChatRequest["messages"]) {
  return sha256Hex(
    JSON.stringify([
      tenantId,
      request.model,
      request.temperature ?? null,
      request.topP ?? null,
      request.maxTokens ?? null,
      request.stop ?? null,
      messages,
    ]),
  );
}

/**
 * Exact cache (hash of the canonical request) with an optional semantic layer that matches
 * the final user message by embedding similarity when everything before it is identical.
 * Both layers are LRU-bounded and expire by TTL.
 */
export class ResponseCache {
  private readonly exact = new Map<string, Entry>();
  private semantic: SemanticEntry[] = [];

  constructor(
    private readonly config: CacheConfig,
    private readonly clock: Clock,
    private readonly embedder: Embedder = new HashingEmbedder(),
  ) {}

  get mode(): CacheConfig["mode"] {
    return this.config.mode;
  }

  get size(): number {
    return this.exact.size;
  }

  lookup(tenantId: string, request: ChatRequest): CacheHit | null {
    if (this.config.mode === "off") return null;
    const now = this.clock.now();
    const key = contextKey(tenantId, request, request.messages);
    const entry = this.exact.get(key);
    if (entry && entry.expiresAt > now) {
      // Re-insert to mark as most recently used.
      this.exact.delete(key);
      this.exact.set(key, entry);
      return { kind: "exact", response: entry.response, similarity: 1 };
    }
    if (entry) this.exact.delete(key);
    if (this.config.mode !== "semantic") return null;

    const split = splitLastUser(request);
    if (!split) return null;
    const ctx = contextKey(tenantId, request, split.context);
    const vector = this.embedder.embed(split.last);
    let best: CacheHit | null = null;
    this.semantic = this.semantic.filter((e) => e.expiresAt > now);
    for (const candidate of this.semantic) {
      if (candidate.contextKey !== ctx) continue;
      const similarity = cosine(vector, candidate.vector);
      if (similarity >= this.config.similarityThreshold && similarity > (best?.similarity ?? 0)) {
        best = { kind: "semantic", response: candidate.response, similarity };
      }
    }
    return best;
  }

  store(tenantId: string, request: ChatRequest, response: CachedResponse): void {
    if (this.config.mode === "off") return;
    const expiresAt = this.clock.now() + this.config.ttlMs;
    this.exact.set(contextKey(tenantId, request, request.messages), { response, expiresAt });
    if (this.exact.size > this.config.maxEntries) {
      const oldest = this.exact.keys().next().value;
      if (oldest !== undefined) this.exact.delete(oldest);
    }
    if (this.config.mode !== "semantic") return;
    const split = splitLastUser(request);
    if (!split) return;
    this.semantic.push({
      contextKey: contextKey(tenantId, request, split.context),
      vector: this.embedder.embed(split.last),
      response,
      expiresAt,
    });
    if (this.semantic.length > this.config.maxEntries) this.semantic.shift();
  }
}

function splitLastUser(request: ChatRequest) {
  const last = request.messages[request.messages.length - 1];
  if (last?.role !== "user") return null;
  return { context: request.messages.slice(0, -1), last: last.content };
}

/**
 * Sampling at temperature > 0 is a request for variety, so only temperature-0 requests are
 * cached unless the client opts in per request.
 */
export function isCacheable(request: ChatRequest, override?: "on" | "off"): boolean {
  if (override === "off" || request.stream) return false;
  return override === "on" || request.temperature === 0;
}
