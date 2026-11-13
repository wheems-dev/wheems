import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadInstall, type LoadedInstall } from '../../config/load.js';
import { defaultHome, paths } from '../../home.js';
import { KnowledgeSearch, type IndexStatus, type SearchAnswer } from '../../knowledge/search.js';
import { request } from '../../service/control.js';
import type { Io } from '../program.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';

export function registerKb(program: Command, io: Io): void {
  const kb = program
    .command('kb')
    .description("Search and rebuild the workspaces' knowledge bases");

  kb.command('search')
    .description('Search the knowledge base by keyword and by meaning (agents run this)')
    .argument('<query...>', 'what to look for, in plain words')
    .option('--workspace <id>', 'the workspace (default: $WHEEMS_WORKSPACE, or the only one)')
    .option('--limit <n>', 'how many results', '5')
    .option('--json', 'print the results as JSON')
    .option('--home <dir>', homeHelp)
    .action(
      async (
        words: string[],
        options: { workspace?: string; limit: string; json?: boolean; home?: string },
      ) => {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit takes a whole number');
        const home = resolve(options.home ?? defaultHome(io.env));
        const install = await loadConfigured(home);
        const workspace = pickWorkspace(install, options.workspace ?? io.env.WHEEMS_WORKSPACE);
        const search = new KnowledgeSearch({
          install: install.config,
          workspaces: install.workspaces,
          registry: io.registry(),
          indexDir: paths(home, io.env).index,
        });
        try {
          const answer = await search.index(workspace).search(words.join(' '), limit);
          io.out(
            options.json === true ? `${JSON.stringify(answer, null, 2)}\n` : formatAnswer(answer),
          );
        } finally {
          await search.close();
        }
      },
    );

  kb.command('reindex')
    .description('Rebuild the search index from the files, and swap it in when it is done')
    .option('--workspace <id>', 'only this workspace (default: every workspace)')
    .option('--home <dir>', homeHelp)
    .action(async (options: { workspace?: string; home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const install = await loadConfigured(home);
      const targets =
        options.workspace !== undefined
          ? [pickWorkspace(install, options.workspace)]
          : install.workspaces.filter((w) => w.config).map((w) => w.id);
      const where = paths(home, io.env);
      // The running service owns the index; ask it, so the two never write at once.
      const running = await request(where.socket, { op: 'ping' }, 2000).then(
        (answer) => answer.ok,
        () => false,
      );
      if (running) {
        io.out('Rebuilding in the service…\n');
        for (const workspace of targets) {
          const answer = await request(where.socket, { op: 'reindex', workspace }, 60 * 60_000);
          if (!answer.ok) throw new Error(`${workspace}: ${answer.error}`);
          if (answer.index) io.out(formatStatus(workspace, answer.index));
        }
        return;
      }
      const search = new KnowledgeSearch({
        install: install.config,
        workspaces: install.workspaces,
        registry: io.registry(),
        indexDir: where.index,
      });
      try {
        for (const workspace of targets)
          io.out(formatStatus(workspace, await search.index(workspace).rebuild()));
      } finally {
        await search.close();
      }
    });
}

async function loadConfigured(
  home: string,
): Promise<LoadedInstall & { config: NonNullable<LoadedInstall['config']> }> {
  const install = await loadInstall(home);
  const config = install.config;
  if (!config) throw new Error(`The install at ${home} has config problems; run wheems doctor`);
  return { ...install, config };
}

function pickWorkspace(install: LoadedInstall, wanted: string | undefined): string {
  const ids = install.workspaces.filter((w) => w.config).map((w) => w.id);
  if (wanted !== undefined && wanted !== '') {
    if (!ids.includes(wanted))
      throw new Error(`No workspace "${wanted}". Workspaces: ${ids.join(', ') || 'none yet'}`);
    return wanted;
  }
  if (ids.length === 1 && ids[0] !== undefined) return ids[0];
  throw new Error(
    ids.length === 0
      ? 'There are no workspaces yet; create one with wheems setup'
      : `Say which workspace with --workspace: ${ids.join(', ')}`,
  );
}

export function formatAnswer(answer: SearchAnswer): string {
  const lines: string[] = [];
  if (answer.results.length === 0) lines.push('Nothing in the knowledge base matches.');
  for (const result of answer.results) {
    const details = [
      result.kind,
      result.updated !== null ? `updated ${result.updated.slice(0, 10)}` : null,
      result.origin === 'automated' ? 'from an automated job' : null,
    ].filter((part) => part !== null);
    lines.push(result.title, `  ${result.path} (${details.join(', ')})`, `  ${result.snippet}`, '');
  }
  if (answer.warning !== undefined) lines.push(`(${answer.warning})`);
  return `${lines.join('\n').trimEnd()}\n`;
}

function formatStatus(workspace: string, status: IndexStatus): string {
  const files = `${String(status.documents)} ${status.documents === 1 ? 'file' : 'files'}`;
  if (status.embeddings === null) return `${workspace}: indexed ${files}, keyword search only\n`;
  const missing = status.chunks - status.embedded;
  return `${workspace}: indexed ${files} with ${status.embeddings.model}${missing > 0 ? `; ${String(missing)} of ${String(status.chunks)} passages have no vector yet` : ''}\n`;
}
