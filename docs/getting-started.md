# Getting started

Set up Opinr on a Mac and chat with a chief of staff from Slack. This takes about ten minutes,
most of it in Slack's app settings.

You need:

- Node.js 22.13 or later
- Herdr core 0.1.20 or later (`hc`)
- A Slack workspace where you can add apps

Setup installs the agent CLIs for you: Claude Code, Codex or opencode.

## 1. Install

```bash
npm install -g @opinr/hq
```

Until the first release, build it from this repository instead, and run `opinr` as
`node /path/to/opinr/dist/cli/main.js`:

```bash
npm install
npm run build
```

If your default `node` is older than 22.13, run Opinr with a newer one, such as Homebrew's:
`brew install node@22`, then `/opt/homebrew/opt/node@22/bin/node /path/to/opinr/dist/cli/main.js`.
`opinr doctor` says which Node.js it is running on.

## 2. Run setup

```bash
opinr setup
```

Setup creates `~/opinr` (a git folder for your config) if there is none, then asks what you want
to set up. Pick from the menu with the arrow keys and Enter; Esc or Ctrl+C backs out of a step
without saving it, and you can run `opinr setup` again any time.

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
   to `~/.config/opinr/secrets.json`, readable only by you. They never pass through an agent.
5. Give your Slack member ID (your profile, **⋯**, **Copy member ID**). Only people on this list
   can talk to your agents; everyone else is ignored.

**Workspaces** creates a workspace with its chief of staff, such as `personal`, on the engine and
model you choose.
The first chats in the Slack app's direct messages; others chat in a channel you invite the app
to. Claude Code and Codex ask once whether to trust a new folder, and nobody can answer that from
Slack, so setup offers to open the engine there: say yes, then press Ctrl+C twice to come back.

**Service** runs Opinr in the background under launchd, now and at every login, with the Node.js
you ran setup with. Afterwards, `opinr service status`, `opinr service logs` and
`opinr service restart` look after it; restart it after changing config.

**Check everything** runs `opinr doctor`.

Each part also has its own command for scripts: `opinr init <workspace> [--engine codex]
[--model gpt-6.1-sol]`, `opinr service install` and `opinr doctor`.

## 3. Chat

Open the app's **Messages** tab in Slack and say hello. Each message you send starts a
conversation, and replies in its thread carry it on. Each conversation is its own Claude Code
session in Herdr, which you can watch or take over with `hc attach`. The 👀 reaction means your
message has reached the agent; it goes when the agent replies.

When a conversation has been quiet for half an hour, Opinr asks its agent to write a note,
which lands in `workspaces/<id>/knowledge/inbox/`. You won't see that in Slack. Fill in
`~/opinr/about-you.md` with what you'd tell anyone working for you: every agent reads it.

If something isn't right, run `opinr doctor`. It checks Node.js, Herdr core, Claude Code, the
folder trust, Slack and the service.
