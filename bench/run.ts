/**
 * Replay benchmark: `npm run bench` (test split, writes bench/results.json) or
 * `npm run bench -- --split dev` (prints only; the split used to choose thresholds).
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config/load.js";
import { loadItems } from "./dataset.js";
import { replay, type RunSummary, type Variant } from "./replay.js";

/** The fixed comparison shown in the README table. */
export const POLICIES: Variant[] = [
  { name: "always-cheap", model: "cheap", cache: "off" },
  { name: "always-standard", model: "standard", cache: "off" },
  { name: "always-premium", model: "premium", cache: "off" },
  { name: "routed", model: "auto", cache: "off" },
  { name: "routed + exact cache", model: "auto", cache: "exact" },
  { name: "routed + semantic cache", model: "auto", cache: "semantic" },
];

/** Threshold pairs (cheap|standard, standard|premium) traced as the routed frontier. */
export const SWEEP: [number, number][] = [
  [0.1, 0.3],
  [0.2, 0.4],
  [0.25, 0.5],
  [0.3, 0.55],
  [0.4, 0.65],
  [0.5, 0.75],
  [0.6, 0.9],
];

export interface BenchResults {
  dataset: string;
  split: "dev" | "test";
  requests: number;
  config: string;
  policies: RunSummary[];
  sweep: RunSummary[];
}

export async function runBenchmark(split: "dev" | "test"): Promise<BenchResults> {
  const items = loadItems().filter((item) => item.split === split);
  const policies: RunSummary[] = [];
  for (const variant of POLICIES) policies.push(await replay(items, variant));
  const sweep: RunSummary[] = [];
  for (const thresholds of SWEEP) {
    sweep.push(
      await replay(items, {
        name: `routed ${thresholds.join("/")}`,
        model: "auto",
        cache: "off",
        thresholds,
      }),
    );
  }
  return {
    dataset: "bench/prompts.synthetic.jsonl",
    split,
    requests: items.length,
    config: `config/default.json (thresholds ${loadConfig().routing.thresholds.join("/")})`,
    policies,
    sweep,
  };
}

export function formatTable(runs: RunSummary[]): string {
  const header =
    "| Policy | Quality proxy | Cost / 1k req | p50 latency | p95 latency | Tier mix (cheap/std/premium) | Cache hits (false) |";
  const sep = "| --- | ---: | ---: | ---: | ---: | --- | ---: |";
  const rows = runs.map((r) => {
    const mix = Object.values(r.tierMix)
      .map((v) => `${Math.round(v)}%`)
      .join(" / ");
    const cache = r.cache === "off" ? "-" : `${r.cacheHits} (${r.falseCacheHits})`;
    return `| ${r.variant} | ${r.quality.toFixed(1)}% | $${r.costPer1kUsd.toFixed(2)} | ${r.p50Ms} ms | ${r.p95Ms} ms | ${mix} | ${cache} |`;
  });
  return [header, sep, ...rows].join("\n");
}

export const RESULTS_PATH = new URL("./results.json", import.meta.url).pathname;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { split: { type: "string", default: "test" } } });
  const split = values.split === "dev" ? "dev" : "test";
  const results = await runBenchmark(split);
  process.stdout.write(
    `Replay of ${results.requests} ${split} prompts from ${results.dataset}\n\n`,
  );
  process.stdout.write(
    `${formatTable(results.policies)}\n\nThreshold sweep (routed, no cache):\n\n`,
  );
  process.stdout.write(`${formatTable(results.sweep)}\n`);
  if (split === "test") {
    writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
    process.stdout.write("\nWrote bench/results.json\n");
  }
}
