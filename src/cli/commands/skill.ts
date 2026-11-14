import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultHome, paths } from '../../home.js';
import { request } from '../../service/control.js';
import { listLibrary, readSkill } from '../../skills/library.js';
import { listProposals } from '../../skills/proposals.js';
import type { Io } from '../program.js';
import { speakerFrom } from '../caller.js';

const homeHelp = 'the install folder (default: $WHEEMS_HOME or ~/wheems)';

export function registerSkill(program: Command, io: Io): void {
  const skill = program.command('skill').description("The install's skill library");

  skill
    .command('propose')
    .description(
      'Propose a new skill, or a change to one, for the person to review (agents run this)',
    )
    .argument('<name>', 'the skill, in lowercase words joined by dashes')
    .argument('[input]', '"-": read the SKILL.md from standard input, which is also the default')
    .option('--home <dir>', homeHelp)
    .action(async (name: string, input: string | undefined, options: { home?: string }) => {
      if (input !== undefined && input !== '-') {
        throw new Error(
          'Pipe the SKILL.md in on standard input, with "-" or nothing after the name.',
        );
      }
      const from = speakerFrom(
        io.env,
        'wheems skill propose',
        ' To add a skill yourself, put it in library/skills/<name>/1/SKILL.md.',
      );
      const text = (await io.stdin()).trim();
      if (text === '') throw new Error('Pipe the SKILL.md in on standard input.');
      const home = resolve(options.home ?? defaultHome(io.env));
      const answer = await request(paths(home, io.env).socket, {
        op: 'propose-skill',
        ...from,
        name,
        text,
      });
      if (!answer.ok) throw new Error(answer.error);
      io.out(answer.message ?? 'Proposed.\n');
    });

  skill
    .command('list')
    .description('List the skills in the library, and proposals waiting for review')
    .option('--json', 'print them as JSON')
    .option('--home <dir>', homeHelp)
    .action(async (options: { json?: boolean; home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      const library = await listLibrary(home);
      const waiting = (await listProposals(paths(home, io.env).state)).map((w) => w.proposal);
      if (options.json === true) {
        io.out(`${JSON.stringify({ library, waiting }, null, 2)}\n`);
        return;
      }
      const lines: string[] = [];
      if (library.length === 0) lines.push('The library has no skills yet.');
      for (const s of library) {
        lines.push(
          `${s.name} (version ${String(s.latest)}${s.writtenBy === 'person' ? ', written by a person' : ''})`,
          `  ${s.description || '(no description)'}`,
        );
      }
      if (waiting.length > 0) {
        lines.push('', 'Waiting for review:');
        for (const p of waiting) {
          lines.push(
            `  ${p.name}${p.basedOn !== null ? ` (version ${String(p.basedOn + 1)})` : ' (new)'}, from ${p.agent} in ${p.workspace}`,
          );
        }
      }
      io.out(`${lines.join('\n')}\n`);
    });

  skill
    .command('show')
    .description("Print a skill's SKILL.md: the latest version, or the one asked for")
    .argument('<name>', 'the skill')
    .argument('[version]', 'this version instead of the latest')
    .option('--home <dir>', homeHelp)
    .action(async (name: string, wanted: string | undefined, options: { home?: string }) => {
      const home = resolve(options.home ?? defaultHome(io.env));
      let version: number | undefined;
      if (wanted !== undefined) {
        version = /^[1-9][0-9]*$/.test(wanted) ? Number(wanted) : Number.NaN;
        if (Number.isNaN(version)) throw new Error('The version is a whole number, such as 2');
      }
      const found = await readSkill(home, name, version);
      if (found === null) {
        throw new Error(
          version === undefined
            ? `No skill ${name} in the library (wheems skill list)`
            : `${name} has no version ${String(version)}`,
        );
      }
      io.out(found.text.endsWith('\n') ? found.text : `${found.text}\n`);
    });
}
