"""The Challenged Collections Vocabulary (ccv:), built from two editable CSVs.

Reads   data/ccv-terms.csv      the seven properties and the five value schemes
        data/ccv-concepts.csv   the values in each scheme (one row per SKOS concept)
Writes  terms/ccv.ttl, terms/ccv.jsonld   the vocabulary as RDF
        terms/index.html                  its human-readable documentation

Each term's definition, domain, range, and comment are the doc's own words (section 5 of
Banned_Books_Metadata.docx). Two things are added to make it machine-readable:
  - dcam:domainIncludes / dcam:rangeIncludes, DCMI's non-binding way of saying what a
    property is used with (DCMI Metadata Terms use the same pair);
  - every controlled value is a SKOS concept with its own URI, e.g. ccv:outcome-banned.
"""

import csv
import html
import re
from pathlib import Path

import rdf

ROOT = Path(__file__).resolve().parent.parent
TERMS_CSV = ROOT / "data" / "ccv-terms.csv"
CONCEPTS_CSV = ROOT / "data" / "ccv-concepts.csv"
OUT = ROOT / "terms"

ONTOLOGY = rdf.SITE + "terms"  # the vocabulary itself; its terms are ONTOLOGY + "#name"
ABOUT = {  # section 4 of the doc
    "title": "Challenged Collections Vocabulary",
    "prefix": "ccv",
    "scope": "Terms describing formal challenges to, and other suppression of, library and "
             "educational materials, and the relationships between challenged works.",
    "status": "Created for this assignment and published with the project site, so its URIs resolve.",
    "creator": "Brittany Isaacson",
    "created": "2026-10-28",
}
# Only evidence values are ordered in the doc ("roughly from most to least verifiable").
ORDERED_SCHEMES = {"EvidenceScheme"}

SEP = "|"
en = lambda text: {"@value": text, "@language": "en"}  # noqa: E731


def _cells(value):
    return [v.strip() for v in (value or "").split(SEP) if v.strip()]


class Vocabulary:
    def __init__(self):
        with open(TERMS_CSV, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        self.properties = [r for r in rows if r["type"] == "Property"]
        self.schemes = {r["id"]: r for r in rows if r["type"] == "ConceptScheme"}
        with open(CONCEPTS_CSV, newline="", encoding="utf-8-sig") as f:
            self.concepts = list(csv.DictReader(f))

    def check(self):
        """Problems in the vocabulary CSVs themselves, as a list of messages."""
        problems = []
        ids = [p["id"] for p in self.properties] + list(self.schemes) + [c["id"] for c in self.concepts]
        for dup in {i for i in ids if ids.count(i) > 1}:
            problems.append(f"ccv vocabulary: '{dup}' is used as an id more than once")
        for p in self.properties:
            if p["scheme"] and p["scheme"] not in self.schemes:
                problems.append(f"ccv-terms.csv: {p['id']} uses unknown scheme '{p['scheme']}'")
        for c in self.concepts:
            if c["scheme"] not in self.schemes:
                problems.append(f"ccv-concepts.csv: {c['id']} is in unknown scheme '{c['scheme']}'")
            if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", c["id"]):
                problems.append(f"ccv-concepts.csv: id '{c['id']}' should be lowercase words joined by hyphens")
            concept_ids = {x["id"] for x in self.concepts if x["scheme"] == c["scheme"]}
            for col in ("skos:broader", "skos:related"):
                for target in _cells(c.get(col)):
                    if target not in concept_ids:
                        problems.append(f"ccv-concepts.csv: {c['id']} {col} '{target}' is not a value in the same scheme")
        return problems

    # --- lookups used by the collection build --------------------------------------------
    def scheme_of(self, term):
        """'ccv:challengeOutcome' -> 'OutcomeScheme' (or '' for a free-text term)."""
        local = term.split(":", 1)[1]
        return next((p["scheme"] for p in self.properties if p["id"] == local), "")

    def labels(self, term):
        """The allowed values of a ccv term, as their preferred labels, in order."""
        scheme = self.scheme_of(term)
        return [c["skos:prefLabel"] for c in self.concepts if c["scheme"] == scheme]

    def concept(self, term, label):
        """The concept IRI for a value of a ccv term, e.g. ('ccv:challengeOutcome', 'banned')
        -> 'ccv:outcome-banned'; None if the label isn't in the term's scheme."""
        scheme = self.scheme_of(term)
        match = next((c for c in self.concepts if c["scheme"] == scheme and c["skos:prefLabel"] == label), None)
        return f"ccv:{match['id']}" if match else None

    # --- RDF -----------------------------------------------------------------------------
    def graph(self):
        defined_by = {"@id": ONTOLOGY}
        nodes = [{
            "@id": ONTOLOGY,
            "@type": "owl:Ontology",
            "dcterms:title": en(ABOUT["title"]),
            "dcterms:description": en(ABOUT["scope"]),
            "dcterms:creator": ABOUT["creator"],
            "dcterms:created": {"@value": ABOUT["created"], "@type": "xsd:date"},
            "rdfs:comment": en(ABOUT["status"]),
            "vann:preferredNamespacePrefix": ABOUT["prefix"],
            "vann:preferredNamespaceUri": rdf.CCV,
        }]
        for p in self.properties:
            node = {
                "@id": f"ccv:{p['id']}",
                "@type": "rdf:Property",
                "rdfs:label": en(p["rdfs:label"]),
                "skos:definition": en(p["skos:definition"]),
                "rdfs:isDefinedBy": defined_by,
            }
            notes = [f"Domain: {p['domain']}" if p["domain"] else "", f"Range: {p['range']}" if p["range"] else ""]
            if any(notes):
                node["skos:scopeNote"] = [en(n) for n in notes if n]
            if p["rdfs:comment"]:
                node["rdfs:comment"] = en(p["rdfs:comment"])
            if _cells(p["dcam:domainIncludes"]):
                node["dcam:domainIncludes"] = [{"@id": c} for c in _cells(p["dcam:domainIncludes"])]
            if _cells(p["dcam:rangeIncludes"]):
                node["dcam:rangeIncludes"] = [{"@id": c} for c in _cells(p["dcam:rangeIncludes"])]
            if p["scheme"]:
                node["rdfs:seeAlso"] = {"@id": f"ccv:{p['scheme']}"}
            nodes.append(node)

        for key, s in self.schemes.items():
            members = [c for c in self.concepts if c["scheme"] == key]
            top = [c for c in members if not _cells(c.get("skos:broader"))]
            nodes.append({
                "@id": f"ccv:{key}",
                "@type": "skos:ConceptScheme",
                "skos:prefLabel": en(s["rdfs:label"]),
                "skos:definition": en(s["skos:definition"]),
                "skos:hasTopConcept": [{"@id": f"ccv:{c['id']}"} for c in top],
                "rdfs:isDefinedBy": defined_by,
            })
            if key in ORDERED_SCHEMES:
                # The order itself carries meaning, so it is stated as a SKOS ordered collection.
                nodes.append({
                    "@id": f"ccv:{key}Order",
                    "@type": "skos:OrderedCollection",
                    "skos:prefLabel": en(f"{s['rdfs:label']}, most to least verifiable"),
                    "skos:memberList": {"@list": [{"@id": f"ccv:{c['id']}"} for c in members]},
                    "rdfs:isDefinedBy": defined_by,
                })
            for c in members:
                node = {
                    "@id": f"ccv:{c['id']}",
                    "@type": "skos:Concept",
                    "skos:prefLabel": en(c["skos:prefLabel"]),
                    "skos:inScheme": {"@id": f"ccv:{key}"},
                }
                # Older wording of a merged value stays findable as an alternative label.
                if _cells(c.get("skos:altLabel")):
                    node["skos:altLabel"] = [en(a) for a in _cells(c["skos:altLabel"])]
                # Hierarchy: a value under one of the doc's starter values is broader-linked to it,
                # and the starter value lists it as narrower; only values with nothing above them
                # are the scheme's top concepts.
                broader = _cells(c.get("skos:broader"))
                if broader:
                    node["skos:broader"] = [{"@id": f"ccv:{b}"} for b in broader]
                else:
                    node["skos:topConceptOf"] = {"@id": f"ccv:{key}"}
                narrower = [x["id"] for x in members if c["id"] in _cells(x.get("skos:broader"))]
                if narrower:
                    node["skos:narrower"] = [{"@id": f"ccv:{n}"} for n in narrower]
                related = _cells(c.get("skos:related"))
                related += [x["id"] for x in members if c["id"] in _cells(x.get("skos:related"))]
                if related:
                    node["skos:related"] = [{"@id": f"ccv:{r}"} for r in dict.fromkeys(related)]
                if c["skos:definition"]:
                    node["skos:definition"] = en(c["skos:definition"])
                nodes.append(node)
        return nodes

    def write(self):
        rdf.write(OUT / "ccv", self.graph(), rdf.CCV,
                  f"{ABOUT['title']} ({ABOUT['prefix']}:). Generated from data/ccv-terms.csv and "
                  "data/ccv-concepts.csv by scripts/build_data.py; edit those, not this file.")
        (OUT / "index.html").write_text(self.html(), encoding="utf-8")

    # --- Documentation page ----------------------------------------------------------------
    def html(self):
        e = html.escape
        known = {p["id"] for p in self.properties} | set(self.schemes)

        def link_terms(text):
            # Turn mentions like ccv:influenceEvidence into links to their entry on this page.
            return re.sub(r"ccv:(\w+)", lambda m: f'<a href="#{m.group(1)}"><code>ccv:{m.group(1)}</code></a>'
                          if m.group(1) in known else m.group(0), e(text))

        def curies(cell):
            return ", ".join(f"<code>{e(c)}</code>" for c in _cells(cell)) or "—"

        props = []
        for p in self.properties:
            rows = [("URI", f"<code>{e(rdf.CCV + p['id'])}</code>"),
                    ("Definition", link_terms(p["skos:definition"]))]
            if p["domain"]:
                rows.append(("Domain", link_terms(p["domain"])))
            if p["range"]:
                rows.append(("Range", link_terms(p["range"])))
            if p["rdfs:comment"]:
                rows.append(("Comment", link_terms(p["rdfs:comment"])))
            rows.append(("Used with", f"{curies(p['dcam:domainIncludes'])} <span class=\"hint\">(dcam:domainIncludes)</span>"))
            if p["dcam:rangeIncludes"]:
                rows.append(("Values", f"{curies(p['dcam:rangeIncludes'])} <span class=\"hint\">(dcam:rangeIncludes)</span>"))
            if p["scheme"]:
                s = self.schemes[p["scheme"]]
                rows.append(("Value scheme", f'<a href="#{p["scheme"]}">{e(s["rdfs:label"])}</a>'))
            props.append(f"""
      <section class="term" id="{p['id']}">
        <h3><span class="prefix">ccv:</span>{p['id']}</h3>
        <p class="term-label">{e(p['rdfs:label'])}</p>
        <dl>{''.join(f'<dt>{k}</dt><dd>{v}</dd>' for k, v in rows)}</dl>
      </section>""")

        schemes = []
        for key, s in self.schemes.items():
            members = [c for c in self.concepts if c["scheme"] == key]
            used_by = [p["id"] for p in self.properties if p["scheme"] == key]
            tag = "ol" if key in ORDERED_SCHEMES else "ul"
            label_of = {c["id"]: c["skos:prefLabel"] for c in members}

            def item(c):
                extra = []
                if _cells(c.get("skos:altLabel")):
                    extra.append("also listed as " + ", ".join(f"“{e(a)}”" for a in _cells(c["skos:altLabel"])))
                if _cells(c.get("skos:related")):
                    extra.append("related to " + ", ".join(f'<a href="#{r}">{e(label_of[r])}</a>' for r in _cells(c["skos:related"])))
                if c["skos:definition"]:
                    extra.append(e(c["skos:definition"]))
                children = [x for x in members if c["id"] in _cells(x.get("skos:broader"))]
                nested = f'<ul class="narrower">{"".join(item(x) for x in children)}</ul>' if children else ""
                note = f' <span class="hint">({"; ".join(extra)})</span>' if extra else ""
                return (f'<li id="{c["id"]}"><span class="concept">{e(c["skos:prefLabel"])}</span> '
                        f'<code>ccv:{c["id"]}</code>{note}{nested}</li>')

            items = "".join(item(c) for c in members if not _cells(c.get("skos:broader")))
            schemes.append(f"""
      <section class="term" id="{key}">
        <h3><span class="prefix">ccv:</span>{key}</h3>
        <p class="term-label">{e(s['rdfs:label'])} · <code>skos:ConceptScheme</code> · values of
          {", ".join(f'<a href="#{u}"><code>ccv:{u}</code></a>' for u in used_by)}</p>
        <p>{link_terms(s['skos:definition'])}</p>
        <{tag} class="concepts">{items}</{tag}>
      </section>""")

        toc = "".join(f'<li><a href="#{p["id"]}">ccv:{p["id"]}</a></li>' for p in self.properties)
        toc_s = "".join(f'<li><a href="#{k}">ccv:{k}</a></li>' for k in self.schemes)
        return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Challenged Collections Vocabulary</title>
  <meta name="description" content="The ccv: namespace: terms for challenges to library and educational materials and the links between challenged works.">
  <link rel="alternate" type="text/turtle" href="ccv.ttl">
  <link rel="alternate" type="application/ld+json" href="ccv.jsonld">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap">
  <link rel="stylesheet" href="../css/doc.css">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23fbf8f1'/%3E%3Ctext x='16' y='24' font-family='Georgia,serif' font-size='22' font-weight='700' text-anchor='middle' fill='%23b0181e'%3ECL%3C/text%3E%3C/svg%3E">
</head>
<body>
<!-- Generated by scripts/build_data.py from data/ccv-terms.csv and data/ccv-concepts.csv. -->
<div class="page">
  <nav class="site-nav" aria-label="Project pages">
    <a href="../">Map</a> <a href="./" aria-current="page">Vocabulary</a> <a href="../profile/">Profile</a> <a href="../questions/">Questions</a>
  </nav>
  <header>
    <p class="eyebrow">Namespace · <code>{ABOUT['prefix']}:</code></p>
    <h1>{e(ABOUT['title'])}</h1>
    <p class="lede">{e(ABOUT['scope'])}</p>
    <dl class="meta">
      <dt>Namespace URI</dt><dd><code>{e(rdf.CCV)}</code></dd>
      <dt>Preferred prefix</dt><dd><code>{ABOUT['prefix']}:</code></dd>
      <dt>Status</dt><dd>{e(ABOUT['status'])}</dd>
      <dt>Creator</dt><dd>{e(ABOUT['creator'])}</dd>
      <dt>Date</dt><dd><time datetime="{ABOUT['created']}">October 28, 2026</time></dd>
      <dt>Download</dt><dd><a href="ccv.ttl">Turtle</a> · <a href="ccv.jsonld">JSON-LD</a></dd>
    </dl>
  </header>
  <main>
    <section class="intro">
      <h2>How to read this vocabulary</h2>
      <p>The challenged collection is described in <a href="https://www.dublincore.org/specifications/dublin-core/dcmi-terms/">DCMI Metadata Terms</a> first. These seven properties are added only where Dublin Core cannot express something: that a link between two works matters for censorship, how strong the evidence for that link is, and the who, why, where, and result of a challenge.</p>
      <p>Each definition, domain, range, and comment is quoted from the project’s metadata analysis. Two additions make the vocabulary machine-readable. <code>dcam:domainIncludes</code> and <code>dcam:rangeIncludes</code> say what each property is used with, without the strict inferences of <code>rdfs:domain</code> and <code>rdfs:range</code>; DCMI Metadata Terms use the same pair. Every controlled value is also a SKOS concept with its own URI, such as <a href="#outcome-banned"><code>ccv:outcome-banned</code></a>, so data can point to a value instead of repeating a string. How these properties combine with Dublin Core in a record is set out in the <a href="../profile/">application profile</a>.</p>
      <div class="toc">
        <div><h3>Properties</h3><ul>{toc}</ul></div>
        <div><h3>Value schemes</h3><ul>{toc_s}</ul></div>
      </div>
    </section>
    <section>
      <h2>Properties</h2>
      {''.join(props)}
    </section>
    <section>
      <h2>Value schemes</h2>
      {''.join(schemes)}
    </section>
  </main>
</div>
</body>
</html>
"""
