import type { RuntimeSkill } from '../../../contracts/runtime.js';

/**
 * The `wheems-herdr` skill: Herdr's own manual for `hc` (from `hc --skill`, so it matches the
 * installed version), after what Wheems allows. Programs that must keep running go in Herdr
 * terminals; agents never do, since they go through `wheems session` (docs/instructions.md).
 */
export function herdrSkill(manual: string): RuntimeSkill {
  // The manual is the body; any front matter of its own gives way to this skill's.
  const body = manual.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '').trim();
  const description =
    'How to run a program that must keep running past your turn, such as a dev server, a watcher or a long build or test run, in a Herdr terminal of its own with hc, where the person can watch it. Use when a program must outlive your turn. Never for starting an agent.';
  return {
    name: 'wheems-herdr',
    when: 'when a program must keep running past your turn, such as a dev server, a watcher or a\n  long test run. Never for starting an agent.',
    rule: "Use Herdr's `hc` only for programs that must keep running (`wheems-herdr`), never for an agent.",
    content: `---
name: wheems-herdr
description: ${JSON.stringify(description)}
---

<!-- Written by Wheems at every start; edits here are replaced. -->

# Herdr, in Wheems

You run in a Herdr terminal. Herdr's \`hc\` keeps programs running in terminals of their own, which
the person can attach to and watch. In Wheems:

- **Use \`hc\` for programs that must keep running** past your turn: a dev server, a watcher, a
  long build or test run. Give each a clear name, and start it in your own folder.
- **Never use \`hc\` for agents.** Don't start an agent (Claude Code, Codex, opencode, pi or any
  other) with \`hc run\`, use its templates, or send to an agent's terminal. Hand agent work on
  with \`wheems session\` (the \`wheems-sessions\` skill): Wheems keeps track of it, brings its
  answer back to you and keeps it running. This comes before "Delegate a task" and anything else
  about agents in Herdr's manual below.
- **Programs you start end when your session does,** and Wheems stops a session once it's quiet.
  If one must keep running after that, start it with \`--outlive-parent\`, say its name in your
  answer, and stop it with \`hc\` once it isn't needed.
- **Only touch your own terminals.** Never stop, send to or type into one you didn't start.

The rest is Herdr's own manual, for the installed \`hc\`.

${body}
`,
  };
}
