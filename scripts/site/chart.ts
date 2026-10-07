/** Writes the README's headline chart from bench/results.json: `npm run chart`. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchResults } from "../../bench/run.js";
import { CHART_PATH, frontierChart } from "./frontier.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const results = JSON.parse(readFileSync(join(root, "bench/results.json"), "utf8")) as BenchResults;
writeFileSync(join(root, CHART_PATH), frontierChart(results));
process.stdout.write(`Wrote ${CHART_PATH}\n`);
