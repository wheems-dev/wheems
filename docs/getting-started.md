# Getting started

Set up Opinr on a Mac and chat with a chief of staff from Slack. This takes about ten minutes,
most of it in Slack's app settings.

You need:

- Node.js 22.12 or later
- Herdr core 0.1.20 or later (`hc`)
- Claude Code, signed in
- A Slack workspace where you can add apps

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

If your default `node` is older than 22.12, run Opinr with a newer one, such as Homebrew's:
`brew install node@22`, then `/opt/homebrew/opt/node@22/bin/node /path/to/opinr/dist/cli/main.js`.
`opinr doctor` says which Node.js it is running on.

## 2. Set up the install and Slack

```bash
opinr setup
```

This creates `~/opinr` (a git folder for your config) and connects Slack. One Slack app serves
every workspace you make, so you only do this once:

1. `opinr setup` writes a Slack app manifest and prints where it is (`opinr slack manifest` prints
   it too). The app uses Socket Mode, so it needs no public address.
2. At <https://api.slack.com/apps?new_app=1>, choose **From a manifest**, pick your Slack
   workspace and paste the manifest.
3. **Install to workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
4. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write`
   scope (`xapp-…`).
5. Paste both tokens into `opinr setup` when it asks. They are hidden as you type, checked with
   Slack, and saved to `~/.config/opinr/secrets.json`, readable only by you. They never pass
   through an agent.
6. Give your Slack member ID (your profile, **⋯**, **Copy member ID**). Only people on this list
   can talk to your agents; everyone else is ignored.

## 3. Create a workspace

```bash
opinr init personal
```

This creates `~/opinr/workspaces/personal` with a chief of staff on Claude Code. It chats in the
Slack app's direct messages. A second workspace needs a channel instead:
`opinr init acme --channel acme-chat`, then invite the app to `#acme-chat`.

Claude Code asks once whether to trust a new folder, and nobody can answer that from Slack, so
answer it now:

```bash
cd ~/opinr/workspaces/personal
claude          # choose "Yes, I trust this folder", then type /exit
```

## 4. Start the service

```bash
opinr service install
```

This runs the service under launchd, now and at every login, with the Node.js you ran the command
with. `opinr service status`, `opinr service logs` and `opinr service restart` look after it;
restart it after changing config.

## 5. Chat

Open the app's **Messages** tab in Slack and say hello. Each message you send starts a
conversation, and replies in its thread carry it on. Each conversation is its own Claude Code
session in Herdr, which you can watch or take over with `hc attach`. The 👀 reaction means your
message has reached the agent; it goes when the agent replies.

If something isn't right, run `opinr doctor`. It checks Node.js, Herdr core, Claude Code, the
folder trust, Slack and the service.
