# Approvals and updates

**Status: proposal, not built.** This is the design for the second half of milestone 3: an agent
asks the person something and waits for a tap on their phone before acting, and an agent posts
an update that needs no answer. The first half is built: the session store, `wheems session` and
handovers, and onboarding by inviting the app to a channel.

## The problem

Today an agent has two ways to reach the person, and neither can wait for a decision:

- **Its chat thread.** A chief asks "shall I deploy?" in its answer, and the person replies in
  words. Nothing records that a decision is pending, nothing binds the reply to the question, and
  an ad-hoc session has no thread at all: only chiefs talk to people.
- **A prompt at the Mac.** An engine running with `permissions: ask` stops at its own permission
  prompt. Wheems says so in the thread (`hc attach …`), but it can only be answered at the
  machine. That's why a chief you talk to from your phone usually runs on `auto`
  ([config.md](config.md)).

Later milestones need a real "ask and wait" too. The broker asks before a risky action, workflows
have `ask` steps, a purchase asks every time, and linking a project's folder is "a yes in chat"
([architecture.md](architecture.md#a-projects-folder-approved-once-never-at-the-mac)). All of
them should use the same mechanism, and this design builds it once.

## What the person sees

An approval is a post in the workspace's `approvals` channel:

> **Approval** · _Chief of staff_ · Personal
>
> Deploy storefront to staging?
>
> The checkout fix is on `fix/checkout-total`; tests pass. Staging only, not production.
>
> [Approve] [Decline]
>
> _Asks until 18 Nov, 14:02. @Mike_

- **It mentions the person.** The post mentions the connection's `allowed_users`, so the phone
  buzzes even when the channel is muted for ordinary posts.
- **It says who asks.** That means the agent and, for an ad-hoc session, its title and its chief.
  Each post is tagged with its project once projects arrive (milestone 4).
- **One tap answers it.** The post is then changed in place to say who answered, what they chose
  and when, and the buttons are removed. The first answer counts. A later press, from a second
  phone or after it expired, changes nothing; the post is just redrawn as it stands.
- **The answer reaches the agent as a message from Wheems**, the way a session's answer does
  today:
  `Wheems: approval a1b2 answered: Approve (Mike, 14:05). Your question was: Deploy storefront to staging?`
  A chief then carries on in its own thread, so the person sees "Deploying now" where they were
  talking.

**Without an `approvals` channel** (a new install has only `chat`), approvals go to the chat
channel as new top-level posts, not into a thread, so they're easy to see. Doctor suggests
adding an `approvals` channel. Updates fall back the same way.

## Asking: `wheems chat ask`

```sh
wheems chat ask approvals "Deploy storefront to staging?" \
  --details "The checkout fix is on fix/checkout-total; tests pass. Staging only."
```

- **Choices** default to Approve and Decline. `--choices "Staging,Production,Neither"` gives up
  to four, which suits a question with a few answers, not only a yes or no. The last choice is
  treated as the no for workflows' `ask` step.
- **`--details`** (or `-` to read stdin) is shown under the question, cut to a few thousand
  characters. The question itself is one line.
- **`--expires`** defaults to 24 hours, with a maximum of a week. When it runs out, the post says
  so, and the agent is told it expired with no answer. Silence never counts as a yes.
- **It returns at once** with the approval's id. The answer comes back later as a message. With
  `--wait`, it waits for the answer and prints it, for up to ten minutes (`--timeout`). After that
  it comes back as without `--wait`. This mirrors `wheems session send --wait`, and the reason is
  the same: an engine's tool call can't wait for hours.
- **The channel** is any named channel in `workspace.yaml`. `approvals` is the usual one. A
  workflow may ask in `briefs` or elsewhere.
- **Limits.** A session may have at most five approvals waiting at once. A sixth is refused, so a
  confused agent can't flood the person's phone.

Every agent's built-in instructions get a short section on this command: when to ask (anything
outside the thread's ask that can't be undone, or that spends money or speaks for the person),
and to wait for the answer before acting.

## Posting: `wheems chat post`

```sh
wheems chat post updates "Nightly backup finished: 3 sites, 1.2 GB."
```

`post` is a one-way post to a named channel: no answer, no thread, and nothing is recorded beyond
the session's own record. It's tagged with who posted it, like an approval. Its main users are
routines and tasks (milestone 5), whose results don't belong in any one conversation. A chief
that's talking to the person keeps answering in its thread.

## Answering

The same code records an answer, wherever it comes from:

| From           | How                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack          | The buttons. Only the connection's `allowed_users` count; anyone else's press is ignored                                                                                |
| The web app    | Review lists approvals waiting, with the same choices, and a history (web app stage 2)                                                                                  |
| A terminal     | `wheems approval list`, `wheems approval show <id>`, `wheems approval answer <id> <choice>`                                                                             |
| Other channels | Any driver with the `buttons` capability. Without buttons, the post says how to answer in words, and a reply `approve a1b2` counts. That's for Telegram and email later |

Recording an answer is one update in the store, from waiting to answered, so two answers at once
can't both count. **An agent can't answer an approval.** `wheems approval answer` refuses any
caller that has a session's identity, as `wheems session restart` does.

## Kept in the store

Approvals live in the session store, `.wheems/state.sqlite`, in a new `approvals` table. That
moves the store to schema version 6. Each approval keeps:

- its id, workspace, the session that asked and, later, its project and task;
- what it's for: `ask` now, and later `action`, `purchase`, `folder` or `workflow`. It also
  keeps a fingerprint of what was approved, such as the question and details, or the broker's
  exact action and arguments, or a purchase's quote;
- the question, details and choices, which are never changed once asked;
- where it was posted: the connection, channel and message;
- its state (`waiting`, `answered`, `expired` or `withdrawn`), the answer, who answered and how
  (Slack, the web app or a terminal);
- when it was asked, when it expires, when it was answered and when the answer reached the agent.

The answer goes back through the same durable hand-back that session answers use
(`passBack` in `src/service/sessions.ts`):

- **A chief's thread** gets the message told into its conversation, resuming it if it had
  stopped.
- **An ad-hoc session** gets it typed in, resuming it if it had stopped.
- **A session that ended after the answer came**, but before it was delivered, has the message
  go to its owner, the chief that started it, with a note that the asker had ended. Ending a
  session withdraws any approvals it still has waiting (below).

**After a restart** nothing is lost. The buttons carry only the approval's id and the choice, and
everything else is read from the store. An approval that's still waiting can still be answered.
One that expired while the service was down is expired when it starts. An answer that hadn't
reached its agent is delivered again.

**Withdrawing.** The agent can withdraw its own approval: `wheems approval withdraw <id>`, with
`withdraw` as a domain verb. Ending a session withdraws its waiting approvals. The post then says
it was withdrawn.

## What the approval does and doesn't enforce

In milestone 3 an approval is **a promise the agent keeps**. The agent asks, waits and acts on
the answer. Nothing yet stops an agent that acts without asking, or one that ignores a no. The
caller check on the control socket is also convenience, not proof: an agent running as the same
user could claim to be the person.

That's deliberate, and the design keeps the record ready for real enforcement:

- **The broker (milestone 9)** asks through this same store before acting, with the fingerprint
  set to the exact action and arguments. The agent never holds the credential, so the approval
  becomes the gate, not a courtesy.
- **Task credentials (milestone 5)** make "who's calling" proof rather than an environment
  variable. Answering can then require a person's identity, not just the absence of a session's.

The docs and the built-in instructions say this plainly, so nobody believes a guardrail exists
before it does ([architecture.md](architecture.md#guardrails-that-work-with-any-engine)).

## What it needs

1. **The Slack driver's buttons.** Posts get an `actions` block. The Socket Mode transport passes
   `interactive` envelopes on as well as events, and a `block_actions` press becomes a `button`
   event. The app manifest already turns interactivity on. Apps made from an older manifest
   need it switched on, which doctor can't check, so `wheems channel connect slack` says so and
   the first approval tests it.
2. **Changing a post.** The channel contract gets an optional `update(message, change)`, which
   Slack does with `chat.update`. Drivers without it post the outcome as a reply under the post
   instead.
3. **The store and the service.** The `approvals` table and its migration, asking and answering,
   expiry checked each minute and at start, and delivery through the hand-back.
4. **The CLI.** `chat ask`, `chat post`, and `approval list`, `show`, `answer` and `withdraw`,
   with the built-in instructions and the README.
5. **The web app, stage 2.** Approvals waiting and their history on Review, answered with the
   same code.
6. **Notices for sessions stuck at a prompt.** When Herdr says a session is `blocked`, Wheems
   posts to `approvals` with its `hc attach` line, as the task design already says, rather than
   only in the thread. It has no buttons yet (see the open questions).

### In pull requests

1. The store, asking, answering from a terminal, expiry and delivery, tested with the memory
   channel, which already has buttons.
2. Slack buttons and changing a post, then a live test on wheems-live.
3. `chat post`, the fallback to `chat`, notices for stuck sessions, and doctor's suggestion.
4. Web app stage 2.

Then milestone 3's test: an agent waits for a tap on the phone before acting.

## Open questions

1. **Can an ad-hoc session ask the person directly?** This design says yes. An approval is a
   structured question with fixed answers, not chat, and the post names the session and its
   chief. The alternative is that only chiefs ask, and an ad-hoc session asks its chief, which
   decides whether to ask the person. That's stricter, but every approval then waits on two
   agents.
2. **Should the chat thread show anything** while its chief waits, such as "Waiting for your
   approval in #approvals"? It helps when the approvals channel is muted, and it's noise when it
   isn't.
3. **Answering engine permission prompts from the phone.** This would let a chief run on `ask`
   rather than `auto`. It needs either typing into the prompt through Herdr, which depends on each
   engine's screen and is easy to get wrong, or an engine's own hook for permission decisions,
   which not every engine has. The suggestion is to leave it until after the broker. By then most
   risky actions go through the broker, where approvals are enforced.
4. **The broker in milestone 3.** The roadmap lists "the first version of the broker" here. This
   design builds the approvals it will use, but no actions. The suggestion is to design the
   broker, which covers actions, rules and credentials, on its own before milestone 9, and to
   count milestone 3 done without it.
