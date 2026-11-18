/**
 * Wheems built as one executable (`bun run compile`, with `bun build --compile`): its own files
 * are inside it, under Bun's virtual /$bunfs/ folder, and it runs as itself rather than as Bun
 * running a script.
 */

/** Whether this is the one-file executable. */
export function isStandalone(): boolean {
  return Bun.main.startsWith('/$bunfs/');
}

let app: ReadonlyMap<string, string> | undefined;

/**
 * The built web app inside the executable: each file's path in the app (`assets/x.js`) and where
 * Bun keeps it. Set by the executable's entry point (scripts/compile.ts) before anything runs.
 */
export function embedApp(files: Record<string, string> | undefined): void {
  app = files === undefined ? undefined : new Map(Object.entries(files));
}

/** The web app embedded in the executable, or undefined when it's served from dist/web/app. */
export function embeddedApp(): ReadonlyMap<string, string> | undefined {
  return app;
}
