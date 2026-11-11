/** Compares two dotted versions such as `0.1.20`. Pre-release and build suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

/** Finds the first `x.y.z` in text such as `hc 0.1.20` or `v22.12.0`. */
export function extractVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

function parts(version: string): number[] {
  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0] ?? '';
  return core.split('.').map((p) => {
    const n = Number.parseInt(p, 10);
    if (Number.isNaN(n)) throw new Error(`Not a version: ${version}`);
    return n;
  });
}
