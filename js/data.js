// Load data/collection.jsonld and reshape it into what the graph needs:
// nodes (works, instances, source works), links (lineage edges), and challenge records.

// ccv:influenceEvidence values, in the doc's order "from most to least verifiable".
export const EVIDENCE = [
  "explicit reference", "title or epigraph allusion", "adaptation", "retelling", "parody",
  "author-acknowledged", "critical attribution", "same author", "genre lineage",
];
// "Strong evidence only" keeps links that are documented in the texts themselves
// or by their authors; it drops critical attribution, same author, and genre lineage.
export const STRONG_EVIDENCE = new Set(EVIDENCE.slice(0, 6));

// Which Dublin Core relation each kind of evidence is paired with (same rule as build_data.py).
export const DC_FOR_EVIDENCE = {
  "explicit reference": "dcterms:references",
  "title or epigraph allusion": "dcterms:references",
  "adaptation": "dcterms:source",
  "retelling": "dcterms:source",
  "parody": "dcterms:source",
};
export const dcRelationFor = (evidence) => DC_FOR_EVIDENCE[evidence] ?? "dcterms:relation";

// A link with a Dublin Core relation but no ccv:influenceEvidence (the expurgated
// Fahrenheit 451 edition). It is toggled with the instance layer.
export const DC_ONLY = "dc-only";

export const ERAS = [
  { key: "pre-2000", label: "Before 2000", test: (y) => y < 2000 },
  { key: "2000-09", label: "2000–09", test: (y) => y >= 2000 && y < 2010 },
  { key: "2010-19", label: "2010–19", test: (y) => y >= 2010 && y < 2020 },
  { key: "2020-24", label: "2020–24", test: (y) => y >= 2020 && y < 2025 },
  { key: "2025", label: "2025", test: (y) => y >= 2025 },
];
export const UNDATED = { key: "undated", label: "Undated" };

export const VENUE_GROUPS = [
  { key: "library", label: "Libraries and schools",
    venues: ["school library", "classroom curriculum", "public library", "academic library"] },
  { key: "state", label: "Government, courts, publishers",
    venues: ["government censor", "court", "customs or postal authority", "publisher"] },
  { key: "none", label: "Venue not recorded", venues: [] },
];

// Redaction levels for the "covered up" layer. A challenge is not a ban, so the default
// level covers only records with a ccv:challengeOutcome of "banned" or "expurgated".
export const REDACTION_LEVELS = [
  { key: "off", label: "Off" },
  { key: "banned", label: "Banned or expurgated" },
  { key: "challenged", label: "Every challenged record" },
];

/** How a node is redacted at a given level: "expurgated", "banned", "challenged", or null. */
export function redactionKind(node, level) {
  if (level === "off") return null;
  const outcomes = node.challenges.flatMap((c) => c.outcomes);
  if (outcomes.includes("expurgated")) return "expurgated";
  if (outcomes.includes("banned")) return "banned";
  if (level === "challenged" && node.challenges.length) return "challenged";
  return null;
}

// JSON-LD lets a property hold one value or an array; normalize to an array.
export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
// A value is either a literal string or a node reference {"@id": ...}.
export const idOf = (v) => (v && typeof v === "object" ? v["@id"] : v);
export const first = (v) => asArray(v)[0];

const DC_LINK_TERMS = ["dcterms:references", "dcterms:source", "dcterms:relation", "dcterms:isVersionOf"];

/** The era of a challenge, from the start year of its dcterms:date ("2010/2019" -> 2010). */
function eraOf(date) {
  if (!date) return UNDATED.key;
  const year = parseInt(date.slice(0, 4), 10);
  return ERAS.find((e) => e.test(year)).key;
}

/** Group(s) a challenge's venues fall into; a challenge can have more than one venue. */
function venueGroupsOf(venues) {
  if (!venues.length) return ["none"];
  return VENUE_GROUPS.filter((g) => venues.some((v) => g.venues.includes(v))).map((g) => g.key);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  return response.json();
}

/** A literal's text, whether plain ("x") or language-tagged ({"@value": "x", "@language": "en"}). */
const text = (v) => (v && typeof v === "object" ? v["@value"] : v) ?? "";

/**
 * Lookups into the ccv vocabulary (terms/ccv.jsonld). Controlled values in the collection
 * are concept IRIs such as ccv:outcome-banned; these give back their label and definition.
 */
function vocabularyIndex(vocabDoc) {
  const byId = new Map(vocabDoc["@graph"].map((n) => [n["@id"], n]));
  return {
    label: (id) => text(byId.get(id)?.["skos:prefLabel"] ?? byId.get(id)?.["rdfs:label"]) || id,
    definition: (id) => text(byId.get(id)?.["skos:definition"]),
    /** Link to a term or value on the vocabulary page: ccv:outcome-banned -> terms/#outcome-banned. */
    href: (id) => `terms/#${id.replace(/^ccv:/, "")}`,
    has: (id) => byId.has(id),
  };
}

export async function loadCollection(url, vocabUrl) {
  const [doc, vocabDoc] = await Promise.all([fetchJson(url), fetchJson(vocabUrl)]);
  const vocab = vocabularyIndex(vocabDoc);
  const conceptLabel = (v) => vocab.label(idOf(v));
  const graph = doc["@graph"];
  const byId = new Map(graph.map((n) => [n["@id"], n]));

  const dataset = graph.find((n) => n["@id"] === "");
  const clusters = graph
    .filter((n) => n["@id"].startsWith("cluster/"))
    .map((n) => ({ key: n["dcterms:identifier"], title: n["dcterms:title"], description: n["dcterms:description"] }));

  // One node per Work or Instance. A work's cluster is the dcterms:isPartOf collection;
  // works without one are Appendix B source works.
  const nodes = graph
    .filter((n) => n["@type"] === "bf:Work" || n["@type"] === "bf:Instance")
    .map((record) => {
      const cluster = idOf(record["dcterms:isPartOf"])?.replace("cluster/", "") ?? null;
      const isInstance = record["@type"] === "bf:Instance";
      return {
        id: record["@id"],
        record,
        kind: isInstance ? "instance" : cluster ? "work" : "source",
        identifier: record["dcterms:identifier"],
        title: record["dcterms:title"],
        // dcterms:creator points to agent records; show each agent's foaf:name.
        creators: asArray(record["dcterms:creator"]).map((v) => text(byId.get(idOf(v))?.["foaf:name"]) || idOf(v)),
        date: record["dcterms:date"] ?? "",
        cluster,
        parent: isInstance ? idOf(record["dcterms:isVersionOf"]) : null,
        outcomeNote: record["ccv:challengeOutcome"] ? conceptLabel(record["ccv:challengeOutcome"]) : null, // "none recorded" on James
        challenges: [],
      };
    });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Instances sit in their parent work's cluster.
  for (const n of nodes) if (n.kind === "instance") n.cluster = nodeById.get(n.parent).cluster;

  // Challenge records hang off the work or instance named in dcterms:relation.
  const challenges = graph
    .filter((n) => n["@type"] === "dcmitype:Event")
    .map((record) => {
      const venues = asArray(record["ccv:challengeVenue"]).map(conceptLabel);
      return {
        id: record["@id"],
        record,
        target: idOf(first(record["dcterms:relation"])),
        outcomes: asArray(record["ccv:challengeOutcome"]).map(conceptLabel),
        era: eraOf(record["dcterms:date"]),
        venueGroups: venueGroupsOf(venues),
      };
    });
  for (const c of challenges) nodeById.get(c.target).challenges.push(c);

  // Lineage links come from the rdf:Statement nodes, which carry per-link evidence.
  // The Dublin Core relation is whichever dcterms: link on the subject points to the object.
  const dcRelationBetween = (subjectId, objectId) =>
    DC_LINK_TERMS.find((term) => asArray(byId.get(subjectId)[term]).some((v) => idOf(v) === objectId));

  const links = graph
    .filter((n) => n["@type"] === "rdf:Statement")
    .map((s) => {
      const source = idOf(s["rdf:subject"]);
      const target = idOf(s["rdf:object"]);
      return { id: s["@id"], source, target, evidence: conceptLabel(s["ccv:influenceEvidence"]),
               dcRelation: dcRelationBetween(source, target), statement: s };
    });

  // Any Dublin Core link without a ccv statement still gets drawn, labelled as DC-only.
  const seen = new Set(links.map((l) => `${l.source}>${l.target}`));
  for (const n of nodes) {
    for (const term of DC_LINK_TERMS) {
      for (const v of asArray(n.record[term])) {
        const target = idOf(v);
        if (!nodeById.has(target) || seen.has(`${n.id}>${target}`)) continue;
        links.push({ id: `${n.id}>${target}`, source: n.id, target, evidence: DC_ONLY, dcRelation: term });
        seen.add(`${n.id}>${target}`);
      }
    }
  }

  return { context: doc["@context"], dataset, clusters, nodes, nodeById, links, challenges, byId, vocab };
}
