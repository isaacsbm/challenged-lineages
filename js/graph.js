// The lineage graph: typographic nodes, dotted red edges, and a force layout that
// anchors each cluster to its own region. d3 is loaded globally from cdnjs (see index.html).
/* global d3 */

import { redactionKind } from "./data.js";

const STAMP_TEXT = { banned: "Banned", expurgated: "Expurgated", challenged: "Challenged" };

// Cluster anchors in layout units (SVG pixels at zoom 1): A B C across the top, D E F along
// the bottom. E sits under B because The Wind Done Gone (E) answers Gone with the Wind (B);
// D sits beside E for Fun Home -> Ulysses. The view zooms to fit, so only proportions matter.
const ANCHORS = {
  A: [380, 360], B: [1120, 360], C: [1860, 360],
  D: [380, 1060], E: [1120, 1060], F: [1860, 1060],
};
const GAP = 28; // minimum space between two label boxes; room for an edge label to sit in

// Line height for each line of a node label. Font sizes live in style.css; keep these in step.
const LINE_HEIGHT = {
  id: 13,
  title: { work: 19, source: 16, instance: 15 },
  creator: 16,
  meta: 14,
};
const WRAP_AT = { work: 22, source: 24, instance: 26 }; // characters per title line

// Below this zoom the full stacked labels are too small to read (a 16-unit title would be
// under about 11 px), so the map shows the title-only overview labels instead.
const OVERVIEW_BELOW = 0.7;
// Type size range, in layout units, for the overview labels. The caps keep short titles
// ("We") from towering over the rest, and keep challenged works larger than source works
// and editions, as in the full labels.
const OVERVIEW_TYPE = { min: 20, max: { work: 36, source: 26, instance: 26 } };

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const duration = (ms) => (reducedMotion.matches ? 0 : ms);

// ---------------------------------------------------------------------------
// Label text
// ---------------------------------------------------------------------------

/** Greedy word wrap; breaks after a colon first, so subtitles start a new line. */
function wrap(text, max) {
  const lines = [];
  for (const part of text.split(/(?<=:)\s+/)) {
    let line = "";
    for (const word of part.split(/\s+/)) {
      if (line && (line + " " + word).length > max) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export const formatDate = (date) => date.replace("/", "–");

/** "3 challenges", "none recorded" (James), or "no challenge record" (source works). */
export function challengeSummary(n) {
  if (n.challenges.length) return `${n.challenges.length} challenge${n.challenges.length > 1 ? "s" : ""}`;
  return n.outcomeNote ?? "no challenge record";
}

function labelLines(n) {
  const lines = [{ cls: "id", text: n.identifier, height: LINE_HEIGHT.id }];
  for (const text of wrap(n.title, WRAP_AT[n.kind])) {
    lines.push({ cls: "title", text, height: LINE_HEIGHT.title[n.kind] });
  }
  if (n.creators.length) lines.push({ cls: "creator", text: n.creators.join(" & "), height: LINE_HEIGHT.creator });
  const meta = [n.date && formatDate(n.date), challengeSummary(n)].filter(Boolean).join(" · ");
  lines.push({ cls: "meta", text: meta, height: LINE_HEIGHT.meta });
  return lines;
}

function ariaLabel(n) {
  const by = n.creators.length ? ` by ${n.creators.join(" and ")}` : "";
  const date = n.date ? `, ${formatDate(n.date)}` : "";
  return `${n.title}${by}${date}. ${n.identifier}. ${challengeSummary(n)}. Press Enter for details.`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Where a ray from a box's centre towards (tx, ty) leaves the box (grown by pad). */
function boxEdge(n, tx, ty, pad) {
  const dx = tx - n.x;
  const dy = ty - n.y;
  if (!dx && !dy) return [n.x, n.y];
  const scale = 1 / Math.max(Math.abs(dx) / (n.w / 2 + pad), Math.abs(dy) / (n.h / 2 + pad));
  return [n.x + dx * Math.min(scale, 1), n.y + dy * Math.min(scale, 1)];
}

/** How far two boxes overlap on each axis (positive = overlapping), including GAP. */
function overlap(a, b) {
  return [
    (a.w + b.w) / 2 + GAP - Math.abs(b.x - a.x),
    (a.h + b.h) / 2 + GAP - Math.abs(b.y - a.y),
  ];
}

/**
 * Rectangle collision force. d3.forceCollide only knows circles, which suit dots but not
 * wide text labels, so this pushes overlapping label boxes apart along whichever axis
 * overlaps least. With ~100 nodes, checking every pair is cheap.
 */
function forceRectCollide() {
  let nodes = [];
  function force() {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const [ox, oy] = overlap(a, b);
        if (ox <= 0 || oy <= 0) continue;
        // A pinned node (fx set) stays put, so the other one takes the whole push.
        const shareA = a.fx != null ? 0 : b.fx != null ? 1 : 0.5;
        const shareB = 1 - shareA;
        if (ox < oy) {
          const dir = b.x >= a.x ? 1 : -1;
          a.vx -= dir * ox * shareA * 0.5;
          b.vx += dir * ox * shareB * 0.5;
        } else {
          const dir = b.y >= a.y ? 1 : -1;
          a.vy -= dir * oy * shareA * 0.5;
          b.vy += dir * oy * shareB * 0.5;
        }
      }
    }
  }
  force.initialize = (n) => (nodes = n);
  return force;
}

/**
 * Keep edges from running through other works' type: when a node sits on an edge it is
 * not part of, push the node off the edge and the edge's ends slightly the other way.
 */
function forceEdgeClearance(links, margin = 14) {
  let nodes = [];
  function force(alpha) {
    for (const l of links) {
      const a = l.source;
      const b = l.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      for (const n of nodes) {
        if (n === a || n === b) continue;
        // Closest point on the edge to the node's centre.
        const t = Math.max(0, Math.min(1, ((n.x - a.x) * dx + (n.y - a.y) * dy) / len2));
        const px = a.x + t * dx;
        const py = a.y + t * dy;
        const ox = n.x - px;
        const oy = n.y - py;
        // How far inside the node's box (grown by margin) the edge passes.
        const inX = n.w / 2 + margin - Math.abs(ox);
        const inY = n.h / 2 + margin - Math.abs(oy);
        if (inX <= 0 || inY <= 0) continue;
        // Push along the shallower axis, away from the edge. The push stays firm as the
        // simulation cools, so the finished layout keeps its edges clear.
        const k = 0.04 + alpha * 0.6;
        if (inX < inY) {
          const s = (ox >= 0 ? 1 : -1) * inX * k;
          n.vx += s; a.vx -= s * 0.25; b.vx -= s * 0.25;
        } else {
          const s = (oy >= 0 ? 1 : -1) * inY * k;
          n.vy += s; a.vy -= s * 0.25; b.vy -= s * 0.25;
        }
      }
    }
  }
  force.initialize = (n) => (nodes = n);
  return force;
}

/**
 * Move boxes directly until none overlap. Forces only nudge velocities, so after the
 * simulation cools this pass guarantees the "nothing overlaps" rule. `fixed` boxes
 * (pinned nodes, cluster headings) never move.
 */
function resolveOverlaps(boxes, maxRounds = 400) {
  for (let round = 0; round < maxRounds; round++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const [ox, oy] = overlap(a, b);
        if (ox <= 0 || oy <= 0) continue;
        const aFixed = a.fx != null || a.fixed;
        const bFixed = b.fx != null || b.fixed;
        if (aFixed && bFixed) continue;
        const shareA = aFixed ? 0 : bFixed ? 1 : 0.5;
        if (ox < oy) {
          const dir = b.x >= a.x ? 1 : -1;
          a.x -= dir * (ox + 0.5) * shareA;
          b.x += dir * (ox + 0.5) * (1 - shareA);
        } else {
          const dir = b.y >= a.y ? 1 : -1;
          a.y -= dir * (oy + 0.5) * shareA;
          b.y += dir * (oy + 0.5) * (1 - shareA);
        }
        moved = true;
      }
    }
    if (!moved) return;
  }
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Draw the graph into `svgElement`. `onSelect(node | null)` fires when a record is selected
 * or cleared; `insets()` returns the screen space ({top, bottom}) taken by overlaid controls.
 */
export function createGraph(svgElement, model, { onSelect, insets = () => ({ top: 0, bottom: 0 }) }) {
  const svg = d3.select(svgElement);
  const nodes = model.nodes; // the simulation adds x, y, vx, vy (and fx, fy when pinned)
  // forceLink swaps id strings for node objects, so give it copies of the links.
  const links = model.links.map((l) => ({ ...l }));

  let labelMode = "ccv"; // or "dc": which vocabulary labels the edges
  let selectedId = null;
  let hoveredId = null;
  let visibleNodes = new Set(nodes.map((n) => n.id));
  let visibleLinks = new Set(links.map((l) => l.id));
  let visibleClusters = new Set(model.clusters.map((c) => c.key));

  // --- Anchors: where each node is pulled towards -------------------------------------
  const nodeById = model.nodeById;
  for (const n of nodes) {
    if (n.kind === "work") [n.ax, n.ay] = ANCHORS[n.cluster];
  }
  for (const n of nodes) {
    if (n.kind === "instance") [n.ax, n.ay] = [nodeById.get(n.parent).ax, nodeById.get(n.parent).ay + 80];
  }
  // A source work is pulled towards the clusters of the works that link to it.
  for (const n of nodes.filter((d) => d.kind === "source")) {
    const linkers = model.links.filter((l) => l.target === n.id).map((l) => nodeById.get(l.source));
    n.ax = d3.mean(linkers, (d) => d.ax);
    n.ay = d3.mean(linkers, (d) => d.ay);
  }

  // --- SVG scaffolding ----------------------------------------------------------------
  const defs = svg.append("defs");
  // Two arrowheads: red, and grey for edges greyed out by a lineage highlight (a marker's
  // colour is fixed where it is defined, so CSS swaps markers rather than recolouring one).
  for (const [id, cls] of [["arrow", "arrowhead"], ["arrow-faded", "arrowhead faded"]]) {
    defs.append("marker")
      .attr("id", id)
      .attr("viewBox", "0 0 10 10")
      .attr("refX", 9).attr("refY", 5)
      .attr("markerWidth", 7).attr("markerHeight", 7)
      .attr("orient", "auto-start-reverse")
      .append("path")
      .attr("d", "M1,1 L9,5 L1,9")
      .attr("class", cls);
  }

  const viewport = svg.append("g").attr("class", "viewport");
  // Drawn in this order: edges, then cluster headings (with a paper halo, so edges pass
  // behind them), then nodes on top.
  const linkLayer = viewport.append("g").attr("class", "links").attr("aria-hidden", "true");
  const headingLayer = viewport.append("g").attr("class", "headings").attr("aria-hidden", "true");
  const nodeLayer = viewport.append("g").attr("class", "nodes");

  // --- Edges: a dotted line plus a label rotated along it ------------------------------
  const linkSel = linkLayer.selectAll("g.link")
    .data(links, (d) => d.id)
    .join("g")
    .attr("class", (d) => `link evidence-${d.evidence.replace(/\s+/g, "-")}`);
  linkSel.append("line").attr("class", "link-line").attr("marker-end", "url(#arrow)");
  linkSel.append("text").attr("class", "link-label").attr("dy", -3).attr("text-anchor", "middle");

  // --- Nodes: stacked lines of type, no shapes -----------------------------------------
  const nodeSel = nodeLayer.selectAll("g.node")
    .data(nodes, (d) => d.id)
    .join("g")
    .attr("class", (d) => `node ${d.kind}`)
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", ariaLabel);

  nodeSel.append("rect").attr("class", "focus-ring");
  const label = nodeSel.append("g").attr("class", "label");
  label.each(function (d) {
    let y = 0;
    for (const line of labelLines(d)) {
      y += line.height;
      d3.select(this).append("text")
        .attr("class", line.cls)
        .attr("y", y)
        .attr("text-anchor", "middle")
        .text(line.text);
    }
  });
  nodeSel.append("circle").attr("class", "pin").attr("r", 3);

  // Measure each label (fonts are loaded before this runs) and centre it on the node.
  nodeSel.each(function (d) {
    const box = this.querySelector(".label").getBBox();
    d.w = box.width;
    d.h = box.height;
    d3.select(this).select(".label")
      .attr("transform", `translate(${-box.x - box.width / 2},${-box.y - box.height / 2})`);
    d3.select(this).select(".focus-ring")
      .attr("x", -d.w / 2 - 6).attr("y", -d.h / 2 - 4)
      .attr("width", d.w + 12).attr("height", d.h + 8);
    d3.select(this).select(".pin").attr("cx", d.w / 2 + 6).attr("cy", -d.h / 2 - 2);
  });

  // --- Overview labels: the title alone, grown into the free space around it -----------
  // At the zoom that fits the whole map, the stacked label is too small to read. So each node
  // also has a title-only label, which sizeOverviewLabels() makes as large as the space around
  // the node allows (see below). The zoom handler switches between the two labels.
  const measure = document.createElement("canvas").getContext("2d");
  const WEIGHT = { work: 700, source: 600, instance: 400 };
  nodeSel.insert("g", ".pin").attr("class", "label-compact");

  /** Greedy word wrap to a width, measured at the canvas's current font. */
  function wrapToWidth(text, width) {
    const lines = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || measure.measureText(next).width <= width) {
        line = next;
      } else {
        lines.push(line);
        line = word;
      }
    }
    return [...lines, line];
  }

  /** Ways to set a title on one to four lines, each with its size per unit of type size. */
  function titleShapes(d) {
    measure.font = `${WEIGHT[d.kind]} 100px "EB Garamond"`;
    const full = measure.measureText(d.title).width;
    const shapes = [];
    for (let n = 1; n <= 4; n++) {
      const lines = wrapToWidth(d.title, (full / n) * 1.05);
      const key = lines.join("\n");
      if (shapes.some((s) => s.key === key)) continue;
      // Size per unit of type: width with a small margin over the canvas measurement; height
      // as rendered glyphs stand, about 1.35 units for the first line and 1.1 for each after.
      shapes.push({ key, lines, w: (Math.max(...lines.map((l) => measure.measureText(l).width)) / 100) * 1.04,
                    h: 1.35 + (lines.length - 1) * 1.1 });
    }
    return shapes;
  }

  /**
   * Size every overview label as large as the free space allows. Labels are settled one at a
   * time, the most crowded first; each may grow until it would touch a neighbour's box (a
   * neighbour already settled counts at its settled size) or a cluster heading. So no two
   * overview labels can overlap. Runs after every layout, since sizes depend on positions.
   */
  function sizeOverviewLabels() {
    const PAD = 10;
    const settled = new Map();
    const plans = nodes.map((d) => ({ d, shapes: titleShapes(d) }));
    // A label not yet settled reserves room for its title at the minimum size (on two lines
    // where it has more than one word), so a crowded neighbour can't squeeze it below that.
    const reserve = new Map(plans.map(({ d, shapes }) => {
      const s = shapes[Math.min(1, shapes.length - 1)];
      return [d.id, { x: d.x, y: d.y, w: s.w * OVERVIEW_TYPE.min, h: s.h * OVERVIEW_TYPE.min }];
    }));
    const boxOf = (o) => settled.get(o.id) ?? reserve.get(o.id);
    const headings = model.clusters.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
    // Largest size a shape can take before touching any obstacle.
    const room = (d, shape) => {
      let size = OVERVIEW_TYPE.max[d.kind];
      for (const o of [...nodes.filter((x) => x !== d).map(boxOf), ...headings]) {
        const dx = Math.abs(o.x - d.x) - o.w / 2 - PAD;
        const dy = Math.abs(o.y - d.y) - o.h / 2 - PAD;
        size = Math.min(size, Math.max((2 * dx) / shape.w, (2 * dy) / shape.h));
      }
      return size;
    };
    // Most crowded first, so the tightest spots get first claim on their space.
    plans.sort((a, b) => Math.max(...a.shapes.map((s) => room(a.d, s))) - Math.max(...b.shapes.map((s) => room(b.d, s))));
    for (const { d, shapes } of plans) {
      const best = shapes.map((s) => ({ s, size: room(d, s) })).sort((a, b) => b.size - a.size)[0];
      const size = best.size;
      settled.set(d.id, { x: d.x, y: d.y, w: best.s.w * size, h: best.s.h * size });
      d.overview = { size, lines: best.s.lines };
    }
    renderOverviewLabels();
  }

  function renderOverviewLabels() {
    nodeSel.each(function (d) {
      const { size, lines } = d.overview;
      const compact = d3.select(this).select(".label-compact");
      compact.selectAll("*").remove();
      lines.forEach((text, i) => {
        compact.append("text")
          .attr("class", "title-compact")
          .attr("text-anchor", "middle")
          .attr("y", (i - (lines.length - 1) / 2) * size * 1.1)
          .attr("dy", "0.32em")
          .style("font-size", `${size}px`)
          .text(text);
      });
    });
    // Bars and stamps are drawn from the text's shape, so they're rebuilt with it. The labels
    // must be displayed to be measured, so the overview class is lifted for a moment.
    const wasOverview = svg.classed("overview");
    svg.classed("overview", true);
    nodeSel.each(function (d) {
      // The stamp grows with the title, so it stays legible zoomed out.
      addRedaction(d3.select(this).select(".label-compact"), d, "text.title-compact", "text.title-compact",
                   d.overview.size / 16);
    });
    svg.classed("overview", wasOverview);
    setRedaction(redactionLevel);
  }

  // --- Redaction overlay -----------------------------------------------------------------
  // Black bars over the title and creator, like a redacted government document, plus a red
  // stamp naming why. Built once per node, in both the full and the overview label (after
  // measuring, so the layout ignores them), and switched on by setRedaction(). In the full
  // label the identifier and date stay readable, like a file number.
  function addRedaction(group, d, coverSelector, titleSelector, stampScale = 1) {
    const layer = group.append("g").attr("class", "redaction").attr("aria-hidden", "true");
    const ragged = d3.randomLcg(d.identifier.length * 131 + d.title.length); // fixed, hand-cut edges
    const bar = (into, x0, x1, box) => into.append("rect")
      .attr("x", x0 - 2 - ragged() * 2)
      .attr("y", box.y + box.height * 0.08)
      .attr("width", x1 - x0 + 4 + ragged() * 4)
      .attr("height", box.height * 0.84);

    // Full redaction: one bar per covered line.
    const full = layer.append("g").attr("class", "bars-full");
    group.selectAll(coverSelector).each(function () {
      const box = this.getBBox();
      bar(full, box.x, box.x + box.width, box);
    });

    // Expurgation: bars over every other word of the title, the way an edition is cut.
    const partial = layer.append("g").attr("class", "bars-partial");
    group.selectAll(titleSelector).each(function () {
      const box = this.getBBox();
      [...this.textContent.matchAll(/\S+/g)].forEach((word, i) => {
        if (i % 2 === 0) return;
        const x0 = this.getStartPositionOfChar(word.index).x;
        const x1 = this.getEndPositionOfChar(word.index + word[0].length - 1).x;
        bar(partial, x0, x1, box);
      });
    });

    // The stamp sits across the middle of the title, slightly askew. An expurgated title stays
    // partly readable, so its stamp moves beside the identifier (or above the overview title).
    const titles = group.selectAll(titleSelector).nodes().map((t) => t.getBBox());
    const top = titles[0].y;
    const bottom = titles[titles.length - 1].y + titles[titles.length - 1].height;
    const id = group.select("text.id").node()?.getBBox();
    const stamp = layer.append("g").attr("class", "stamp");
    stamp.append("rect");
    stamp.append("text").attr("text-anchor", "middle").attr("dy", "0.35em");
    stamp.node().stampAt = {
      centre: [titles[0].x + titles[0].width / 2, (top + bottom) / 2],
      // Left edge of an expurgation stamp; its width is added when the word is known.
      beside: id ? [id.x + id.width + 8, id.y + id.height / 2] : [titles[0].x, top - 10 * stampScale],
      scale: stampScale,
    };
  }
  nodeSel.each(function (d) {
    addRedaction(d3.select(this).select(".label"), d, "text.title, text.creator", "text.title");
  });

  // Stamp widths are measured once, now, while every label is displayed (a hidden label
  // can't be measured, and the overview hides the full one).
  const stampWidth = {};
  {
    const probe = svg.append("g").attr("class", "stamp").append("text");
    for (const [kind, word] of Object.entries(STAMP_TEXT)) {
      stampWidth[kind] = probe.text(word).node().getComputedTextLength() + 10;
    }
    probe.node().parentNode.remove();
  }

  /** Cover records at the given level ("off", "banned", "challenged"); returns how many. */
  let redactionLevel = "off";
  function setRedaction(level) {
    redactionLevel = level;
    let count = 0;
    nodeSel.each(function (d) {
      const kind = redactionKind(d, level);
      const node = d3.select(this)
        .classed("redacted", kind != null)
        .attr("data-redaction", kind)
        .attr("aria-label", ariaLabel(d) + (kind ? ` Shown redacted on the map: ${kind}.` : ""));
      if (!kind) return;
      count += 1;
      const width = stampWidth[kind];
      node.selectAll(".stamp").each(function () {
        const { centre, beside, scale } = this.stampAt;
        const [x, y] = kind === "expurgated" ? [beside[0] + (width / 2) * scale, beside[1]] : centre;
        const stamp = d3.select(this).attr("transform", `translate(${x},${y}) rotate(-6) scale(${scale})`);
        stamp.select("text").text(STAMP_TEXT[kind]);
        stamp.select("rect").attr("x", -width / 2).attr("y", -7).attr("width", width).attr("height", 14);
      });
    });
    return count;
  }

  // --- Cluster headings ----------------------------------------------------------------
  const headingSel = headingLayer.selectAll("text")
    .data(model.clusters, (d) => d.key)
    .join("text")
    .attr("class", "cluster-heading")
    .attr("text-anchor", "middle")
    .text((d) => `${d.key} · ${d.title}`);
  headingSel.each(function (d) {
    const box = this.getBBox();
    d.w = box.width;
    d.h = box.height;
    d.fixed = true;
  });

  // --- Edge label widths -----------------------------------------------------------------
  // Measure each edge label in both vocabularies once, while everything is displayed.
  for (const l of links) l.labelWidth = {};
  for (const mode of ["ccv", "dc"]) {
    labelMode = mode;
    linkSel.select("text").text(linkLabel).each(function (l) {
      l.labelWidth[mode] = this.getComputedTextLength();
    });
  }
  labelMode = "ccv";

  /** Resting length for a link, centre to centre. An instance hangs just below its work,
   *  as editions do in Hazlitt's poster, with its label set level across the gap. Other
   *  links get half of each label box plus room for the edge label; boxes are much wider
   *  than tall, so this reserves the side-by-side case. */
  function linkDistance(l) {
    const s = nodeById.get(l.source.id ?? l.source);
    const t = nodeById.get(l.target.id ?? l.target);
    if (s.kind === "instance") return (s.h + t.h) / 2 + GAP + 22;
    return (s.w + t.w) / 2 + Math.max(l.labelWidth.ccv, l.labelWidth.dc) + 20;
  }

  // --- Simulation ----------------------------------------------------------------------
  const random = d3.randomLcg(42); // seeded, so the layout is the same on every load
  // Source works have no cluster, so only a link between two clustered works can cross clusters.
  const crossCluster = (l) => l.source.cluster && l.target.cluster && l.source.cluster !== l.target.cluster;
  const simulation = d3.forceSimulation(nodes)
    .randomSource(random)
    // Links are long enough to carry their label. Links between clusters pull weakly,
    // so a long cross-cluster link doesn't drag two clusters together.
    .force("link", d3.forceLink(links).id((d) => d.id)
      .distance(linkDistance)
      .strength((l) => (l.source.kind === "instance" ? 0.6 : crossCluster(l) ? 0.08 : 0.5)))
    // Pull each node towards its cluster's region...
    .force("x", d3.forceX((d) => d.ax).strength((d) => (d.kind === "source" ? 0.02 : 0.05)))
    .force("y", d3.forceY((d) => d.ay).strength((d) => (d.kind === "source" ? 0.02 : 0.05)))
    // ...while nodes repel each other enough to leave room for edge labels.
    .force("charge", d3.forceManyBody().strength(-420).distanceMax(420))
    .force("collide", forceRectCollide())
    .force("clearance", forceEdgeClearance(links))
    .stop()
    .on("tick", ticked)
    .on("end", () => {
      resolveOverlaps([...nodes, ...model.clusters]);
      ticked();
      sizeOverviewLabels(); // positions changed (after a drag), so free space did too
    });

  /** Run the layout to completion off-screen, then place headings and remove overlaps. */
  function layout() {
    for (const n of nodes) {
      n.fx = n.fy = null;
      n.pinned = false;
      n.x = n.ax + (random() - 0.5) * 400;
      n.y = n.ay + (random() - 0.5) * 300;
      n.vx = n.vy = 0;
    }
    simulation.alpha(1);
    for (let i = 0; i < 450; i++) simulation.tick();
    resolveOverlaps(nodes);
    placeHeadings();
    resolveOverlaps([...nodes, ...model.clusters]);
    nodeSel.classed("pinned", false);
    ticked();
    sizeOverviewLabels();
  }

  /** Centre each cluster heading just above that cluster's works. */
  function placeHeadings() {
    for (const c of model.clusters) {
      const members = nodes.filter((n) => n.cluster === c.key && n.kind !== "source");
      const top = d3.min(members, (n) => n.y - n.h / 2);
      c.x = d3.mean(members, (n) => n.x);
      c.y = top - c.h / 2 - 28;
    }
    headingSel.attr("x", (d) => d.x).attr("y", (d) => d.y + d.h / 3);
  }

  function ticked() {
    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    placedLabelPoints = [];
    linkSel.each(function (l) {
      // Clip the edge to the two label boxes so it never runs through type.
      const [x1, y1] = boxEdge(l.source, l.target.x, l.target.y, 4);
      const [x2, y2] = boxEdge(l.target, l.source.x, l.source.y, 6);
      const g = d3.select(this);
      g.select("line").attr("x1", x1).attr("y1", y1).attr("x2", x2).attr("y2", y2);
      // Rotate the label along the edge, flipped so it never reads upside down.
      let angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      // Where the label goes:
      //  - along the edge, when the edge is longer than the label;
      //  - level, across the gap, when a short edge joins two works stacked one above the
      //    other (the gap is wide enough for one line of type);
      //  - otherwise it would spill over the type at either end, so it shows only while
      //    its lineage is highlighted (see .no-room in style.css). The evidence is also
      //    listed in the detail panel.
      const length = Math.hypot(x2 - x1, y2 - y1);
      const alongEdge = length > l.labelWidth[labelMode] + 14;
      const acrossGap = !alongEdge && Math.abs(angle) > 60 && Math.abs(y2 - y1) >= 16;
      let spot = null; // where the label's centre goes, if anywhere is clear
      if (alongEdge) {
        // Try the midpoint first, then slide towards either end until the label is clear
        // of every other work's type.
        const slack = (length - l.labelWidth[labelMode] - 14) / 2;
        for (const t of [0, 0.35, -0.35, 0.7, -0.7, 1, -1]) {
          const cx = (x1 + x2) / 2 + ((x2 - x1) / length) * slack * t;
          const cy = (y1 + y2) / 2 + ((y2 - y1) / length) * slack * t;
          if (!labelBlocked(l, cx, cy, angle, 6)) {
            spot = [cx, cy];
            break;
          }
        }
      } else if (acrossGap && !labelBlocked(l, (x1 + x2) / 2, (y1 + y2) / 2, 0, 0)) {
        spot = [(x1 + x2) / 2, (y1 + y2) / 2];
      }
      const [cx, cy] = spot ?? [(x1 + x2) / 2, (y1 + y2) / 2];
      if (spot && visibleLinks.has(l.id)) {
        placedLabelPoints.push(...labelPoints(l, cx, cy, alongEdge ? angle : 0, alongEdge ? 6 : 0));
      }
      g.select("text")
        .classed("no-room", spot == null)
        .attr("dy", alongEdge ? -3 : 3)
        .attr("transform", `translate(${cx},${cy}) rotate(${alongEdge ? angle : 0})`);
    });
  }

  // Points along every edge label placed so far in this pass, so later labels avoid them.
  let placedLabelPoints = [];

  /** Points along the middle of an edge label's letters. The label is centred at (cx, cy) and
   *  rotated by `angle`; `lift` is how far the letters sit above the edge line (a label set
   *  along its edge is raised; one set level across a gap is centred on it). */
  function labelPoints(l, cx, cy, angle, lift) {
    const half = l.labelWidth[labelMode] / 2 + 3; // + letter-spacing past the last letter
    const rad = (angle * Math.PI) / 180;
    const ox = Math.sin(rad) * lift;
    const oy = -Math.cos(rad) * lift;
    return d3.range(-1, 1.01, 0.125).map((t) =>
      [cx + ox + Math.cos(rad) * half * t, cy + oy + Math.sin(rad) * half * t]);
  }

  /** Would this label run across another visible node's type, or another edge label? */
  function labelBlocked(l, cx, cy, angle, lift) {
    const points = labelPoints(l, cx, cy, angle, lift);
    const hitsNode = nodes.some((n) => n !== l.source && n !== l.target && visibleNodes.has(n.id) &&
      // Each point stands for the label's full height (about 6 units either side), with a
      // little more sideways for the slanted ends of a steep label.
      points.some(([px, py]) => Math.abs(px - n.x) < n.w / 2 + 9 && Math.abs(py - n.y) < n.h / 2 + 6));
    const hitsLabel = points.some(([px, py]) =>
      placedLabelPoints.some(([qx, qy]) => Math.hypot(px - qx, py - qy) < 10));
    return hitsNode || hitsLabel;
  }

  // --- Edge labels: ccv evidence or the Dublin Core relation ---------------------------
  function linkLabel(l) {
    if (labelMode === "dc") return l.dcRelation;
    return l.evidence === "dc-only" ? "no ccv evidence" : l.evidence;
  }
  function setLabelMode(mode) {
    labelMode = mode;
    svg.attr("data-label-mode", mode);
    linkSel.select("text").text(linkLabel);
    ticked();
  }

  // --- Zoom and pan --------------------------------------------------------------------
  const zoom = d3.zoom()
    .scaleExtent([0.12, 4])
    .on("zoom", (event) => {
      viewport.attr("transform", event.transform);
      // Title-only labels when zoomed out; full labels (and edge labels) when zoomed in.
      svg.classed("overview", event.transform.k < OVERVIEW_BELOW);
    });
  svg.call(zoom).on("dblclick.zoom", null);

  /** Zoom so every visible node and cluster heading fits between the toolbar and title block. */
  function fit(animate = true) {
    const boxes = [
      ...nodes.filter((n) => visibleNodes.has(n.id)),
      ...model.clusters.filter((c) => visibleClusters.has(c.key)),
    ];
    if (!boxes.length) return;
    const x0 = d3.min(boxes, (b) => b.x - b.w / 2);
    const x1 = d3.max(boxes, (b) => b.x + b.w / 2);
    const y0 = d3.min(boxes, (b) => b.y - b.h / 2);
    const y1 = d3.max(boxes, (b) => b.y + b.h / 2);
    const { width, height } = svgElement.getBoundingClientRect();
    const { top, bottom } = insets();
    const k = Math.min(2, 0.96 * Math.min((width - 24) / (x1 - x0), (height - top - bottom) / (y1 - y0)));
    const t = d3.zoomIdentity
      .translate(width / 2, top + (height - top - bottom) / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    svg.transition().duration(animate ? duration(600) : 0).call(zoom.transform, t);
  }

  function zoomBy(factor) {
    svg.transition().duration(duration(250)).call(zoom.scaleBy, factor);
  }

  /** Centre a node on screen and select it (used by search and the record list).
   *  With moveFocus false, keyboard focus stays where it is (e.g. in the record list). */
  function focusNode(id, { moveFocus = true } = {}) {
    const n = nodeById.get(id);
    const { width, height } = svgElement.getBoundingClientRect();
    const k = Math.max(d3.zoomTransform(svgElement).k, 1.2);
    const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-n.x, -n.y);
    svg.transition().duration(duration(600)).call(zoom.transform, t);
    // Focus the node first, so closing its record returns focus here.
    if (moveFocus) nodeSel.filter((d) => d.id === id).node().focus({ preventScroll: true });
    select(id);
  }

  // --- Drag: moving a node pins it where it is dropped ---------------------------------
  const drag = d3.drag()
    .clickDistance(4)
    .on("start", (event, d) => {
      d.wasPinned = d.fx != null;
      d.moved = false;
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      if (!d.moved) {
        d.moved = true;
        simulation.alphaTarget(0.12).restart();
      }
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      simulation.alphaTarget(0);
      if (d.moved) {
        d.pinned = true;
      } else if (!d.wasPinned) {
        d.fx = d.fy = null; // a plain click is not a drag; don't pin
      }
      nodeSel.classed("pinned", (n) => n.pinned);
    });
  nodeSel.call(drag);

  function unpin(d) {
    d.fx = d.fy = null;
    d.pinned = false;
    nodeSel.classed("pinned", (n) => n.pinned);
    simulation.alpha(0.3).restart();
  }

  // --- Lineage highlight ----------------------------------------------------------------
  /** Every node reachable from `id` along visible edges: ancestors (the works it draws on)
   *  and descendants (the works that draw on it). */
  function lineageOf(id) {
    const shown = links.filter((l) => visibleLinks.has(l.id));
    const walk = (start, next) => {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        for (const l of shown) {
          const step = next(l, current);
          if (step && !seen.has(step)) {
            seen.add(step);
            queue.push(step);
          }
        }
      }
      return seen;
    };
    const ancestors = walk(id, (l, cur) => (l.source.id === cur ? l.target.id : null));
    const descendants = walk(id, (l, cur) => (l.target.id === cur ? l.source.id : null));
    return { members: new Set([...ancestors, ...descendants]), ancestors, descendants };
  }

  function updateHighlight() {
    const focus = hoveredId ?? selectedId;
    svg.classed("highlighting", focus != null);
    if (focus == null) {
      nodeSel.classed("lit", false);
      linkSel.classed("lit", false);
      headingSel.classed("lit", false);
      return;
    }
    const { ancestors, descendants, members } = lineageOf(focus);
    // An edge is lit if it lies on a path up from, or down to, the focused node.
    const onPath = (l) =>
      (ancestors.has(l.source.id) && ancestors.has(l.target.id)) ||
      (descendants.has(l.source.id) && descendants.has(l.target.id));
    nodeSel.classed("lit", (d) => members.has(d.id));
    linkSel.classed("lit", onPath);
    // A cluster heading stays lit if the lineage reaches into that cluster; the rest grey out.
    const litClusters = new Set([...members].map((id) => nodeById.get(id).cluster).filter(Boolean));
    headingSel.classed("lit", (d) => litClusters.has(d.key));
  }

  function select(id) {
    selectedId = id;
    nodeSel.classed("selected", (d) => d.id === id);
    updateHighlight();
    onSelect(id ? nodeById.get(id) : null);
  }

  nodeSel
    .on("mouseenter focus", (event, d) => {
      hoveredId = d.id;
      updateHighlight();
    })
    .on("mouseleave blur", () => {
      hoveredId = null;
      updateHighlight();
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      select(d.id);
    })
    .on("dblclick", (event, d) => {
      event.stopPropagation();
      unpin(d);
    })
    .on("keydown", (event, d) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(d.id);
      }
    });
  svg.on("click", () => select(null));

  // --- Layers --------------------------------------------------------------------------
  function applyVisibility({ nodeIds, linkIds, clusterKeys }) {
    visibleNodes = nodeIds;
    visibleLinks = linkIds;
    visibleClusters = clusterKeys;
    nodeSel.attr("display", (d) => (nodeIds.has(d.id) ? null : "none"));
    linkSel.attr("display", (d) => (linkIds.has(d.id) ? null : "none"));
    headingSel.attr("display", (d) => (clusterKeys.has(d.key) ? null : "none"));
    ticked(); // labels held back by a node that is now hidden may have room again
    if (selectedId && !nodeIds.has(selectedId)) select(null);
    else updateHighlight();
  }

  // --- First render ----------------------------------------------------------------------
  layout();
  setLabelMode(labelMode);

  return {
    applyVisibility,
    setLabelMode,
    setRedaction,
    select,
    focusNode,
    fit,
    zoomBy,
    resetLayout() {
      layout();
      fit();
    },
    isVisible: (id) => visibleNodes.has(id),
  };
}
