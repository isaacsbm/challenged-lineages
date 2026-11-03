// Competency questions: run each question's two SPARQL queries in the browser and compare.
//   - "Dublin Core only" runs against a copy of the data with every ccv: statement removed;
//   - "Dublin Core + ccv" runs against the full data plus the ccv vocabulary (for labels).
// Oxigraph is a SPARQL engine compiled to WebAssembly; it runs entirely in this page.

import init, { Store } from "https://cdn.jsdelivr.net/npm/oxigraph@0.5.9/web.js";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  return response.text();
}

/** The @base and @prefix lines of a Turtle file, so queries can use the data's own prefixes. */
function turtleHeader(ttl) {
  const prefixes = Object.fromEntries([...ttl.matchAll(/@prefix (\w+): <([^>]+)> \./g)].map((m) => [m[1], m[2]]));
  const base = ttl.match(/@base <([^>]+)> \./)?.[1] ?? "";
  return { prefixes, base };
}

// ---------------------------------------------------------------------------
// The two stores
// ---------------------------------------------------------------------------

async function loadStores() {
  const [dataTtl, vocabTtl] = await Promise.all([
    fetchText("../data/collection.ttl"),
    fetchText("../terms/ccv.ttl"),
  ]);
  const data = turtleHeader(dataTtl);
  const vocab = turtleHeader(vocabTtl);
  const prefixes = { ...vocab.prefixes, ...data.prefixes };
  const sparqlPrefixes = Object.entries(prefixes).map(([p, iri]) => `PREFIX ${p}: <${iri}>`).join("\n") + "\n";

  const full = new Store();
  full.load(dataTtl, { format: "text/turtle" });
  full.load(vocabTtl, { format: "text/turtle" });

  // The Dublin Core-only copy: drop the lineage statements (they exist only to carry
  // ccv:influenceEvidence), then every triple whose property or value is a ccv: term.
  const dc = new Store();
  dc.load(dataTtl, { format: "text/turtle" });
  const ccv = prefixes.ccv;
  dc.update(`${sparqlPrefixes}DELETE { ?s ?p ?o } WHERE { ?s a rdf:Statement ; ?p ?o }`);
  dc.update(`${sparqlPrefixes}DELETE { ?s ?p ?o } WHERE { ?s ?p ?o
    FILTER (STRSTARTS(STR(?p), "${ccv}") || (isIRI(?o) && STRSTARTS(STR(?o), "${ccv}"))) }`);

  const count = (store) => Number(store.query("SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }")[0].get("n").value);
  const dataTriples = new Store();
  dataTriples.load(dataTtl, { format: "text/turtle" });
  $("#size-full").textContent = `${count(dataTriples).toLocaleString()} triples, plus ${(count(full) - count(dataTriples)).toLocaleString()} from the ccv vocabulary`;
  $("#size-dc").textContent = `${count(dc).toLocaleString()} triples (${(count(dataTriples) - count(dc)).toLocaleString()} ccv triples removed)`;

  return { stores: { full, dc }, sparqlPrefixes, prefixes, base: data.base };
}

// ---------------------------------------------------------------------------
// Running a query and showing its results
// ---------------------------------------------------------------------------

/** The projected variable names, in the order the query lists them. */
function projection(query) {
  const clause = query.replace(/#.*$/gm, "").match(/SELECT\s+(?:DISTINCT\s+|REDUCED\s+)?([\s\S]*?)\s*WHERE/i)?.[1] ?? "";
  if (clause.trim() === "*") return null;
  // "?a ?b (COUNT(?c) AS ?n)" -> a, b, n
  return [...clause.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\s+AS\s+\?(\w+)\)/gi, " ?$1 ").matchAll(/\?(\w+)/g)].map((m) => m[1]);
}

function makeFormatter({ prefixes, base }) {
  const entries = Object.entries(prefixes).sort((a, b) => b[1].length - a[1].length);
  return (term) => {
    if (!term) return "";
    if (term.termType === "NamedNode") {
      if (base && term.value.startsWith(base)) return term.value.slice(base.length);
      const hit = entries.find(([, iri]) => term.value.startsWith(iri));
      return hit ? `${hit[0]}:${term.value.slice(hit[1].length)}` : term.value;
    }
    return term.value;
  };
}

function run(store, sparqlPrefixes, query) {
  const rows = store.query(sparqlPrefixes + query);
  const vars = projection(query) ?? [...new Set(rows.flatMap((r) => [...r.keys()]))];
  return { rows, vars };
}

function tableHtml({ rows, vars }, format, { hide = [], marks = new Map(), caption }) {
  const shown = vars.filter((v) => !hide.includes(v));
  if (!rows.length) return `<p class="empty">No results.</p>`;
  const body = rows.map((row, i) => {
    const mark = marks.get(i);
    return `<tr class="${mark ?? ""}">${shown.map((v) => `<td>${escapeHtml(format(row.get(v)))}</td>`).join("")}${
      marks.size ? `<td>${mark ? `<span class="tag ${mark}">${mark === "extra" ? "extra" : "missed by Dublin Core"}</span>` : ""}</td>` : ""}</tr>`;
  }).join("");
  return `<div class="table-wrap results"><table>
    <caption class="visually-hidden">${escapeHtml(caption)}</caption>
    <thead><tr>${shown.map((v) => `<th scope="col">${escapeHtml(v)}</th>`).join("")}${marks.size ? '<th scope="col"><span class="visually-hidden">Comparison</span></th>' : ""}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

async function renderQuestions(ctx) {
  const questions = JSON.parse(await fetchText("../questions/questions.json"));
  const format = makeFormatter(ctx);
  const container = $("#questions");
  const summary = [];

  for (const [index, q] of questions.entries()) {
    const [dcQuery, ccvQuery] = await Promise.all([fetchText(`${q.id}-dc.rq`), fetchText(`${q.id}-ccv.rq`)]);
    const dc = run(ctx.stores.dc, ctx.sparqlPrefixes, dcQuery);
    const ccv = run(ctx.stores.full, ctx.sparqlPrefixes, ccvQuery);

    // Compare the two answers on the question's key variables.
    const key = (row) => q.keys.map((k) => row.get(k)?.value ?? "").join("|");
    const dcKeys = new Set(dc.rows.map(key));
    const ccvKeys = new Set(ccv.rows.map(key));
    const extra = new Map(dc.rows.flatMap((r, i) => (ccvKeys.has(key(r)) ? [] : [[i, "extra"]])));
    const missed = new Map(ccv.rows.flatMap((r, i) => (dcKeys.has(key(r)) ? [] : [[i, "missed"]])));
    const both = [...dcKeys].filter((k) => ccvKeys.has(k)).length;
    const agreement = !extra.size && !missed.size
      ? `Same ${both} results`
      : [extra.size && `${extra.size} extra`, missed.size && `${missed.size} missed`].filter(Boolean).join(", ");
    summary.push({ index, q, dc: dc.rows.length, ccv: ccv.rows.length, agreement, same: !extra.size && !missed.size });

    const comparison = !extra.size && !missed.size
      ? `Both queries return the same ${both} result${both === 1 ? "" : "s"}.`
      : `Both return ${both}. ${extra.size ? `Dublin Core also returns ${extra.size} that ${extra.size === 1 ? "doesn’t" : "don’t"} answer the question. ` : ""}${
          missed.size ? `Dublin Core misses ${missed.size}.` : ""}`;

    const article = document.createElement("article");
    article.className = "question";
    article.id = q.id;
    article.innerHTML = `
      <h2><span class="number">${index + 1}.</span> ${escapeHtml(q.question)}</h2>
      <p class="why">${escapeHtml(q.why)}</p>
      <p class="comparison"><strong>${escapeHtml(comparison)}</strong></p>
      <div class="sides">
        <section class="side dc" aria-label="Dublin Core only">
          <h3>Dublin Core only <span class="verdict ${q.dc.verdict}">${escapeHtml(q.dc.label)}</span></h3>
          <p>${escapeHtml(q.dc.note)}</p>
          <p class="count">${dc.rows.length} result${dc.rows.length === 1 ? "" : "s"}</p>
          ${tableHtml(dc, format, { hide: q.keys, marks: extra, caption: `Dublin Core only results for question ${index + 1}` })}
          <details><summary>SPARQL</summary><pre><code>${escapeHtml(dcQuery.trim())}</code></pre></details>
        </section>
        <section class="side ccv" aria-label="Dublin Core plus ccv">
          <h3>Dublin Core + ccv</h3>
          <p>${escapeHtml(q.ccv.note)}</p>
          <p class="count">${ccv.rows.length} result${ccv.rows.length === 1 ? "" : "s"}</p>
          ${tableHtml(ccv, format, { hide: q.keys, marks: missed, caption: `Dublin Core plus ccv results for question ${index + 1}` })}
          <details><summary>SPARQL</summary><pre><code>${escapeHtml(ccvQuery.trim())}</code></pre></details>
        </section>
      </div>`;
    container.append(article);
  }

  $("#summary").innerHTML = summary.map((s) => `
    <tr>
      <th scope="row"><a href="#${s.q.id}">${s.index + 1}. ${escapeHtml(s.q.question)}</a></th>
      <td><span class="verdict ${s.q.dc.verdict}">${escapeHtml(s.q.dc.label)}</span></td>
      <td>${s.dc}</td>
      <td>${s.ccv}</td>
      <td class="${s.same ? "same" : "differs"}">${escapeHtml(s.agreement)}</td>
    </tr>`).join("");
}

// ---------------------------------------------------------------------------
// Free query console
// ---------------------------------------------------------------------------

const EXAMPLE = `# Challenge records by venue, with their outcomes
SELECT ?venue (COUNT(?challenge) AS ?challenges)
       (GROUP_CONCAT(DISTINCT ?result; separator=", ") AS ?outcomes) WHERE {
  ?challenge a dcmitype:Event ;
             ccv:challengeVenue/skos:prefLabel ?venue .
  OPTIONAL { ?challenge ccv:challengeOutcome/skos:prefLabel ?recorded }
  BIND (COALESCE(STR(?recorded), "not recorded") AS ?result)
}
GROUP BY ?venue
ORDER BY DESC(?challenges)`;

function setupConsole(ctx) {
  const format = makeFormatter(ctx);
  const textarea = $("#console-query");
  textarea.value = EXAMPLE;
  $("#console-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const out = $("#console-result");
    try {
      const result = run(ctx.stores[$("#console-graph").value], ctx.sparqlPrefixes, textarea.value);
      if (!Array.isArray(result.rows)) throw new Error("Only SELECT queries can be shown as a table.");
      out.innerHTML = `<p class="count">${result.rows.length} result${result.rows.length === 1 ? "" : "s"}</p>`
        + tableHtml(result, format, { caption: "Query results" });
    } catch (error) {
      out.innerHTML = `<p class="error" role="alert">${escapeHtml(error.message ?? error)}</p>`;
    }
  });
}

// ---------------------------------------------------------------------------

async function main() {
  await init(); // compiles Oxigraph's WebAssembly
  const ctx = await loadStores();
  await renderQuestions(ctx);
  setupConsole(ctx);
}

main().catch((error) => {
  console.error(error);
  $("#summary").innerHTML = `<tr><td colspan="5" class="error" role="alert">Could not run the queries: ${escapeHtml(error.message ?? error)}. If you opened this file directly, serve the folder with <code>python -m http.server</code>.</td></tr>`;
});
