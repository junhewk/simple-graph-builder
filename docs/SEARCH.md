# Search

Search makes no API calls. The first search after Obsidian starts builds an
index of your notes in memory, and later edits keep it up to date.

There are two ways in:

- **Search graph and notes** (command): a list of notes and entities, for
  finding something and opening it.
- **The search box in the [graph view](GRAPH_VIEW.md#search)**: the same
  engine, with the results shown on the map and split into what matched and
  what the graph reached.

[Agents connected over MCP](AGENT_ACCESS.md) use the same engine through their
`search` tool.

## The Search command

1. Run **Search graph and notes**.
2. Type words, a concept or an entity name. Korean particles are fine:
   `머신러닝은` finds `머신러닝`.
3. **Notes** are ranked by how well they match *and* how close they are in the
   graph to what matched. Under each note: a snippet, the words it matched,
   and the entities connecting it to your query. For example,
   `Via: Transformer —uses→ Attention` means the note mentions Transformer,
   which uses the Attention you searched for.
4. **Entities** are listed by type, with the notes they appear in.
5. Click a note to open it.

## How results are ranked

1. **Text.** Notes are matched on title, aliases, headings, tags and body
   (titles count most). Korean is matched by syllable pairs, so particles and
   spacing variations still match. Entities are matched on name, aliases and
   description.
2. **Graph.** The best matches become starting points for a random walk over
   the graph (Personalized PageRank, as in HippoRAG). The walk spreads
   relevance along relationships, note mentions and wikilinks, the last
   counting half.
3. **Score.** Each result's score blends the two: 60% text, 40% graph.

The graph half is why a note can rank without containing your words: it is
close to notes and entities that do.

## Reached through the graph

The blended score has a blind spot. A node with no text match scores at most
40%, so once more things match your words than the result limit, every slot
goes to them. On a large vault that is most searches.

So the graph view asks the engine for a second, separate list: up to 15
entities and 15 notes that the walk reached **without** a text match, ranked
only against each other.

They are ranked by walk score **divided by number of connections**. A random
walk always spends much of its time on the best-connected nodes, so raw walk
score would put the same hubs at the top of every search. Dividing by
connections ranks a node by how much more your query reaches it than its
connectivity alone would explain. A hub everything touches is not something
you didn't know to look for.

Each reached result shows the relationship that ties it to a match, when there
is one.
