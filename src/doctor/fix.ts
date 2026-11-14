import type { DoctorCheck, DoctorReport } from './doctor.js';

/** What `offerFixes` needs from the terminal. */
export interface FixPrompt {
  /** Asks a yes-or-no question; no unless the person says yes. */
  ask(question: string): Promise<boolean>;
  out(text: string): void;
}

/**
 * `wheems doctor --fix`: for each failing or warning check that has a safe fix, says what's
 * wrong and what the fix will do, and asks before doing it. Nothing is ever fixed without a
 * yes. Returns how many were fixed and how many were offered.
 */
export async function offerFixes(
  report: DoctorReport,
  prompt: FixPrompt,
): Promise<{ fixed: number; offered: number }> {
  const fixable = report.sections
    .flatMap((section) => section.checks)
    .filter(
      (check): check is DoctorCheck & { fix: NonNullable<DoctorCheck['fix']> } =>
        check.fix !== undefined && (check.status === 'fail' || check.status === 'warn'),
    );
  if (fixable.length === 0) {
    prompt.out('\nNothing here that doctor can fix by itself.\n');
    return { fixed: 0, offered: 0 };
  }
  let fixed = 0;
  for (const check of fixable) {
    prompt.out(`\n${check.name}: ${check.message}\n`);
    if (!(await prompt.ask(`${check.fix.what}. Do it?`))) {
      prompt.out('Left as it is.\n');
      continue;
    }
    try {
      prompt.out(`${await check.fix.run()}\n`);
      fixed++;
    } catch (error) {
      prompt.out(`That didn't work: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return { fixed, offered: fixable.length };
}
