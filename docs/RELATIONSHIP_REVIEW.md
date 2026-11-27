# Relationship review and correction

Simple Graph Builder can revisit old relationships against the notes that
produced them. It checks a few sources at a time and saves its progress, so
the graph can improve across sessions.

## Enable background correction

1. Set up an extraction model in **Settings → Simple Graph Builder**.
2. Under **Analysis**, turn on **Automatically correct relationships**. This
   setting is off by default. Enabling it lets the configured model receive
   short excerpts from eligible source notes.

The plugin first checks for work shortly after the vault opens. It waits if
vault analysis is running and continues in later sessions or while the vault
stays open. Each batch checks up to six existing relationships through one
request, with a limit of 6,000 prompt characters and 768 output tokens. The
plugin saves the last request time before sending it, so reopening Obsidian or
a provider failure stays within the one-request-per-24-hours budget. A batch
with no eligible sources skips the model call.

Flagged sources get priority, and the plugin saves its place as it moves
through older relationships. It applies an automatic correction when the model
proposes a replacement or retraction and the cited passage matches the current
note and names both entities. The change applies to that note's contribution.
The plugin records the correction and reports the number of changes in an
Obsidian notice. It follows the same exclusions as note analysis. [Analysis exclusions](SETTINGS.md#analysis-exclusions)

## Review or correct a relationship yourself

1. Open the graph and select an entity.
2. Under **Relationships** in the inspector, choose **Review relationship** and
   select the source note you want to check.
3. Edit the verb, reverse the direction, or choose **Retract this source**. For
   help with the excerpt, choose **Check excerpt with model**. Use **Flag for
   next review** to prioritize that source in a later batch.

Run **Review graph relationships** from the command palette to preview a
batch of existing relationships. With automatic correction off, **Review
relationships after vault analysis** can open the same preview after a full
vault analysis finds new or changed notes. Use **Undo last relationship
correction** to reverse a manual or automatic change while the reviewed note
revision is still current.

## How evidence is stored and refreshed

Each edge can have contributions from multiple notes. For example, suppose
one note says Atlas evaluated Beacon and declined to adopt it. A review can
replace that note's contribution to `Atlas uses Beacon` with `Atlas evaluated
Beacon`. If another note documents a later adoption, its support for `uses`
stays attached to that edge.

After a successful full-note extraction, the plugin refreshes that note's
relationship evidence. Truncated analyses and MCP submissions add evidence
because they can cover only part of a note. Older graphs can gain more source
records as notes are analyzed or reviewed. Each correction applies to the
reviewed note revision, so rerunning extraction on the same text respects it.
The graph, review position and undo records live in the plugin's existing
`data.json`. [Data model](DATA_MODEL.md#relationships-free-form-verbs)

This recurring review follows the idea of revisiting original records to improve
derived knowledge over time. In Simple Graph Builder, the derived knowledge is
the graph and the original records are your Obsidian notes. [Anthropic on agent memory](https://www.anthropic.com/research/components-of-agent-memory), [LangChain Knowledge Factory](https://www.langchain.com/blog/knowledge-factory)
