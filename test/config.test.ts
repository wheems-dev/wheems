import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crossCheck } from '../src/config/check.js';
import {
  kindOf,
  loadInstall,
  parseAgent,
  parseWorkflow,
  parseYaml,
  validateFile,
  type Problem,
} from '../src/config/load.js';
import { installSchema, skillsSchema, workspaceSchema } from '../src/config/schemas.js';

const EXAMPLE = new URL('../examples/install/', import.meta.url).pathname;

describe('the example install', () => {
  it('loads with no problems', async () => {
    const install = await loadInstall(EXAMPLE);
    expect(install.problems).toEqual([]);
    expect(crossCheck(install)).toEqual([]);
    expect(install.workspaces.map((w) => w.id)).toEqual(['acme', 'personal']);
    const acme = install.workspaces[0]!;
    expect(acme.config?.chief_of_staff).toBe('chief-of-staff');
    expect(acme.agents.map((a) => a.definition.name)).toEqual([
      'chief-of-staff',
      'developer',
      'reviewer',
    ]);
    expect(acme.workflows.map((w) => w.name)).toEqual(['morning-brief']);
    expect(acme.skills?.skills).toEqual({ 'release-notes': 2, 'code-review': 1 });
  });

  it('warns about engines that have no driver yet', async () => {
    const install = await loadInstall(EXAMPLE);
    const problems = crossCheck(install, { engines: ['claude-code'] });
    expect(problems).toEqual([
      {
        level: 'warning',
        file: 'workspaces/acme/agents/reviewer.md',
        message: 'No engine driver "codex" is installed yet',
      },
    ]);
  });
});

describe('install.yaml', () => {
  it('applies defaults', () => {
    const problems: Problem[] = [];
    const config = parseYaml(
      'install.yaml',
      'machines:\n  mac: { local: true }\n',
      installSchema,
      problems,
    );
    expect(problems).toEqual([]);
    expect(config).toEqual({
      machines: { mac: { local: true, always_on: false, reach: 'inbound' } },
      accounts: {},
      connections: {},
      knowledge: {},
    });
  });

  it("takes the knowledge base's embeddings with the driver's own options", () => {
    const problems: Problem[] = [];
    const config = parseYaml(
      'install.yaml',
      'knowledge:\n  embeddings:\n    driver: ollama\n    model: nomic-embed-text:v1.5\n    url: http://10.0.0.2:11434\n',
      installSchema,
      problems,
    );
    expect(problems).toEqual([]);
    expect(config?.knowledge).toEqual({
      embeddings: {
        driver: 'ollama',
        model: 'nomic-embed-text:v1.5',
        url: 'http://10.0.0.2:11434',
      },
    });
    parseYaml('install.yaml', 'knowledge:\n  embeddings: { model: x }\n', installSchema, problems);
    expect(problems.map((p) => p.message)).toEqual([expect.stringMatching(/driver/)]);
  });

  it('reports schema problems with the line they are on', () => {
    const problems: Problem[] = [];
    const text = [
      'machines:',
      '  mac:',
      '    local: true',
      'accounts:',
      '  Bad_Name:',
      '    driver: claude',
      'extra: 1',
    ].join('\n');
    expect(parseYaml('install.yaml', text, installSchema, problems)).toBeNull();
    expect(problems).toEqual([
      expect.objectContaining({
        level: 'error',
        line: 5,
        message: expect.stringMatching(/^accounts\.Bad_Name: /) as string,
      }),
      expect.objectContaining({
        level: 'error',
        line: 7,
        message: expect.stringMatching(/extra/) as string,
      }),
    ]);
  });

  it('reports YAML syntax errors with their line', () => {
    const problems: Problem[] = [];
    expect(
      parseYaml('install.yaml', 'machines:\n  mac: {local: true\n', installSchema, problems),
    ).toBeNull();
    expect(problems[0]).toMatchObject({ level: 'error', file: 'install.yaml' });
    expect(problems[0]?.line).toBeGreaterThan(0);
  });

  it('refuses duplicate keys', () => {
    const problems: Problem[] = [];
    parseYaml('install.yaml', 'accounts: {}\naccounts: {}\n', installSchema, problems);
    expect(problems.length).toBe(1);
  });

  it('wants a machine to be either local or reached through Herdr', () => {
    const problems: Problem[] = [];
    parseYaml('install.yaml', 'machines:\n  a: { always_on: true }\n', installSchema, problems);
    expect(problems[0]?.message).toMatch(/either `local: true` or reached through Herdr/);
    expect(problems[0]?.line).toBe(2);
  });

  it('allows only one local machine', () => {
    const problems: Problem[] = [];
    parseYaml(
      'install.yaml',
      'machines:\n  a: { local: true }\n  b: { local: true }\n',
      installSchema,
      problems,
    );
    expect(problems[0]?.message).toMatch(/Only one machine/);
  });

  it('wants a three-part Herdr version', () => {
    const problems: Problem[] = [];
    parseYaml('install.yaml', 'herdr: { version: "0.1" }\n', installSchema, problems);
    expect(problems[0]?.message).toMatch(/herdr\.version/);
  });
});

describe('workspace.yaml', () => {
  it('needs a name and at least one account, and applies defaults', () => {
    const problems: Problem[] = [];
    expect(parseYaml('workspace.yaml', '', workspaceSchema, problems)).toBeNull();
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/^name: /),
      expect.stringMatching(/^accounts: /),
    ]);
    const ok = parseYaml('workspace.yaml', 'name: Acme\naccounts: [a]\n', workspaceSchema, []);
    expect(ok).toMatchObject({
      chief_of_staff: 'chief-of-staff',
      isolation: 'enforced',
      skill_budget: 20,
      rules: [],
    });
  });

  it('checks rules', () => {
    const problems: Problem[] = [];
    const text =
      'name: A\naccounts: [a]\nrules:\n  - name: empty\n  - name: half\n    approval: approvals\n';
    parseYaml('workspace.yaml', text, workspaceSchema, problems);
    expect(problems.map((p) => [p.line, p.message])).toEqual([
      [4, 'rules.0: A rule needs `deny`, `require` or `approval`'],
      [5, 'rules.1: `approval` and `action` go together'],
    ]);
  });
});

describe('agent files', () => {
  it('reads front matter and instructions', () => {
    const problems: Problem[] = [];
    const agent = parseAgent(
      'agents/writer.md',
      '---\nengine: opencode\nmodel: openrouter/x-ai/grok\naccount: openrouter\n---\n\n# Writer\n\nWrite posts.\n',
      problems,
    );
    expect(problems).toEqual([]);
    expect(agent?.definition).toEqual({
      name: 'writer',
      description: null,
      engine: 'opencode',
      model: 'openrouter/x-ai/grok',
      account: 'openrouter',
      skills: [],
      integrations: [],
      permissions: 'ask',
      instructions: '# Writer\n\nWrite posts.',
    });
  });

  it('needs front matter', () => {
    const problems: Problem[] = [];
    expect(parseAgent('agents/a.md', '# No front matter\n', problems)).toBeNull();
    expect(problems[0]?.message).toMatch(/front matter/);
  });

  it('needs engine, model and account, with lines counted from the top of the file', () => {
    const problems: Problem[] = [];
    parseAgent('agents/a.md', '---\ndescription: x\nengine: claude-code\n---\nBody\n', problems);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/^model: /),
      expect.stringMatching(/^account: /),
    ]);
    const typo: Problem[] = [];
    parseAgent(
      'agents/a.md',
      '---\nengine: claude-code\nmodel: m\naccount: a\nmodle: x\n---\n',
      typo,
    );
    expect(typo).toEqual([
      expect.objectContaining({ line: 5, message: expect.stringMatching(/modle/) as string }),
    ]);
  });

  it('wants a name that matches the file', () => {
    const problems: Problem[] = [];
    parseAgent('agents/a.md', '---\nname: b\nengine: e\nmodel: m\naccount: a\n---\n', problems);
    expect(problems[0]?.message).toMatch(/must match its file name "a"/);
  });

  it("refuses the name adhoc, which ad-hoc sessions' folders use", () => {
    const problems: Problem[] = [];
    parseAgent('agents/adhoc.md', '---\nengine: e\nmodel: m\naccount: a\n---\n', problems);
    expect(problems[0]?.message).toMatch(/"adhoc" can't be an agent's name/);
  });
});

describe('skills.yaml', () => {
  it('maps skills to pinned versions', () => {
    const problems: Problem[] = [];
    expect(parseYaml('skills.yaml', 'skills:\n  notes: 3\n', skillsSchema, problems)).toEqual({
      skills: { notes: 3 },
    });
    parseYaml('skills.yaml', 'skills:\n  notes: ""\n', skillsSchema, problems);
    expect(problems.length).toBe(1);
  });
});

describe('workflow files', () => {
  it('reads each trigger and step kind', () => {
    const problems: Problem[] = [];
    const workflow = parseWorkflow(
      'workflows/w.yaml',
      [
        'trigger: { message: { channel: chat, contains: invoice } }',
        'steps:',
        '  - agent: chief-of-staff',
        '    task: Chase it.',
        '  - ask: { question: Send the reminder? }',
        '  - post: { channel: updates, text: Sent. }',
      ].join('\n'),
      problems,
    );
    expect(problems).toEqual([]);
    expect(workflow?.name).toBe('w');
    expect(workflow?.config.steps[1]).toEqual({
      ask: { question: 'Send the reminder?', channel: 'approvals' },
    });
    expect(
      parseWorkflow(
        'workflows/f.yaml',
        'trigger: { file: { path: "wiki/inbox/*.md" } }\nsteps: [{ post: { channel: c } }]\n',
        problems,
      ),
    ).not.toBeNull();
    expect(problems).toEqual([]);
  });

  it('refuses unknown triggers, bad cron and empty steps', () => {
    const problems: Problem[] = [];
    parseWorkflow('workflows/w.yaml', 'trigger: { webhook: x }\nsteps: []\n', problems);
    parseWorkflow(
      'workflows/w.yaml',
      'trigger: { schedule: "daily" }\nsteps: [{ post: { channel: c } }]\n',
      problems,
    );
    parseWorkflow(
      'workflows/w.yaml',
      'trigger: { schedule: "0 7 * * *" }\nsteps: [{ agent: a }]\n',
      problems,
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe('file kinds', () => {
  it('works out the kind from the name and folder', () => {
    expect(kindOf('/x/install.yaml')).toBe('install');
    expect(kindOf('/x/workspaces/a/workspace.yaml')).toBe('workspace');
    expect(kindOf('/x/workspaces/a/skills.yaml')).toBe('skills');
    expect(kindOf('/x/workspaces/a/agents/dev.md')).toBe('agent');
    expect(kindOf('/x/workspaces/a/workflows/brief.yml')).toBe('workflow');
    expect(kindOf('/x/notes.md')).toBeNull();
  });

  it('validates single files', async () => {
    expect((await validateFile(join(EXAMPLE, 'install.yaml'))).problems).toEqual([]);
    expect((await validateFile(join(EXAMPLE, 'workspaces/acme/agents/reviewer.md'))).kind).toBe(
      'agent',
    );
    expect((await validateFile(join(EXAMPLE, 'library/README.md'))).problems[0]?.message).toMatch(
      /Not a config file/,
    );
  });
});

describe('links between files', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds names that point nowhere', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wheems-config-'));
    cpSync(EXAMPLE, dir, { recursive: true });
    const acme = join(dir, 'workspaces/acme');
    writeFileSync(
      join(acme, 'workspace.yaml'),
      [
        'name: Acme',
        'chief_of_staff: boss',
        'accounts: [claude-subscription, chatgpt-subscription, missing-account]',
        'machine: nowhere',
        'skill_budget: 1',
        'channels:',
        '  chat: { connection: discord, channel: c }',
        'integrations:',
        '  linear: {}',
        'rules:',
        '  - name: r1',
        '    require: { review: ghost, before: merge }',
        '  - name: r2',
        '    action: deploy',
        '    approval: approvals',
      ].join('\n'),
    );
    writeFileSync(
      join(acme, 'workflows/broken.yaml'),
      'trigger: { message: { channel: nowhere } }\nsteps:\n  - agent: ghost\n    task: x\n  - post: { channel: briefs }\n',
    );
    const install = await loadInstall(dir);
    expect(install.problems).toEqual([]);
    const messages = crossCheck(install).map((p) => `${p.level} ${p.file}: ${p.message}`);
    expect(messages).toEqual([
      'error workspaces/acme/workspace.yaml: Account "missing-account" is not in install.yaml',
      'error workspaces/acme/workspace.yaml: Channel "chat" uses connection "discord", which is not in install.yaml',
      'error workspaces/acme/workspace.yaml: Integration "linear" is not a connection in install.yaml',
      'error workspaces/acme/workspace.yaml: Machine "nowhere" is not in install.yaml',
      'error workspaces/acme/workspace.yaml: The chief of staff "boss" has no file in agents/',
      'error workspaces/acme/workspace.yaml: Rule "r1" requires a review by "ghost", which has no file in agents/',
      'error workspaces/acme/workspace.yaml: Rule "r2" asks for approval in "approvals", which is not one of its channels',
      'warning workspaces/acme/skills.yaml: 2 skills is over the budget of 1',
      'error workspaces/acme/agents/developer.md: Integration "github" is not one of the workspace\'s integrations',
      'error workspaces/acme/agents/reviewer.md: Integration "github" is not one of the workspace\'s integrations',
      'error workspaces/acme/workflows/broken.yaml: Trigger channel "nowhere" is not one of the workspace\'s channels',
      'error workspaces/acme/workflows/broken.yaml: Step agent "ghost" has no file in agents/',
      'error workspaces/acme/workflows/broken.yaml: Channel "briefs" is not one of the workspace\'s channels',
      'error workspaces/acme/workflows/morning-brief.yaml: Channel "briefs" is not one of the workspace\'s channels',
    ]);
  });

  it('does not take inherited object properties for granted integrations or channels', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wheems-config-'));
    cpSync(EXAMPLE, dir, { recursive: true });
    const personal = join(dir, 'workspaces/personal');
    writeFileSync(
      join(personal, 'workspace.yaml'),
      [
        'name: Personal',
        'accounts: [claude-subscription]',
        'channels:',
        '  chat: { connection: slack, channel: c }',
        '  approvals: { connection: slack, channel: a }',
        '  updates: { connection: slack, channel: u }',
        'rules:',
        '  - name: r',
        '    action: deploy',
        '    approval: constructor',
      ].join('\n'),
    );
    writeFileSync(
      join(personal, 'agents/chief-of-staff.md'),
      '---\nengine: claude-code\nmodel: m\naccount: claude-subscription\nintegrations: [constructor]\n---\n',
    );
    mkdirSync(join(personal, 'workflows'));
    writeFileSync(
      join(personal, 'workflows/w.yaml'),
      'trigger: { message: { channel: tostring } }\nsteps:\n  - post: { channel: constructor }\n  - ask: { question: Ok?, channel: hasownproperty }\n',
    );
    const install = await loadInstall(dir);
    expect(install.problems).toEqual([]);
    const messages = crossCheck(install)
      .filter((p) => p.file.startsWith('workspaces/personal'))
      .map((p) => p.message);
    expect(messages).toEqual([
      'Rule "r" asks for approval in "constructor", which is not one of its channels',
      'Integration "constructor" is not one of the workspace\'s integrations',
      'Trigger channel "tostring" is not one of the workspace\'s channels',
      'Channel "constructor" is not one of the workspace\'s channels',
      'Channel "hasownproperty" is not one of the workspace\'s channels',
    ]);
  });

  it('reports a missing install.yaml and badly named workspace folders', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wheems-config-'));
    cpSync(join(EXAMPLE, 'workspaces/personal'), join(dir, 'workspaces/Bad Name'), {
      recursive: true,
    });
    const install = await loadInstall(dir);
    expect(install.config).toBeNull();
    expect(install.problems.map((p) => `${p.file}: ${p.message}`)).toEqual([
      'install.yaml: File is missing',
      expect.stringMatching(
        /^workspaces\/Bad Name: Workspace folder "Bad Name" is not a valid name/,
      ),
    ]);
  });
});
