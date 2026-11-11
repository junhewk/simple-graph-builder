# Find more literature

Use concepts and relationships in an existing graph to decide what to search
for next. Simple Graph Builder searches PubMed and OpenAlex directly, shows
citations and available abstracts in Obsidian, and opens an article in your
external browser for reading, access and downloading.

This works with an already prepared graph. It requires no graph regeneration,
model API key, AI agent session, med-lit-mcp process or separate backend.

## From exploration to a search

1. Search the knowledge graph and select a concept.
2. Use **1 hop** or **2 hops**, follow inspector relationships, or use **Path
   to…**. Expand **Supporting sources** and open the source notes to check the
   passages behind the relationships.
3. Choose **Find more literature…** (**다음 문헌 검색…** when Obsidian uses
   Korean). A displayed path has its own action, using the final node as the
   selected concept. The command palette action is available while the graph
   view has a selection.
4. Review **Graph origin**, including the original graph query, route, verbs,
   direction, available source references and imported evidence quotes.
5. Select expressions, add required concepts, choose the sources and review
   each outgoing query. Press **Search**.
6. Select a publication to inspect its citation and available abstracts. Use
   **Open in external browser** to visit the displayed destination.

The route stays visible while scrolling. Expand **Graph context and supporting
sources** to inspect its evidence. **Search controls** starts open and collapses
after Search; reopen it to revise a query. Result lists scroll within a bounded
area so the selected citation and abstract remain close at hand.

The route is captured when you invoke the action. Later graph changes do not
rewrite that origin; the pane reports that the graph changed. Invoke the graph
action again to capture a new origin. A research question can be entered as
optional local context.

The **1 hop / 2 hops** controls narrow a neighborhood around their current
anchor. **Reached through the graph** and **Search around** are ranked graph
propagation, not fixed-hop result sets. A separately measured distance describes
the captured view. Note mentions and wikilinks count as steps when note nodes
are included. Filters and large-graph rendering limits can restrict that view.

A relationship click records the edge you followed. An unrelated selection is
shown as a selection jump; it is not presented as a supporting relationship.
The origin retains up to 128 navigation steps, preserving the starting node and
marking any shortened history. Ordinary extraction details remain descriptions;
only evidence stored as a quote by an importer is displayed as a quotation.

## Concepts, alternatives and exact queries

The selected concept starts as one group. Canonical names and aliases are
available to select, including Korean labels and English aliases already in
the graph. No terms are translated by a model.

- Expressions within one concept are joined with **OR**.
- Separately required concepts are joined with **AND**.
- Connected concepts and all nodes on a path are not selected automatically.
- You can add your own expressions or concepts and remove any term.

For example, selecting two expressions for one concept and requiring another
produces different source queries:

```text
PubMed:
("simulation-based medical education"[tiab] OR "SBME"[tiab]) AND ("deliberate practice"[tiab])

OpenAlex:
("simulation-based medical education" OR "SBME") AND ("deliberate practice")
```

PubMed uses title/abstract field tags. OpenAlex uses its own title/abstract
search parameter. PubMed syntax is never copied into OpenAlex automatically.
Each preview shows scope, dates, provider relevance ordering, page size and
the 100-record source cap. A date range requires both dates. PubMed and
OpenAlex have different publication-date definitions, so coverage can differ.

**Edit source query** enables a native override for that source. Concept edits
do not overwrite it; **Reset from concepts** resumes compilation. Native filters
in an override also apply. Returned PubMed translations and warnings appear
with the exact submitted query. The builder itself adds no language, access or
publication-type filter. There is no PICO/PCC form.

The small builder supports up to four concepts and five selected expressions
per concept. It validates dates, empty groups, reserved literal syntax and
encoded query length before a request. A long or invalid query is reported;
terms and filters are not silently dropped.

## Results and identity

Source tabs retain each provider's order. Selecting a row displays title,
authors, year, journal/source, publication type, available abstracts and
identifiers. Missing, empty and undecodable abstracts have different messages.
PubMed structured abstract section labels are preserved. OpenAlex abstracts are
reconstructed from its inverted index. Provider text is rendered as text.

Exact DOI, PMID or PMCID matches can group records, provided other supplied
identifiers do not contradict them. The plugin never deduplicates by title
similarity alone or merges different publication versions using location DOIs.
Records without reliable shared identifiers stay separate. Conflicting identity
records stay separate and are flagged; incomplete records do not bridge them.

PubMed is preferred for shared citation fields, with nonempty metadata from the
other source filling missing display fields. Original source values and
abstract versions remain inspectable. Source relevance scores are not combined.

**Already in vault** requires an exact identifier match to an existing visible
note. Recognized frontmatter includes `doi`, `pmid`, `pmcid`, `openalex` and
importer `uid` values. Existing med-lit importer mappings are reused, and
identifiers on a DOCUMENT/NOTE with a single source can be recognized. Ordinary
notes need none of these fields. Without a match, the pane says **No reliable
vault match detected**; it does not assert that the paper is absent.

## Requests, failure and privacy

Opening the pane, clicking graph nodes, editing queries and selecting results
make no literature requests. **Search**, **Load more** and **Retry source** are
explicit network actions. PubMed captures at most 100 PMIDs and fetches metadata
in batches. OpenAlex uses bounded basic pages. Page size defaults to 20 and can
be 10, 20 or 50.

Only submitted queries, filters and configured contact/authentication details
are sent to the selected source. The graph route, source passages, vault paths
and local research question are not transmitted. Extraction-provider keys are
never used for literature retrieval.

Requests are paced independently per source. Temporary errors have at most two
retries with backoff; rate-limit retry timing is respected. Authentication and
exhausted-allowance errors are actionable failures. One source can fail while
the other remains usable. A failed additional page preserves loaded results.

**Stop** discards late responses and prevents queued requests/retries. Obsidian's
HTTP API does not expose transport cancellation; an already dispatched request
may finish. Its physical queue slot remains occupied until it finishes, even
if the pane reports a timeout. A new search never accepts an older response.

Public citation pages are cached in memory for ten minutes, bounded to 25 pages
and 500 records. The pane labels cached responses and their retrieval time.
Cache entries contain no credentials or graph origin. **Clear literature
cache** is available in settings. Search sessions and results are not saved as
notes, added to the graph or persisted as search history.

The external-open action chooses an available open-access landing page, then a
publisher/DOI page, then a bibliographic record. The destination is shown before
opening. Direct PDF/download URLs are not the default. Only valid HTTP/HTTPS
article destinations are accepted. The plugin performs no article download or
import; access, login and downloading happen in the browser.

## Settings and provider access

**Settings → Simple Graph Builder → Literature search** is separate from
extraction providers. Both sources support bounded searches without a key under
their current policies. Optional keys can improve allowances.

- **Contact email:** optional contact address included with PubMed requests.
  NCBI recommends a real contact address and a stable tool name for distributed
  software. The tool name is `simple-graph-builder`.
- **PubMed API key:** optional personal NCBI key. NCBI permits three requests per
  second per IP without a key and ten with a key. This plugin paces requests
  conservatively; other applications can still consume the same allowance.
- **OpenAlex API key:** optional verified personal key. Basic paging supports
  this feature's limit; cursor pagination is not used. API usage has an
  allowance, and exhausted allowances are reported without repeated retries.
- **Keys:** stored through Obsidian secret storage when available; on older
  supported versions, keys last only for the session. They are never written to
  `data.json`, graph exports, cached results or documentation. Do not distribute
  credentials with a copied vault.

Provider behavior was checked against current documentation on November 11,
2026. See [PubMed search help](https://pubmed.ncbi.nlm.nih.gov/help/),
[NCBI API limits](https://support.nlm.nih.gov/kbArticle/?pn=KA-05317),
[NCBI software usage guidance](https://www.ncbi.nlm.nih.gov/home/about/policies/),
[OpenAlex search](https://help.openalex.org/api/searching/),
[OpenAlex authentication](https://help.openalex.org/api/authentication/) and
[OpenAlex paging](https://help.openalex.org/api/paging/).

## Release acceptance fixture

```bash
npm run build
node scripts/make-literature-test-vault.mjs /tmp/sgb-literature-acceptance
```

Use a new or empty directory. The generator refuses to overwrite a vault. It
copies the built plugin and creates a prepared three-concept graph:

```text
Simulation —provides→ Feedback ←uses— Deliberate practice
```

Read `Start.md` in that vault for the acceptance sequence. Source passages are
clearly labeled illustrative fixture text, not quotations from the linked
publications. The fixture has bilingual aliases, ordinary source notes, two
known article identifiers and synthetic saved offline examples. Imported quote
provenance is tested separately in the automated suite. Live search never
substitutes examples for a failure.

For a live, read-only API smoke test, run `npm run eval -- literature`. Optional
environment variables are `SGB_LITERATURE_EMAIL`, `SGB_PUBMED_API_KEY` and
`SGB_OPENALEX_API_KEY`. It checks both providers return publications outside the
fixture's two seed PMIDs, using deliberate practice AND medical education.

Saving search trails, creating reference notes, full-text retrieval, automatic
graph updates, citation chasing and scheduled searches are outside this release.
