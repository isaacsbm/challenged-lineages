"""Shared RDF plumbing: namespaces, and writing a graph as JSON-LD and Turtle.

A graph is a list of JSON-LD node objects using compact IRIs ("dcterms:title"). The same
objects are written to both formats, so the .jsonld and .ttl files always match.
Values may be:
    "text"                          a plain literal
    7, True                         a typed literal (xsd:integer, xsd:boolean)
    {"@id": "W.A.3"}                an IRI (relative to the base, or prefixed)
    {"@value": "^\\d{4}$", "@type": "xsd:string"}   an explicitly typed literal
    {"@list": [...]}                an RDF list (SHACL's sh:in and sh:or use these)
    {"sh:path": ...}                a dict without "@id" is a blank node, nested in place
"""

import json
from pathlib import Path

# Everything this project mints lives under one site address: the published GitHub Pages
# site. So the ccv namespace resolves: a term URI such as .../terms#challengeLineage opens
# that term's entry on terms/index.html. (The metadata analysis drafted the namespace at a
# fictional address, https://ns.challengedcollections.org/terms#.)
SITE = "https://isaacsbm.github.io/challenged-lineages/"
CCV = SITE + "terms#"
COLLECTION_BASE = SITE + "collection/"
PROFILE = SITE + "profile#"

PREFIXES = {
    "dcterms": "http://purl.org/dc/terms/",
    "dcmitype": "http://purl.org/dc/dcmitype/",
    "dcam": "http://purl.org/dc/dcam/",
    "ccv": CCV,
    "bf": "http://id.loc.gov/ontologies/bibframe/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "madsrdf": "http://www.loc.gov/mads/rdf/v1#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "vann": "http://purl.org/vocab/vann/",
    "sh": "http://www.w3.org/ns/shacl#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "ccvp": PROFILE,
}


def is_prefixed(iri):
    return iri.split(":", 1)[0] in PREFIXES and not iri.startswith(("http:", "https:"))


def expand(iri):
    """'dcterms:title' -> 'http://purl.org/dc/terms/title'; other IRIs unchanged."""
    if is_prefixed(iri):
        prefix, local = iri.split(":", 1)
        return PREFIXES[prefix] + local
    return iri


def used_prefixes(text):
    return {p: uri for p, uri in PREFIXES.items() if f"{p}:" in text}


# ---------------------------------------------------------------------------
# JSON-LD
# ---------------------------------------------------------------------------

def to_jsonld(graph, base):
    body = json.dumps(graph, ensure_ascii=False)
    context = dict(used_prefixes(body))
    context["@base"] = base
    return {"@context": context, "@graph": graph}


# ---------------------------------------------------------------------------
# Turtle
# ---------------------------------------------------------------------------

def _literal(text):
    escaped = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def ttl_term(value, indent):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _literal(value)
    if "@id" in value:
        iri = value["@id"]
        return iri if is_prefixed(iri) else f"<{iri}>"
    if "@value" in value:
        lit = _literal(str(value["@value"]))
        if "@language" in value:
            return f"{lit}@{value['@language']}"
        return f"{lit}^^{value['@type']}" if "@type" in value else lit
    if "@list" in value:
        return "( " + " ".join(ttl_term(v, indent) for v in value["@list"]) + " )"
    # A blank node, written in place as [ ... ].
    inner = indent + "    "
    props = _properties(value, inner)
    return "[\n" + inner + (" ;\n" + inner).join(props) + "\n" + indent + "]"


def _properties(node, indent):
    props = []
    types = node.get("@type")
    if types:
        types = types if isinstance(types, list) else [types]
        props.append("a " + ", ".join(types))
    for key, value in node.items():
        if key.startswith("@"):
            continue
        values = value if isinstance(value, list) else [value]
        props.append(f"{key} " + ", ".join(ttl_term(v, indent) for v in values))
    return props


def to_turtle(graph, base, header_comment=""):
    body = []
    for node in graph:
        subject = ttl_term({"@id": node["@id"]}, "")
        body.append(f"{subject}\n    " + " ;\n    ".join(_properties(node, "    ")) + " .\n")
    text = "\n".join(body)
    lines = [f"# {line}" for line in header_comment.splitlines()]
    lines.append(f"@base <{base}> .")
    lines += [f"@prefix {p}: <{uri}> ." for p, uri in used_prefixes(text).items()]
    return "\n".join(lines) + "\n\n" + text


def write(path_without_suffix, graph, base, header_comment=""):
    """Write <path>.jsonld and <path>.ttl."""
    path = Path(path_without_suffix)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_suffix(".jsonld").write_text(
        json.dumps(to_jsonld(graph, base), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    path.with_suffix(".ttl").write_text(to_turtle(graph, base, header_comment), encoding="utf-8")
