"""The Challenged Lineages application profile: a DC-TAP table, turned into SHACL.

Reads   profile/tap.csv          the profile, in DCMI Tabular Application Profile (DC-TAP) form
Writes  profile/shapes.ttl       the same rules as SHACL shapes, for standard validators
        profile/namespaces.csv   the prefixes tap.csv uses (DC-TAP keeps these in their own table)
        profile/index.html       the profile as a readable page

Each DC-TAP row says how one property is used in one kind of record. The translation:
    mandatory TRUE          -> sh:minCount 1
    repeatable FALSE        -> sh:maxCount 1
    valueNodeType           -> sh:nodeKind (sh:IRI or sh:Literal)
    valueDataType           -> sh:datatype
    picklist                -> sh:in ( ... )
    pattern                 -> sh:pattern
    IRIstem                 -> sh:pattern on the expanded IRI (ccv:outcome- -> ^https://...#outcome-)
    valueShape              -> sh:class of that shape's rdf:type (sh:or when several)
Every shape is closed (sh:closed), so a misspelled or stray property is reported too.

One rule doesn't fit a table, because it compares two properties: each ccv:challengeLineage
link must be paired with the Dublin Core relation its evidence calls for. It is added as a
SHACL-SPARQL constraint, built from DC_PAIRING below.
"""

import csv
import html
import re
from pathlib import Path

import rdf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "profile"
TAP_CSV = OUT / "tap.csv"

# Which Dublin Core relation each kind of ccv:influenceEvidence is paired with.
# Evidence not listed here is paired with the generic dcterms:relation.
DC_PAIRING = {
    "explicit reference": "dcterms:references",
    "title or epigraph allusion": "dcterms:references",
    "adaptation": "dcterms:source",
    "retelling": "dcterms:source",
    "parody": "dcterms:source",
}


def dc_relation_for(evidence):
    return DC_PAIRING.get(evidence, "dcterms:relation")


TRUE, FALSE = "TRUE", "FALSE"
en = lambda text: {"@value": text, "@language": "en"}  # noqa: E731


class Profile:
    def __init__(self, vocabulary):
        self.vocab = vocabulary
        with open(TAP_CSV, newline="", encoding="utf-8-sig") as f:
            self.rows = [r for r in csv.DictReader(f) if r["propertyID"].strip()]
        # Shapes in order of first appearance; the label comes from the shape's first row.
        self.shapes = {}
        for r in self.rows:
            shape = self.shapes.setdefault(r["shapeID"], {"label": r["shapeLabel"], "rows": [], "class": None})
            shape["label"] = shape["label"] or r["shapeLabel"]
            if r["propertyID"] == "rdf:type":
                shape["class"] = r["valueConstraint"].split()[0]
            else:
                shape["rows"].append(r)

    def check(self):
        problems = []
        concepts = {f"ccv:{c['id']}" for c in self.vocab.concepts}
        for r in self.rows:
            where = f"tap.csv {r['shapeID']} {r['propertyID']}"
            if not rdf.is_prefixed(r["propertyID"]):
                problems.append(f"{where}: unknown prefix in propertyID")
            for col in ("mandatory", "repeatable"):
                if r[col] not in (TRUE, FALSE):
                    problems.append(f"{where}: {col} must be TRUE or FALSE")
            for shape in r["valueShape"].split():
                if shape not in self.shapes:
                    problems.append(f"{where}: valueShape '{shape}' is not a shape in tap.csv")
            if r["valueConstraintType"] == "picklist" and r["valueNodeType"] == "IRI":
                for v in r["valueConstraint"].split():
                    if v.startswith("ccv:") and v not in concepts and v != "ccv:challengeLineage":
                        problems.append(f"{where}: '{v}' is not a concept in the ccv vocabulary")
            if r["valueConstraintType"] == "IRIstem" and r["valueConstraint"].startswith("ccv:"):
                if not any(c.startswith(r["valueConstraint"]) for c in concepts):
                    problems.append(f"{where}: no ccv concept starts with '{r['valueConstraint']}'")
        for key, shape in self.shapes.items():
            if not shape["class"]:
                problems.append(f"tap.csv {key}: needs an rdf:type row, which names the class it applies to")
        return problems

    # --- SHACL -----------------------------------------------------------------------------
    def _property_shape(self, r):
        ps = {"sh:path": {"@id": r["propertyID"]}, "sh:name": en(r["propertyLabel"])}
        if r["mandatory"] == TRUE:
            ps["sh:minCount"] = 1
        if r["repeatable"] == FALSE:
            ps["sh:maxCount"] = 1
        if r["valueNodeType"] == "IRI":
            ps["sh:nodeKind"] = {"@id": "sh:IRI"}
        elif r["valueNodeType"] == "literal":
            ps["sh:nodeKind"] = {"@id": "sh:Literal"}
        if r["valueDataType"]:
            ps["sh:datatype"] = {"@id": r["valueDataType"]}
        kind, constraint = r["valueConstraintType"], r["valueConstraint"]
        if kind == "picklist":
            values = constraint.split()
            ps["sh:in"] = {"@list": [{"@id": v} if r["valueNodeType"] == "IRI" else v for v in values]}
        elif kind == "pattern":
            ps["sh:pattern"] = constraint
        elif kind == "IRIstem":
            ps["sh:pattern"] = "^" + re.escape(rdf.expand(constraint))
        targets = [self.shapes[s]["class"] for s in r["valueShape"].split()]
        if len(targets) == 1:
            ps["sh:class"] = {"@id": targets[0]}
        elif targets:
            ps["sh:or"] = {"@list": [{"sh:class": {"@id": t}} for t in targets]}
        if r["note"]:
            ps["sh:description"] = en(r["note"])
        return ps

    def _pairing_constraint(self):
        """SHACL-SPARQL: a lineage link whose paired Dublin Core relation is missing.
        SHACL forbids VALUES in constraints, so the pairing table becomes a UNION of BINDs
        into fresh variables, matched to the link's evidence with a FILTER."""
        x = rdf.expand
        pairs = "\n  UNION ".join(
            f"{{ BIND(<{x(self.vocab.concept('ccv:influenceEvidence', ev))}> AS ?pairedEvidence) "
            f"BIND(<{x(dc_relation_for(ev))}> AS ?pairedProperty) }}"
            for ev in self.vocab.labels("ccv:influenceEvidence"))
        query = f"""SELECT $this ?target ?pairedProperty WHERE {{
  ?link <{x('rdf:subject')}> $this ; <{x('rdf:predicate')}> <{x('ccv:challengeLineage')}> ;
        <{x('rdf:object')}> ?target ; <{x('ccv:influenceEvidence')}> ?evidence .
  {pairs}
  FILTER (?pairedEvidence = ?evidence)
  FILTER NOT EXISTS {{ $this ?pairedProperty ?target }}
}}"""
        return {
            "@type": "sh:SPARQLConstraint",
            "sh:message": en("Lineage link to {?target} lacks its paired Dublin Core relation {?pairedProperty}"),
            "sh:select": query,
        }

    def graph(self):
        nodes = []
        for key, shape in self.shapes.items():
            node = {
                "@id": f"ccvp:{key}Shape",
                "@type": "sh:NodeShape",
                "rdfs:label": en(shape["label"]),
                "sh:targetClass": {"@id": shape["class"]},
                "sh:closed": True,
                "sh:ignoredProperties": {"@list": [{"@id": "rdf:type"}]},
                "sh:property": [self._property_shape(r) for r in shape["rows"]],
            }
            if key == "Work":
                node["sh:sparql"] = self._pairing_constraint()
            nodes.append(node)
        return nodes

    def write(self):
        rdf.write(OUT / "shapes", self.graph(), rdf.PROFILE,
                  "Challenged Lineages application profile as SHACL. Generated from profile/tap.csv "
                  "by scripts/build_data.py; edit the CSV, not this file.")
        (OUT / "shapes.jsonld").unlink(missing_ok=True)  # Turtle is the usual form for shapes
        with open(OUT / "namespaces.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["prefix", "namespace"])
            w.writerows(rdf.PREFIXES.items())
        (OUT / "index.html").write_text(self.html(), encoding="utf-8")

    # --- Page -------------------------------------------------------------------------------
    def html(self):
        e = html.escape

        def value_cell(r):
            parts = []
            if r["valueShape"]:
                parts.append(" or ".join(f'<a href="#{s}">{e(self.shapes[s]["label"])}</a>' for s in r["valueShape"].split()))
            elif r["valueNodeType"]:
                parts.append(r["valueNodeType"])
            kind, c = r["valueConstraintType"], r["valueConstraint"]
            if kind == "picklist":
                parts.append("one of " + ", ".join(f"<code>{e(v)}</code>" for v in c.split()))
            elif kind == "pattern":
                parts.append(f"matching <code>{e(c)}</code>")
            elif kind == "IRIstem" and not c.startswith("ccv:"):
                parts.append(f"a URI starting <code>{e(c)}</code>")
            elif kind == "IRIstem":
                scheme = next((p["scheme"] for p in self.vocab.properties
                               if any(x["scheme"] == p["scheme"] and f"ccv:{x['id']}".startswith(c)
                                      for x in self.vocab.concepts)), "")
                parts.append(f'a concept in <a href="../terms/#{scheme}"><code>ccv:{scheme}</code></a>')
            return "<br>".join(parts) or "any"

        def term_link(pid):
            if pid.startswith("ccv:"):
                return f'<a href="../terms/#{pid[4:]}"><code>{e(pid)}</code></a>'
            if pid.startswith("dcterms:"):
                return (f'<a href="https://www.dublincore.org/specifications/dublin-core/dcmi-terms/terms/{pid[8:]}/">'
                        f"<code>{e(pid)}</code></a>")
            return f"<code>{e(pid)}</code>"

        sections = []
        for key, shape in self.shapes.items():
            note = next((r["note"] for r in self.rows if r["shapeID"] == key and r["propertyID"] == "rdf:type"), "")
            rows = "".join(f"""
          <tr class="{'ccv' if r['propertyID'].startswith('ccv:') else ''}">
            <th scope="row">{term_link(r['propertyID'])}</th>
            <td>{'Yes' if r['mandatory'] == TRUE else 'No'}</td>
            <td>{'Yes' if r['repeatable'] == TRUE else 'No'}</td>
            <td>{value_cell(r)}</td>
            <td>{e(r['note'])}</td>
          </tr>""" for r in shape["rows"])
            sections.append(f"""
      <section class="term" id="{key}">
        <h3>{e(shape['label'])} <span class="hint">· every <code>{e(shape['class'])}</code></span></h3>
        <p>{e(note)}</p>
        <div class="table-wrap"><table class="profile-table">
          <thead><tr><th scope="col">Property</th><th scope="col">Required</th><th scope="col">Repeats</th><th scope="col">Value</th><th scope="col">Note</th></tr></thead>
          <tbody>{rows}</tbody>
        </table></div>
      </section>""")

        pairing = "".join(
            f"<tr><th scope=\"row\">{e(ev)}</th><td><code>{dc_relation_for(ev)}</code></td></tr>"
            for ev in self.vocab.labels("ccv:influenceEvidence"))
        counts = {k: len(v["rows"]) for k, v in self.shapes.items()}
        return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Application Profile</title>
  <meta name="description" content="How Dublin Core and the ccv: vocabulary combine in each Challenged Lineages record, as a DC-TAP table and SHACL shapes.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap">
  <link rel="stylesheet" href="../css/doc.css">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23fbf8f1'/%3E%3Ctext x='16' y='24' font-family='Georgia,serif' font-size='22' font-weight='700' text-anchor='middle' fill='%23b0181e'%3ECL%3C/text%3E%3C/svg%3E">
</head>
<body>
<!-- Generated by scripts/build_data.py from profile/tap.csv. -->
<div class="page">
  <nav class="site-nav" aria-label="Project pages">
    <a href="../">Map</a> <a href="../terms/">Vocabulary</a> <a href="./" aria-current="page">Profile</a> <a href="../questions/">Questions</a>
  </nav>
  <header>
    <p class="eyebrow">Application profile</p>
    <h1>Challenged Lineages Application Profile</h1>
    <p class="lede">Which properties each kind of record uses, which are required, and what their values may be. Dublin Core describes every record; <code>ccv:</code> properties, shown in red, appear only where Dublin Core cannot express something.</p>
    <dl class="meta">
      <dt>Format</dt><dd><a href="https://www.dublincore.org/specifications/dctap/">DCMI Tabular Application Profile (DC-TAP)</a>, compiled to <a href="https://www.w3.org/TR/shacl/">SHACL</a></dd>
      <dt>Shapes</dt><dd>{len(self.shapes)} ({", ".join(f"{e(s['label'])}: {counts[k]} properties" for k, s in self.shapes.items())})</dd>
      <dt>Download</dt><dd><a href="tap.csv">tap.csv</a> · <a href="namespaces.csv">namespaces.csv</a> · <a href="shapes.ttl">shapes.ttl</a></dd>
    </dl>
  </header>
  <main>
    <section class="intro">
      <h2>How it works</h2>
      <p>The profile is written once, as a DC-TAP table (<a href="tap.csv">tap.csv</a>), where each row says how one property is used in one kind of record. The build script compiles that table into SHACL shapes (<a href="shapes.ttl">shapes.ttl</a>), so any standard SHACL validator can check the published data against it. Every shape is closed, so a misspelled or stray property is reported as well as a missing one.</p>
      <p>To validate the collection yourself with <a href="https://github.com/RDFLib/pySHACL">pySHACL</a>, run this from the project folder. The <code>-e</code> option adds the vocabulary, so the validator can confirm that each value is a concept in the right ccv scheme:</p>
      <pre><code>pip install pyshacl
pyshacl -s profile/shapes.ttl -e terms/ccv.ttl data/collection.ttl</code></pre>
    </section>

    <section>
      <h2>The pairing rule</h2>
      <p>Every <code>ccv:challengeLineage</code> link is also stated with the Dublin Core relation that fits its evidence, so a Dublin Core-only application still sees the link. A table can't express a rule that compares two properties, so this one is a SHACL-SPARQL constraint on the Work shape. Instances pair with <code>dcterms:isVersionOf</code> instead.</p>
      <div class="table-wrap"><table class="profile-table pairing">
        <thead><tr><th scope="col">ccv:influenceEvidence</th><th scope="col">Paired Dublin Core relation</th></tr></thead>
        <tbody>{pairing}</tbody>
      </table></div>
    </section>

    <section>
      <h2>Shapes</h2>
      {''.join(sections)}
    </section>
  </main>
</div>
</body>
</html>
"""
