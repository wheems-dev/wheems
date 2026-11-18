/**
 * Builds the web app into dist/web/app, where the Wheems service serves it (`bun run build`).
 * Assets are named by their content, under /assets/, which the service lets browsers keep.
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outdir = fileURLToPath(new URL('../dist/web/app/', import.meta.url));
rmSync(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../web/index.html', import.meta.url))],
  outdir,
  minify: true,
  // React's production build.
  define: { 'process.env.NODE_ENV': '"production"' },
  publicPath: '/',
  naming: {
    entry: '[name].[ext]',
    chunk: 'assets/[name]-[hash].[ext]',
    asset: 'assets/[name]-[hash].[ext]',
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
