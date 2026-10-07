import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../scripts/site/build.js";
import { mermaidBlock, parseFlowchart } from "../scripts/site/mermaid.js";
import { headline, markdownSection, markdownToHtml } from "../scripts/site/page.js";
import { runBenchmark } from "../bench/run.js";

const root = new URL("..", import.meta.url).pathname;

describe("parseFlowchart", () => {
  it("reads shapes, arrow styles and edge labels", () => {
    const chart = parseFlowchart(
      [
        "flowchart TB",
        "  A[Client<br/>SDK] --> G{Cache}",
        "  G -.-> S[(ledger)]",
        "  G -- hit --> A",
      ].join("\n"),
    );
    expect(chart.nodes).toEqual([
      { id: "A", label: "Client\nSDK", group: "step" },
      { id: "G", label: "Cache", group: "decision" },
      { id: "S", label: "ledger", group: "store" },
    ]);
    expect(chart.edges).toEqual([
      { from: "A", to: "G" },
      { from: "G", to: "S", dashed: true },
      { from: "G", to: "A", label: "hit" },
    ]);
  });

  it("rejects syntax it cannot draw and parses the README diagram", async () => {
    expect(() => parseFlowchart("A --> B & C")).toThrow(/Unsupported/);
    const readme = await readFile(join(root, "README.md"), "utf8");
    const { nodes, edges } = parseFlowchart(mermaidBlock(readme));
    expect(nodes.length).toBeGreaterThanOrEqual(10);
    expect(
      edges.every((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to)),
    ).toBe(true);
  });
});

describe("markdown helpers", () => {
  it("extracts a section and rewrites relative links to the repository", () => {
    const md =
      "# T\n\n## A\n\nsee [bench](bench/README.md) and [brief](../docs/PRODUCT.md)\n\n## B\n\nx\n";
    const html = markdownToHtml(markdownSection(md, "A"));
    expect(html).toContain(
      "https://github.com/seanmcrae/llm-gateway-cost-aware-LLM-router-/blob/main/bench/README.md",
    );
    expect(html).toContain("/blob/main/docs/PRODUCT.md");
    expect(() => markdownSection(md, "C")).toThrow(/not found/);
  });
});

describe("buildSite", () => {
  let dir = "";
  let html = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "llmgw-site-"));
    await buildSite(root, dir);
    html = await readFile(join(dir, "index.html"), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders every section with numbers from a fresh benchmark run", async () => {
    for (const id of [
      "results",
      "quickstart",
      "architecture",
      "evaluation",
      "product",
      "limitations",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    const h = headline(await runBenchmark("test"));
    expect(html).toContain(`${h.savingsVsPremium}% lower`);
    expect(html).toContain(`${h.routed.p50Ms} ms`);
    expect(html).toContain("Problem</h3>");
    expect(html).toContain("200 mock-small (cheap)");
  });

  it("is self-contained: no external scripts, styles or images", () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
  });

  it("writes .nojekyll and the raw results", async () => {
    await expect(readFile(join(dir, ".nojekyll"), "utf8")).resolves.toBe("");
    const results = JSON.parse(await readFile(join(dir, "data/results.json"), "utf8")) as {
      split: string;
    };
    expect(results.split).toBe("test");
  });
});
