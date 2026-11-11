# Milestone 2 plan: the knowledge loop

**Done when** a day's work reaches the knowledge base without anyone doing anything, and the
chief of staff finds it by meaning in a new conversation the next day.

Built from [the research](../research/knowledge-loop.md) and these decisions:

- Embeddings and the vector store are drivers, local by default.
- Skills agents propose wait for approval, given in the terminal until milestone 3.
- One "about you" page is read by every workspace and changed only with approval.

## What a workspace gets

```
workspaces/personal/
  knowledge/
    brief.md        # short, capped; every agent loads it at launch
    inbox/          # notes land here, one file per note
    notes/2026/11/  # filed notes, kept as the sources
    pages/          # knowledge-base pages, one topic each
    reports/        # nightly: contradictions and stale pages
```

`about-you.md` sits at the top of the install, beside `install.yaml`. Every agent in every
workspace loads it. It is the one thing shared across workspaces.

The knowledge base is part of the install's git folder, so every version of every page is kept.
The search index is running state in `.opinr/index/`, never committed, and can always be rebuilt.

## How it works

1. **Notes.** An agent writes a note with `opinr note`, which reads Markdown on stdin. Opinr
   adds the details agents can't be trusted with (workspace, agent, conversation, time) and
   saves it to the workspace's inbox. Agents never write into `knowledge/` directly.
2. **When notes are written.** The service asks for a note as an extra turn:
   - when a conversation has been quiet for 30 minutes after new work (configurable);
   - before it stops an idle session to make room.

   This works with every engine. The answer to that extra turn is never posted to Slack.
   Agents may also write a note whenever something is worth keeping.

3. **Filing.** When a note lands, the service runs the **filer**, a built-in agent you never talk
   to. It runs in Herdr like any other, so you can watch it. It reads the note, searches the
   knowledge base, updates or creates pages, and keeps `brief.md` under its cap. Then Opinr
   checks its work in code before committing:
   - every page lists the notes it came from;
   - a page that loses more than a quarter of its content is put back;
   - the brief stays under its cap;
   - nothing outside `knowledge/` changed.

   The filed note moves to `notes/`, and the change is committed with the note as its source.
   The filer uses a cheaper model by default (Claude Sonnet on Claude Code), set in
   `workspace.yaml`.

4. **Search.**
   - Keyword search always works: SQLite's full-text search, built into Node.
   - With an embeddings driver set up, it also searches by meaning, and the two are combined.
   - Notes from automated jobs rank below people's own work.
   - `opinr kb search "…"` searches the agent's own workspace.
   - `opinr kb reindex` rebuilds the index into a new file and swaps it in. The index rebuilds
     itself when the embedding model changes.
5. **Built-in instructions and skills.**
   - Every agent's instructions file gets the brief, `about-you.md`, and short built-in
     sections: search the knowledge base before answering about past work, write notes, and
     propose skills.
   - Longer guidance ships as built-in skills where the engine supports them.
6. **Skill proposals.**
   - `opinr skill propose <name>` saves a proposed skill to the install's library, marked as
     waiting.
   - The proposing guidance carries the lessons from the research: improve an existing skill
     before making a new one, read before changing, write lessons not logs, and never record
     one-off failures.
   - A near-duplicate check runs against existing skills when a proposal is made, and the
     result is shown with it.
   - Skills people wrote are never changed by an agent.
7. **Review.**
   - `opinr review` lists what's waiting: skill proposals and suggested changes to
     `about-you.md`. For each it shows the content or a diff, and you approve, edit or turn it
     down.
   - An approved skill goes into the library, pinned in that workspace's `skills.yaml`.
   - The filer suggests changes to `about-you.md`; it never edits it.
8. **Nightly tidy.**
   - A built-in schedule runs the filer once a night. It writes
     `reports/contradictions.md` and `reports/stale.md` and refreshes the brief.
   - It becomes an ordinary workflow in milestone 6.

## New contracts and drivers

| Driver type  | Contract                                                         | Ships now                                                                                                                                 |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Embeddings   | `embed(texts)` → vectors, with its `model` and `dimensions`      | **Ollama** (`nomic-embed-text`, local and free). With none set up, search is keyword-only                                                 |
| Vector store | `upsert`, `remove`, `nearest(vector, k)`, `clear`, per workspace | **SQLite**: vectors kept beside the full-text index and compared in code, fast enough for thousands of pages. pgvector and Pinecone later |

Both get contract suites in `@opinr/hq/testing`, plus in-memory reference drivers, as
the existing driver types have. `opinr setup` gains a **Knowledge** section, which offers to pull
the Ollama model. `opinr doctor` checks the index and the embeddings driver.

## Pull requests

Each one is reviewed by Vasquez and merged by Mike before the next starts.

1. **Notes**
   - `opinr note`, the inbox and the knowledge folder layout.
   - The note turn when a conversation goes quiet or before a session stops, with its answer
     never posted.
   - `about-you.md`, and the brief loaded at launch.
   - `opinr init` creates the knowledge folder.
2. **Filing**
   - A small runner that gives an agent a task and waits for its answer, outside any chat.
     Workflows reuse it in milestone 6.
   - The filer, the checks on its work, and git commits.
3. **Search**
   - The embeddings and vector store contracts, the Ollama and SQLite drivers, and the index.
   - `kb search` and `kb reindex`, the setup section, and the doctor checks.
4. **Skills and review**
   - The library folder, `skill propose` with its near-duplicate check, `opinr review`, and
     pinning in `skills.yaml`.
   - The nightly tidy.

Then the live test: a day of real use, then the next morning a new thread asking about it.

## Left for later

- **Usage counts and archiving unused skills.** These come in milestone 4, with the skill
  library's scoping.
- **A reviewer from a different provider checking skill proposals.** This comes in milestone 5,
  with agent templates.
- **Notes before Claude Code compresses a long conversation.** Its `PreCompact` hook can't give
  the agent a turn. The 30-minute quiet note covers most cases. Revisit if long threads lose
  things.
- **Searching raw session transcripts.** Only notes and pages are searched, as Opinr's design
  says.

## Risks

- **Codex and skills.** Codex reads skills from its own folders, and that is still untested. The
  built-in guidance also goes into every agent's instructions file, so it works whatever skills
  support an engine has.
- **Node's SQLite** prints an "experimental" warning. Opinr hides that warning, and the minimum
  Node version rises to 22.13, the first version where it works without a flag.
- **Subscription usage.** Each note and filing run uses your Claude subscription. That's why the
  filer defaults to Sonnet and runs once per note, with no reviewer firing every few turns.
