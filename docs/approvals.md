# Approvals and updates

**Status: built** (unreleased), apart from what [What was built](#what-was-built) says. This is
the design for the second half of milestone 3: work that waits for a decision before going on,
and updates that need no answer. The first half was built before it: the session store,
`wheems session` and handovers, and onboarding by inviting the app to a channel.

The one rule it follows: **the person only ever deals with the chief of staff.** Sub-agents
(defined agents, project leads and ad-hoc sessions) never post to, ask or chat with the person.
They ask their chief, and the chief decides what to bring to the person. See
[team.md](team.md).

## The problem

Today nothing can wait for a decision:

- **A chief asks in words.** It says "shall I deploy?" in its answer, and the person replies in
  the thread. Nothing records that a decision is pending, nothing ties the reply to the question,
  and nothing stops an old "yes" being read as the answer to a newer question.
- **A sub-agent can only send its chief a message.** `wheems session send` delivers it, but the
  chief has no record of what's waiting on it, and no way to pass the question on to the person
  and route the answer back.
- **An engine's own prompt** (with `permissions: ask`) stops the session until someone answers it
  at the Mac. That's why chiefs usually run on `auto` ([config.md](config.md)).

Later milestones need "ask and wait" too:

- the broker asks before a risky action;
- workflows have `ask` steps;
- a purchase asks every time;
- linking a project's folder needs a yes from the person
  ([architecture.md](architecture.md#a-projects-folder-approved-once-never-at-the-mac)).

They should all use one mechanism, and this design builds it once.

## Two kinds of approval

| Kind                    | Who decides                                                     | Examples                                                                                                                   |
| ----------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **The chief's to make** | The chief, within the authority it's been given                 | A developer asks "merge the fix to the staging branch?"; a writer asks which draft to send                                 |
| **The person's only**   | The person, by a rule. The chief carries it but can't answer it | Deploying to production, spending money, linking a folder, anything a rule in `workspace.yaml` marks as needing the person |

A sub-agent asks with `wheems approval request`. It never chooses who decides:

- **A request goes to the asker's owner**, which is the chief that started it, or later the project
  lead that sent it the task.
- **The chief either answers it, or passes it to the person**, who sees it in the chief's voice,
  in the conversation the work came from.
- **Approvals that are the person's only** come from rules, not from the asker: the broker
  (milestone 9), purchases and folder links. The chief is told about one, and passes it on, but
  `wheems approval answer` refuses it. Nothing in milestone 3 creates one yet. Folder links in
  milestone 4 are the first.

## What the chief may decide

**Agreed on 17 November.** It follows the same line as the chief's work
([team.md](team.md#what-counts-as-work)): the chief decides what can be undone and stays inside
what the person asked for. The person decides five things:

| The person decides          | For example                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| **Money**                   | Any purchase, a paid plan, a subscription, or anything that adds to a bill                     |
| **Speaking for the person** | Sending an email or message to someone outside, publishing, replying to a customer or a review |
| **What can't be undone**    | Deploying to production, deleting data, force-pushing, closing or cancelling an account        |
| **Access**                  | Sharing anything outside, granting access, new credentials or integrations, linking a folder   |
| **Outside the ask**         | Anything the person didn't ask for and wouldn't expect, however small                          |

Everything else is the chief's. For example:

- merging a fix to a working branch;
- deploying to staging or a preview;
- choosing between drafts;
- creating an agent;
- starting or ending sessions;
- retrying a failed job.

How the line is drawn and kept:

- **Five categories, not a long list,** so the chief can apply them and the person can remember
  them.
- **In milestone 3, the chief applies them** from its instructions. From milestone 9, the broker
  maps each action to its category in code, so a production deploy is the person's whatever the
  chief thinks.
- **A workspace can move a category to the chief,** for example publishing on a blog where the
  person trusts it: `approvals: { chief_decides: [speaking] }` in `workspace.yaml`. It can also
  name single actions with rules. Only the person changes this. The chief can't widen its own
  authority.
- **The person sees every decision the chief made.** A short daily list ("Decisions I made since
  my last list: Approve on "Merge the checkout fix to staging?", for developer, …") goes to
  `updates`, or to the chat channel without one, each evening after six, local time. That way a bad call is noticed, and the person learns where to widen or
  narrow the chief's authority. It's also the record a later "shadow mode" for decisions can
  learn from.

## What the person sees

When the chief brings a decision to the person, it's a post **in the chat thread the work came
from**, where the person was already talking to the chief, with buttons:

> **Approval needed** · _Personal chief of staff_
>
> Deploy storefront to staging?
>
> The developer has the checkout fix on `fix/checkout-total`; tests pass. Staging only, not
> production.
>
> [Approve] [Decline]
>
> _Open until 18 Nov, 14:02. @Mike_

- **It mentions the person,** meaning the connection's `allowed_users`, so their phone buzzes.
- **It's always from the chief.** When a sub-agent asked, the post says which agent the chief is
  asking for, but the person never deals with the agent itself.
- **One tap answers it.** The post is changed in place to show who answered, what they chose and
  when, and its buttons go. The first answer counts. A later press changes nothing, and the post
  is redrawn as it stands.
- **Then the chief carries on in the same thread,** so the next thing the person sees is "Deploying
  now", where they were talking.
- **Work that came from no thread** (a routine, a workflow, or a session the chief started on its
  own initiative) posts to the workspace's `approvals` channel if there is one, otherwise to its
  chat channel as a new top-level post. Either way it's still from the chief.

## Asking and answering

| Command                                              | Who                                                       | What it does                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `wheems approval request "<question>" [--details …]` | Any agent                                                 | Asks its decider: a sub-agent's owner, or for the chief, the person. Returns at once with the approval's id |
| `wheems approval answer <id> <choice> [--reason …]`  | The chief, for requests made to it; the person            | Answers it. The chief can't answer an approval that's the person's only, or one it asked itself             |
| `wheems approval escalate <id> [--note …]`           | The chief                                                 | Passes a request from its team to the person, posted as above with the chief's note                         |
| `wheems approval list`, `show <id>`                  | The chief (what's waiting on it); the person (everything) | What's waiting, and the history                                                                             |
| `wheems approval withdraw <id>`                      | The agent that asked                                      | Takes a request back, for example when it's no longer needed                                                |

`answer`, `escalate` and `withdraw` are domain verbs, like `session end` (see [cli.md](cli.md)).
`request` replaces the `chat ask` planned in the CLI docs: the asker no longer picks a channel,
because who decides picks where it goes.

**Choices** default to Approve and Decline. `--choices "Staging,Production,Neither"` gives up to
four. The last choice is the no for a workflow's `ask` step.

**`--details`** (or `-` to read stdin) is shown under the question, cut to a few thousand
characters. The question itself is one line.

**`--expires`** defaults to 24 hours, with a maximum of a week. When it runs out, the asker is
told it expired with no answer, and any post says so. Silence never counts as a yes.

**The answer comes back as a message from Wheems**, through the same durable hand-back that session
answers use (`passBack` in `src/service/sessions.ts`):

```
Wheems: approval a1b2 answered: Approve (by the person, 14:05). Your question was: Deploy storefront to staging?
```

When the chief escalated a sub-agent's request, the chief is told the answer too, so it stays in
charge of the work. `--wait` waits for the answer and prints it, for up to ten minutes. After that
it comes back as without `--wait`, as `wheems session send --wait` does, because an engine's tool
call can't wait for hours.

**Limits.** An agent may have at most five requests waiting at once, so a confused agent can't
flood its chief or the person.

**The person answers** from the buttons in Slack (only the connection's `allowed_users` count),
from the web app's Review page (web app stage 2), or with `wheems approval answer` at a terminal.
A channel without buttons says how to answer in words, and a reply `approve a1b2` counts. That's
for Telegram and email later.

Recording an answer is one update in the store, from waiting to answered, so two answers at once
can't both count.

## Updates: `wheems chat post`

```sh
wheems chat post updates "Nightly backup finished: 3 sites, 1.2 GB."
```

Only a chief posts. A one-way post to a named channel suits results that belong in no thread, such
as a routine's morning brief. A sub-agent's results go back to its chief, which decides what the
person needs to hear. Without an `updates` channel, posts go to the chat channel.

## Kept in the store

Approvals live in the session store, `.wheems/state.sqlite`, in a new `approvals` table, moving
it to schema version 7. Each one keeps:

- **Who's involved:** its id, the workspace, and the agent and session that asked. Later, its
  project and task too.
- **Who decides,** the chief or the person, and whether it's the person's only.
- **What it's for:** `request` now, and later `action`, `purchase`, `folder` or `workflow`. It
  also keeps a fingerprint of exactly what was approved. That's the question and details, or the
  broker's action and arguments, or a purchase's quote.
- **The question, details and choices,** never changed once asked.
- **Where it was posted,** if it was: the connection, channel, thread and message.
- **What happened:**
  - its state: `waiting`, `escalated`, `answered`, `expired` or `withdrawn`;
  - the answer and any reason;
  - who answered (the chief or the person) and how (Slack, the web app or a terminal);
  - when it was asked, escalated, answered and delivered, and when it expires.

**Ids** are six hex digits, such as `a1b2c3`, short enough to type in a reply.

**After a restart** nothing is lost. The buttons carry only the approval's id and the choice, and
everything else is read from the store. Requests still waiting can still be answered. Any that
expired while the service was down are expired when it starts. Answers that hadn't reached their
agent are delivered again.

**Ending a session** withdraws the requests it has waiting. An answer that arrives after its asker
ended goes to the asker's owner instead.

## What it does and doesn't enforce

In milestone 3 an approval is **a promise the agents keep**. Nothing yet stops an agent that acts
without asking, or one that ignores a no. The caller check on the control socket is convenience,
not proof: an agent running as the same user could claim to be its chief, or the person.

The design keeps the record ready for real enforcement:

- **The broker (milestone 9)** asks through this same store before acting, with the fingerprint
  set to the exact action. The agent never holds the credential, so the approval is the gate.
- **Task credentials (milestone 5)** make "who's calling" proof, so "the chief can't answer the
  person's approvals" is checked rather than trusted.

The docs and the built-in instructions say this plainly
([architecture.md](architecture.md#guardrails-that-work-with-any-engine)).

## What was built

1. **The store and the service.** The `approvals` table (schema 7), and `src/service/approvals.ts`:
   asking, answering, escalating and withdrawing, expiry checked each minute and at start, and
   delivery as a hand-back (`notify` in `src/service/sessions.ts`), so a restart delivers again
   what hadn't arrived. Posts for the person go through `src/service/poster.ts`, which also
   serves `chat post`.
2. **The CLI.** The `approval` area, `chat post`, the chief's **Decisions** section and the
   worker's rule, always loaded, and the `wheems-approvals` skill, worded for each
   ([instructions.md](instructions.md)).
3. **The Slack driver's buttons.** An `actions` block under the post, a mention of the person,
   presses from `interactive` envelopes, and `chat.update` to change the post
   ([drivers.md](drivers.md)). Wheems's manifest has always turned Interactivity on; an app set
   up by hand needs it switched on, which the first approval tests.
4. **Changing a post.** The channel contract's optional `update(message, change)`; drivers
   without it get a reply under the post.
5. **The web app, stage 2.** Review shows what's waiting, answered with a button, and the
   history ([web-app.md](web-app.md)).
6. **Sub-agents stuck at a prompt.** Not as designed. A sub-agent's session that Herdr says is
   `blocked` was already stopped by Wheems, to keep its answers in order, and its owner told; the
   hand-back now says it was a question from its engine, such as a permission, and that what only
   the person can allow is theirs to decide. Keeping it blocked with an `hc attach` line for the
   person would hold the session's messages for as long as nobody answers.

Answering in words (`approve a1b2c3`) works on every channel, not only those without buttons:
a reply from the person in that form is taken as the answer, and not passed to the chief.

Milestone 3's test is still to come: a developer agent asks before merging, the chief brings it
to the person's phone, one tap answers it, and the work carries on.

## Open questions

1. **Engine prompts from the phone.** Answering an engine's own permission prompt remotely would
   let agents run on `ask`, but it means typing into each engine's screen through Herdr, which is
   easy to get wrong. The suggestion is to leave it until after the broker, through which most
   risky actions will go.
2. **The broker in milestone 3.** The roadmap lists "the first version of the broker" here. This
   design builds the approvals it will use, but no actions. The suggestion is to design the broker
   on its own before milestone 9, and count milestone 3 done without it.
