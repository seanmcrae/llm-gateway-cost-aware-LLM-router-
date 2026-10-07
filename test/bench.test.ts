import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATASET_PATH, loadItems } from "../bench/dataset.js";
import { generateItems, serialize } from "../bench/generate.js";
import { passProbability, replay } from "../bench/replay.js";
import { RESULTS_PATH, runBenchmark } from "../bench/run.js";

describe("synthetic prompt set", () => {
  it("matches a fresh generation byte for byte (npm run bench:generate)", () => {
    expect(readFileSync(DATASET_PATH, "utf8")).toBe(serialize(generateItems()));
  });

  it("has two disjoint splits and consistent labels for repeated prompts", () => {
    const items = loadItems();
    expect(items.filter((i) => i.split === "dev")).toHaveLength(300);
    expect(items.filter((i) => i.split === "test")).toHaveLength(300);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    const byGroup = new Map<string, number>();
    for (const item of items) {
      expect(item.group.startsWith(item.split)).toBe(true);
      const difficulty = byGroup.get(item.group) ?? item.difficulty;
      expect(item.difficulty).toBe(difficulty);
      byGroup.set(item.group, difficulty);
    }
    const repeats = items.filter((i) => i.group !== i.id).length / items.length;
    expect(repeats).toBeGreaterThan(0.25);
    expect(repeats).toBeLessThan(0.4);
  });
});

describe("quality proxy", () => {
  it("rises with capability and falls with difficulty", () => {
    expect(passProbability(4.6, 1)).toBeGreaterThan(0.99);
    expect(passProbability(2.3, 4)).toBeLessThan(0.15);
    expect(passProbability(3, 3)).toBeCloseTo(1 / (1 + Math.exp(-1)));
    expect(passProbability(3.4, 3)).toBeGreaterThan(passProbability(2.3, 3));
  });
});

describe("replay benchmark", () => {
  it("is deterministic", async () => {
    const items = loadItems()
      .filter((i) => i.split === "dev")
      .slice(0, 60);
    const variant = { name: "routed", model: "auto", cache: "exact" as const };
    expect(await replay(items, variant)).toEqual(await replay(items, variant));
  });

  it("reproduces the committed bench/results.json (npm run bench)", async () => {
    const committed = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as unknown;
    expect(await runBenchmark("test")).toEqual(committed);
  });

  it("orders the fixed tiers by cost and quality, with routing in between", async () => {
    const { policies } = await runBenchmark("test");
    const get = (name: string) => {
      const run = policies.find((p) => p.variant === name);
      if (!run) throw new Error(name);
      return run;
    };
    const [cheap, premium, routed, exact] = [
      get("always-cheap"),
      get("always-premium"),
      get("routed"),
      get("routed + exact cache"),
    ];
    expect(cheap.costPer1kUsd).toBeLessThan(routed.costPer1kUsd);
    expect(routed.costPer1kUsd).toBeLessThan(premium.costPer1kUsd);
    expect(cheap.quality).toBeLessThan(routed.quality);
    expect(routed.quality).toBeLessThan(premium.quality);
    expect(exact.falseCacheHits).toBe(0);
    expect(exact.costPer1kUsd).toBeLessThan(routed.costPer1kUsd);
    expect(policies.every((p) => p.errors === 0)).toBe(true);
  });
});
