# Test order — 0.6.0 (vault write-back)

Run this before tagging a release. It is written to be followed top to bottom by
a person or an agent, on desktop or on iOS, and every step says what counts as a
pass.

**Why this release needs it.** 0.6.0 is the first version that writes into your
notes, and the first that rewrites `data.json` on load. Both are hard to undo by
hand, so they get tested on a throwaway vault first.

Parts 1 and 2 need **no API key and cost nothing** — the migration runs on load,
and writing links makes no model calls. Only Part 3 spends money.

---

## Rules

1. **Never run this on your only copy of a vault.** Use the generated test vault,
   or a duplicate of a real one.
2. **If a step fails, stop.** Do not continue writing to the vault. Record what
   happened (see *Reporting* at the end) — later steps write more files and make
   the failure harder to read.
3. **Do not push a git tag until this document is finished.** Every tag triggers
   the release workflow, and the release is what Community Plugins offers to all
   existing users. Pushing a branch is safe; pushing a tag ships.

---

## Setup

### The test vault

On a desktop with node, from a clone of this branch:

```bash
npm run build                              # produces main.js
node scripts/make-test-vault.mjs ~/sgb-test-vault
cp main.js manifest.json styles.css ~/sgb-test-vault/.obsidian/plugins/simple-graph-builder/
```

That vault is built to fail loudly: it carries a pre-0.6 graph (641 nodes,
3,167 edges, ~1.4 MB), whole-file hashes from the old scheme, a Korean folder
using both Unicode spellings, a file already sitting where the plugin wants to
put one, and a note with a hand-written `related:` property.

To test on real data instead, duplicate a real vault and use that. Skip the
numeric expectations below and compare against what that vault showed before.

### Getting it onto iOS

Obsidian mobile runs this plugin (`isDesktopOnly: false`). Pick one:

- **Obsidian Sync** — put the vault on a synced desktop, let it sync, open on the
  phone. Simplest if you already have Sync.
- **Files app** — copy the vault folder to *On My iPhone → Obsidian*. The
  `.obsidian` folder is visible in Files on iOS, so you can drop `main.js`,
  `manifest.json` and `styles.css` straight into
  `.obsidian/plugins/simple-graph-builder/`.
- **BRAT** — needs a published pre-release. The workflow tags any version
  containing a hyphen (`0.6.0-beta.1`) as a GitHub pre-release, which BRAT
  installs and the Community Plugins updater ignores. Use this only if the file
  copy is impractical, since it does publish something public.

After copying, open the vault and enable **Simple Graph Builder** in
*Settings → Community plugins*. If it was already enabled, toggle it off and on
so the new build loads.

---

## Part 1 — migration (no API key)

### T1. It loads

- **Do:** open the test vault and enable the plugin.
- **Expect:** no error notice; the status bar shows `Graph: … nodes, … edges`.
- **Fail if:** Obsidian reports the plugin failed to load, or the status bar
  stays empty.

### T2. `data.json` gets smaller

- **Do:** wait ~5 seconds after the vault opens, then check the size of
  `.obsidian/plugins/simple-graph-builder/data.json`.
- **Expect:** roughly **1.4 MB → ~490 KB** (about −65%). On a real vault expect
  somewhere between −30% and −65%, depending on how many entities each note has.
- **Fail if:** the file grew, or is unchanged after a minute.

### T3. The graph is still all there

- **Do:** read the status bar. Open the graph view (ribbon icon → *Open graph
  view*).
- **Expect:** **641 nodes, 3,167 edges** — the same totals the old file held, now
  rebuilt in memory. Notes appear as grey rounded nodes linked to their entities.
- **Fail if:** the counts are near 521/513. That means the note layer was dropped
  but never rebuilt, which is the failure this whole design hinges on.

### T4. A legacy `note:` entity kept its relationships

Old data could store an ordinary entity under an id starting with `note:`,
because the model labelled it "Note". Those must not be mistaken for note-layer
data and deleted.

- **Do:** run *Search related notes* and search `Attention Is All You Need`.
- **Expect:** the entity exists and has an `introduces` relationship to
  *Machine Learning*.
- **Fail if:** it has no relationships, or is missing.

### T5. Analyzed notes are not re-analyzed

The old hashes covered the whole file; 0.6.0 hashes the body. An upgrade must not
make every note look changed.

- **Do:** open `research/note 001.md`, run *Analyze current note*.
- **Expect:** the notice **"Note has not changed since last analysis"**, straight
  away, with no network activity.
- **Fail if:** it starts analyzing. That is a paid call per note across the vault.

---

## Part 2 — write-back (no API key)

### T6. Turn it on

- **Do:** *Settings → Simple Graph Builder → Vault write-back*. Enable
  **Create entity notes**, then **Link notes to their entities**. Leave the
  folder as `Entities` and the property as `related`.
- **Expect:** the extra settings and the two buttons appear as each toggle goes on.

### T7. Write links for the whole vault

- **Do:** press **Write links**, confirm.
- **Expect:** a progress notice that moves, then a summary like
  `Entity notes: 521, notes updated: 120`. On iOS this takes a while — it is
  writing ~520 files. The UI must stay responsive and **Cancel** must work if you
  press it (if you cancel, press *Write links* again to finish before continuing).
- **Fail if:** Obsidian freezes with no repaint, or Cancel does nothing.

### T8. Entity notes look right

- **Do:** open `Entities/Machine Learning (CONCEPT).md`.
- **Expect:** frontmatter with `aliases: [ML, 머신러닝, 기계학습]`,
  `entity-type: CONCEPT`, and an `sgb-id`; below it a description and a
  `## Relationships` list of links, wrapped in `%% sgb:managed:start %%` /
  `%% sgb:managed:end %%`.
- **Note:** the `(CONCEPT)` suffix is correct here — see T11.

### T9. Aliases resolve in Obsidian itself

This is the point of the whole feature.

- **Do:** in any note, type `[[ML` and look at the autocomplete. Then try
  `[[머신러닝` and `[[기계학습`.
- **Expect:** all three offer the same *Machine Learning* entity note.
- **Fail if:** they offer nothing, or three different notes.

### T10. The dual graph

- **Do:** open Obsidian's **own** graph view (not the plugin's).
- **Expect:** notes connected to entity notes, and entity notes connected to each
  other through the Relationships lists. That structure did not exist before this
  release.

### T11. A file the plugin did not create is untouched

- **Do:** open `Entities/Machine Learning.md` — a file that existed before the
  plugin ran.
- **Expect:** exactly the text that was there ("I wrote this by hand…"), no
  frontmatter added. The plugin's own note is the `(CONCEPT)` one from T8.
- **Fail if:** it gained `sgb-id` or lost its text. **Stop immediately** — that is
  data loss.

### T12. A hand-written `related:` survives

- **Do:** open `notes/my-related.md`.
- **Expect:** both entries — `[[research/note 001]]` and `[[My Reading List]]` —
  still there, unchanged.
- **Fail if:** either is gone.

### T13. Running again changes nothing

- **Do:** press **Write links** again.
- **Expect:** it finishes quickly and reports **`Entity notes: 0, notes updated: 0`**
  — every writer compares against the current state and skips.
- **Fail if:** the counts match the first run. That means files are rewritten
  every time, which on a synced vault is endless traffic and, with *Analyze on
  save*, a re-analysis loop waiting to happen.

### T14. Hashes stayed valid through the writes

- **Do:** open `research/note 001.md` (it now has a `related:` property) and run
  *Analyze current note*.
- **Expect:** **"Note has not changed since last analysis"** again.
- **Fail if:** it analyzes. The plugin's own write is being read as a user edit —
  the exact loop this release is built to avoid.

### T15. User text in an entity note survives regeneration

Editing an entity note is not hypothetical — the whole point of them being real
notes is that people will write in them.

- **Do:** open `Entities/딥러닝.md`. Add a `## My notes` section with a sentence
  at the **bottom**, below `%% sgb:managed:end %%`. Then delete the text
  *between* the two markers, leaving the markers themselves. Press **Write links**.
- **Expect:** the managed text is restored, and your `## My notes` section is
  still there, untouched.
- **Fail if:** your section is gone. **Stop immediately** — that is data loss.

### T15b. A damaged marker does not eat the note

The markers are `%%` comments, invisible in reading view, so deleting one by
accident while editing around it is ordinary.

- **Do:** in `Entities/임베딩.md`, delete just the `%% sgb:managed:end %%` line,
  and add a `## Mine` section with a sentence at the bottom. Press **Write links**.
- **Expect:** your `## Mine` section survives, and the note ends up with exactly
  one start marker and one end marker.
- **Fail if:** everything below the surviving marker disappeared. **Stop.**

### T16. Removing links removes only ours

- **Do:** run *Remove graph links from notes* from the command palette, confirm.
- **Expect:** `related:` gone from the 120 generated notes; `notes/my-related.md`
  **keeps both of its hand-written entries**; the `Entities/` folder is left alone;
  no note body changed.
- **Fail if:** `my-related.md` lost anything.

### T17. Entity notes are never analyzed

- **Do:** open any file in `Entities/` and run *Analyze current note*. Then turn
  **Create entity notes** off in settings and try again.
- **Expect:** "This is a plugin-managed entity note" both times — the second time
  proves it is recognized by its `sgb-id`, not just by its folder.
- **Fail if:** it starts analyzing after the toggle is off. That would feed the
  graph its own output, at API cost.

---

## Part 3 — with an API key (spends money)

Run these on the test vault with a cheap model.

### T18. A new note end to end

- **Do:** turn **Create entity notes** back on. Create a note with a few
  paragraphs of real prose, run *Analyze current note*.
- **Expect:** entities extracted; a `related:` property appears listing them; new
  entity notes appear in `Entities/`; nothing in your prose changed.

### T19. No analyze loop

- **Do:** turn on **Analyze on save** (*Analysis* section). Edit the note from
  T18, wait 10 seconds.
- **Expect:** exactly **one** auto-analysis notice. The `related:` property the
  plugin then writes must not trigger a second one.
- **Fail if:** notices keep appearing. Turn the setting off and stop.

### T20. Frontmatter is not extracted

- **Do:** open `notes/tagged.md` (tags only, one-word body) and analyze it.
- **Expect:** "Note is too short to analyze" — the tags and aliases in its
  frontmatter must not count as content, and must not become entities.

---

## Part 4 — rehearsal on real data

Before tagging, run **Part 1 only** against a *duplicate* of your real vault.
That is the one test the generated vault cannot stand in for: real Korean text,
real note counts, a real `data.json`. Record the before/after size.

---

## Results

| # | Test | Pass | Notes |
|---|------|------|-------|
| T1 | Loads | ☐ | |
| T2 | data.json shrinks | ☐ | before ___ → after ___ |
| T3 | Graph intact (641 / 3,167) | ☐ | saw ___ / ___ |
| T4 | Legacy `note:` entity kept edges | ☐ | |
| T5 | No re-analysis after upgrade | ☐ | |
| T6 | Settings appear | ☐ | |
| T7 | Vault write completes, cancel works | ☐ | took ___ |
| T8 | Entity note contents correct | ☐ | |
| T9 | Aliases resolve in Obsidian | ☐ | |
| T10 | Native graph shows structure | ☐ | |
| T11 | Pre-existing file untouched | ☐ | |
| T12 | Hand-written `related:` survives | ☐ | |
| T13 | Second run changes nothing | ☐ | |
| T14 | Hashes valid after writes | ☐ | |
| T15 | User text in entity note survives | ☐ | |
| T15b | Damaged marker does not eat text | ☐ | |
| T16 | Removal takes only our links | ☐ | |
| T17 | Entity notes never analyzed | ☐ | |
| T18 | New note end to end | ☐ | |
| T19 | No analyze loop | ☐ | |
| T20 | Frontmatter not extracted | ☐ | |
| P4 | Real-vault migration rehearsal | ☐ | before ___ → after ___ |

### Reporting a failure

Give the step number, what you expected, what happened, and:

- **Desktop:** the developer console (`Ctrl/Cmd+Shift+I` → Console) — errors are
  logged with a `Simple Graph Builder:` prefix.
- **iOS:** the exact notice text, plus the affected file's contents.
- Either: whether `data.json` grew, shrank, or stayed the same.

Keep the broken vault. It is the reproduction.

---

## Then, and only then

```bash
git checkout master
git merge --ff-only feat/vault-writeback
git push origin master          # ships nothing on its own
git tag 0.6.0
git push origin 0.6.0           # this is the release
```

CI builds, runs the test suite, and publishes `main.js`, `manifest.json` and
`styles.css`. `versions.json` already carries the `0.6.0 → 1.7.2` entry.
