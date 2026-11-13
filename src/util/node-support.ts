/**
 * Which Node.js versions Wheems runs on. Search needs SQLite's full-text search (FTS5) in
 * Node's built-in `node:sqlite`. Node bundles SQLite with FTS5 from 22.16.0 and 24.0.0 (nodejs
 * PR 57621); no Node 23 release has it, and below 22.13 `node:sqlite` needs a flag. Builds that
 * use the system's SQLite can still lack it, so doctor and search also check at run time.
 *
 * Kept free of imports: the CLI checks this before loading anything else.
 */
export const NODE_SUPPORTED = 'Node.js 22.16 or later in the 22 line, or 24 or later';

/** Why this Node.js version can't run Wheems, or null when it can. */
export function nodeVersionProblem(version: string): string | null {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  if (major === 23) {
    return `Node.js ${version} can't run Wheems: no Node 23 release has SQLite full-text search, which Wheems's search needs. Use ${NODE_SUPPORTED}.`;
  }
  if (major < 22 || (major === 22 && minor < 16)) {
    return `Node.js ${version} is too old for Wheems. Use ${NODE_SUPPORTED}.`;
  }
  return null;
}
