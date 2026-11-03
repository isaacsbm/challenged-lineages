// The HTML side of the page: layers checkboxes, the record detail panel, the legend, and search.
/* global d3 */

import {
  EVIDENCE, STRONG_EVIDENCE, DC_ONLY, ERAS, UNDATED, VENUE_GROUPS, REDACTION_LEVELS,
  asArray, idOf, dcRelationFor, redactionKind,
} from "./data.js";
import { toTurtle } from "./turtle.js";
import { formatDate, challengeSummary } from "./graph.js";

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Everything switched on: the starting state, and what "Reset" returns to. */
export function defaultLayers(model) {
  return {
    clusters: new Set(model.clusters.map((c) => c.key)),
    evidence: new Set(EVIDENCE),
    instances: true,
    sources: true,
    eras: new Set([...ERAS.map((e) => e.key), UNDATED.key]),
    venues: new Set(VENUE_GROUPS.map((g) => g.key)),
    redaction: "off",
  };
}

/** Which nodes, links, and cluster headings the current layers leave visible. */
export function computeVisibility(model, layers) {
  const { nodeById } = model;
  // A challenged record stays if at least one challenge matches both the era and venue layers.
  const passesChallenges = (n) =>
    !n.challenges.length ||
    n.challenges.some((c) => layers.eras.has(c.era) && c.venueGroups.some((g) => layers.venues.has(g)));
  const evidenceOn = (l) => (l.evidence === DC_ONLY ? layers.instances : layers.evidence.has(l.evidence));

  const nodeIds = new Set();
  for (const n of model.nodes.filter((d) => d.kind === "work")) {
    if (layers.clusters.has(n.cluster) && passesChallenges(n)) nodeIds.add(n.id);
  }
  // An instance is filtered on its own challenges: the Anne Frank adaptation's 2025
  // challenges keep it visible even when the diary's own records are filtered out.
  for (const n of model.nodes.filter((d) => d.kind === "instance")) {
    if (layers.instances && layers.clusters.has(n.cluster) && passesChallenges(n)) nodeIds.add(n.id);
  }
  // A source work shows only while some visible work still links to it.
  const linkOn = (l) => evidenceOn(l) && nodeIds.has(l.source);
  if (layers.sources) {
    for (const l of model.links) {
      if (nodeById.get(l.target).kind === "source" && linkOn(l)) nodeIds.add(l.target);
    }
  }
  const linkIds = new Set(model.links.filter((l) => linkOn(l) && nodeIds.has(l.target)).map((l) => l.id));
  const clusterKeys = new Set(model.nodes.filter((n) => n.kind === "work" && nodeIds.has(n.id)).map((n) => n.cluster));
  return { nodeIds, linkIds, clusterKeys };
}

/**
 * Build the layers panel. Each checkbox writes straight into `layers` and calls onChange.
 * Counts beside each option say how many records or links it governs.
 */
export function buildLayersPanel(container, model, layers, onChange) {
  const root = d3.select(container);
  const count = (n) => `<span class="count">${n}</span>`;
  const challenges = model.challenges;

  const groups = [
    {
      legend: "Clusters", key: "clusters",
      options: model.clusters.map((c) => ({
        value: c.key, label: `${c.key}. ${c.title}`,
        n: model.nodes.filter((n) => n.kind === "work" && n.cluster === c.key).length,
      })),
    },
    {
      legend: "Evidence (ccv:influenceEvidence)", key: "evidence",
      options: EVIDENCE.map((e) => ({
        value: e, label: e, n: model.links.filter((l) => l.evidence === e).length,
        note: STRONG_EVIDENCE.has(e) ? "" : "weaker",
      })),
    },
    {
      legend: "Records", key: null,
      options: [
        { value: "instances", label: "Instances (editions and adaptations)",
          n: model.nodes.filter((n) => n.kind === "instance").length },
        { value: "sources", label: "Source works (no challenge record)",
          n: model.nodes.filter((n) => n.kind === "source").length },
      ],
    },
    {
      legend: "Challenge era", key: "eras",
      options: [...ERAS, UNDATED].map((e) => ({
        value: e.key, label: e.label, n: challenges.filter((c) => c.era === e.key).length,
      })),
    },
    {
      legend: "Challenge venue", key: "venues",
      options: VENUE_GROUPS.map((g) => ({
        value: g.key, label: g.label, n: challenges.filter((c) => c.venueGroups.includes(g.key)).length,
      })),
    },
  ];

  const isOn = (group, value) => (group.key ? layers[group.key].has(value) : layers[value]);
  const set = (group, value, on) => {
    if (group.key) layers[group.key][on ? "add" : "delete"](value);
    else layers[value] = on;
  };

  const shortcuts = root.append("div").attr("class", "shortcuts");
  shortcuts.append("button").attr("type", "button").text("Strong evidence only")
    .on("click", () => {
      layers.evidence = new Set(STRONG_EVIDENCE);
      sync();
      onChange();
    });
  shortcuts.append("button").attr("type", "button").text("Reset")
    .on("click", () => {
      Object.assign(layers, defaultLayers(model));
      sync();
      onChange();
    });

  const fieldsets = root.selectAll("fieldset.layer-group")
    .data(groups)
    .join("fieldset")
    .attr("class", "layer-group");
  fieldsets.append("legend").text((g) => g.legend);
  fieldsets.each(function (group) {
    const labels = d3.select(this).selectAll("label")
      .data(group.options)
      .join("label");
    labels.append("input")
      .attr("type", "checkbox")
      .on("change", function (event, opt) {
        set(group, opt.value, this.checked);
        onChange();
      });
    labels.append("span").attr("class", "option-label").html((o) =>
      `${o.label}${o.note ? ` <em class="note">(${o.note})</em>` : ""}`);
    labels.append("span").html((o) => count(o.n)).attr("aria-hidden", "true");
    // Screen readers get the count as part of the label text.
    labels.select("input").attr("aria-label", (o) => `${o.label}${o.note ? ` (${o.note})` : ""}, ${o.n}`);
  });

  // Redaction is a choice of one level, so it gets radio buttons rather than checkboxes.
  const redaction = root.append("fieldset").attr("class", "layer-group");
  redaction.append("legend").text("Redaction");
  const redactionLabels = redaction.selectAll("label")
    .data(REDACTION_LEVELS)
    .join("label");
  redactionLabels.append("input")
    .attr("type", "radio")
    .attr("name", "redaction")
    .attr("value", (level) => level.key)
    .on("change", (event, level) => {
      layers.redaction = level.key;
      onChange();
    });
  redactionLabels.append("span").attr("class", "option-label").text((level) => level.label);
  redactionLabels.append("span").attr("aria-hidden", "true").html((level) =>
    level.key === "off" ? "" : count(model.nodes.filter((n) => redactionKind(n, level.key)).length));

  /** Reflect `layers` back into the controls (after a shortcut, or the toolbar's Redact button). */
  function sync() {
    fieldsets.each(function (group) {
      d3.select(this).selectAll("input").property("checked", (o) => isOn(group, o.value));
    });
    redaction.selectAll("input").property("checked", (level) => level.key === layers.redaction);
  }
  sync();
  return { sync };
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

const DC_ORDER = [
  "dcterms:identifier", "dcterms:title", "dcterms:creator", "dcterms:date", "dcterms:type",
  "dcterms:language", "dcterms:subject", "dcterms:description", "dcterms:isPartOf",
  "dcterms:isVersionOf", "dcterms:references", "dcterms:source", "dcterms:relation",
];
const CHALLENGE_DC = ["dcterms:identifier", "dcterms:date", "dcterms:spatial", "dcterms:source", "dcterms:description"];
const CHALLENGE_CCV = ["ccv:challengeVenue", "ccv:challengeOutcome", "ccv:challengeReason",
                       "ccv:challengeInitiator", "ccv:challengeSource"];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createDetailPanel(container, model, { onNavigate, onClose }) {
  const { nodeById, clusters, vocab } = model;

  /** A property name, linked to its definition: ccv terms to the vocabulary page,
   *  dcterms terms to DCMI's documentation. */
  function termHtml(term) {
    if (term.startsWith("ccv:")) {
      const def = vocab.definition(term);
      return `<a href="${vocab.href(term)}" title="${escapeHtml(def)}">${term}</a>`;
    }
    if (term.startsWith("dcterms:")) {
      return `<a href="https://www.dublincore.org/specifications/dublin-core/dcmi-terms/terms/${term.slice(8)}/">${term}</a>`;
    }
    return term;
  }

  /** A value as HTML: links to other records become buttons that select them. */
  function valueHtml(v, term) {
    const id = idOf(v);
    if (typeof v !== "object") return escapeHtml(term === "dcterms:date" ? formatDate(v) : v);
    if (nodeById.has(id)) {
      const n = nodeById.get(id);
      return `<button type="button" class="record-link" data-id="${escapeHtml(id)}">${escapeHtml(n.title)}</button>`
        + ` <span class="record-id">${escapeHtml(n.identifier)}</span>`;
    }
    if (id.startsWith("cluster/")) {
      const c = clusters.find((d) => `cluster/${d.key}` === id);
      return `${escapeHtml(c.key)}. ${escapeHtml(c.title)}`;
    }
    if (vocab.has(id)) {
      // A ccv value: show its label, linked to its concept on the vocabulary page.
      return `<a class="concept" href="${vocab.href(id)}" title="${escapeHtml(id)}">${escapeHtml(vocab.label(id))}</a>`;
    }
    const linked = model.byId.get(id);
    if (linked?.["foaf:name"] || linked?.["rdfs:label"]) {
      // An agent (creator) or location record: its name, then its authority links.
      return `${escapeHtml(linked["foaf:name"] ?? linked["rdfs:label"])}${authorityLinks(linked)}`;
    }
    return `<code>${escapeHtml(id)}</code>`; // e.g. dcmitype:Text
  }

  /** " · LC · Wikidata · VIAF" links for a record that has reviewed authority links. */
  function authorityLinks(record) {
    const links = [
      ...asArray(record["madsrdf:isIdentifiedByAuthority"]).map((v) => ["LC", idOf(v)]),
      ...asArray(record["owl:sameAs"]).map((v) => ["Wikidata", idOf(v)]),
      ...asArray(record["rdfs:seeAlso"]).map((v) => ["VIAF", idOf(v)]),
    ];
    if (!links.length) return "";
    return ` <span class="authorities">${links.map(([name, href]) =>
      `<a href="${escapeHtml(href)}" title="${escapeHtml(href)}">${name}</a>`).join(" · ")}</span>`;
  }

  /** The record's own authority links, with the property each uses. */
  function authoritiesHtml(record) {
    const terms = [
      ["madsrdf:isIdentifiedByAuthority", "Library of Congress authority record"],
      ["owl:sameAs", "Wikidata"],
      ["rdfs:seeAlso", "VIAF"],
    ];
    const rowsHtml = terms.filter(([term]) => asArray(record[term]).length).map(([term, label]) =>
      `<div class="row"><dt>${term}</dt><dd>${asArray(record[term]).map((v) =>
        `<a href="${escapeHtml(idOf(v))}">${label}</a> <span class="pairing">${escapeHtml(idOf(v).replace(/^https?:\/\//, ""))}</span>`).join("<br>")}</dd></div>`);
    if (!rowsHtml.length) {
      return `<section><h3>Authorities</h3><p class="empty">No authority record linked yet${
        record["@type"] === "bf:Instance" ? "; LC has no record for this edition or adaptation" : ""}.</p></section>`;
    }
    return `<section><h3>Authorities</h3><dl>${rowsHtml.join("")}</dl></section>`;
  }

  function rows(record, terms, { showEmpty = false } = {}) {
    return terms.map((term) => {
      const values = asArray(record[term]);
      if (!values.length && !showEmpty) return "";
      const html = values.length
        ? values.map((v) => valueHtml(v, term)).join("<br>")
        : `<span class="empty">not recorded</span>`;
      return `<div class="row"><dt>${termHtml(term)}</dt><dd>${html}</dd></div>`;
    }).join("");
  }

  /** A link's own dcterms:description (what the evidence is) and dcterms:source (its citation). */
  function linkEvidenceHtml(statement) {
    if (!statement) return "";
    const note = statement["dcterms:description"], source = statement["dcterms:source"];
    const cite = source && escapeHtml(source).replace(/https?:\/\/\S+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    return (note ? `<span class="link-note">${escapeHtml(note)}</span>` : "") +
           (cite ? `<span class="link-source">${cite}</span>` : "");
  }

  /** The ccv: layer for a work: each lineage link with its evidence and its DC partner. */
  function ccvHtml(node) {
    const out = model.links.filter((l) => l.source === node.id);
    const parts = [];
    if (out.length) {
      parts.push(`<div class="row"><dt>${termHtml("ccv:challengeLineage")}<br>+ ${termHtml("ccv:influenceEvidence")}</dt><dd><ul class="lineage">${
        out.map((l) => `<li>${valueHtml({ "@id": l.target })}<br><span class="evidence">${
          l.evidence === DC_ONLY ? "no ccv evidence recorded" : escapeHtml(l.evidence)
        }</span> <span class="pairing">paired with ${l.dcRelation}</span>${linkEvidenceHtml(l.statement)}</li>`).join("")
      }</ul></dd></div>`);
    }
    if (node.record["ccv:challengeOutcome"]) {
      parts.push(rows(node.record, ["ccv:challengeOutcome"]));
    }
    return parts.join("") || `<p class="empty">No ccv: statements on this record${
      node.kind === "source" ? "; it is a source that challenged works link to" : ""}.</p>`;
  }

  function linkedFromHtml(node) {
    const incoming = model.links.filter((l) => l.target === node.id);
    if (!incoming.length) return "";
    return `<section><h3>Linked from</h3><ul class="lineage">${
      incoming.map((l) => `<li>${valueHtml({ "@id": l.source })}<br><span class="evidence">${
        l.evidence === DC_ONLY ? "no ccv evidence recorded" : escapeHtml(l.evidence)
      }</span> <span class="pairing">${l.dcRelation}</span></li>`).join("")
    }</ul></section>`;
  }

  function challengesHtml(node) {
    if (!node.challenges.length) {
      return `<section><h3>Challenge records</h3><p class="empty">${
        node.outcomeNote ? `ccv:challengeOutcome: ${escapeHtml(node.outcomeNote)}.` : "No challenge record in this collection."
      }</p></section>`;
    }
    return `<section><h3>Challenge records (${node.challenges.length})</h3>${
      node.challenges.map((c) => `<article class="challenge">
        <h4 class="group-label">Dublin Core</h4><dl>${rows(c.record, CHALLENGE_DC)}</dl>
        <h4 class="group-label ccv">Challenged Collections Vocabulary</h4><dl>${rows(c.record, CHALLENGE_CCV, { showEmpty: true })}</dl>
      </article>`).join("")
    }</section>`;
  }

  function turtleFor(node) {
    const statements = model.links.filter((l) => l.source === node.id && l.statement).map((l) => l.statement);
    // The agent and location records the record and its challenges point to.
    const records = [node.record, ...node.challenges.map((c) => c.record)];
    const linked = [...new Set(records.flatMap((r) =>
      [...asArray(r["dcterms:creator"]), ...asArray(r["dcterms:spatial"])].map(idOf)))]
      .map((id) => model.byId.get(id)).filter(Boolean);
    return toTurtle([...records, ...linked, ...statements], model.context);
  }

  function show(node) {
    const creators = node.creators.join(" & ");
    container.innerHTML = `
      <header class="detail-header">
        <p class="record-id">${escapeHtml(node.identifier)} · ${
          { work: "Work", source: "Source work", instance: "Instance" }[node.kind]}</p>
        <h2 id="detail-title" tabindex="-1">${escapeHtml(node.title)}</h2>
        ${creators ? `<p class="creator">${escapeHtml(creators)}</p>` : ""}
        <p class="meta">${[node.date && formatDate(node.date), challengeSummary(node)].filter(Boolean).join(" · ")}</p>
        <button type="button" class="close" aria-label="Close details">×</button>
      </header>
      <section><h3>Dublin Core <span class="ns">dcterms:</span></h3><dl>${rows(node.record, DC_ORDER)}</dl></section>
      ${authoritiesHtml(node.record)}
      <section><h3>Challenged Collections Vocabulary <span class="ns">ccv:</span></h3><dl>${ccvHtml(node)}</dl></section>
      ${linkedFromHtml(node)}
      ${challengesHtml(node)}
      <section><h3>Turtle</h3><pre class="turtle"><code>${escapeHtml(turtleFor(node))}</code></pre></section>`;
    container.hidden = false;
    container.scrollTop = 0;
    container.querySelector(".close").addEventListener("click", onClose);
    container.querySelectorAll(".record-link").forEach((b) =>
      b.addEventListener("click", () => onNavigate(b.dataset.id)));
  }

  function hide() {
    container.hidden = true;
    container.innerHTML = "";
  }

  return { show, hide };
}

// ---------------------------------------------------------------------------
// Record list: the whole collection as text, for keyboard and screen-reader users
// ---------------------------------------------------------------------------

export function buildRecordList(container, model, onOpen) {
  const item = (n) => `
    <li class="${n.kind}">
      <button type="button" class="record-link" data-id="${escapeHtml(n.id)}">${escapeHtml(n.title)}</button>
      <span class="list-meta">${escapeHtml([n.identifier, n.creators.join(" & "),
        n.date && formatDate(n.date), challengeSummary(n)].filter(Boolean).join(" · "))}</span>
    </li>`;
  // model.nodes keeps the CSV order, so each instance follows its work.
  const groups = [
    ...model.clusters.map((c) => ({ title: `${c.key}. ${c.title}`, nodes: model.nodes.filter((n) => n.cluster === c.key) })),
    { title: "Source works", nodes: model.nodes.filter((n) => n.kind === "source") },
  ];
  container.innerHTML = groups.map((g) =>
    `<h3>${escapeHtml(g.title)}</h3><ul class="record-list">${g.nodes.map(item).join("")}</ul>`).join("");
  container.addEventListener("click", (event) => {
    const button = event.target.closest(".record-link");
    if (button) onOpen(button.dataset.id);
  });
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export function buildLegend(container) {
  container.querySelector("#legend-evidence").innerHTML = EVIDENCE.map((e) => `
    <tr>
      <th scope="row">${e}${STRONG_EVIDENCE.has(e) ? "" : ` <em class="note">(weaker)</em>`}</th>
      <td><code>${dcRelationFor(e)}</code></td>
    </tr>`).join("") + `
    <tr><th scope="row">Instance link</th><td><code>dcterms:isVersionOf</code></td></tr>`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A native <datalist> gives keyboard-accessible suggestions with no extra code. */
export function setupSearch(form, input, datalist, model, onFind) {
  const sorted = [...model.nodes].sort((a, b) => a.title.localeCompare(b.title));
  datalist.innerHTML = sorted.map((n) =>
    `<option value="${escapeHtml(n.title)}">${escapeHtml([n.creators.join(" & "), n.identifier].filter(Boolean).join(", "))}</option>`
  ).join("");

  const find = (query) => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return sorted.find((n) => n.title.toLowerCase() === q || n.identifier.toLowerCase() === q)
      ?? sorted.find((n) => n.title.toLowerCase().includes(q))
      ?? sorted.find((n) => n.creators.some((c) => c.toLowerCase().includes(q)));
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onFind(find(input.value), input.value);
  });
  // Picking a suggestion fills the box with an exact title; jump straight to it.
  input.addEventListener("change", () => {
    const exact = model.nodes.find((n) => n.title === input.value);
    if (exact) onFind(exact, input.value);
  });
}
