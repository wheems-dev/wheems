# Research: how other agent tools remember and learn

Before designing milestone 2, we looked at how two open-source personal agents handle memory,
search and skills they write themselves: [OpenClaw](https://github.com/openclaw/openclaw) and
Nous Research's [Hermes Agent](https://github.com/NousResearch/hermes-agent). Checked in
November 2026 against their current docs and source. Both change quickly, so treat details as a
snapshot.

## What they do

|                      | OpenClaw                                                                                                                      | Hermes Agent                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Always-loaded memory | `MEMORY.md` (curated facts) and `USER.md` (preferences), loaded at session start                                              | `MEMORY.md` (2,200 characters) and `USER.md` (1,375), hard caps, frozen per session so the prompt cache holds             |
| Day-to-day memory    | `memory/YYYY-MM-DD.md` daily notes, searched but not loaded                                                                   | Every session kept in SQLite and searched                                                                                 |
| When it's written    | By the agent as it works, and by a silent "memory flush" turn before the conversation is compacted                            | By the agent with a memory tool, and by a background reviewer every 10 turns                                              |
| Tidying up           | "Dreaming": a nightly job that promotes a fact to `MEMORY.md` only after it has been recalled enough, from enough queries     | Nothing automatic. A full file refuses new writes until the agent makes room                                              |
| Guards               | A rewrite that drops more than 25% of entries is refused; every entry has a source and an importance score; old versions kept | Entries scanned for prompt injection; exact duplicates refused                                                            |
| Search               | Hybrid: keyword (SQLite FTS5, BM25) plus vectors, with recency and diversity. Keyword-only when no embedder is set up         | Keyword only (FTS5) built in. Vectors come from one external provider plugin (Mem0, Honcho and others)                    |
| Embeddings           | Pluggable: OpenAI by default when a key is set, many hosted providers, local models through a plugin                          | None built in                                                                                                             |
| Reindexing           | On file change; a full rebuild goes to a new database and is swapped in; changing the model forces a rebuild                  | Not needed for keyword search                                                                                             |
| Self-written skills  | Written mid-turn, by a background review, or on `/learn`. **Applied with no approval by default**, with undo                  | Written by the agent or the background reviewer. **No approval by default**; `write_approval: true` holds them for review |
| Unused skills        | Archived after 30 days                                                                                                        | A curator marks them stale after 14 days and archives them after 30, never deletes; merging overlapping skills is opt-in  |
| Separation           | One folder, index and skill list per agent, but cross-agent access and the shared wiki are on by default                      | One home folder per profile with its own memory, skills and sessions. The user model can be shared across profiles        |

OpenClaw also has an optional `memory-wiki` plugin that compiles notes into wiki pages where
each claim has a status, a confidence and its evidence. It also generates pages listing
contradictions, stale pages and low-confidence claims.

## What went wrong for them

- **Skill sprawl.** One OpenClaw user had 95 active and 47 archived learned skills, with
  duplicates under different names
  ([#197211](https://github.com/openclaw/openclaw/issues/197211)). A Hermes user had 152, with
  22 unused near-duplicates the curator missed
  ([#67582](https://github.com/NousResearch/hermes-agent/issues/67582)). Neither checks for
  near-duplicates when a skill is created.
- **The agent judges itself.** Hermes's reviewer rewrote skills people had written by hand
  ([#70128](https://github.com/NousResearch/hermes-agent/issues/70128)), learned to avoid tools
  after one failure ([#6051](https://github.com/NousResearch/hermes-agent/issues/6051)), and
  is "author, user and judge" of its own skills
  ([#25833](https://github.com/NousResearch/hermes-agent/issues/25833)).
- **Memory filling up.** Hermes drops new writes silently when memory is full
  ([#79472](https://github.com/NousResearch/hermes-agent/issues/79472)), and one model wiped
  `USER.md` believing it was full
  ([#76035](https://github.com/NousResearch/hermes-agent/issues/76035)). OpenClaw users
  complain that `MEMORY.md` grows until it crowds the prompt.
- **Agents don't search unless told.** A common OpenClaw complaint (from blogs, unverified).
- **Cost.** Background reviews run a model call often
  ([#194300](https://github.com/openclaw/openclaw/issues/194300)).
- **Noise.** Hermes ranks scheduled sessions lower because their repeated words crowded out the
  user's own sessions in search.

Hermes's reviewer prompt now carries rules learned from these failures:

- patch an existing skill before creating one;
- read a skill before changing it;
- write lessons, not logs;
- never record environment failures or "tool X is broken".

## What Wheems takes from this

Wheems's design already differs in three ways. Notes go to an inbox and a filing job writes the
knowledge base, so sessions never edit it directly. Skills an agent proposes wait for approval.
Workspaces are separated by default. Both projects' issues support those choices. What to add:

1. **Capture before context is lost, not only at the end.** Sessions that time out, or that get
   compacted mid-way, lose what a session-end note would have said. Wheems already stops idle
   sessions, so the service asks for the note as a last turn before stopping one. This works
   with every engine. Where the engine has hooks (Claude Code's `PreCompact`), it also asks before
   compaction.
2. **Two layers.** A small, capped workspace brief that every agent loads (Hermes's caps and
   frozen snapshot), plus the full knowledge base, searched when needed. The filing job keeps
   the brief under its cap, so it never silently refuses or loses facts.
3. **Guards on the filing job.**
   - Every claim links to the note it came from.
   - A rewrite that drops much of a page is refused.
   - The knowledge base is a git folder, so every version is kept for free.
   - A nightly tidy lists contradictions and stale pages (OpenClaw's wiki plugin).
4. **Hybrid search that works with nothing set up.** Keyword search (SQLite FTS5) always; vectors
   added when an embeddings driver is configured, local by default. Rebuild into a new index
   and swap it in, rebuild when the embedding model changes, and rank automated sources (filing
   job, scheduled workflows) below people's own work.
5. **Make search the habit.** The built-in knowledge skill tells agents to search before
   answering, and the chief of staff is briefed from the workspace brief at the start.
6. **Skill proposals with the lessons built in.**
   - The proposing skill says to patch before creating, read before writing, write lessons not
     logs, and never record one-off failures.
   - A near-duplicate check runs before a proposal reaches you.
   - Skills people wrote are never changed by an agent.
   - Usage is counted, and unused agent-written skills are archived.
   - A reviewer from a different provider can check a proposal before you see it.
7. **Keep it cheap.** The filing job runs when a note lands and a tidy runs nightly. There is no
   reviewer firing every few turns.

## Open questions

- **A shared profile of you.** Hermes shares the user model across profiles. Wheems could keep an
  install-level "about you" page that each workspace reads but none writes, changed only with
  your approval. It's useful (your preferences once, not per workspace) but is the one thing
  that crosses workspaces.
- **Approving skill proposals before milestone 3.** Approvals with buttons arrive in milestone 3.
  Until then, proposals wait for `wheems skills review` in the terminal.
