// Imported rather than read, so a one-file executable carries it inside.
import pkg from '../../package.json' with { type: 'json' };

export function packageVersion(): string {
  return pkg.version;
}
