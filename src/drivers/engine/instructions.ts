import type { PlannedFile } from '../../contracts/engine.js';

/**
 * The instructions files every engine gets in a session's folder: `AGENTS.md` with everything,
 * which Codex and opencode read, and a `CLAUDE.md` whose one line has Claude Code read it too.
 * `AGENTS.md` holds it all rather than pointing elsewhere, since only Claude Code follows a
 * pointer. See docs/instructions.md.
 */
export function instructionsFiles(instructions: string): PlannedFile[] {
  return [
    {
      path: 'AGENTS.md',
      content: `<!-- Written by Wheems at every start; edits here are replaced. Edit WHEEMS.md, GOAL.md or agents/*.md instead. -->\n\n${instructions}\n`,
    },
    {
      path: 'CLAUDE.md',
      content: `<!-- Written by Wheems: Claude Code reads AGENTS.md through the line below. -->\n@AGENTS.md\n`,
    },
  ];
}
