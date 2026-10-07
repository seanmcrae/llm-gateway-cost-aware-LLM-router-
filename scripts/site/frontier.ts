/**
 * The headline chart: quality proxy against cost per 1k requests for every policy in
 * bench/results.json, with the routed threshold sweep drawn as a line. `npm run chart` writes
 * docs/img/frontier.svg; a test fails if the committed file drifts from a fresh render.
 */
import type { RunSummary } from "../../bench/replay.js";
import type { BenchResults } from "../../bench/run.js";
import { escapeXml as esc, FONT } from "./svg.js";

export const CHART_PATH = "docs/img/frontier.svg";

type Kind = "fixed" | "routed" | "sweep" | "exact" | "semantic";

const STYLE: Record<Kind, { color: string; label: string }> = {
  fixed: { color: "#374151", label: "Fixed tier" },
  routed: { color: "#1d4ed8", label: "Routed (default)" },
  sweep: { color: "#93c5fd", label: "Threshold sweep" },
  exact: { color: "#0f766e", label: "Routed + exact cache" },
  semantic: { color: "#c2410c", label: "Routed + semantic cache" },
};

function kindOf(run: RunSummary): Kind {
  if (run.model !== "auto") return "fixed";
  if (run.cache === "exact") return "exact";
  if (run.cache === "semantic") return "semantic";
  return "routed";
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function marker(kind: Kind, x: number, y: number, title: string): string {
  const { color } = STYLE[kind];
  const t = `<title>${esc(title)}</title>`;
  switch (kind) {
    case "fixed":
      return `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" fill="${color}">${t}</rect>`;
    case "exact":
    case "semantic":
      return `<path d="M${x},${y - 8} L${x + 8},${y} L${x},${y + 8} L${x - 8},${y} Z" fill="${color}">${t}</path>`;
    case "routed":
      return `<circle cx="${x}" cy="${y}" r="7.5" fill="${color}" stroke="#fff" stroke-width="2">${t}</circle>`;
    case "sweep":
      return `<circle cx="${x}" cy="${y}" r="4" fill="${color}" stroke="${STYLE.routed.color}" stroke-width="1">${t}</circle>`;
  }
}

/**
 * Label placement per policy, relative to its marker, chosen so labels clear the sweep line
 * and each other. Labels set away from their marker get a thin leader line.
 */
const LABEL_AT: Record<string, { dx: number; dy: number; anchor: "start" | "end" }> = {
  "always-cheap": { dx: 12, dy: 0, anchor: "start" },
  "always-standard": { dx: -16, dy: -26, anchor: "end" },
  "always-premium": { dx: -12, dy: 0, anchor: "end" },
  routed: { dx: 70, dy: 34, anchor: "start" },
  "routed + exact cache": { dx: -40, dy: -40, anchor: "end" },
  "routed + semantic cache": { dx: 16, dy: 26, anchor: "start" },
};

export function frontierChart(results: BenchResults): string {
  const width = 760;
  const height = 470;
  const left = 64;
  const right = 24;
  const top = 74;
  const bottom = 92;
  const all = [...results.policies, ...results.sweep];
  const xMax = Math.ceil((Math.max(...all.map((r) => r.costPer1kUsd)) * 1.15) / 0.2) * 0.2;
  const yMin = Math.floor((Math.min(...all.map((r) => r.quality)) - 5) / 10) * 10;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (cost: number) => left + (cost / xMax) * plotW;
  const y = (quality: number) => top + ((100 - quality) / (100 - yMin)) * plotH;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Quality proxy versus cost per 1,000 requests for each routing policy" ${FONT}>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="24" y="32" font-size="18" font-weight="600" fill="#111827">Quality vs cost: fixed tiers and routed policies</text>`,
    `<text x="24" y="54" font-size="13" fill="#4b5563">npm run bench: ${results.requests} prompts, synthetic ${results.split} split, mock providers. Labels: quality, cost per 1k, p95 latency.</text>`,
  ];
  for (let q = yMin; q <= 100; q += 10) {
    out.push(
      `<line x1="${left}" y1="${r1(y(q))}" x2="${width - right}" y2="${r1(y(q))}" stroke="#e5e7eb"/>`,
      `<text x="${left - 8}" y="${r1(y(q)) + 4}" font-size="11" fill="#6b7280" text-anchor="end">${q}%</text>`,
    );
  }
  for (let c = 0; c <= xMax + 1e-9; c += 0.2) {
    const cx = r1(x(c));
    out.push(
      `<line x1="${cx}" y1="${top}" x2="${cx}" y2="${top + plotH}" stroke="#f1f5f9"/>`,
      `<text x="${cx}" y="${top + plotH + 18}" font-size="11" fill="#6b7280" text-anchor="middle">$${c.toFixed(2)}</text>`,
    );
  }
  out.push(
    `<text x="${left + plotW / 2}" y="${top + plotH + 40}" font-size="12" fill="#374151" text-anchor="middle">Cost per 1,000 requests (USD, illustrative prices)</text>`,
    `<text x="16" y="${top + plotH / 2}" font-size="12" fill="#374151" text-anchor="middle" transform="rotate(-90 16 ${top + plotH / 2})">Quality proxy</text>`,
  );

  const sweep = [...results.sweep].sort((a, b) => a.costPer1kUsd - b.costPer1kUsd);
  const path = sweep.map((r, i) => `${i ? "L" : "M"}${r1(x(r.costPer1kUsd))},${r1(y(r.quality))}`);
  out.push(`<path d="${path.join(" ")}" fill="none" stroke="${STYLE.sweep.color}" stroke-width="2"/>`);
  for (const r of sweep) {
    const title = `${r.variant}: ${r.quality}% at $${r.costPer1kUsd.toFixed(2)} per 1k, p95 ${seconds(r.p95Ms)}`;
    out.push(marker("sweep", r1(x(r.costPer1kUsd)), r1(y(r.quality)), title));
  }
  for (const r of results.policies) {
    const kind = kindOf(r);
    const px = r1(x(r.costPer1kUsd));
    const py = r1(y(r.quality));
    const title = `${r.variant}: ${r.quality}% at $${r.costPer1kUsd.toFixed(2)} per 1k, p50 ${seconds(r.p50Ms)}, p95 ${seconds(r.p95Ms)}`;
    out.push(marker(kind, px, py, title));
    const detail = `${r.quality.toFixed(1)}%, $${r.costPer1kUsd.toFixed(2)}, p95 ${seconds(r.p95Ms)}`;
    const at = LABEL_AT[r.variant] ?? { dx: 12, dy: 0, anchor: "start" as const };
    const lx = px + at.dx;
    const ly = py + at.dy;
    if (Math.abs(at.dx) > 20 || Math.abs(at.dy) > 20) {
      const ex = at.anchor === "end" ? lx + 4 : lx - 4;
      out.push(`<line x1="${px}" y1="${py}" x2="${ex}" y2="${ly + 2}" stroke="#9ca3af" stroke-width="1"/>`);
    }
    out.push(
      `<text x="${lx}" y="${ly}" font-size="12" fill="#111827" text-anchor="${at.anchor}">${esc(r.variant)}</text>`,
      `<text x="${lx}" y="${ly + 14}" font-size="11" fill="#6b7280" text-anchor="${at.anchor}">${esc(detail)}</text>`,
    );
  }

  let legendX = left;
  const ly = height - 20;
  for (const kind of ["fixed", "routed", "sweep", "exact", "semantic"] as const) {
    out.push(marker(kind, legendX + 6, ly - 4, STYLE[kind].label));
    out.push(`<text x="${legendX + 18}" y="${ly}" font-size="11" fill="#374151">${esc(STYLE[kind].label)}</text>`);
    legendX += 34 + STYLE[kind].label.length * 6;
  }
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}
