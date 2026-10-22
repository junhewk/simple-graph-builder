# Graph View

Open it with **Open graph view** (command or ribbon menu). It opens in the right
sidebar, or in a main tab if **Open graph in main window** is on
([settings](SETTINGS.md#view)).

The graph view is meant for working with your notes, not just looking at a
picture of them. Extraction gives you a first map of the concepts and
relationships in your notes. The view lets you search that map, follow its
connections back to the notes they came from, and rearrange it until it shows
what you want to see.

- [Reading the graph](#reading-the-graph)
- [Search](#search)
- [Inspecting a node](#inspecting-a-node)
- [Narrowing and connecting](#narrowing-and-connecting)
- [Display and forces](#display-and-forces)
- [Clusters](#clusters)
- [Layout](#layout)
- [Large graphs](#large-graphs)
- [Mouse and keyboard](#mouse-and-keyboard)
- [Note neighborhood panel](#note-neighborhood-panel)

## Reading the graph

- **Color** is the entity type (10 types, plus grey rounded squares for notes;
  see the [data model](DATA_MODEL.md)), or the cluster when **Color by cluster**
  is on.
- **Size** grows with the number of visible connections, on a logarithmic
  scale, so hubs stand out without dwarfing everything else.
- **Edge opacity** reflects how connected both ends are. Zoomed out, edges are
  drawn bold, because a 1px line covers a fraction of a pixel there and only
  the mass of them registers. Zoom in and they thin out behind the nodes and
  labels.
- **Hover** a node for its type, connections and source-note count. Hover an
  edge for its relationship verb and detail.

## Search

Type in the box at the top left.

- Nodes whose **names** contain your words light up at once.
- The [search engine](SEARCH.md) then adds what it ranks, in two groups:
  - **Matches**: entities and notes that contain the words themselves, marked
    with a solid ring.
  - **Reached through the graph**: up to 15 entities and 15 notes that do not
    contain your words but are closely connected to what does, marked with a
    dashed ring. Each one shows the relationship that connects it, for example
    `Transformer —uses→ Attention`.
- Everything else fades, so the results read as a shape on the map.
- Press **Enter** to jump to the first result, or click any result. A note
  hidden by your filters can still be opened from the list.

The second group is the point of searching here. It holds what you did not
know to search for, and why it surfaced, so it is kept separate from the
matches rather than ranked below them. How it is chosen is described in
[Search](SEARCH.md#reached-through-the-graph).

## Inspecting a node

Click a node to open the inspector:

- its type, number of connections and description;
- every **relationship**, grouped by verb (`→ uses`, `← cites`, …). Each one is
  a link to the node at its other end;
- the notes it was **found in**, each one a link that opens the note.

The **trail** at the top records the route you took from node to node. Click a
step to go back to it. In a narrow pane the inspector sits at the bottom and
can be collapsed with its chevron.

## Narrowing and connecting

From the inspector:

- **1 hop** / **2 hops** hide everything outside the selected node's
  neighborhood. **All** shows the whole graph again.
- **Path to…**, then click a second node or a search result, shows the
  shortest connection between the two, step by step with each verb.
- **Search around** (or double-click a node) ranks the whole vault by how
  closely it connects to that node.
- **Open note** opens a note node's note.

## Display and forces

The sliders button next to the search box opens the display panel. Every
change applies immediately and is saved.

| Section | What you can set |
|---|---|
| Filters | Show notes, minimum connections, and for each entity type: shown or hidden, and its color |
| Clusters | Color by cluster, cluster size, cluster pull, and the cluster list ([below](#clusters)) |
| Nodes | Size, opacity, label size |
| Edges | Thickness, opacity, color (or follow the theme), relationship labels written along each edge |
| Forces | Repulsion, link length, center pull, spacing, and **Lay out again** |

**Restore defaults** at the bottom resets everything in the panel.

Relationship labels are easiest to read together with **1 hop** focus: on a
dense graph, every edge carrying its verb is a lot of text.

## Clusters

Densely connected groups are found from the graph itself (the Louvain method)
over what is currently visible. They are a reading of the structure, not
labels anyone assigned.

- **Color by cluster** colors each group of three or more nodes. Smaller groups
  stay grey.
- **Cluster size** sets how finely the graph is divided. Higher finds more,
  smaller clusters.
- **Cluster pull** makes the layout draw each cluster into its own region.
- The **cluster list** names each cluster after its best-connected entity.
  Click one to highlight its members.

## Layout

The graph appears at once and settles while you watch. The layout runs in a
background worker, so Obsidian stays responsive while it does.

- **First open:** a quick spectral placement, then ForceAtlas2 (the force
  model Gephi uses) settles it. A short spacing pass at the end gives labels
  room.
- **Remembered positions:** where every node ended up is saved in
  `graph-layout.json` in the plugin folder. The next time the graph opens, or
  after you analyze another note, the map keeps its shape. Only new nodes are
  placed, next to what they connect to, and they settle while everything else
  stays put.
- **Arrange it yourself:** drag a node and it stays where you put it.
- **Forces:** **Repulsion** and **Center pull** reach a layout that is still
  settling on its next step. **Link length**, **Cluster pull** and **Spacing**
  start it again from where the nodes are. **Lay out again** does the same.
- While it settles, a **Settling layout… Stop** notice shows at the bottom.
  Stop keeps the positions reached so far.

Deleting `graph-layout.json` (with the graph view closed) starts the layout
over from scratch next time.

## Large graphs

On a 2,001-node / 10,368-edge test vault the graph is visible in about 2
seconds on first open and settles over about 4 more. With remembered
positions, it opens in about 1 second.

Above 2,000 nodes plus edges, the view trades detail for speed: straight edges
without arrowheads, a 1× pixel ratio, and labels and edges hidden while you pan
or zoom. Beyond 5,000 nodes or 15,000 edges, the best-connected are kept and a
notice says how many were left out.

A large graph redraws less often while it settles, about once a second,
because each redraw of thousands of moved nodes is expensive. Small graphs
animate smoothly.

If the graph still looks crowded, raise **Minimum connections**, hide notes or
some entity types, or focus on a node with **1 hop**.

## Mouse and keyboard

| Action | Result |
|---|---|
| Click a node | Select it and open the inspector. Click it again to release it |
| Double-click a node | Search around it |
| Drag a node | Move it; its new position is kept |
| Drag the background | Pan |
| Scroll | Zoom |
| Click the background | Release the selection |
| Enter (in the search box) | Jump to the first result |
| Escape | Step back out: the path, then the selection, then the search |

## Note neighborhood panel

**Open note neighborhood panel** shows the graph around the note you are
reading, in a sidebar that follows the active note:

- **Extracted nodes**: entities from the current note, with entity type badges
- **Connected nodes**: what those entities connect to, grouped by entity type
- **Relationships**: the verb and detail of each connection
- Click a node to see its source notes and relationship details
