# Challenged Lineages

An interactive map of banned and challenged books and the links between them: later works that reference, retell, adapt, or answer classic works. Every record is a Dublin Core description first. The Challenged Collections Vocabulary (`ccv:`) adds only what Dublin Core cannot say. The design follows Jamie Hazlitt's *Alice Meets FRBR* (2005).

```
index.html               the map
terms/                   the ccv vocabulary: documentation page, ccv.ttl, ccv.jsonld   (generated)
profile/                 the application profile: tap.csv (edit), shapes.ttl and page (generated)
questions/               competency questions: questions.json and one .rq file per query
css/, js/                styling and scripts (js/questions.js runs the questions page)

data/collection.csv      MASTER DATA: one row per record
data/clusters.csv        the six lineage clusters (A–F)
data/ccv-terms.csv       the seven ccv properties and five value schemes
data/ccv-concepts.csv    the values in each scheme (one row per SKOS concept)
data/authorities.csv     LC / VIAF / Wikidata matches, waiting for review
data/collection.jsonld, data/collection.ttl    generated; do not edit by hand

scripts/build_data.py    builds everything above from the CSVs, after validating them
scripts/vocab.py, scripts/profile_tap.py, scripts/rdf.py    its parts
review/                  candidate data waiting for your approval
References/              source documents (not used by the site)
```

The site has four pages: the **map**, the **vocabulary** (`terms/`), the **application profile** (`profile/`), and the **competency questions** (`questions/`).

## Editing the data

Open `data/collection.csv` in Excel. When you save, choose **CSV UTF-8 (Comma delimited)** so accented names (Renée, García Márquez) survive.

Each row is one record. The `recordType` column says which kind:

| recordType | What it is | Must have |
|---|---|---|
| `Work` | A book or text. Works with `dcterms:isPartOf` (A–F) are in a lineage cluster. Works without one are linked source works (Appendix B). | `dcterms:identifier`, `dcterms:title` |
| `Instance` | An edition or adaptation challenged separately from its work. | `dcterms:title`, `dcterms:isVersionOf` (the work's ID) |
| `Challenge` | One challenge record, or one ranked-list entry. | `dcterms:relation` (the work or instance's ID), plus `dcterms:source` or `dcterms:description` |

- **Multiple values** go in one cell, separated by ` | ` (space, bar, space). For example: `Margaret Atwood | Renée Nault`.
- **Dates** are a year (`1985`) or a range of years (`1986/1991`).
- **IDs** follow the Hazlitt pattern: `W.A.3` is work 3 in cluster A, `W.A.3 I1` is its first instance, `W.A.3 C2` is its second challenge, and `W.S.12` is source work 12.
- **Controlled values** must match the vocabulary exactly. The lists are at the top of `scripts/build_data.py`, and the build reports any value that isn't on them:
  - `ccv:influenceEvidence`
  - `ccv:challengeVenue`
  - `ccv:challengeOutcome`
  - `ccv:challengeInitiator`
- **Blank cells** mean the source doesn't say. Leave them blank rather than guessing.

### Adding a link between two works

On the later work's row:

1. Put the earlier work's ID in `ccv:challengeLineage`.
2. Put the kind of evidence in `ccv:influenceEvidence`.
3. Put the same ID in the Dublin Core column that matches the evidence:

| ccv:influenceEvidence | Dublin Core column |
|---|---|
| explicit reference, title or epigraph allusion | `dcterms:references` |
| adaptation, retelling, parody | `dcterms:source` |
| author-acknowledged, critical attribution, same author, genre lineage | `dcterms:relation` |

A work can have several links. List the targets in `ccv:challengeLineage` and either give one evidence value for all of them, or one per target in the same order.

### Editing the vocabulary

`data/ccv-terms.csv` holds each ccv property's label, definition, domain, range, and comment, quoted from the metadata analysis. `data/ccv-concepts.csv` holds the controlled values. To add a value, such as a new challenge reason, add a row with its scheme, an `id` (lowercase words joined by hyphens, such as `reason-offensive-language`), and its label. The `id` becomes its URI (`ccv:reason-offensive-language`), so don't change an `id` once data uses it. Change the label instead.

### Authority links

`data/authorities.csv` links creators, works, places, and the two subject headings to Library of Congress authority records. It also holds the VIAF and Wikidata links each LC record gives. Only rows with `approved` set to `yes` reach the data. Each row is matched by its `local` value: a creator's name or a place exactly as `collection.csv` spells it, or a work's identifier. If you rename a creator in `collection.csv`, change the matching `local` too; the build warns about approved rows that no longer match anything.

In the published data, `dcterms:creator` and `dcterms:spatial` point to agent and location records (`agent/margaret-atwood`, `place/medford-or`). Those carry the links: `madsrdf:isIdentifiedByAuthority` for the LC record, `owl:sameAs` for Wikidata, and `rdfs:seeAlso` for VIAF.

Where LC has no record for a work, the `wikidata` column can hold a Wikidata item found directly. It was accepted only when the item's author matches the creator's Wikidata. The `seeAlso` column is for a related record that is not the same thing, such as the book a short work is part of; it becomes `rdfs:seeAlso`, never `owl:sameAs`.

The `match` and `status` columns record how each link was found and reviewed. Rows marked "no LC or Wikidata record" were checked and have nothing to link to.

### Editing the application profile

`profile/tap.csv` is a DCMI Tabular Application Profile (DC-TAP). Each row says how one property is used in one kind of record: whether it is required (`mandatory`), whether it repeats (`repeatable`), and what values it takes. The build compiles it into SHACL shapes (`profile/shapes.ttl`). To check the published data against the profile with a standard validator:

```
pip install pyshacl
pyshacl -s profile/shapes.ttl -e terms/ccv.ttl data/collection.ttl
```

### The site's address

Every URI the project mints (records, the ccv namespace, the profile) comes from one setting, `SITE` at the top of `scripts/rdf.py`. It is set to the published site, `https://isaacsbm.github.io/challenged-lineages/`, so a term URI such as `…/terms#challengeLineage` opens that term on the vocabulary page. If the site ever moves, change `SITE` and rebuild.

## Rebuilding the data

After editing the CSV, run this from the project folder:

```
python scripts/build_data.py
```

It needs Python 3.8 or later and nothing else. It checks every row first: broken link targets, duplicate IDs, unknown evidence or other controlled values, empty required fields, and links missing their Dublin Core or ccv partner. Errors name the CSV row number, so you can find them in Excel. If there are any errors, nothing is written. Warnings, such as a challenge with no cited source, don't stop the build.

When the build succeeds, it rewrites `data/collection.jsonld` (which the site loads) and `data/collection.ttl` (the same data as Turtle). It also rewrites the vocabulary in `terms/` and the SHACL shapes and profile page in `profile/`, then prints a summary.

## Running locally

The page loads its data with `fetch`, so it must be served over HTTP. Opening `index.html` directly won't work.

```
python -m http.server
```

Then visit <http://localhost:8000>. D3 v7.9.0 and EB Garamond load from cdnjs and Google Fonts, so you need an internet connection.

## The live site

The site is published with GitHub Pages:

- **Site:** <https://isaacsbm.github.io/challenged-lineages/>
- **Repository:** <https://github.com/isaacsbm/challenged-lineages>

Pages serves the `main` branch from the repository root. `References/` is listed in `.gitignore`, so the source documents never leave your computer.

### Publishing a change

Edit, rebuild, check locally, then commit and push. Pages republishes about a minute after each push.

```
python scripts/build_data.py
python -m http.server
git add -A
git commit -m "Describe what changed"
git push
```

Always commit the generated files (`data/`, `terms/`, `profile/`) together with the CSVs they come from, so the published data matches its sources.

### Setting it up again elsewhere

1. Create a public GitHub repository and push this folder to it.
2. In the repository, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`.
3. Set `SITE` in `scripts/rdf.py` to the new address, rebuild, and push. All paths are relative, so nothing else needs to change.

## Using the site

- **Questions** (linked at the bottom left of the map) runs eight questions as SPARQL queries live in the browser. Each runs once against the data with every ccv statement removed and once against the full data, and the page shows where the answers differ. It also has a box for writing your own queries.
- **List** shows every record as plain text, grouped by cluster. It's the quickest route for keyboard and screen-reader users. Choosing a title opens its record, and Escape returns you to the list.
- **Hover over or focus a title** to highlight its full lineage: the works it draws on, and the works that draw on it.
- **Click a title, or press Enter on it,** to open its record. The record shows the Dublin Core fields, then the ccv fields, then its challenge records, then a Turtle snippet.
- **Drag a title** to pin it in place. Double-click it to unpin it. **Reset layout** unpins everything.
- **Layers** turns on and off: clusters, evidence types, instances, source works, challenge eras, and venues.
- **Edge labels** switches every edge between its ccv evidence and its Dublin Core relation. This shows what the coined terms add.
- **Redact** blacks out the title and creator of every challenged record, like a censored government document. Each one is stamped Challenged, Banned (where the challenge outcome is `banned`), or Expurgated, and an expurgated edition loses every other word. Under **Layers → Redaction** you can narrow it to banned and expurgated records only. Hover over or select a record to lift its bars.
