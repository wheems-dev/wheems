# Session handover

**Status: proposal, not built.** This explores what happens to a chat thread that's already open
when its chief changes: a new engine, model, account or permissions. It's the open question that
keeps those four settings read-only in the web app ([web-app.md](web-app.md#settings)).

## The problem

A chat thread is one conversation with one engine session, resumed by the engine itself:
`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`. At most four run at once.
An idle one is asked for its note and stopped, and the thread's next message resumes it. Every
launch reads the chief's agent file afresh.

That gives three gaps when the chief's settings change:

1. **A session still running keeps its old settings.** `wheems restart` restarts Wheems, not the
   sessions in Herdr. Tightening permissions from `skip` to `ask` doesn't reach an open thread
   until its session happens to be stopped and resumed.
2. **An engine change breaks the thread.** The session id belongs to the old engine. The new one
   can't resume it, and while the old session runs, messages go to it but answers are read through
   the new engine.
3. **The only way to start a thread over is a new thread.** That's also the fix for a session
   whose context is long, stale or confused.

## The choice, per conversation

When a change reaches open conversations, each gets one of three:

| Choice          | What happens                                                                                     | Memory                      | Offered when                                        |
| --------------- | ------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------- |
| **Carry on**    | Its session stops now. The next message resumes the same engine session with the new settings.   | Kept in full, by the engine | Same engine (model, account or permissions changed) |
| **Hand over**   | The old chief writes a handover. A new session on the new settings starts from it.               | A summary                   | Always; the default when the engine changes         |
| **Start fresh** | Its session stops and forgets. The next message starts a new session with only the thread's ask. | None                        | Always                                              |

**Carry on** costs nothing new: Wheems already stops idle sessions and resumes them, so this
just does it now. It closes gap 1 without losing anything, so it's the default for a change of
model, account or permissions.

## Handing over

### The handover note

A handover is written as a turn of its own, the way a note turn is now: its answer never reaches
the thread, and no message can slip in between. The chief is asked for:

- what the person asked, in their words;
- what's done, with links, files and commits;
- what's in progress and what's next;
- decisions made, and why;
- open questions, and anything it promised the person;
- what the next chief should know that isn't written down anywhere else.

It answers with a new command, `wheems session handover`, which saves the note to the session
store. Saving it there, rather than in the engine's history, means it outlives the old engine.

**When the old chief can't write one**, because it times out or its engine is gone, Wheems
assembles a handover from what it already keeps: the thread's ask, the conversation's latest
knowledge note, and its latest chat turns (kept since 0.1.6). Such a note is marked as written by
Wheems, so the new chief knows it's thinner.

### The new chief

The new session starts on the new settings. Its first message is the handover, marked as such,
followed by the person's next message when there is one. Its instructions say to treat the
handover as context, check anything that matters before acting on it, and continue the thread.

### When it runs

Handovers are written **before the restart**. The running service still has the old chief loaded,
so it can ask the old sessions for theirs:

1. **Save** writes the new settings to the files.
2. The page lists the open conversations with a choice for each. The defaults depend on the change.
3. **Apply and restart:**
   - every **Hand over** conversation gets its handover turn, using the old settings;
   - a conversation whose session was already stopped is resumed briefly on the old settings to
     write its handover;
   - every **Carry on** or **Start fresh** session is stopped;
   - then the service restarts.
4. Each new session starts at that thread's next message, not straight away. A thread nobody
   comes back to costs nothing more.

A conversation that's mid-turn waits for the turn to end, as a note turn does. The page shows
each one's progress: writing handover, handed over, stopped.

### What the person sees

- **In the thread,** one line from Wheems, once the new chief takes over: "Your chief of staff now
  runs on Codex (gpt-6). It has a handover of this conversation so far." After **Start fresh**:
  "This conversation starts afresh: the chief doesn't remember it." Without that line, a change in
  what the chief remembers would be a surprise.
- **On the Sessions page,** the old and new sessions are linked ("Took over from …", "Handed over
  to …"), with the handover readable on both. The original ask carries on, as it does for every
  session.

## Beyond settings changes

The same three choices work as actions on a single conversation, on the Sessions page and later in
chat:

- **Hand over** to a fresh session of the same chief, when its context has grown long or confused.
- **Start fresh**, without opening a new thread.

The handover note is also the natural seed for moving a thread to a different agent later.

## What it needs

- **A handover turn.** It's built on the note turn's machinery: the queue, keeping its answer out of
  the thread, and stopping a session that doesn't finish.
- **`wheems session handover`.** A command an agent runs to save its handover, like
  `wheems knowledgebase note`.
- **Migration 5.**
  - A `handovers` table: id, workspace, session, text, written by (agent or Wheems), from and to
    engine and model, written at, and used at.
  - On the conversation: a pending handover, and whether it starts fresh.
- **The launch path.** It takes a pending handover as the first message, starts a new engine
  session rather than resuming the old one, and posts the line to the thread.
- **The web app.** The choice table after a save that changes the chief, an apply step with
  progress, per-session **Hand over** and **Start fresh**, and the linked sessions.
- **Tests.**
  - Handover turns, including timeouts and the assembled fallback.
  - Each choice on the same engine and on a changed engine.
  - A conversation mid-turn.
  - A restart in the middle of applying.

## Open questions

1. **Announce in the thread?** Proposed: yes, one line, as above.
2. **When does the new chief start?** Proposed: at the thread's next message, not straight away.
3. **Defaults.** Proposed: **Carry on** when only the model, account or permissions change;
   **Hand over** when the engine changes. Or should every change default to **Hand over**?
4. **How many at once?** A workspace with many open threads would write many handovers at once.
   Proposed: hand over the ones active in the last week; older ones start fresh, unless chosen
   otherwise.
5. **Does the handover also go to the knowledge base?** It overlaps with the note a session
   writes. Proposed: no. A handover is for the next chief, a note is for the knowledge base, and
   the handover turn can skip the note when one was written recently.
