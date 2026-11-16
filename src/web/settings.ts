import { rename, writeFile } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { isMap, isScalar, parseDocument, type Document } from 'yaml';
import { loadInstall } from '../config/load.js';
import { agentFrontMatterSchema, workspaceSchema } from '../config/schemas.js';
import { paths } from '../home.js';
import { commitFiling } from '../knowledge/filing.js';
import { withReviewLock } from '../review/review.js';
import type { Flash, Form } from './actions.js';
import { settingsFiles, type WebContext } from './data.js';

/** The front matter of an agent file: the YAML between the first two `---` lines. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

/**
 * Saves a workspace's settings from the page: what `workspace.yaml` and the chief of staff's
 * agent file say, changing only the values given and keeping comments and everything else.
 * Nothing is written unless both files still read as the page showed them and both still pass
 * their checks after the change. The change is committed, and the service uses it once it
 * restarts.
 *
 * A change to the chief reaches open chat threads only as the person chooses for each, on the
 * page, before the restart: carry on, hand over or start fresh (docs/session-handover.md).
 */
export async function saveSettings(context: WebContext, id: string, form: Form): Promise<Flash> {
  const state = paths(context.home, context.env).state;
  try {
    return await withReviewLock(state, () => saveNow(context, id, form));
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

async function saveNow(context: WebContext, id: string, form: Form): Promise<Flash> {
  const install = await loadInstall(context.home);
  const workspace = install.workspaces.find((w) => w.id === id);
  if (!workspace) return { ok: false, text: `There's no workspace ${id}.` };
  const config = workspace.config;
  if (!config) {
    return {
      ok: false,
      text: "Its workspace.yaml has problems, so it can't be changed here. See them with: wheems doctor",
    };
  }
  const files = await settingsFiles(context.home, workspace);
  if (value(form, 'seen') !== files.seen) {
    return {
      ok: false,
      text: 'Not saved: its settings changed since the page showed them. Look again, then save.',
    };
  }

  const problems: string[] = [];
  const doc = parseDocument(files.workspaceText);
  const text = (name: string, label: string, path: string[], optional: boolean) => {
    const given = value(form, name);
    if (given === undefined) return;
    const trimmed = given.trim();
    if (trimmed.includes('\n')) problems.push(`${label} must be one line.`);
    else if (trimmed === '' && !optional) problems.push(`${label} can't be empty.`);
    else if (trimmed === '') doc.deleteIn(path);
    else setIfChanged(doc, path, trimmed);
  };
  const whole = (name: string, label: string, path: string[], least: number) => {
    const given = value(form, name);
    if (given === undefined) return;
    const number = Number(given.trim());
    if (given.trim() === '' || !Number.isInteger(number) || number < least) {
      problems.push(`${label} must be a whole number, ${String(least)} or more.`);
    } else setIfChanged(doc, path, number);
  };
  text('name', 'The name', ['name'], false);
  const hadDescription = doc.has('description');
  text('description', 'The description', ['description'], true);
  if (!hadDescription && doc.has('description')) besideName(doc, 'description');
  whole('maxOpenPerOwner', 'Open sessions per owner', ['sessions', 'max_open_per_owner'], 1);
  whole('maxDepth', 'How deep sessions may start sessions', ['sessions', 'max_depth'], 1);
  whole('noteAfterIdle', 'Minutes before a note', ['knowledge', 'note_after_idle'], 0);
  whole('skillBudget', 'The skill budget', ['skill_budget'], 1);
  const tidy = value(form, 'tidyAt')?.trim();
  if (tidy !== undefined) {
    if (tidy === 'off') setIfChanged(doc, ['knowledge', 'tidy_at'], false);
    else if (/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(tidy))
      setIfChanged(doc, ['knowledge', 'tidy_at'], tidy);
    else problems.push('The nightly tidy needs a 24-hour time, such as 03:00, or off.');
  }
  const postsAs = value(form, 'postsAs')?.trim();
  if (postsAs !== undefined) {
    if (postsAs.includes('\n')) problems.push('The name it posts as must be one line.');
    else if (postsAs === '') doc.deleteIn(['identity']);
    else setIfChanged(doc, ['identity', 'name'], postsAs);
  } else if (
    config.identity?.name === `${config.name} chief of staff` &&
    doc.get('name') !== config.name
  ) {
    // As wheems workspace rename does: the name it posts as follows, when it was made from the old one.
    setIfChanged(doc, ['identity', 'name'], `${String(doc.get('name'))} chief of staff`);
  }

  // The chief of staff's agent file: its engine, model, account and permissions.
  let chiefOut: string | null = null;
  const chiefFields = ['engine', 'model', 'account', 'permissions'].filter(
    (name) => value(form, name) !== undefined,
  );
  if (chiefFields.length > 0) {
    if (files.chiefFile === null || files.chiefText === null) {
      problems.push(`There's no agent file for the chief of staff, ${config.chief_of_staff}.`);
    } else {
      const match = FRONT_MATTER.exec(files.chiefText);
      const front = match ? parseDocument(match[1] ?? '') : null;
      if (!match || !front || front.errors.length > 0) {
        problems.push(`${basename(files.chiefFile)} has front matter that won't parse.`);
      } else {
        const engine = value(form, 'engine')?.trim();
        if (engine !== undefined) {
          if (!context.registry.has('engine', engine)) {
            problems.push(`There's no engine called ${engine}.`);
          } else setIfChanged(front, ['engine'], engine);
        }
        const model = value(form, 'model')?.trim();
        if (model !== undefined) {
          if (model === '' || model.includes('\n')) problems.push('Give a model, on one line.');
          else setIfChanged(front, ['model'], model);
        }
        const account = value(form, 'account')?.trim();
        if (account !== undefined) {
          if (!config.accounts.includes(account)) {
            problems.push(
              `The account must be one this workspace may use: ${config.accounts.join(', ')}.`,
            );
          } else setIfChanged(front, ['account'], account);
        }
        const permissions = value(form, 'permissions')?.trim();
        if (permissions !== undefined) {
          if (!['ask', 'auto', 'skip'].includes(permissions)) {
            problems.push('Permissions are ask, auto or skip.');
          } else setIfChanged(front, ['permissions'], permissions);
        }
        const checked = agentFrontMatterSchema.safeParse(front.toJS() ?? {});
        if (!checked.success) problems.push(...issues(basename(files.chiefFile), checked.error));
        const rest = files.chiefText.slice(match[0].length);
        chiefOut = `---\n${front.toString().trimEnd()}\n---${match[2] ?? '\n'}${rest}`;
      }
    }
  }

  const checked = workspaceSchema.safeParse(doc.toJS() ?? {});
  if (!checked.success) problems.push(...issues('workspace.yaml', checked.error));
  if (problems.length > 0) return { ok: false, text: `Not saved. ${problems.join(' ')}` };

  const workspaceOut = doc.toString();
  const changed: string[] = [];
  if (workspaceOut !== files.workspaceText) {
    await replace(files.workspaceFile, workspaceOut);
    changed.push(files.workspaceFile);
  }
  if (chiefOut !== null && files.chiefFile !== null && chiefOut !== files.chiefText) {
    await replace(files.chiefFile, chiefOut);
    changed.push(files.chiefFile);
  }
  if (changed.length === 0) return { ok: true, text: 'Nothing changed.' };
  const committed = await commitFiling(
    context.home,
    changed.map((file) => relative(context.home, file)),
    `Settings for ${id}, from the web app`,
  );
  return {
    ok: true,
    text: `Saved.${committed.ok ? '' : ' Not committed to git.'} The service uses it once it restarts.`,
  };
}

function value(form: Form, name: string): string | undefined {
  return form.get(name)?.[0];
}

/** Sets a value only when it differs, so an unchanged file stays byte for byte the same. */
function setIfChanged(doc: Document, path: string[], next: string | number | boolean): void {
  if (doc.getIn(path) === next) return;
  // A parent written as `{}` or missing becomes a block map, as a person would write it.
  const parent = path.slice(0, -1);
  if (parent.length > 0) {
    const node = doc.getIn(parent, true);
    if (isMap(node)) node.flow = false;
  }
  doc.setIn(path, next);
}

/** Moves a new top-level key to just after `name`, where a person would write it. */
function besideName(doc: Document, key: string): void {
  const top = doc.contents;
  if (!isMap(top)) return;
  // A key read from the file is a node; one just added may be a plain string.
  const keyOf = (k: unknown) => (isScalar(k) ? k.value : k);
  const at = top.items.findIndex((pair) => keyOf(pair.key) === key);
  const name = top.items.findIndex((pair) => keyOf(pair.key) === 'name');
  if (at === -1 || name === -1) return;
  const [pair] = top.items.splice(at, 1);
  if (pair) top.items.splice(name + 1, 0, pair);
}

function issues(
  file: string,
  error: { issues: { path: PropertyKey[]; message: string }[] },
): string[] {
  return error.issues.map(
    (issue) =>
      `${file}: ${issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}.`,
  );
}

/** Writes a file whole: to a new file beside it, then moved over it, so it's never half written. */
async function replace(file: string, text: string): Promise<void> {
  const next = `${file}.wheems-saving`;
  await writeFile(next, text);
  await rename(next, file);
}
