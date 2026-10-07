/**
 * Builds the static docs site: `npm run site` (or `tsx scripts/site/build.ts [outDir]`).
 * Reruns the benchmark and the demo, so every number and transcript on the page comes from
 * the code at build time, and writes one self-contained index.html. No network access needed.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBenchmark } from "../../bench/run.js";
import { runDemo } from "../demo.js";
import { frontierChart } from "./frontier.js";
import { mermaidBlock } from "./mermaid.js";
import { markdownSection, renderPage } from "./page.js";

export async function buildSite(root: string, outDir: string): Promise<string[]> {
  const read = (path: string) => readFile(join(root, path), "utf8");
  const [readme, product, pkg] = await Promise.all([
    read("README.md"),
    read("docs/PRODUCT.md"),
    read("package.json"),
  ]);
  const results = await runBenchmark("test");
  const html = renderPage({
    version: (JSON.parse(pkg) as { version: string }).version,
    results,
    chartSvg: frontierChart(results),
    demo: await runDemo(),
    architectureMermaid: mermaidBlock(readme),
    designMarkdown: markdownSection(readme, "Design decisions"),
    evaluationMarkdown: markdownSection(readme, "How evaluation works"),
    limitationsMarkdown: markdownSection(readme, "Limitations"),
    productMarkdown: product,
  });

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "data"), { recursive: true });
  await writeFile(join(outDir, "index.html"), html);
  await writeFile(join(outDir, ".nojekyll"), "");
  await writeFile(join(outDir, "data", "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  return ["index.html", ".nojekyll", "data/results.json"];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const outDir = resolve(process.argv[2] ?? join(root, "site"));
  const written = await buildSite(root, outDir);
  process.stdout.write(`Built ${outDir}: ${written.join(", ")}\n`);
}
