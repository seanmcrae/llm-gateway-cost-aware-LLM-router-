/**
 * Dependency-free SVG rendering for the README and docs site: the quality-vs-cost frontier
 * chart and a layered layout for the architecture diagram. Output is deterministic, so the
 * committed chart can be checked against a fresh render.
 */

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Greedy word wrap that keeps explicit newlines; words longer than the width stay on their own
 * line. Past maxLines the last kept line ends in an ellipsis.
 */
export function wrapText(text: string, width: number, maxLines = Infinity): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (current && current.length + 1 + word.length > width) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${(kept[maxLines - 1] ?? "").replace(/\s*\S*$/, "")}...`;
    return kept;
  }
  return lines;
}

export const FONT = "font-family=\"system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif\"";

export interface GraphNode {
  id: string;
  label: string;
  /** Optional group used to colour the node. */
  group?: string;
  /** Highlighted nodes get a red outline. */
  highlight?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  dashed?: boolean;
  label?: string;
}

export interface GraphOptions {
  nodeWidth?: number;
  wrap?: number;
  maxLines?: number;
  palette?: Record<string, string>;
  ariaLabel: string;
  /** Prefix for element ids, so several graphs can share one HTML page. */
  idPrefix?: string;
  /** Left-to-right (default) or top-to-bottom layers. */
  direction?: "LR" | "TB";
}

export interface Layout {
  /** Node ids per layer, in drawing order; includes virtual waypoint ids for long edges. */
  layers: string[][];
  layerOf: Map<string, number>;
  /** For each input edge (by index) that spans several layers, its virtual waypoints. */
  waypoints: Map<number, string[]>;
}

const VIRTUAL = "\u0000v";

export const isVirtual = (id: string) => id.startsWith(VIRTUAL);

/**
 * Longest-path layering, then one barycenter pass per layer to reduce crossings. Edges that
 * skip layers get a virtual waypoint in every layer they cross, so they route around real
 * nodes instead of through them. A node in a cycle is placed after its already-placed
 * predecessors, so the edge that closes the cycle points backwards and is drawn as a loop.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Layout {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const valid = edges.filter((e) => known.has(e.from) && known.has(e.to));
  const remaining = new Map(ids.map((id) => [id, 0]));
  for (const e of valid) remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);

  // Kahn's topological order; on a cycle, release the unplaced node with the fewest
  // unresolved inputs and carry on.
  const order: string[] = [];
  const placed = new Set<string>();
  const ready = ids.filter((id) => remaining.get(id) === 0);
  while (order.length < ids.length) {
    let id = ready.shift();
    if (id === undefined) {
      id = ids
        .filter((n) => !placed.has(n))
        .sort((a, b) => (remaining.get(a) ?? 0) - (remaining.get(b) ?? 0))[0];
      if (id === undefined) break;
    }
    if (placed.has(id)) continue;
    placed.add(id);
    order.push(id);
    for (const e of valid) {
      if (e.from !== id || placed.has(e.to)) continue;
      const left = (remaining.get(e.to) ?? 0) - 1;
      remaining.set(e.to, left);
      if (left === 0) ready.push(e.to);
    }
  }

  const layerOf = new Map<string, number>();
  for (const id of order) {
    const preds = valid.filter((e) => e.to === id && layerOf.has(e.from));
    layerOf.set(id, Math.max(-1, ...preds.map((e) => layerOf.get(e.from) ?? 0)) + 1);
  }

  const depth = Math.max(0, ...layerOf.values());
  const layers: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const id of ids) layers[layerOf.get(id) ?? 0]?.push(id);

  // Split long forward edges into unit-length segments through virtual waypoints.
  const segments: { from: string; to: string }[] = [];
  const waypoints = new Map<number, string[]>();
  edges.forEach((e, index) => {
    const from = layerOf.get(e.from);
    const to = layerOf.get(e.to);
    if (from === undefined || to === undefined || to <= from) return;
    const chain = [e.from];
    for (let l = from + 1; l < to; l++) {
      const v = `${VIRTUAL}${index}:${l}`;
      layers[l]?.push(v);
      chain.push(v);
    }
    chain.push(e.to);
    if (chain.length > 2) waypoints.set(index, chain.slice(1, -1));
    for (let i = 1; i < chain.length; i++) {
      segments.push({ from: chain[i - 1] ?? "", to: chain[i] ?? "" });
    }
  });

  for (let i = 1; i < layers.length; i++) {
    const prev = layers[i - 1] ?? [];
    const position = (id: string) => {
      const preds = segments.filter((e) => e.to === id).map((e) => prev.indexOf(e.from));
      const found = preds.filter((p) => p >= 0);
      return found.length ? found.reduce((a, b) => a + b, 0) / found.length : Infinity;
    };
    const current = new Map((layers[i] ?? []).map((id, idx) => [id, idx]));
    layers[i]?.sort(
      (a, b) => position(a) - position(b) || (current.get(a) ?? 0) - (current.get(b) ?? 0),
    );
  }
  return { layers, layerOf, waypoints };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

/** Places layers as columns (LR) or rows (TB), centring each layer on the cross axis. */
function placeBoxes(
  layers: string[][],
  sizeOf: (id: string) => { w: number; h: number },
  direction: "LR" | "TB",
  margin: number,
): Map<string, Box> {
  const layerGap = direction === "LR" ? 64 : 40;
  const nodeGap = direction === "LR" ? 18 : 24;
  const box = new Map<string, Box>();
  // Cross-axis extent of a node: height in LR, width in TB.
  const cross = (id: string) => (direction === "LR" ? sizeOf(id).h : sizeOf(id).w);
  const along = (id: string) => (direction === "LR" ? sizeOf(id).w : sizeOf(id).h);
  const span = (layer: string[]) =>
    layer.reduce((sum, id) => sum + cross(id), 0) + Math.max(0, layer.length - 1) * nodeGap;
  const widest = Math.max(0, ...layers.map(span));
  let main = margin;
  for (const layer of layers) {
    const depth = Math.max(0, ...layer.map(along));
    let offset = margin + (widest - span(layer)) / 2;
    for (const id of layer) {
      const { w, h } = sizeOf(id);
      const centred = main + (depth - along(id)) / 2;
      box.set(
        id,
        direction === "LR" ? { x: centred, y: offset, w, h } : { x: offset, y: centred, w, h },
      );
      offset += cross(id) + nodeGap;
    }
    main += depth + layerGap;
  }
  return box;
}

/** Smooth path through points, leaving and entering each along the main axis. */
function smoothPath(points: Point[], direction: "LR" | "TB"): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${first.x},${first.y}`;
  let prev = first;
  for (const p of rest) {
    if (direction === "LR") {
      const c = (p.x - prev.x) / 2;
      d += ` C${prev.x + c},${prev.y} ${p.x - c},${p.y} ${p.x},${p.y}`;
    } else {
      const c = (p.y - prev.y) / 2;
      d += ` C${prev.x},${prev.y + c} ${p.x},${p.y - c} ${p.x},${p.y}`;
    }
    prev = p;
  }
  return d;
}

interface EdgeGeometry {
  d: string;
  label: Point & { anchor: "start" | "middle" };
  /** Furthest point the curve reaches, and with room for its label. */
  extent: Point;
  labelExtent: Point;
}

/** A forward edge through its waypoints, or a loop around the boxes when it points backwards. */
function edgeGeometry(
  a: Box,
  b: Box,
  via: Box[],
  forward: boolean,
  direction: "LR" | "TB",
  loop: number,
): EdgeGeometry {
  if (forward) {
    const points: Point[] =
      direction === "LR"
        ? [
            { x: a.x + a.w, y: a.y + a.h / 2 },
            ...via.flatMap((v) => [
              { x: v.x, y: v.y + v.h / 2 },
              { x: v.x + v.w, y: v.y + v.h / 2 },
            ]),
            { x: b.x, y: b.y + b.h / 2 },
          ]
        : [
            { x: a.x + a.w / 2, y: a.y + a.h },
            ...via.flatMap((v) => [
              { x: v.x + v.w / 2, y: v.y },
              { x: v.x + v.w / 2, y: v.y + v.h },
            ]),
            { x: b.x + b.w / 2, y: b.y },
          ];
    const start = points[0] ?? { x: 0, y: 0 };
    const end = points[points.length - 1] ?? start;
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const extent = { x: Math.max(...points.map((p) => p.x)), y: Math.max(...points.map((p) => p.y)) };
    return {
      d: smoothPath(points, direction),
      label:
        direction === "LR"
          ? { x: mid.x, y: mid.y - 6, anchor: "middle" }
          : { x: mid.x + 6, y: mid.y + 4, anchor: "start" },
      extent,
      labelExtent: direction === "LR" ? extent : { x: extent.x + 110, y: extent.y },
    };
  }
  if (direction === "LR") {
    const [x1, y1, x2, y2] = [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y + b.h];
    const dip = Math.max(y1, y2) + loop;
    return {
      d: `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2}`,
      label: { x: (x1 + x2) / 2, y: dip + 8, anchor: "middle" },
      extent: { x: Math.max(x1, x2), y: dip },
      labelExtent: { x: Math.max(x1, x2), y: dip + 14 },
    };
  }
  const [x1, y1, x2, y2] = [a.x + a.w, a.y + a.h / 2, b.x + b.w, b.y + b.h / 2];
  const bulge = Math.max(x1, x2) + loop;
  return {
    d: `M${x1},${y1} C${bulge},${y1} ${bulge},${y2} ${x2},${y2}`,
    label: { x: bulge + 4, y: (y1 + y2) / 2 + 4, anchor: "start" },
    extent: { x: bulge, y: Math.max(y1, y2) },
    labelExtent: { x: bulge + 110, y: Math.max(y1, y2) },
  };
}

const DEFAULT_FILL = "#eef2ff";
const WAYPOINT = 14;

export function graphSvg(nodes: GraphNode[], edges: GraphEdge[], options: GraphOptions): string {
  const nodeWidth = options.nodeWidth ?? 180;
  const wrap = options.wrap ?? 24;
  const maxLines = options.maxLines ?? 3;
  const direction = options.direction ?? "LR";
  const lineHeight = 15;
  const padY = 10;
  const margin = 16;
  const arrowId = `${options.idPrefix ?? "graph"}-arrow`;

  const { layers, layerOf, waypoints } = layoutGraph(nodes, edges);
  const lines = new Map(nodes.map((n) => [n.id, wrapText(n.label, wrap, maxLines)]));
  const sizeOf = (id: string) => {
    if (isVirtual(id)) return direction === "LR" ? { w: 0, h: WAYPOINT } : { w: WAYPOINT, h: 0 };
    return { w: nodeWidth, h: (lines.get(id)?.length ?? 1) * lineHeight + padY * 2 };
  };
  const box = placeBoxes(layers, sizeOf, direction, margin);

  let right = 0;
  let bottom = 0;
  for (const b of box.values()) {
    right = Math.max(right, b.x + b.w);
    bottom = Math.max(bottom, b.y + b.h);
  }
  const paths: string[] = [];
  edges.forEach((e, index) => {
    const a = box.get(e.from);
    const b = box.get(e.to);
    if (!a || !b) return;
    const forward = (layerOf.get(e.to) ?? 0) > (layerOf.get(e.from) ?? 0);
    const via = (waypoints.get(index) ?? [])
      .map((id) => box.get(id))
      .filter((v): v is Box => v !== undefined);
    const { d, label, ...geometry } = edgeGeometry(a, b, via, forward, direction, 34);
    const extent = e.label ? geometry.labelExtent : geometry.extent;
    right = Math.max(right, extent.x);
    bottom = Math.max(bottom, extent.y);
    const dash = e.dashed ? ` stroke-dasharray="5 4"` : "";
    paths.push(
      `<path d="${d}" fill="none" stroke="#6b7280" stroke-width="1.4"${dash} marker-end="url(#${arrowId})"/>`,
    );
    if (e.label) {
      paths.push(
        `<text x="${label.x}" y="${label.y}" font-size="11" fill="#4b5563" text-anchor="${label.anchor}">${escapeXml(e.label)}</text>`,
      );
    }
  });
  const width = Math.ceil(right + margin);
  const height = Math.ceil(bottom + margin);

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(options.ariaLabel)}" ${FONT}>`,
    `<defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6b7280"/></marker></defs>`,
    ...paths,
  ];
  for (const n of nodes) {
    const b = box.get(n.id);
    if (!b) continue;
    const fill = (n.group !== undefined ? options.palette?.[n.group] : undefined) ?? DEFAULT_FILL;
    const stroke = n.highlight ? `stroke="#c0392b" stroke-width="2.5"` : `stroke="#94a3b8"`;
    out.push(
      `<g><title>${escapeXml(n.label)}</title><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${fill}" ${stroke}/>`,
    );
    (lines.get(n.id) ?? []).forEach((line, i) => {
      const ty = b.y + padY + lineHeight * (i + 1) - 3;
      out.push(
        `<text x="${b.x + b.w / 2}" y="${ty}" font-size="12" fill="#111827" text-anchor="middle">${escapeXml(line)}</text>`,
      );
    });
    out.push("</g>");
  }
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}
