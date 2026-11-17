import { HERDR_MINIMUM_VERSION } from '../drivers/runtime/herdr/herdr-runtime.js';

export const INSTALL_GITIGNORE = `# Running state: conversations, the control socket, logs.
.wheems/
# Written by Wheems from agents/*.md for each engine.
workspaces/*/CLAUDE.md
workspaces/*/AGENTS.md
`;

export function installYaml(): string {
  return `# Wheems install: what every workspace shares. See docs/config.md.
herdr:
  version: ${HERDR_MINIMUM_VERSION}

machines:
  this-mac:
    local: true

accounts:
  claude-subscription:
    driver: claude

connections:
  slack:
    driver: slack
    secret: slack
    allowed_users: []
`;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  /** A channel name, or null for the bot's direct messages. */
  channel: string | null;
  /** The install connection it chats on. Defaults to `slack`. */
  connection?: string;
  /** The engine the chief of staff runs in, its model, and the account that pays. */
  engine: EngineChoice;
}

export interface EngineChoice {
  name: string;
  model: string;
  account: string;
}

export const DEFAULT_ENGINE: EngineChoice = {
  name: 'claude-code',
  model: 'claude-opus-5-5',
  account: 'claude-subscription',
};

/** A YAML scalar for text a person typed, such as `Acme: UK` or `#work-chat`. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function workspaceYaml(template: WorkspaceTemplate): string {
  const connection = template.connection ?? 'slack';
  const chat =
    template.channel === null
      ? `{ connection: ${connection}, direct: true }`
      : `{ connection: ${connection}, channel: ${yamlString(template.channel)} }`;
  return `name: ${yamlString(template.name)}
accounts: [${template.engine.account}]

channels:
  chat: ${chat}

identity:
  name: ${yamlString(`${template.name} chief of staff`)}
`;
}

export const SKILLS_YAML = `# Skills this workspace uses, each pinned to a library version.
skills: {}
`;

export function chiefOfStaffMd(template: WorkspaceTemplate): string {
  return `---
description: ${yamlString(`The one entry point for ${template.name}, aware of everything going on in it.`)}
engine: ${template.engine.name}
model: ${yamlString(template.engine.model)}
account: ${template.engine.account}
permissions: auto
---

# ${template.name}: chief of staff

You are the chief of staff for ${template.name}. The person you work for talks to you from Slack,
usually on their phone, and you're the only one they talk to. You run a team of agents that does
the work, and you keep the person informed.

- Understand what they want, hand it to the right member of your team, follow it, and check the
  result before you report.
- Decide what you can. Ask the person only when a decision is genuinely theirs.
- Be brief. Lead with the answer or the result, then any detail they need.
- Say plainly what's done, what isn't, and anything that needs them.

## What we're working towards

<!-- The goal for ${template.name}: what you want your chief of staff and its team to achieve. -->
`;
}

export const ABOUT_YOU_MD = `<!--
About you: every agent in every workspace reads this page when it starts, so write what you'd
tell anyone working for you. Agents never change it; they suggest changes, which you approve.
Keep it short: only the first 4,000 characters are loaded.
-->

# About me

## How I like to work

## How I like things written
`;

export const BRIEF_MD = `<!--
The workspace's brief: every agent here loads it when it starts. Wheems's filing job keeps it up
to date from notes, under 4,000 characters.
-->
`;
