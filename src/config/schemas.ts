/**
 * The config formats. Config is YAML and Markdown in a git folder:
 *
 *   ~/opinr/
 *   ├── install.yaml            machines, connections, accounts, Herdr version
 *   ├── library/                agent templates, skills, workflow templates
 *   └── workspaces/<id>/
 *       ├── workspace.yaml      chief of staff, channels, rules, accounts
 *       ├── agents/<name>.md    front matter (engine, model, account) + instructions
 *       ├── skills.yaml         chosen skills and pinned versions
 *       └── workflows/<name>.yaml
 *
 * Keys are snake_case. Names (of workspaces, agents, accounts, connections,
 * channels, skills and workflows) are lowercase with dashes.
 */
import { z } from 'zod';

export const nameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'Use lowercase letters, digits and dashes, starting with a letter or digit',
  )
  .max(64);

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'Use a version such as 0.1.20');

const nonEmpty = z.string().trim().min(1);

// install.yaml ---------------------------------------------------------------

export const machineSchema = z
  .strictObject({
    local: z.boolean().optional().describe('True for the machine the install lives on'),
    herdr: nameSchema.optional().describe("The machine's name in `hc machine ls`"),
    always_on: z.boolean().default(false).describe('Agents run on always-on machines by default'),
    reach: z
      .enum(['inbound', 'outbound'])
      .default('inbound')
      .describe(
        '`inbound`: the hub can reach it. `outbound`: it connects out to the hub and collects its work, like a laptop.',
      ),
  })
  .refine((m) => (m.local === true) !== (m.herdr !== undefined), {
    message: 'A machine is either `local: true` or reached through Herdr with `herdr: <name>`',
  });

export const accountSchema = z.strictObject({
  driver: nameSchema.describe('The account driver, such as `claude`, `chatgpt` or `openrouter`.'),
  secret: nameSchema
    .optional()
    .describe('The name of the credential in the secret store, when the account needs one.'),
  description: z.string().optional(),
});

export const connectionSchema = z.strictObject({
  allowed_users: z
    .array(nonEmpty)
    .default([])
    .describe(
      "For chat connections: the service's user ids allowed to talk to agents, such as Slack member ids. Everyone else is ignored.",
    ),
  driver: nameSchema.describe(
    'The channel or integration driver, such as `slack`, `telegram` or `github`.',
  ),
  secret: nameSchema.optional(),
  description: z.string().optional(),
});

export const installSchema = z
  .strictObject({
    herdr: z
      .strictObject({
        version: versionSchema.describe('The minimum Herdr core version this install runs on'),
        binary: z.string().min(1).optional().describe('Path to hc, when it is not on PATH'),
      })
      .optional(),
    machines: z.record(nameSchema, machineSchema).default({}),
    accounts: z.record(nameSchema, accountSchema).default({}),
    connections: z.record(nameSchema, connectionSchema).default({}),
  })
  .refine(
    (install) => Object.values(install.machines).filter((m) => m.local === true).length <= 1,
    {
      message: 'Only one machine can be `local: true`',
      path: ['machines'],
    },
  );

export type InstallConfig = z.infer<typeof installSchema>;

// workspace.yaml -------------------------------------------------------------

export const channelBindingSchema = z.union([
  z.strictObject({
    connection: nameSchema.describe('The install connection that carries it, such as `slack`.'),
    channel: nonEmpty.describe("The channel's id or name in that service."),
  }),
  z.strictObject({
    connection: nameSchema.describe('The install connection that carries it, such as `slack`.'),
    direct: z
      .literal(true)
      .describe(
        "Direct messages with the connection's bot. Only one workspace per connection can have them.",
      ),
  }),
]);

export type ChannelBinding = z.infer<typeof channelBindingSchema>;

export const ruleSchema = z
  .strictObject({
    name: nameSchema,
    description: z.string().optional(),
    project: nameSchema.optional().describe('Limit the rule to one project.'),
    deny: z
      .record(nameSchema, z.array(nonEmpty).min(1))
      .optional()
      .describe(
        'Actions it refuses, each with the targets it refuses them for (branches, servers).',
      ),
    require: z
      .strictObject({ review: nameSchema, before: nameSchema })
      .optional()
      .describe('Something that must happen first, such as a review before a merge.'),
    action: nameSchema.optional().describe('The action this rule is about, for `approval`.'),
    approval: nameSchema.optional().describe('The channel that must approve `action` first.'),
  })
  .refine((r) => r.deny !== undefined || r.require !== undefined || r.approval !== undefined, {
    message: 'A rule needs `deny`, `require` or `approval`',
  })
  .refine((r) => (r.approval === undefined) === (r.action === undefined), {
    message: '`approval` and `action` go together',
  });

export const workspaceSchema = z.strictObject({
  name: nonEmpty.describe("Display name. The folder name is the workspace's id."),
  description: z.string().optional(),
  chief_of_staff: nameSchema
    .default('chief-of-staff')
    .describe("The agent file (in agents/) that is the workspace's chief of staff."),
  accounts: z
    .array(nameSchema)
    .min(1)
    .describe('Install accounts this workspace may use. Each agent picks from these.'),
  channels: z
    .record(nameSchema, channelBindingSchema)
    .default({})
    .describe(
      'Named channels. `chat`, `approvals` and `updates` are the built-in ones; workflows may post to others, such as `briefs`.',
    ),
  integrations: z
    .record(nameSchema, z.strictObject({ access: z.enum(['read', 'full']).default('read') }))
    .default({})
    .describe('Install connections this workspace may use, with the access it gets.'),
  isolation: z
    .enum(['enforced', 'hard'])
    .default('enforced')
    .describe(
      '`enforced`: its own folder, Claude Code config, permission rules, secrets and account. `hard`: a separate machine, VM or user account.',
    ),
  skill_budget: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe('Doctor warns when the workspace or one agent goes past this many skills.'),
  knowledge: z
    .strictObject({
      note_after_idle: z
        .number()
        .int()
        .nonnegative()
        .default(30)
        .describe(
          'Minutes a conversation stays quiet, after new work, before Opinr asks its agent for a note. 0 turns this off.',
        ),
      filer: z
        .strictObject({
          engine: nameSchema.optional().describe("Defaults to the chief of staff's engine."),
          model: nonEmpty
            .optional()
            .describe("Defaults to Claude Sonnet on Claude Code, else the chief of staff's model."),
          account: nameSchema.optional().describe("Defaults to the chief of staff's account."),
        })
        .optional()
        .describe('The agent that files notes into the knowledge base.'),
    })
    .default({ note_after_idle: 30 })
    .describe("How the workspace's knowledge loop runs."),
  machine: nameSchema.optional().describe('The machine agents run on by default.'),
  identity: z
    .strictObject({
      name: nonEmpty,
      icon: nonEmpty.optional().describe('An emoji such as `:house:`, or an image URL.'),
    })
    .optional()
    .describe(
      "The name and icon the workspace's posts appear under, where the channel supports it.",
    ),
  rules: z
    .array(ruleSchema)
    .default([])
    .describe('Rules written once and enforced at every layer that can enforce them.'),
});

export type WorkspaceConfig = z.infer<typeof workspaceSchema>;

// agents/<name>.md front matter ----------------------------------------------

export const agentFrontMatterSchema = z.strictObject({
  name: nameSchema.optional().describe('Defaults to the file name.'),
  description: z.string().optional(),
  engine: nameSchema.describe(
    "The CLI it runs in: `claude-code`, `codex`, `opencode` or a plugin's engine.",
  ),
  model: nonEmpty.describe("The engine's model id, such as `claude-opus-5-5`."),
  account: nameSchema.describe("The install account that pays, from the workspace's `accounts`."),
  skills: z.array(nameSchema).default([]).describe("Skills from the workspace's skills.yaml."),
  integrations: z
    .array(nameSchema)
    .default([])
    .describe("Integrations from the workspace's `integrations`."),
  permissions: z
    .enum(['ask', 'auto', 'skip'])
    .default('ask')
    .describe(
      "How much the agent may do without asking. `ask`: the engine's normal prompts. `auto`: the engine allows routine actions and asks for risky ones. `skip`: never asks.",
    ),
});

export type AgentFrontMatter = z.infer<typeof agentFrontMatterSchema>;

// skills.yaml ----------------------------------------------------------------

export const skillsSchema = z.strictObject({
  skills: z.record(nameSchema, nonEmpty.describe('A library version or content hash')).default({}),
});

export type SkillsConfig = z.infer<typeof skillsSchema>;

// workflows/<name>.yaml ------------------------------------------------------

const cronSchema = z
  .string()
  .regex(/^\S+(\s+\S+){4}$/, 'Use a five-field cron expression, such as "0 7 * * 1-5"');

export const triggerSchema = z.union([
  z.strictObject({ schedule: cronSchema.describe('Runs on a time') }),
  z.strictObject({
    message: z.strictObject({
      channel: nameSchema,
      contains: nonEmpty.optional().describe('Only messages containing this text.'),
    }),
  }),
  z.strictObject({
    file: z.strictObject({
      path: nonEmpty.describe(
        'A glob, relative to the workspace folder, such as `wiki/inbox/*.md`.',
      ),
    }),
  }),
]);

export const stepSchema = z.union([
  z.strictObject({
    agent: nameSchema.describe('Run an agent with a task.'),
    task: nonEmpty,
  }),
  z.strictObject({
    ask: z
      .strictObject({
        question: nonEmpty,
        channel: nameSchema.default('approvals'),
      })
      .describe('Ask for approval and wait. Stops the workflow on a no.'),
  }),
  z.strictObject({
    post: z
      .strictObject({
        channel: nameSchema,
        text: nonEmpty.optional(),
      })
      .describe("Post to a channel. Without `text`, posts the previous step's result."),
  }),
]);

export const workflowSchema = z.strictObject({
  name: nameSchema.optional().describe('Defaults to the file name.'),
  description: z.string().optional(),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1),
});

export type WorkflowConfig = z.infer<typeof workflowSchema>;
export type WorkflowStep = z.infer<typeof stepSchema>;

/** Every config format, by the name its JSON Schema file is published under. */
export const configSchemas = {
  install: installSchema,
  workspace: workspaceSchema,
  agent: agentFrontMatterSchema,
  skills: skillsSchema,
  workflow: workflowSchema,
} as const;

export type ConfigKind = keyof typeof configSchemas;
