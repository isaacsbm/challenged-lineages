// Serialize JSON-LD nodes back to Turtle for the detail panel's snippet.
// Mirrors the to_turtle() function in scripts/build_data.py so snippets match collection.ttl.

import { asArray } from "./data.js";

const escapeLiteral = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function term(value, prefixes) {
  if (value && typeof value === "object") {
    const iri = value["@id"];
    const prefix = iri.split(":")[0];
    return prefix in prefixes ? iri : `<${iri}>`;
  }
  return `"${escapeLiteral(String(value))}"`;
}

function node(n, prefixes) {
  const props = [`a ${n["@type"]}`];
  for (const [key, value] of Object.entries(n)) {
    if (key.startsWith("@")) continue;
    props.push(`${key} ${asArray(value).map((v) => term(v, prefixes)).join(", ")}`);
  }
  return `${term({ "@id": n["@id"] }, prefixes)}\n    ${props.join(" ;\n    ")} .`;
}

/** Turtle for a list of nodes, with only the prefixes those nodes actually use. */
export function toTurtle(nodes, context) {
  const { "@base": base, ...prefixes } = context;
  const body = nodes.map((n) => node(n, prefixes)).join("\n\n");
  const used = Object.keys(prefixes).filter((p) => body.includes(`${p}:`));
  const header = [`@base <${base}> .`, ...used.map((p) => `@prefix ${p}: <${prefixes[p]}> .`)];
  return `${header.join("\n")}\n\n${body}\n`;
}
