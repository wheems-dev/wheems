# Getting started

Set up Wheems on a Mac and chat with a chief of staff from Slack. This takes about ten minutes,
most of it in Slack's app settings.

You need:

- Node.js 22.16 or later in the 22 line, or 24 or later (not 23: its SQLite has no full-text
  search, which Wheems needs)
- Herdr core 0.1.20 or later (`hc`): see [herdr.dev/core](https://herdr.dev/core/) to install it
- A Slack workspace where you can add apps

Setup installs the agent CLIs for you: Claude Code, Codex or opencode.

## 1. Install

```bash
npm install -g wheems
```

Or build it from this repository (clone it anywhere except `~/wheems`, which is your install),
and link the command:

```bash
npm install
npm run build
npm link
```

If your default `node` isn't one of those (Homebrew's `node` may be 23), run Wheems with one that is, such as Homebrew's 22:
`brew install node@22`, then `/opt/homebrew/opt/node@22/bin/node /path/to/wheems/dist/cli/main.js`.
`wheems doctor` says which Node.js it is running on, and checks its SQLite has full-text search.

## 2. Run setup

```bash
wheems setup
```

Setup creates `~/wheems` (a git folder for your config) if there is none, then asks what you want
to set up. Pick from the menu with the arrow keys and Enter; Esc or Ctrl+C backs out of a step
without saving it, and you can run `wheems setup` again any time.

**Engines** installs and signs in the CLIs your agents run in: Claude Code (on a Claude
subscription), Codex (on a ChatGPT subscription) and opencode (any model, through OpenRouter, a
provider's own key, or its free models). For each, setup shows whether it's installed and signed
in, shows the install command and asks before running it, then runs the engine's own sign-in on
your terminal so you log in yourself.

**Channels** connects a chat app. Choose Slack (Telegram is coming in a later version). One Slack
app serves every workspace, so you do this once:

1. Setup copies the app's manifest to your clipboard and offers to open
   <https://api.slack.com/apps?new_app=1>. Choose **From a manifest**, pick your Slack workspace
   and paste. The app uses Socket Mode, so it needs no public address.
2. **Install to workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write`
   scope (`xapp-…`).
4. Paste both tokens when setup asks. They are masked as you type, checked with Slack, and saved
   to `~/.config/wheems/secrets.json`, readable only by you. They never pass through an agent.
5. Give your Slack member ID (your profile, **⋯**, **Copy member ID**). Only people on this list
   can talk to your agents; everyone else is ignored.

**Workspaces** creates a workspace with its chief of staff, such as `personal`, on the engine and
model you choose.
The first chats in the Slack app's direct messages; others chat in a channel you invite the app
to. Claude Code and Codex ask once whether to trust a new folder, and nobody can answer that from
Slack, so setup offers to open the engine there: say yes, then press Ctrl+C twice to come back.

**Service** runs Wheems in the background under launchd, now and at every login, with the Node.js
you ran setup with. Afterwards, `wheems service status`, `wheems service logs` and
`wheems service restart` look after it; restart it after changing config.

**Check everything** runs `wheems doctor`.

Each part also has its own command for scripts: `wheems init <workspace> [--engine codex]
[--model gpt-6.1-sol]`, `wheems service install` and `wheems doctor`.

## 3. Chat

Open the app's **Messages** tab in Slack and say hello. Each message you send starts a
conversation, and replies in its thread carry it on. Each conversation is its own Claude Code
session in Herdr, which you can watch or take over with `hc attach`. The 👀 reaction means your
message has reached the agent; it goes when the agent replies.

When a conversation has been quiet for half an hour, Wheems asks its agent to write a note,
which lands in `workspaces/<id>/knowledge/inbox/`. You won't see that in Slack. Fill in
`~/wheems/about-you.md` with what you'd tell anyone working for you: every agent reads it.

Now and then, run `wheems review`. It shows what waits for you: skills agents proposed, and
changes to `about-you.md` suggested from their notes. Nothing changes until you approve it.
Overnight, Wheems writes `knowledge/reports/contradictions.md` and `knowledge/reports/stale.md`,
pages that disagree and pages that look out of date.

If something isn't right, run `wheems doctor`. It checks Node.js, Herdr core, Claude Code, the
folder trust, Slack and the service.
