"""Build every Challenged Lineages data file from the CSVs in data/.

    python scripts/build_data.py

Reads   data/collection.csv     one row per record: Work, Instance, or Challenge
        data/clusters.csv       the six lineage clusters (A-F) that works are dcterms:isPartOf
        data/ccv-terms.csv, data/ccv-concepts.csv    the ccv vocabulary (see vocab.py)
        data/authorities.csv    reviewed links to LC, VIAF, and Wikidata (approved rows only)
        profile/tap.csv         the application profile (see profile.py)
Writes  data/collection.jsonld, data/collection.ttl   the collection (the site loads the JSON-LD)
        terms/ccv.jsonld, terms/ccv.ttl, terms/index.html     the vocabulary
        profile/shapes.ttl, profile/index.html                the profile as SHACL, and its page

Every row is validated first. If anything is wrong (a broken link, a duplicate ID, a value
outside a controlled list, a required field left empty) the script prints each problem with
its CSV row number and writes nothing.

Standard library only; no dependencies.
"""

import csv
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import profile_tap
import rdf
import vocab

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CSV_PATH = DATA / "collection.csv"
CLUSTERS_PATH = DATA / "clusters.csv"
OUT_PATH = DATA / "collection"  # + .jsonld / .ttl

# ---------------------------------------------------------------------------
# Controlled values: the ccv value schemes, read from the vocabulary CSVs
# ---------------------------------------------------------------------------

VOCAB = vocab.Vocabulary()
EVIDENCE = VOCAB.labels("ccv:influenceEvidence")  # "roughly from most to least verifiable"
VENUES = VOCAB.labels("ccv:challengeVenue")
OUTCOMES = VOCAB.labels("ccv:challengeOutcome")
INITIATORS = VOCAB.labels("ccv:challengeInitiator")
REASONS = VOCAB.labels("ccv:challengeReason")
CONCEPT_COLUMNS = ["ccv:influenceEvidence", "ccv:challengeVenue", "ccv:challengeOutcome",
                   "ccv:challengeReason", "ccv:challengeInitiator"]
DCMI_TYPES = [
    "Collection", "Dataset", "Event", "Image", "InteractiveResource", "MovingImage",
    "PhysicalObject", "Service", "Software", "Sound", "StillImage", "Text",
]

# Which Dublin Core relation pairs with each kind of evidence is part of the application
# profile, so it is defined once, in profile_tap.py.
dc_relation_for = profile_tap.dc_relation_for
DC_LINK_COLUMNS = ["dcterms:references", "dcterms:source", "dcterms:relation"]

# ---------------------------------------------------------------------------
# CSV layout
# ---------------------------------------------------------------------------

COLUMNS = [
    "recordType", "dcterms:identifier", "dcterms:title", "dcterms:creator", "dcterms:date",
    "dcterms:type", "dcterms:language", "dcterms:subject", "dcterms:description", "dcterms:spatial",
    "dcterms:source", "dcterms:isVersionOf", "dcterms:references", "dcterms:relation",
    "dcterms:isPartOf", "ccv:challengeLineage", "ccv:influenceEvidence",
    "ccv:challengeVenue", "ccv:challengeOutcome", "ccv:challengeReason", "ccv:challengeInitiator",
    "ccv:challengeSource",
]
SEP = " | "  # separator for multi-value cells
MULTI_VALUE = {
    "dcterms:creator", "dcterms:type", "dcterms:language", "dcterms:subject",
    "dcterms:description", "dcterms:source", "dcterms:references", "dcterms:relation",
    "ccv:challengeLineage", "ccv:influenceEvidence", "ccv:challengeVenue", "ccv:challengeOutcome",
    "ccv:challengeReason", "ccv:challengeInitiator", "ccv:challengeSource",
}
CHALLENGE_ONLY = ["ccv:challengeVenue", "ccv:challengeReason", "ccv:challengeInitiator",
                  "ccv:challengeSource", "dcterms:spatial"]
RECORD_CLASS = {"Work": "bf:Work", "Instance": "bf:Instance", "Challenge": "dcmitype:Event"}
DATE_RE = re.compile(r"^\d{4}(/\d{4})?$")  # a year, or an ISO 8601 interval of years


def slug(identifier):
    """'W.A.3 I1' -> 'W.A.3-I1', usable as a relative IRI."""
    return identifier.strip().replace(" ", "-")


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

class Record:
    """One CSV row. `values[col]` is always a list (empty when the cell is blank)."""

    def __init__(self, row_number, row):
        self.row = row_number
        self.values = {}
        for col in COLUMNS:
            cell = (row.get(col) or "").strip()
            if col in MULTI_VALUE:
                self.values[col] = [v.strip() for v in cell.split("|") if v.strip()]
            else:
                self.values[col] = [cell] if cell else []

    def get(self, col):
        """First (or only) value of a column, or '' when blank."""
        return self.values[col][0] if self.values[col] else ""

    def all(self, col):
        return self.values[col]

    @property
    def id(self):
        return self.get("dcterms:identifier")

    @property
    def type(self):
        return self.get("recordType")


def load(errors):
    # utf-8-sig accepts files with or without the byte-order mark Excel adds.
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        for col in header:
            if col not in COLUMNS:
                errors.append(f"collection.csv header: unknown column '{col}'")
        for col in COLUMNS:
            if col not in header:
                errors.append(f"collection.csv header: missing column '{col}'")
        # Row 1 is the header, so data starts on spreadsheet row 2.
        records = [Record(i, row) for i, row in enumerate(reader, start=2)
                   if any((v or "").strip() for v in row.values() if isinstance(v, str))]

    with open(CLUSTERS_PATH, newline="", encoding="utf-8-sig") as f:
        clusters = {r["dcterms:identifier"].strip(): r for r in csv.DictReader(f)}
    return records, clusters


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def lineage_pairs(rec):
    """Pair each ccv:challengeLineage target with its ccv:influenceEvidence value.
    One evidence value applies to every target; otherwise they pair up by position."""
    targets, evidence = rec.all("ccv:challengeLineage"), rec.all("ccv:influenceEvidence")
    if len(evidence) == 1:
        evidence = evidence * len(targets)
    return list(zip(targets, evidence))


def validate(records, clusters):
    errors, warnings = [], []

    def err(rec, msg):
        errors.append(f"row {rec.row} ({rec.id or 'no ID'}): {msg}")

    def warn(rec, msg):
        warnings.append(f"row {rec.row} ({rec.id or 'no ID'}): {msg}")

    # Identifiers must exist and be unique.
    by_id = {}
    for rec in records:
        if not rec.id:
            err(rec, "dcterms:identifier is empty")
        elif rec.id in by_id:
            err(rec, f"duplicate dcterms:identifier (also on row {by_id[rec.id].row})")
        else:
            by_id[rec.id] = rec

    challenged = Counter(rec.get("dcterms:relation") for rec in records if rec.type == "Challenge")
    linked_to = Counter(t for rec in records if rec.type != "Challenge"
                        for col in DC_LINK_COLUMNS + ["dcterms:isVersionOf"] for t in rec.all(col))

    for rec in records:
        if rec.type not in RECORD_CLASS:
            err(rec, f"recordType must be one of {', '.join(RECORD_CLASS)} (found '{rec.type}')")
            continue

        # Shared checks on controlled values and formats.
        for t in rec.all("dcterms:type"):
            if t not in DCMI_TYPES:
                err(rec, f"dcterms:type '{t}' is not a DCMI Type Vocabulary term")
        date = rec.get("dcterms:date")
        if date and not DATE_RE.match(date):
            err(rec, f"dcterms:date '{date}' should be YYYY or YYYY/YYYY")
        for col in COLUMNS:
            if col not in MULTI_VALUE and len(rec.all(col)) > 1:
                err(rec, f"{col} takes a single value")

        if rec.type in ("Work", "Instance"):
            validate_described_work(rec, by_id, clusters, challenged, linked_to, err, warn)
        else:
            validate_challenge(rec, by_id, err, warn)

    return errors, warnings


def validate_described_work(rec, by_id, clusters, challenged, linked_to, err, warn):
    if not rec.get("dcterms:title"):
        err(rec, "dcterms:title is empty")
    for col in CHALLENGE_ONLY:
        if rec.all(col):
            err(rec, f"{col} belongs on a Challenge row, not a {rec.type}")
    outcome = rec.get("ccv:challengeOutcome")
    if outcome and outcome != "none recorded":
        err(rec, "on a Work, ccv:challengeOutcome may only be 'none recorded'; "
                 "put real outcomes on a Challenge row")

    # dcterms:isPartOf names the lineage cluster (A-F) the work belongs to.
    cluster = rec.get("dcterms:isPartOf")
    if cluster and cluster not in clusters:
        err(rec, f"dcterms:isPartOf '{cluster}' is not a cluster listed in clusters.csv")
    if rec.type == "Instance" and cluster:
        err(rec, "an Instance takes its cluster from its work; leave dcterms:isPartOf empty")

    # Every link target must be an existing Work or Instance.
    for col in DC_LINK_COLUMNS + ["ccv:challengeLineage", "dcterms:isVersionOf"]:
        for target in rec.all(col):
            if target not in by_id:
                err(rec, f"{col} points to '{target}', which is not an identifier in the CSV")
            elif by_id[target].type == "Challenge":
                err(rec, f"{col} points to '{target}', which is a Challenge, not a work")
            elif target == rec.id:
                err(rec, f"{col} points to itself")

    if rec.type == "Instance":
        parent = rec.get("dcterms:isVersionOf")
        if not parent:
            err(rec, "an Instance needs dcterms:isVersionOf (the work it is a version of)")
        elif parent in by_id and by_id[parent].type != "Work":
            err(rec, f"dcterms:isVersionOf must point to a Work ('{parent}' is a {by_id[parent].type})")

    # ccv:challengeLineage and ccv:influenceEvidence must come as a matched set.
    targets, evidence = rec.all("ccv:challengeLineage"), rec.all("ccv:influenceEvidence")
    for ev in evidence:
        if ev not in EVIDENCE:
            err(rec, f"ccv:influenceEvidence '{ev}' is not one of: {', '.join(EVIDENCE)}")
    if targets and not evidence:
        err(rec, "ccv:challengeLineage needs a ccv:influenceEvidence value")
    if evidence and not targets:
        err(rec, "ccv:influenceEvidence given without any ccv:challengeLineage target")
    if len(evidence) > 1 and len(evidence) != len(targets):
        err(rec, f"{len(targets)} lineage targets but {len(evidence)} evidence values; "
                 "give one value for all, or one per target in the same order")

    # Each ccv link must be paired with the matching Dublin Core relation, and vice versa.
    for target, ev in lineage_pairs(rec):
        if ev not in EVIDENCE:
            continue
        if rec.type == "Instance":
            if target != rec.get("dcterms:isVersionOf"):
                err(rec, f"an Instance's ccv:challengeLineage ('{target}') should be its dcterms:isVersionOf")
            continue
        expected = dc_relation_for(ev)
        if target not in rec.all(expected):
            err(rec, f"link to '{target}' is '{ev}', so '{target}' must also appear in {expected}")
    lineage = set(targets)
    for col in DC_LINK_COLUMNS:
        for target in rec.all(col):
            if target not in lineage:
                err(rec, f"{col} '{target}' has no matching ccv:challengeLineage entry")

    # Coverage checks (warnings): every described work should be challenged, linked, or explained.
    if rec.type == "Work" and cluster and not challenged[rec.id] and outcome != "none recorded":
        warn(rec, "in a cluster but has no Challenge row; add one, or set ccv:challengeOutcome "
                  "to 'none recorded'")
    if rec.type == "Work" and not cluster and not linked_to[rec.id]:
        warn(rec, "source work (no cluster) that nothing links to")


def validate_challenge(rec, by_id, err, warn):
    target = rec.get("dcterms:relation")
    if not target:
        err(rec, "a Challenge needs dcterms:relation (the work or instance challenged)")
    elif target not in by_id:
        err(rec, f"dcterms:relation points to '{target}', which is not an identifier in the CSV")
    elif by_id[target].type not in ("Work", "Instance"):
        err(rec, f"dcterms:relation must point to a Work or Instance ('{target}' is a {by_id[target].type})")
    if not rec.all("dcterms:source") and not rec.all("dcterms:description"):
        err(rec, "a Challenge needs dcterms:source or dcterms:description (where the record comes from)")
    elif not rec.all("dcterms:source"):
        warn(rec, "no dcterms:source cited for this challenge")
    for col in ("dcterms:title", "dcterms:isVersionOf", "dcterms:references",
                "dcterms:isPartOf", "ccv:challengeLineage", "ccv:influenceEvidence"):
        if rec.all(col):
            err(rec, f"{col} does not belong on a Challenge row")

    checks = [("ccv:challengeVenue", VENUES), ("ccv:challengeOutcome", OUTCOMES),
              ("ccv:challengeInitiator", INITIATORS)]
    for col, allowed in checks:
        for v in rec.all(col):
            if v not in allowed:
                err(rec, f"{col} '{v}' is not one of: {', '.join(allowed)}")
    # The reason scheme is meant to grow, but each new reason is added to the vocabulary
    # first, so that it gets a concept URI.
    for v in rec.all("ccv:challengeReason"):
        if v not in REASONS:
            err(rec, f"ccv:challengeReason '{v}' is not in the reason scheme; add it to "
                     "data/ccv-concepts.csv first")


# ---------------------------------------------------------------------------
# JSON-LD
# ---------------------------------------------------------------------------

def ref(identifier):
    return {"@id": slug(identifier)}


# ---------------------------------------------------------------------------
# Authorities: the approved rows of data/authorities.csv
# ---------------------------------------------------------------------------
# Each approved row links something in the collection (a creator, work, place, or subject)
# to its Library of Congress authority record, plus the VIAF and Wikidata links LC gives.
#   madsrdf:isIdentifiedByAuthority  -> the LC authority record (LC's own property for this)
#   owl:sameAs                       -> Wikidata, which describes the same real-world thing
#   rdfs:seeAlso                     -> VIAF
# Rows without approved = yes are ignored, so nothing unreviewed reaches the data.

AUTHORITIES_PATH = DATA / "authorities.csv"


def load_authorities():
    with open(AUTHORITIES_PATH, newline="", encoding="utf-8-sig") as f:
        return {(r["kind"], r["local"]): r for r in csv.DictReader(f)
                if (r.get("approved") or "").strip().lower() == "yes"}


AUTH = load_authorities()


def name_slug(text):
    """'Renée Nault' -> 'renee-nault', for agent/ and place/ URIs."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def agent_iri(name):
    return f"agent/{name_slug(name)}"


def place_iri(place):
    return f"place/{name_slug(place)}"


def authority_links(kind, local):
    row = AUTH.get((kind, local))
    if not row:
        return {}
    split = lambda cell: [v.strip() for v in cell.split("|") if v.strip()]  # noqa: E731
    links = {}
    if row["lc"]:
        links["madsrdf:isIdentifiedByAuthority"] = {"@id": row["lc"]}
    if split(row["wikidata"]):
        links["owl:sameAs"] = [{"@id": v} for v in split(row["wikidata"])]
    if split(row["viaf"]):
        links["rdfs:seeAlso"] = [{"@id": v} for v in split(row["viaf"])]
    return links


def to_node(rec):
    """Convert one CSV record into a JSON-LD node.
    Multi-value columns are always arrays; single-value columns are plain strings."""
    node = {"@id": slug(rec.id), "@type": RECORD_CLASS[rec.type]}
    link_cols = set(DC_LINK_COLUMNS + ["dcterms:isVersionOf", "ccv:challengeLineage"])
    if rec.type == "Challenge":
        link_cols = {"dcterms:relation"}  # dcterms:source on a challenge is a citation, not a link

    for col in COLUMNS:
        values = rec.all(col)
        if col == "recordType" or not values:
            continue
        if col == "dcterms:type":
            out = [{"@id": f"dcmitype:{v}"} for v in values]
        elif col == "dcterms:isPartOf":
            out = [{"@id": f"cluster/{v}"} for v in values]
        elif col in link_cols:
            out = [ref(v) for v in values]
        elif col in CONCEPT_COLUMNS:
            # A controlled value becomes a link to its SKOS concept, e.g. ccv:outcome-banned.
            out = [{"@id": VOCAB.concept(col, v)} for v in values]
        elif col == "dcterms:creator":
            # The range of dcterms:creator is dcterms:Agent, so point to an agent record.
            out = [{"@id": agent_iri(v)} for v in values]
        elif col == "dcterms:spatial":
            out = [{"@id": place_iri(v)} for v in values]
        else:
            out = list(values)
        node[col] = out if col in MULTI_VALUE else out[0]
    if rec.type in ("Work", "Instance"):
        node.update(authority_links("work", rec.id))
    return node


def lineage_statements(rec):
    """ccv:influenceEvidence describes one link, not the whole work. Plain triples can't
    say which evidence goes with which link when a work has several, so each link also
    gets a standard RDF reification node: (subject, ccv:challengeLineage, object)
    + ccv:influenceEvidence."""
    out = []
    for target, ev in lineage_pairs(rec):
        out.append({
            "@id": f"{slug(rec.id)}#lineage-{slug(target)}",
            "@type": "rdf:Statement",
            "rdf:subject": ref(rec.id),
            "rdf:predicate": {"@id": "ccv:challengeLineage"},
            "rdf:object": ref(target),
            "ccv:influenceEvidence": {"@id": VOCAB.concept("ccv:influenceEvidence", ev)},
        })
    return out


def build_graph(records, clusters):
    dataset = {
        "@id": "",
        "@type": "dcmitype:Dataset",
        "dcterms:identifier": "challenged-lineages",
        "dcterms:title": "Challenged Lineages",
        "dcterms:description": "Metadata analysis of banned classics and the challenged works they inspired.",
        "dcterms:creator": "Brittany Isaacson",
        "dcterms:date": "2026-10-28",
        # LCSH headings for what the collection is about, as URIs where approved.
        "dcterms:subject": [{"@id": AUTH[("subject", s)]["lc"]} if ("subject", s) in AUTH else s
                            for s in ("Prohibited books", "Censorship")],
    }
    subjects = [{"@id": AUTH[("subject", s)]["lc"], "skos:prefLabel": {"@value": s, "@language": "en"}}
                for s in ("Prohibited books", "Censorship") if ("subject", s) in AUTH]

    # One agent record per creator, and one location record per place, with authority links.
    creators = sorted({c for rec in records for c in rec.all("dcterms:creator")})
    agents = [{"@id": agent_iri(name), "@type": ["dcterms:Agent", "foaf:Person"], "foaf:name": name,
               **authority_links("creator", name)} for name in creators]
    places = sorted({rec.get("dcterms:spatial") for rec in records if rec.get("dcterms:spatial")})
    locations = [{"@id": place_iri(p), "@type": "dcterms:Location", "rdfs:label": p,
                  **authority_links("place", p)} for p in places]
    cluster_nodes = [{
        "@id": f"cluster/{key}",
        "@type": "dcmitype:Collection",
        "dcterms:identifier": key,
        "dcterms:title": row["dcterms:title"].strip(),
        "dcterms:description": row["dcterms:description"].strip(),
        "dcterms:isPartOf": {"@id": ""},
    } for key, row in clusters.items()]

    nodes = [to_node(rec) for rec in records]
    statements = [s for rec in records if rec.type != "Challenge" for s in lineage_statements(rec)]
    return [dataset] + subjects + cluster_nodes + nodes + agents + locations + statements


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def summarize(records, graph):
    types = Counter(rec.type for rec in records)
    works = [r for r in records if r.type == "Work"]
    sources = [r for r in works if not r.get("dcterms:isPartOf")]
    print("Records")
    print(f"  Works      {types['Work']:>4}  ({len(works) - len(sources)} in clusters A-F, "
          f"{len(sources)} linked source works)")
    print(f"  Instances  {types['Instance']:>4}")
    print(f"  Challenges {types['Challenge']:>4}")

    statements = [n for n in graph if n.get("@type") == "rdf:Statement"]
    versions = sum(1 for r in records if r.get("dcterms:isVersionOf"))
    print(f"Links\n  ccv:challengeLineage {len(statements)}  "
          f"(+ {versions} dcterms:isVersionOf from Instances)")
    dc = Counter()
    for r in records:
        if r.type == "Challenge":
            continue
        for target, ev in lineage_pairs(r):
            dc["dcterms:isVersionOf" if r.type == "Instance" else dc_relation_for(ev)] += 1
    for term, n in dc.most_common():
        print(f"    paired with {term:<20} {n}")
    ev = Counter(e for r in records if r.type != "Challenge" for _, e in lineage_pairs(r))
    print("  by ccv:influenceEvidence")
    for term in EVIDENCE:
        print(f"    {term:<28} {ev[term]}")


def main():
    errors = VOCAB.check()
    tap = profile_tap.Profile(VOCAB)
    errors += tap.check()
    warnings = []
    records, clusters = load(errors)
    if not errors:
        more_errors, warnings = validate(records, clusters)
        errors += more_errors
        # An approved authority row that matches nothing (say, after a name was edited) is ignored.
        present = ({("creator", c) for r in records for c in r.all("dcterms:creator")}
                   | {("work", r.id) for r in records} | {("place", r.get("dcterms:spatial")) for r in records}
                   | {("subject", s) for s in ("Prohibited books", "Censorship")})
        warnings += [f"authorities.csv: approved {kind} '{local}' matches nothing in the collection"
                     for kind, local in AUTH if (kind, local) not in present]

    for w in warnings:
        print(f"WARNING  {w}")
    for e in errors:
        print(f"ERROR    {e}")
    if errors:
        print(f"\n{len(errors)} error(s). Nothing was written; fix the CSV and run again.")
        sys.exit(1)

    graph = build_graph(records, clusters)
    rdf.write(OUT_PATH, graph, rdf.COLLECTION_BASE,
              "Challenged Lineages collection. Generated from data/collection.csv by "
              "scripts/build_data.py; edit the CSV, not this file.")
    VOCAB.write()
    tap.write()
    print()
    summarize(records, graph)
    print(f"\n{len(warnings)} warning(s), 0 errors. Wrote data/collection.(jsonld|ttl), "
          "terms/, and profile/.")


if __name__ == "__main__":
    main()
