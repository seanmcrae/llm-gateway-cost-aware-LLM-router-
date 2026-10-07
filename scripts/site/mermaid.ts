/**
 * Reads the small flowchart subset the README's architecture diagram uses, so the site can
 * draw the same diagram as static SVG without loading Mermaid. Supported: `A[label]`,
 * `A{label}`, `A[(label)]`, `-->`, `-.->` and `-- text -->`, with `<br/>` line breaks.
 */
import type { GraphEdge, GraphNode } from "./svg.js";

export interface Flowchart {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const NODE = String.raw`([A-Za-z][\w-]*)(\[\((.+?)\)\]|\[(.+?)\]|\{(.+?)\})?`;
const ARROW = String.raw`(-->|-\.->|--\s+(.+?)\s+-->)`;
const EDGE = new RegExp(String.raw`^${NODE}\s*${ARROW}\s*${NODE}$`);
const LONE = new RegExp(String.raw`^${NODE}$`);

const label = (raw: string) => raw.replace(/<br\s*\/?>/g, "\n");

export function parseFlowchart(source: string): Flowchart {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const declare = (id: string, store?: string, box?: string, decision?: string) => {
    const text = store ?? box ?? decision;
    const existing = nodes.get(id);
    if (existing && text === undefined) return;
    const group = store !== undefined ? "store" : decision !== undefined ? "decision" : "step";
    nodes.set(id, { id, label: text === undefined ? id : label(text), group });
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || /^(flowchart|graph)\b/.test(line) || line.startsWith("%%")) continue;
    const edge = EDGE.exec(line);
    if (edge) {
      const [, from = "", , fs, fb, fd, arrow = "", text, to = "", , ts, tb, td] = edge;
      declare(from, fs, fb, fd);
      declare(to, ts, tb, td);
      edges.push({
        from,
        to,
        ...(arrow === "-.->" ? { dashed: true } : {}),
        ...(text ? { label: text } : {}),
      });
      continue;
    }
    const lone = LONE.exec(line);
    if (lone) {
      const [, id = "", , s, b, d] = lone;
      declare(id, s, b, d);
      continue;
    }
    throw new Error(`Unsupported flowchart line: ${line}`);
  }
  return { nodes: [...nodes.values()], edges };
}

/** The first ```mermaid block in a markdown document. */
export function mermaidBlock(markdown: string): string {
  const match = /```mermaid\n([\s\S]*?)```/.exec(markdown);
  if (!match?.[1]) throw new Error("No mermaid block found");
  return match[1];
}
