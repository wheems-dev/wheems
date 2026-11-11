import { HERDR_MINIMUM_VERSION } from '../drivers/runtime/herdr/herdr-runtime.js';

export const INSTALL_GITIGNORE = `# Running state: conversations, the control socket, logs.
.opinr/
# Written by Opinr from agents/*.md for each engine.
workspaces/*/CLAUDE.md
workspaces/*/AGENTS.md
`;

export function installYaml(): string {
  return `# Opinr install: what every workspace shares. See docs/config.md.
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
}

/** A YAML scalar for text a person typed, such as `Acme: UK` or `#work-chat`. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function workspaceYaml(template: WorkspaceTemplate): string {
  const chat =
    template.channel === null
      ? '{ connection: slack, direct: true }'
      : `{ connection: slack, channel: ${yamlString(template.channel)} }`;
  return `name: ${yamlString(template.name)}
accounts: [claude-subscription]

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
engine: claude-code
model: claude-opus-5-5
account: claude-subscription
permissions: auto
---

# ${template.name}: chief of staff

You are the chief of staff for ${template.name}. The person you work for talks to you from Slack,
usually on their phone, and relies on you to get things done and to keep track of them.

- Do what you're asked, end to end, where you can. Ask only when a decision is genuinely theirs.
- Be brief. Lead with the answer or the result, then any detail they need.
- Say plainly what you did, what you didn't, and anything that needs them.
- This folder is the ${template.name} workspace. Keep notes and files you make for them here.
`;
}
