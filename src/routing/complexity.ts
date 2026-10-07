import type { Message } from "../api/schema.js";
import { estimateTextTokens } from "../core/tokens.js";

export interface Complexity {
  /** 0 (trivial) to 1 (needs the most capable tier). */
  score: number;
  /** Human-readable features that moved the score, surfaced in the route reason. */
  signals: string[];
}

const REASONING =
  /\b(prove|proof|derive|step[- ]by[- ]step|explain why|trade-?offs?|analy[sz]e|compare|design|architect\w*|optimi[sz]e|debug|root cause|edge cases?|complexity|algorithm|invariant|concurren\w+|race condition|strategy|migrat\w+|threat model)\b/gi;
const SIMPLE =
  /\b(translate|classify|sentiment|extract|rewrite|reword|fix (?:the )?(?:typo|grammar|spelling)|one word|yes or no|tl;?dr|label|title for|capitali[sz]e|convert .* to (?:json|csv|uppercase|lowercase))\b/gi;
const CODE =
  /```|\bfunction\b|=>|\bdef \w+\(|\bclass \w+|\bSELECT\b.*\bFROM\b|\bimport \w+|[{};]\s*$/im;
const CONSTRAINT =
  /\b(must|must not|should|at least|at most|no more than|without|exactly|ensure|constraint)\b/gi;

const clamp = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Cheap, explainable complexity estimate from the conversation text alone. It runs on every
 * request, so it uses regexes and counts rather than a model call. It is deliberately
 * conservative: a hard prompt routed cheap costs quality, an easy prompt routed premium only
 * costs money. The weights were set by hand, then the tier thresholds were tuned on the
 * benchmark's dev split (see bench/README.md).
 */
export function scoreComplexity(messages: readonly Message[]): Complexity {
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const allText = messages.map((m) => m.content).join("\n");
  const signals: string[] = [];

  const tokens = estimateTextTokens(userText);
  // 40 tokens -> 0, ~1300 tokens -> 1, logarithmic in between.
  const length = clamp(Math.log2(Math.max(1, tokens) / 40) / 5);
  if (length > 0.4) signals.push(`long:${tokens}tok`);

  const reasoning = new Set((allText.match(REASONING) ?? []).map((w) => w.toLowerCase()));
  if (reasoning.size > 0) signals.push(`reasoning:${[...reasoning].slice(0, 3).join(",")}`);

  const code = CODE.test(userText);
  if (code) signals.push("code");

  const constraints =
    (userText.match(CONSTRAINT) ?? []).length +
    (userText.match(/^\s*(?:\d+\.|-|\*)\s/gm) ?? []).length;
  if (constraints >= 3) signals.push(`constraints:${constraints}`);

  const questions = (userText.match(/\?/g) ?? []).length;
  if (questions >= 2) signals.push(`questions:${questions}`);

  const simple = new Set((userText.match(SIMPLE) ?? []).map((w) => w.toLowerCase()));
  if (simple.size > 0) signals.push(`simple:${[...simple].slice(0, 2).join(",")}`);

  const turns = messages.filter((m) => m.role === "assistant").length;
  if (turns >= 2) signals.push(`turns:${turns}`);

  const raw =
    0.15 +
    0.2 * length +
    0.3 * clamp(reasoning.size / 2) +
    0.25 * (code ? 1 : 0) +
    0.15 * clamp(constraints / 5) +
    0.1 * clamp((questions - 1) / 2) +
    0.05 * clamp(turns / 4) -
    0.25 * clamp(simple.size);
  return { score: Math.round(clamp(raw) * 1000) / 1000, signals };
}
