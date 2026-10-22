# Importing med-lit Projects

[**med-lit-mcp**](https://github.com/junhewk/med-lit-mcp) is a companion tool
for medical literature reviews, by the same author. It is an MCP server: you
work with it from Claude Code, Claude Desktop, Codex, ChatGPT desktop or
Hermes, and the agent takes a review question through
**search → screening → fetch → wiki**. Along the way it:

- searches PubMed, PMC, OpenAlex, Semantic Scholar, Scopus and Europe PMC,
- screens titles and abstracts, with every decision backed by a quote,
- fetches the full text where it is openly available, and
- writes a wiki: one page per article, one page per entity (conditions,
  interventions, technologies, methods, …) with an evidence-linked synthesis,
  and a knowledge graph of those entities and their relationships.

A scheduled **bot** can keep a review up to date, adding a few new articles a
day. Install it from [GitHub](https://github.com/junhewk/med-lit-mcp) or
[PyPI](https://pypi.org/project/med-lit-mcp/) (`uvx med-lit-mcp setup`).

Simple Graph Builder imports such a project into your vault:

- **The pages stay together** in their own folder, named after the project
  (`<project>/sources`, `<project>/entities`, `<project>/updates`), apart from
  your notes and from the plugin's own entity notes.
- **Links become Obsidian wikilinks.** med-lit writes relative Markdown links;
  the import rewrites them to `[[<project>/entities/Empathy|Empathy]]`, so
  backlinks, the graph view and renames work as they do for your own notes.
- **Its knowledge graph joins yours.** med-lit's graph is merged into this
  plugin's graph, with no LLM extraction and no API calls. An entity med-lit
  found ("Large language models", acronym "LLM") becomes the same node as the
  "LLM" in your own notes, and relationships keep med-lit's verbatim quotes as
  evidence. med-lit's medical types are converted to this plugin's ten types by
  med-lit's own table.
- **Updating is the same command.** Import the project again after the bot has
  run and only what changed comes in. Pages you edited in Obsidian are kept and
  listed, never overwritten without your say-so.

It needs med-lit-mcp 0.1.6 or later and the desktop app.

## The project folder

med-lit keeps each review in a project folder,
`~/med-lit/<review name>/` by default:

```
<review>/
├── sources/        one page per included article
├── entities/       one page per entity, with its synthesis
├── updates/        a report for each bot run
├── index.md, log.md
└── .med-lit/       med-lit's own data, including sgb-export.json
```

Since 0.1.6, med-lit also writes `.med-lit/sgb-export.json` whenever it writes
the pages. The file is a snapshot of the review's knowledge graph in a
documented format (`med-lit-sgb/1`). This plugin imports from that file and
never opens med-lit's database. The pages and the graph therefore always come
from the same moment. A med-lit run that crashed leaves the previous export in
place, and the import says when the last run did not finish.

## Importing

1. Run **Import or update med-lit project** (or **Settings → Imported projects → Import…**).
2. Enter the project folder's path, e.g. `/Users/you/med-lit/My review`. If the
   bot runs on another machine, copy or sync the folder to this one first.
3. **Read project** shows what will happen before anything is written:
   - how many pages are new, updated or unchanged,
   - which ones you edited,
   - the folder they go into (on a first import you can rename it).
4. **Import**.

Optionally, if [entity resolution](SETTINGS.md#entity-resolution-opt-in) is on, the import
can also match entities to your graph by embedding similarity. That costs
embedding (and possibly verification) calls for entities it has not seen before.
Without it, entities are matched by exact name and by the aliases med-lit
recorded, at no cost.

## What ends up where

| | |
|---|---|
| Pages | `<project>/…`, with links rewritten as full-path wikilinks |
| Entities | One graph node per med-lit entity, typed by med-lit's own conversion (`sgb_type`: CONDITION → CONCEPT, INTERVENTION → METHOD, TECHNOLOGY → TOOL, …). An entity that already exists in your graph is joined, not duplicated: it keeps its own name and type and gains med-lit's name as an alias |
| Sources | An entity's sources are the article pages that mention it. Agents connected over MCP get its wiki page as its entity note |
| Relationships | med-lit's relationships, with every supporting quote. If your own notes already assert the same relationship, the quotes are added to it |
| Your notes | Untouched. The plugin's [entity notes](SETTINGS.md#vault-write-back-opt-in) link to med-lit's wiki page for entities only the import knows, instead of creating a second page for them |

Imported pages are never sent to the LLM. **Analyze entire vault** and
auto-analysis skip them, because their graph came with them. They are also
left out of `related:` write-back, which would make every page look edited.
Search and connected agents see them like any other note.

## Updating

When the bot (or you) has added to the review, import the same project again.
It is recognized by med-lit's project id, so the folder can be a fresh copy at a
different path. The import then decides for each page:

| The page in your vault | med-lit's version | What happens |
|---|---|---|
| As last imported | Changed | Updated |
| As last imported | Gone (article withdrawn, entity merged) | Moved to the trash |
| Edited by you | Unchanged | Kept |
| Edited by you | Changed | **Kept, and listed**; **Use med-lit's version** replaces it |
| Edited by you | Gone | Kept, and no longer tracked |
| Deleted by you | Any | Not brought back (unless you ask) |
| Moved or renamed by you | Any | Updated where it now is |
| (new) | New | Added |

The graph follows the same snapshot:

- New articles and entities are added.
- Entities and relationships med-lit dropped are removed. Anything your own
  notes also support stays.
- Earlier entity matches are reused, so an update makes no API calls. This also
  respects any merge you made by hand.
- When med-lit merged two entities that your graph still keeps apart, the
  import suggests the merge rather than doing it.

Importing an older snapshot than the last one asks for confirmation first.

## Removing

**Settings → Imported projects → Remove** takes the project out of the graph:

- its entities, relationships and aliases go;
- anything your notes also support keeps that support;
- its pages are either kept, or moved to the trash if you have not edited them.

## Managing imported projects

Under **Settings → Imported projects**:

- **Import med-lit project**: opens the import window (desktop only)
- One row per imported project, with:
  - **Update**: import a newer snapshot of it
  - **Rebuild graph**: restore its entities and relationships from the copy kept in the plugin folder, for example after **Clear graph data**. Needs no source folder and works on mobile
  - **Remove**: take it out of the graph, and either keep its pages or move the ones you have not edited to the trash

