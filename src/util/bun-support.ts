/**
 * Which Bun versions Wheems runs on: the one it's tested with (.bun-version) and later. Bun's
 * SQLite has full-text search (FTS5), which search needs, so doctor and search still check at
 * run time but never expect it missing.
 *
 * Kept free of imports: the CLI checks this before loading anything else.
 */
export const BUN_MINIMUM = '1.4.4';
export const BUN_SUPPORTED = `Bun ${BUN_MINIMUM} or later`;
export const BUN_INSTALL = 'curl -fsSL https://bun.sh/install | bash';

/** Why this runtime can't run Wheems, or null when it can. `bun` is `process.versions.bun`. */
export function bunVersionProblem(bun: string | undefined): string | null {
  if (bun === undefined) {
    return `Wheems runs on Bun, not Node.js. Install ${BUN_SUPPORTED}: ${BUN_INSTALL}`;
  }
  const parts = (version: string) => version.replace(/^v/, '').split(/[.-]/).map(Number);
  const have = parts(bun);
  const need = parts(BUN_MINIMUM);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a > b) return null;
    if (a < b)
      return `Bun ${bun} is too old for Wheems. Update it with bun upgrade, to ${BUN_SUPPORTED}.`;
  }
  return null;
}
