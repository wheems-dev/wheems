import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import type { z } from 'zod';
import type { AgentDefinition } from '../contracts/engine.js';
import {
  agentFrontMatterSchema,
  installSchema,
  skillsSchema,
  workflowSchema,
  workspaceSchema,
  type AgentFrontMatter,
  type ConfigKind,
  type InstallConfig,
  type SkillsConfig,
  type WorkflowConfig,
  type WorkspaceConfig,
} from './schemas.js';

export interface Problem {
  level: 'error' | 'warning';
  /** The file, relative to the install folder where there is one. */
  file: string;
  line?: number;
  message: string;
}

export interface LoadedAgent {
  file: string;
  config: AgentFrontMatter;
  definition: AgentDefinition;
}

export interface LoadedWorkflow {
  file: string;
  name: string;
  config: WorkflowConfig;
}

export interface LoadedWorkspace {
  id: string;
  dir: string;
  config: WorkspaceConfig | null;
  agents: LoadedAgent[];
  skills: SkillsConfig | null;
  workflows: LoadedWorkflow[];
}

export interface LoadedInstall {
  home: string;
  config: InstallConfig | null;
  workspaces: LoadedWorkspace[];
  problems: Problem[];
}

/** Reads and validates an install folder: install.yaml and every workspace in it. */
export async function loadInstall(home: string): Promise<LoadedInstall> {
  const problems: Problem[] = [];
  const display = (file: string) => relative(home, file) || basename(file);
  const installFile = join(home, 'install.yaml');
  const config = await readYaml(installFile, installSchema, problems, display);

  const workspaces: LoadedWorkspace[] = [];
  const workspacesDir = join(home, 'workspaces');
  for (const id of await listDir(workspacesDir)) {
    const dir = join(workspacesDir, id);
    if (!(await isDirectory(dir))) continue;
    workspaces.push(await loadWorkspace(dir, id, problems, display));
  }
  return { home, config, workspaces, problems };
}

async function loadWorkspace(
  dir: string,
  id: string,
  problems: Problem[],
  display: (file: string) => string,
): Promise<LoadedWorkspace> {
  if (nameProblem(id)) {
    problems.push({
      level: 'error',
      file: display(dir),
      message: `Workspace folder "${id}" is not a valid name: use lowercase letters, digits and dashes`,
    });
  }
  const config = await readYaml(join(dir, 'workspace.yaml'), workspaceSchema, problems, display);

  const skillsFile = join(dir, 'skills.yaml');
  const skills = (await exists(skillsFile))
    ? await readYaml(skillsFile, skillsSchema, problems, display)
    : { skills: {} };

  const agents: LoadedAgent[] = [];
  for (const entry of await listDir(join(dir, 'agents'))) {
    if (extname(entry) !== '.md') continue;
    const file = join(dir, 'agents', entry);
    const agent = parseAgent(display(file), await readFile(file, 'utf8'), problems);
    if (agent) agents.push(agent);
  }

  const workflows: LoadedWorkflow[] = [];
  for (const entry of await listDir(join(dir, 'workflows'))) {
    const ext = extname(entry);
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const file = join(dir, 'workflows', entry);
    const workflow = parseWorkflow(display(file), await readFile(file, 'utf8'), problems);
    if (workflow) workflows.push(workflow);
  }

  return { id, dir, config, agents, skills, workflows };
}

/** Parses an agent file: YAML front matter between `---` lines, then Markdown instructions. */
export function parseAgent(file: string, text: string, problems: Problem[]): LoadedAgent | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    problems.push({
      level: 'error',
      file,
      line: 1,
      message: 'An agent file starts with YAML front matter between --- lines',
    });
    return null;
  }
  const config = parseYaml(file, match[1] ?? '', agentFrontMatterSchema, problems, 1);
  if (!config) return null;
  const fileName = basename(file, extname(file));
  const name = config.name ?? fileName;
  if (config.name !== undefined && config.name !== fileName) {
    problems.push({
      level: 'error',
      file,
      message: `The agent's name "${config.name}" must match its file name "${fileName}"`,
    });
  }
  return {
    file,
    config,
    definition: {
      name,
      description: config.description ?? null,
      engine: config.engine,
      model: config.model,
      account: config.account,
      skills: config.skills,
      integrations: config.integrations,
      permissions: config.permissions,
      instructions: text.slice(match[0].length).trim(),
    },
  };
}

export function parseWorkflow(
  file: string,
  text: string,
  problems: Problem[],
): LoadedWorkflow | null {
  const config = parseYaml(file, text, workflowSchema, problems);
  if (!config) return null;
  const fileName = basename(file, extname(file));
  if (config.name !== undefined && config.name !== fileName) {
    problems.push({
      level: 'error',
      file,
      message: `The workflow's name "${config.name}" must match its file name "${fileName}"`,
    });
  }
  return { file, name: config.name ?? fileName, config };
}

/**
 * Parses YAML text against a schema. Syntax and schema problems are added to
 * `problems` with line numbers; the result is `null` when there were any.
 */
export function parseYaml<S extends z.ZodType>(
  file: string,
  text: string,
  schema: S,
  problems: Problem[],
  lineOffset = 0,
): z.infer<S> | null {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const line = lineCounter.linePos(error.pos[0]).line + lineOffset;
      problems.push({
        level: 'error',
        file,
        line,
        message: error.message.split('\n')[0] ?? error.message,
      });
    }
    return null;
  }
  const result = schema.safeParse(doc.toJS() ?? {});
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    // For unknown keys, point at the first one rather than the object holding it.
    const path =
      issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys.slice(0, 1)] : issue.path;
    const line = lineFor(doc, lineCounter, path);
    problems.push({
      level: 'error',
      file,
      ...(line !== undefined && { line: line + lineOffset }),
      message: `${where}${issue.message}`,
    });
  }
  return null;
}

/** Validates one config file, working out its kind from its name and folder. */
export async function validateFile(
  path: string,
): Promise<{ kind: ConfigKind | null; problems: Problem[] }> {
  const problems: Problem[] = [];
  const kind = kindOf(path);
  const text = await readFile(path, 'utf8');
  switch (kind) {
    case 'install':
      parseYaml(path, text, installSchema, problems);
      break;
    case 'workspace':
      parseYaml(path, text, workspaceSchema, problems);
      break;
    case 'skills':
      parseYaml(path, text, skillsSchema, problems);
      break;
    case 'agent':
      parseAgent(path, text, problems);
      break;
    case 'workflow':
      parseWorkflow(path, text, problems);
      break;
    case null:
      problems.push({
        level: 'error',
        file: path,
        message:
          'Not a config file Wheems knows: expected install.yaml, workspace.yaml, skills.yaml, agents/*.md or workflows/*.yaml',
      });
  }
  return { kind, problems };
}

export function kindOf(path: string): ConfigKind | null {
  const name = basename(path);
  const folder = basename(join(path, '..'));
  if (name === 'install.yaml') return 'install';
  if (name === 'workspace.yaml') return 'workspace';
  if (name === 'skills.yaml') return 'skills';
  if (folder === 'agents' && extname(name) === '.md') return 'agent';
  if (folder === 'workflows' && (extname(name) === '.yaml' || extname(name) === '.yml'))
    return 'workflow';
  return null;
}

async function readYaml<S extends z.ZodType>(
  path: string,
  schema: S,
  problems: Problem[],
  display: (file: string) => string,
): Promise<z.infer<S> | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      problems.push({ level: 'error', file: display(path), message: 'File is missing' });
      return null;
    }
    throw error;
  }
  return parseYaml(display(path), text, schema, problems);
}

/** The line a schema issue is about: the key it names, or the nearest node above it. */
function lineFor(doc: Document, lineCounter: LineCounter, path: PropertyKey[]): number | undefined {
  const lineOf = (node: unknown): number | undefined =>
    isNode(node) && node.range ? lineCounter.linePos(node.range[0]).line : undefined;
  let node: unknown = doc.contents;
  let line = lineOf(node);
  for (const segment of path) {
    if (isMap(node)) {
      const pair = node.items.find(
        (p) => String(isScalar(p.key) ? p.key.value : p.key) === String(segment),
      );
      if (!pair) break;
      line = lineOf(pair.key) ?? line;
      node = pair.value;
    } else if (isSeq(node) && typeof segment === 'number') {
      node = node.items[segment];
      line = lineOf(node) ?? line;
    } else {
      break;
    }
  }
  return line;
}

function nameProblem(name: string): boolean {
  return !/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((entry) => !entry.startsWith('.')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
