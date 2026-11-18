# Getting started

Set up Wheems on a Mac and chat with a chief of staff from Slack. This takes about ten minutes,
most of it in Slack's app settings.

You need:

- Herdr core 0.1.20 or later (`hc`): see [herdr.dev/core](https://herdr.dev/core/) to install it
- A Slack workspace where you can add apps

Setup installs the agent CLIs for you: Claude Code, Codex or opencode.

## 1. Install

The simplest way is the one-file executable from the latest
[release](https://github.com/wheems-dev/wheems/releases), with everything inside it. On a Mac
with Apple silicon:

```bash
curl -fsSL -o wheems.tar.gz https://github.com/wheems-dev/wheems/releases/latest/download/wheems-darwin-arm64.tar.gz
tar -xzf wheems.tar.gz && mv wheems-darwin-arm64 ~/.local/bin/wheems
```

On an Intel Mac, use `wheems-darwin-x64`. Use `curl` rather than a browser, which marks the file
as downloaded so that macOS refuses to open it.

Or install [Bun](https://bun.com) 1.4.4 or later, Wheems's runtime, and Wheems with it:

```bash
curl -fsSL https://bun.sh/install | bash
bun install -g wheems
```

Or build it from this repository (clone it anywhere except `~/wheems`, which is your install),
and link the command:

```bash
bun install
bun run build
bun link
```

`wheems doctor` says which Bun it is running on.

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

**Workspaces** creates a workspace with its chief of staff, such as `default`, on the engine and
model you choose.
The first chats in the Slack app's direct messages; others chat in a channel you invite the app
to. Claude Code and Codex ask once whether to trust a folder, and nobody can answer that from
Slack, so setup asks once whether Wheems may mark your install folder trusted for them: say yes.
That covers every workspace in the install, so it's asked only once (see
[Trusting the install folder](../README.md#trusting-the-install-folder)).

**Service** runs Wheems in the background under launchd, now and at every login, with the Bun
(or the executable) you ran setup with. Nothing answers in chat until it runs, so setup asks again if you leave
without starting it. Afterwards, `wheems status`, `wheems logs` and `wheems restart` look after
it; restart it after changing config. `wheems stop` stops it until `wheems start`.

**Check everything** runs `wheems doctor`.

When you choose **Done** with the service running, your chief of staff says hello in Slack's
direct messages: that's how you know it works, and where to find it. If it can't, setup says
why.

Each part also has its own command for scripts: `wheems engine install <engine>`,
`wheems channel connect slack`,
`wheems workspace create <workspace> [--engine codex] [--model …]`, `wheems start` and
`wheems doctor`. `wheems list` shows every command, grouped by area.

## 3. Chat

Open the app's **Messages** tab in Slack and say hello. Each message you send starts a
conversation, and replies in its thread carry it on. Each conversation is its own Claude Code
session in Herdr, which you can watch or take over with `hc attach`. The 👀 reaction means your
message has reached the agent; it goes when the agent replies.

When a conversation has been quiet for half an hour, Wheems asks its agent to write a note,
which lands in `workspaces/<id>/knowledge/inbox/`. You won't see that in Slack. Fill in
`~/wheems/about-you.md` with what you'd tell anyone working for you: every agent reads it.

### Add a chief by inviting the app to a channel

To give a team, a client or a side project its own chief of staff, invite the app to a Slack
channel: type `@Wheems` there and accept the invitation. Wheems answers in the channel that it
isn't set up there yet, and asks for a name. Reply in its thread with one, such as `Marketing`,
and Wheems creates the workspace (`~/wheems/workspaces/marketing/`) with its chief of staff, on
the same engine and account as your first chief, and the chief answers in that channel straight
away. There's nothing to restart, and you never leave Slack.

Only people in `allowed_users` get the offer, and it's made once per channel (again after the
service restarts, if no one answered). If you'd rather set it up from the terminal,
`wheems init marketing --channel marketing` does the same, then `wheems restart`.

The offer comes as soon as the app is invited, through Slack's `member_joined_channel` event.
A Slack app made from the manifest before this version doesn't have that event: add it under
**Event Subscriptions → Subscribe to bot events** in the app's settings (it needs no new
scope). Until then, the offer comes with your first message in the channel instead.

A workspace whose `workspace.yaml` names a channel the app isn't in yet, such as one made with
`wheems init`, starts answering there as soon as you invite the app: its chief says it's there.

Now and then, run `wheems review`. It shows what waits for you: skills agents proposed, and
changes to `about-you.md` suggested from their notes. Nothing changes until you approve it.
Overnight, Wheems writes `knowledge/reports/contradictions.md` and `knowledge/reports/stale.md`,
pages that disagree and pages that look out of date.

If your chief can't answer, it says so in the thread, with the one step that fixes it: an engine
that isn't signed in or doesn't trust the folder, a question waiting at the Mac, or a session
that failed to start. It says each problem once, until it's fixed.

If nothing answers at all, run `wheems status`: it says whether the service is running and where
each workspace chats. For everything else, run `wheems doctor`, or `wheems doctor --fix`, which
offers to fix what it safely can and asks before each fix. It checks Bun, Herdr core, Claude
Code, the folder trust, Slack and the service.
