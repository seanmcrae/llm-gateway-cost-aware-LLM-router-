/**
 * Renders the single-page docs site. Pure functions from collected data to an HTML string;
 * CSS is inlined and diagrams are SVG, so the page works offline with no external assets.
 */
import { Marked, type Tokens } from "marked";
import type { RunSummary } from "../../bench/replay.js";
import type { BenchResults } from "../../bench/run.js";
import { parseFlowchart } from "./mermaid.js";
import { escapeXml as esc, graphSvg } from "./svg.js";

export const REPO_URL = "https://github.com/seanmcrae/llm-gateway-cost-aware-LLM-router-";
export const PAGES_URL = "https://seanmcrae.github.io/llm-gateway-cost-aware-LLM-router-/";

export interface PageInput {
  version: string;
  results: BenchResults;
  chartSvg: string;
  demo: string;
  architectureMermaid: string;
  designMarkdown: string;
  evaluationMarkdown: string;
  limitationsMarkdown: string;
  productMarkdown: string;
}

/** Markdown links to repo files become absolute GitHub links, since the site has no copies. */
export function markdownToHtml(markdown: string, headingShift = 0): string {
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === "heading") {
        const heading = token as Tokens.Heading;
        heading.depth = Math.min(6, heading.depth + headingShift);
        return;
      }
      if (token.type !== "link") return;
      const link = token as Tokens.Link;
      if (!/^(https?:|#|mailto:)/.test(link.href)) {
        link.href = `${REPO_URL}/blob/main/${link.href.replace(/^(\.\.\/|\.\/)+/, "")}`;
      }
    },
  });
  return marked.parse(markdown, { async: false });
}

/** The body of a `## Heading` section, without the heading itself. */
export function markdownSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`Section "${heading}" not found`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##?\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

function find(results: BenchResults, variant: string): RunSummary {
  const run = results.policies.find((p) => p.variant === variant);
  if (!run) throw new Error(`benchmark has no "${variant}" run`);
  return run;
}

const money = (x: number) => `$${x.toFixed(2)}`;
const pct = (x: number) => `${x.toFixed(1)}%`;

/** Headline comparisons, computed from the benchmark rather than typed. */
export function headline(results: BenchResults) {
  const premium = find(results, "always-premium");
  const standard = find(results, "always-standard");
  const routed = find(results, "routed");
  const exact = find(results, "routed + exact cache");
  const semantic = find(results, "routed + semantic cache");
  return {
    premium,
    standard,
    routed,
    exact,
    semantic,
    savingsVsPremium: Math.round((1 - routed.costPer1kUsd / premium.costPer1kUsd) * 100),
    exactSavings: Math.round((1 - exact.costPer1kUsd / routed.costPer1kUsd) * 100),
  };
}

function hero(data: PageInput): string {
  const h = headline(data.results);
  return `
<header class="hero" id="top">
  <div class="wrap hero-grid">
    <div>
      <p class="eyebrow">llm-gateway v${esc(data.version)} &middot; TypeScript &middot; OpenAI-compatible</p>
      <h1>Send each LLM request to the cheapest model that can answer it, and keep serving when a provider fails.</h1>
      <p class="lede">A drop-in <code>/v1/chat/completions</code> gateway that routes across model tiers by task complexity, budget, cost cap and latency SLO, with fallback chains, retries, circuit breakers, response caching, per-tenant budgets and rate limits, and per-request cost telemetry. Runs with a deterministic mock provider, so everything on this page was produced without API keys.</p>
      <ul class="kpis">
        <li><strong>${h.savingsVsPremium}% lower</strong><span>cost than always-premium<br>(${money(h.routed.costPer1kUsd)} vs ${money(h.premium.costPer1kUsd)} per 1k)</span></li>
        <li><strong>${h.routed.p50Ms} ms</strong><span>p50 latency<br>vs ${h.premium.p50Ms} ms premium</span></li>
        <li><strong>${pct(h.routed.quality)}</strong><span>quality proxy<br>vs ${pct(h.premium.quality)} premium</span></li>
      </ul>
      <p class="fine">Routed policy, <code>npm run bench</code>, ${data.results.requests} prompts from the synthetic ${data.results.split} split, simulated providers with illustrative prices. The quality proxy is a simulation; see <a href="#evaluation">how evaluation works</a>.</p>
      <p class="cta"><a class="button" href="#results">See the results</a> <a class="button ghost" href="${REPO_URL}">View on GitHub</a></p>
    </div>
    <figure class="chart">${data.chartSvg}</figure>
  </div>
</header>`;
}

function runRow(r: RunSummary): string {
  const mix = Object.values(r.tierMix)
    .map((v) => `${Math.round(v)}%`)
    .join(" / ");
  const cache = r.cache === "off" ? "-" : `${r.cacheHits} (${r.falseCacheHits})`;
  return `<tr><td>${esc(r.variant)}</td><td>${pct(r.quality)}</td><td>${money(r.costPer1kUsd)}</td><td>${r.p50Ms} ms</td><td>${r.p95Ms} ms</td><td>${mix}</td><td>${r.retries}</td><td>${cache}</td></tr>`;
}

const RUN_HEAD =
  "<thead><tr><th>Policy</th><th>Quality proxy</th><th>Cost / 1k req</th><th>p50</th><th>p95</th><th>Tier mix (cheap / std / premium)</th><th>Retries</th><th>Cache hits (false)</th></tr></thead>";

function categoryTable(results: BenchResults): string {
  const runs = ["always-cheap", "always-standard", "always-premium", "routed"].map((v) =>
    find(results, v),
  );
  const categories = Object.keys(runs[0]?.qualityByCategory ?? {});
  const rows = categories
    .map((c) => {
      const cells = runs.map((r) => r.qualityByCategory[c] ?? 0);
      const routed = cells[3] ?? 0;
      const premium = cells[2] ?? 0;
      const flag = premium - routed >= 30 ? ' class="gap"' : "";
      return `<tr${flag}><td>${esc(c)}</td>${cells.map((v) => `<td>${pct(v)}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<table class="num"><thead><tr><th>Category</th>${runs.map((r) => `<th>${esc(r.variant)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function resultsSection(data: PageInput): string {
  const { results } = data;
  const h = headline(results);
  const tricky = h.routed.qualityByCategory.tricky;
  const best = [...results.sweep].sort((a, b) => b.quality - a.quality)[0];
  return `
<section id="results" class="wrap">
  <h2>Results</h2>
  <p>Each policy replays the same ${results.requests} prompts (${esc(results.dataset)}, ${results.split} split) through the gateway's HTTP app. Thresholds were tuned on the separate dev split. Default config: ${esc(results.config)}.</p>
  <table class="num">${RUN_HEAD}<tbody>${results.policies.map(runRow).join("")}</tbody></table>
  <ul>
    <li><b>Against premium:</b> routing cut cost ${h.savingsVsPremium}% and p50 latency from ${h.premium.p50Ms} ms to ${h.routed.p50Ms} ms, for ${(h.premium.quality - h.routed.quality).toFixed(1)} points of quality proxy.</li>
    <li><b>Against a fixed standard tier:</b> ${(h.routed.quality - h.standard.quality).toFixed(1)} points better for ${money(h.routed.costPer1kUsd - h.standard.costPer1kUsd)} more per 1k requests. Lower thresholds trace the frontier upward${best ? `: ${esc(best.variant)} reaches ${pct(best.quality)} at ${money(best.costPer1kUsd)}` : ""}.</li>
    <li><b>Exact cache:</b> ${h.exact.cacheHits} hits, ${h.exact.falseCacheHits} wrong, ${h.exactSavings}% cheaper than routing alone. <b>Semantic cache:</b> ${h.semantic.cacheHits} hits, of which ${h.semantic.falseCacheHits} answered a different question; quality fell to ${pct(h.semantic.quality)}. It is off by default.</li>
    ${tricky !== undefined ? `<li><b>Blind spot:</b> on short puzzle-style prompts with no complexity cues (<code>tricky</code>), the router scores ${pct(tricky)} against ${pct(h.premium.qualityByCategory.tricky ?? 0)} for premium. That category explains most of the gap.</li>` : ""}
  </ul>
  <h3>Quality proxy by prompt category</h3>
  <p class="fine">Rows highlighted where routing loses 30 points or more against premium.</p>
  ${categoryTable(results)}
  <h3>Threshold sweep</h3>
  <p class="fine">Routed policy, no cache, complexity thresholds (cheap | standard, standard | premium). These are the light blue points in the chart.</p>
  <table class="num">${RUN_HEAD}<tbody>${results.sweep.map(runRow).join("")}</tbody></table>
</section>`;
}

function quickstartSection(demo: string): string {
  return `
<section id="quickstart" class="wrap">
  <h2>Quickstart</h2>
  <p>Requires Node 20 or later. No API keys: the bundled config uses simulated models.</p>
  <pre><code>git clone ${REPO_URL}.git llm-gateway &amp;&amp; cd llm-gateway
npm ci &amp;&amp; npm run build &amp;&amp; npm start      # http://127.0.0.1:8787/v1

curl -s http://127.0.0.1:8787/v1/chat/completions \\
  -H 'authorization: Bearer sk-local-acme-demo' -H 'content-type: application/json' \\
  -d '{"model":"auto","temperature":0,"messages":[{"role":"user","content":"Translate to French: good morning"}]}' -i</code></pre>
  <p>Point any OpenAI SDK at <code>http://127.0.0.1:8787/v1</code>. Use <code>model: "auto"</code> to route, a tier name (<code>cheap</code>, <code>standard</code>, <code>premium</code>) to fix a tier, or a model id to pin one. <code>npm run demo</code> prints the walkthrough below; <code>npm run bench</code> reruns the benchmark.</p>
  <h3>Demo output</h3>
  <p class="fine">Real output of <code>npm run demo</code>, regenerated when this page was built.</p>
  <pre class="demo"><code>${esc(demo)}</code></pre>
</section>`;
}

const ARCH_PALETTE = { step: "#eef2ff", decision: "#fef3c7", store: "#dcfce7" };

function architectureSection(data: PageInput): string {
  const { nodes, edges } = parseFlowchart(data.architectureMermaid);
  const svg = graphSvg(nodes, edges, {
    ariaLabel: "llm-gateway request pipeline",
    idPrefix: "arch",
    nodeWidth: 210,
    wrap: 30,
    maxLines: 3,
    palette: ARCH_PALETTE,
    direction: "TB",
  });
  return `
<section id="architecture" class="wrap">
  <h2>Architecture</h2>
  <div class="arch">
    <figure class="graph">${svg}<figcaption class="fine">Drawn at build time from the Mermaid diagram in the README.</figcaption></figure>
    <div class="prose"><h3>Design decisions</h3>${markdownToHtml(data.designMarkdown)}</div>
  </div>
</section>`;
}

function evaluationSection(markdown: string): string {
  return `
<section id="evaluation" class="wrap">
  <h2>How evaluation works</h2>
  <div class="prose">${markdownToHtml(markdown)}</div>
</section>`;
}

function productSection(markdown: string): string {
  return `
<section id="product" class="wrap">
  <h2>Product brief</h2>
  <p class="fine">Rendered from <a href="${REPO_URL}/blob/main/docs/PRODUCT.md">docs/PRODUCT.md</a>.</p>
  <div class="prose product">${markdownToHtml(markdown.replace(/^# .*\n/, ""), 1)}</div>
</section>`;
}

function limitationsSection(markdown: string): string {
  return `
<section id="limitations" class="wrap">
  <h2>Limitations</h2>
  <div class="prose">${markdownToHtml(markdown)}</div>
</section>`;
}

const CSS = `
:root{--fg:#111827;--muted:#4b5563;--line:#e5e7eb;--bg:#fff;--soft:#f8fafc;--accent:#1d4ed8;--code:#f1f5f9}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
a{color:var(--accent)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
code{background:var(--code);padding:.1em .3em;border-radius:4px}pre code{background:none;padding:0}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
pre.demo{max-height:560px}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
nav.top{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.94);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
nav.top .wrap{display:flex;gap:20px;align-items:center;height:52px;overflow-x:auto;white-space:nowrap}
nav.top a{color:var(--fg);text-decoration:none;font-size:.92rem}nav.top a.brand{font-weight:700;margin-right:auto}
.hero{background:linear-gradient(180deg,#f8fafc,#fff);border-bottom:1px solid var(--line);padding:48px 0 40px}
.hero-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:36px;align-items:center}
.eyebrow{color:var(--muted);font-size:.85rem;margin:0}
h1{font-size:2.1rem;line-height:1.2;margin:.3em 0 .4em;letter-spacing:-.01em}
.lede{color:#374151;font-size:1.02rem}
.kpis{list-style:none;padding:0;display:flex;gap:26px;margin:22px 0 6px;flex-wrap:wrap}
.kpis strong{display:block;font-size:1.6rem;line-height:1.15}.kpis span{color:var(--muted);font-size:.84rem}
.fine{color:var(--muted);font-size:.85rem}
.button{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;margin:4px 8px 4px 0}
.button.ghost{background:none;color:var(--accent);border:1px solid var(--accent)}
.chart{margin:0}.chart svg,.graph svg{max-width:100%;height:auto;display:block}
.chart svg{border:1px solid var(--line);border-radius:10px}
section{padding:36px 0 8px}h2{font-size:1.6rem;margin:0 0 .5em}h3{margin:1.6em 0 .5em}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:.92rem;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--soft)}
table.num td:not(:first-child){text-align:right;white-space:nowrap}tr.gap td{background:#fff7ed}
.graph{overflow-x:auto;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff}
.prose{max-width:860px}.arch{display:grid;grid-template-columns:minmax(0,520px) minmax(0,1fr);gap:32px;align-items:start}.arch figure{margin:0;position:sticky;top:64px}.arch h3{margin-top:0}figcaption{padding:4px 8px}.product table{font-size:.86rem}
footer{border-top:1px solid var(--line);margin-top:40px;padding:24px 0;color:var(--muted);font-size:.88rem}
@media (max-width:960px){.hero-grid,.arch{grid-template-columns:1fr}.arch figure{position:static}h1{font-size:1.7rem}}
`;

export function renderPage(data: PageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llm-gateway: cost-aware, OpenAI-compatible LLM routing</title>
<meta name="description" content="OpenAI-compatible LLM gateway that routes requests across model tiers by complexity, budget, cost cap and latency SLO, with fallbacks, retries, circuit breakers, caching, per-tenant budgets and cost telemetry.">
<link rel="canonical" href="${PAGES_URL}">
<style>${CSS}</style>
</head>
<body>
<nav class="top"><div class="wrap"><a class="brand" href="#top">llm-gateway</a><a href="#results">Results</a><a href="#quickstart">Quickstart</a><a href="#architecture">Architecture</a><a href="#evaluation">Evaluation</a><a href="#product">Product brief</a><a href="#limitations">Limitations</a><a href="${REPO_URL}">GitHub</a></div></nav>
${hero(data)}
<main>
${resultsSection(data)}
${quickstartSection(data.demo)}
${architectureSection(data)}
${evaluationSection(data.evaluationMarkdown)}
${productSection(data.productMarkdown)}
${limitationsSection(data.limitationsMarkdown)}
</main>
<footer><div class="wrap">llm-gateway v${esc(data.version)} &middot; <a href="${REPO_URL}">Source on GitHub</a> &middot; <a href="${REPO_URL}/blob/main/CONTRIBUTING.md">Contributing</a> &middot; MIT License, copyright 2026 Sean McRae. Prompts are synthetic, providers are simulated and prices are illustrative; no production traffic is involved. Built by <code>npm run site</code>.</div></footer>
</body>
</html>
`;
}
