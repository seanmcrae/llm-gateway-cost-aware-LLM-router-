import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatTable, RESULTS_PATH, type BenchResults } from "../bench/run.js";
import { runDemo } from "../scripts/demo.js";
import { CHART_PATH, frontierChart } from "../scripts/site/frontier.js";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as BenchResults;

/** Table rows as trimmed cells, so Prettier's column alignment does not matter. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

describe("README", () => {
  it("shows the results table exactly as npm run bench produces it", () => {
    const expected = tableRows(formatTable(results.policies));
    const readme = tableRows(read("README.md"));
    const start = readme.findIndex((row) => row[0] === "Policy");
    expect(readme.slice(start, start + expected.length)).toEqual(expected);
  });

  it("shows the real npm run demo output", async () => {
    const demo = await runDemo();
    expect(read("README.md")).toContain(`\`\`\`text\n${demo}\`\`\``);
  });
});

describe("headline chart", () => {
  it("matches a fresh render from bench/results.json (npm run chart)", () => {
    expect(read(CHART_PATH)).toBe(frontierChart(results));
  });
});
