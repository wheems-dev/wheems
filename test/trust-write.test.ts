import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { claudeTrusts, codexTrusts } from '../src/util/trust.js';
import { markClaudeTrusted, markCodexTrusted } from '../src/util/trust-write.js';

// Every file here is a temporary copy inside the repository (see test/setup): no test reads or
// writes this Mac's ~/.claude.json or ~/.codex/config.toml.
describe('marking a folder trusted', () => {
  let root: string;
  let install: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'trust-')));
    install = join(root, 'wheems');
    mkdirSync(install);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Files in a folder, so a test can see no temporary file was left behind. */
  const files = (dir: string) => readdirSync(dir).sort();

  describe('Claude Code (~/.claude.json)', () => {
    const claudeJson = {
      numStartups: 42,
      theme: 'dark',
      oauthAccount: { emailAddress: 'someone@example.com', organizationUuid: 'org-1' },
      projects: {
        '/Users/me/Projects/wheems': {
          allowedTools: [],
          hasTrustDialogAccepted: true,
          lastCost: 0.25,
        },
      },
      tipsHistory: { 'new-user-warmup': 1 },
    };

    it('adds the trust entry and keeps everything else, its format and its permissions', async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, `${JSON.stringify(claudeJson, null, 2)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      expect(await claudeTrusts(install, file)).toBe(false);

      expect(await markClaudeTrusted(install, file)).toBe('marked');
      const text = readFileSync(file, 'utf8');
      expect(JSON.parse(text)).toEqual({
        ...claudeJson,
        projects: { ...claudeJson.projects, [install]: { hasTrustDialogAccepted: true } },
      });
      // Same layout: two-space indent, keys in their order, the closing newline.
      expect(text).toBe(
        `${JSON.stringify(
          {
            ...claudeJson,
            projects: { ...claudeJson.projects, [install]: { hasTrustDialogAccepted: true } },
          },
          null,
          2,
        )}\n`,
      );
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(await claudeTrusts(install, file)).toBe(true);
      expect(await claudeTrusts(join(install, '.wheems', 'sessions'), file)).toBe(true);
      expect(files(root)).toEqual(['.claude.json', 'wheems']);
      // Asked again, it's already there, and the file isn't touched.
      expect(await markClaudeTrusted(install, file)).toBe('already');
      expect(readFileSync(file, 'utf8')).toBe(text);
    });

    it("keeps the folder's other settings when it has an entry already", async () => {
      const file = join(root, '.claude.json');
      const before = {
        projects: { [install]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false } },
      };
      writeFileSync(file, JSON.stringify(before, null, 2));
      await markClaudeTrusted(install, file);
      const text = readFileSync(file, 'utf8');
      expect(JSON.parse(text)).toEqual({
        projects: { [install]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true } },
      });
      expect(text.endsWith('\n')).toBe(false);
    });

    it('records the folder by its real path, as Claude Code does', async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, '{}\n');
      const link = join(root, 'link');
      symlinkSync(install, link);
      await markClaudeTrusted(link, file);
      expect(
        Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { projects: object }).projects),
      ).toEqual([install]);
    });

    it('writes through a symlinked ~/.claude.json, keeping the link', async () => {
      const real = join(root, 'dotfiles-claude.json');
      writeFileSync(real, '{}\n');
      const file = join(root, '.claude.json');
      symlinkSync(real, file);
      await markClaudeTrusted(install, file);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(await claudeTrusts(install, real)).toBe(true);
    });

    it.each([
      ['not JSON', '{"projects": {', "isn't valid JSON"],
      ['not an object', '[]', "isn't the JSON object Claude Code writes"],
      ['projects not an object', '{"projects": []}', "projects in .* isn't an object"],
      [
        'a number it would round',
        '{"big": 12345678901234567890}',
        'holds a number \\(12345678901234567890\\)',
      ],
      ['a number in another form', '{"x": 1.50}', 'holds a number \\(1.50\\)'],
    ])('refuses a file with %s, and leaves it as it was', async (_what, text, why) => {
      const file = join(root, '.claude.json');
      writeFileSync(file, text);
      await expect(markClaudeTrusted(install, file)).rejects.toThrow(new RegExp(why));
      expect(readFileSync(file, 'utf8')).toBe(text);
      expect(files(root)).toEqual(['.claude.json', 'wheems']);
    });

    it("refuses when Claude Code hasn't made the file yet, creating nothing", async () => {
      const file = join(root, '.claude.json');
      await expect(markClaudeTrusted(install, file)).rejects.toThrow(/Open Claude Code once/);
      expect(files(root)).toEqual(['wheems']);
    });

    it('starts over when the engine writes the file meanwhile, keeping its change', async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, '{\n  "numStartups": 1\n}\n');
      let engineWrites = 1;
      const result = await markClaudeTrusted(install, file, {
        pauseMs: 1,
        beforeCheck: () => {
          // Claude Code saves its config between Wheems's read and its write.
          if (engineWrites-- > 0) writeFileSync(file, '{\n  "numStartups": 2\n}\n');
          return Promise.resolve();
        },
      });
      expect(result).toBe('marked');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        numStartups: 2,
        projects: { [install]: { hasTrustDialogAccepted: true } },
      });
      expect(files(root)).toEqual(['.claude.json', 'wheems']);
    });

    it("holds Claude Code's own lock while it writes, so Claude Code can't save in between", async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, '{}\n');
      const lock = `${file}.lock`;
      let claudeCouldLock: boolean | null = null;
      await markClaudeTrusted(install, file, {
        // Claude Code tries to save after Wheems's last read: proper-lockfile's mkdir fails.
        beforeCheck: () => {
          try {
            mkdirSync(lock);
            claudeCouldLock = true;
          } catch {
            claudeCouldLock = false;
          }
          return Promise.resolve();
        },
      });
      expect(claudeCouldLock as boolean | null).toBe(false);
      expect(await claudeTrusts(install, file)).toBe(true);
      // Let go of afterwards.
      expect(files(root)).toEqual(['.claude.json', 'wheems']);
    });

    it('waits while Claude Code holds its lock, and writes once it lets go', async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, '{}\n');
      const lock = `${file}.lock`;
      mkdirSync(lock);
      setTimeout(() => {
        // Claude Code saves, then lets go.
        writeFileSync(file, '{\n  "numStartups": 7\n}\n');
        rmSync(lock, { recursive: true });
      }, 150);
      await markClaudeTrusted(install, file);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        numStartups: 7,
        projects: { [install]: { hasTrustDialogAccepted: true } },
      });
    });

    it('leaves the file and the lock alone when Claude Code keeps holding it', async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, '{}\n');
      const lock = `${file}.lock`;
      mkdirSync(lock);
      await expect(markClaudeTrusted(install, file, { lockWaitMs: 200 })).rejects.toThrow(
        /The engine is saving .* so Wheems left it alone/,
      );
      expect(readFileSync(file, 'utf8')).toBe('{}\n');
      expect(statSync(lock).isDirectory()).toBe(true);
    });

    it('takes over a lock left behind by a Claude Code that died', async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, '{}\n');
      const lock = `${file}.lock`;
      mkdirSync(lock);
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      expect(await markClaudeTrusted(install, file, { lockWaitMs: 200 })).toBe('marked');
      expect(files(root)).toEqual(['.claude.json', 'wheems']);
    });

    it('gives up, changing nothing, when the engine keeps writing it', async () => {
      const file = join(root, '.claude.json');
      writeFileSync(file, '{"n": 0}');
      let n = 0;
      await expect(
        markClaudeTrusted(install, file, {
          attempts: 3,
          pauseMs: 1,
          beforeCheck: () => {
            writeFileSync(file, `{"n": ${String(++n)}}`);
            return Promise.resolve();
          },
        }),
      ).rejects.toThrow(/kept changing while Wheems tried to update it. Close the engine/);
      expect(readFileSync(file, 'utf8')).toBe('{"n": 3}');
      expect(files(root)).toEqual(['.claude.json', 'wheems']);
    });
  });

  describe('Codex (config.toml)', () => {
    /** No Codex runs: the tests never ask this Mac's processes. */
    const closed = { codexRunning: () => Promise.resolve(false) };

    const config = [
      '# My Codex settings',
      'model = "gpt-6.1-sol"',
      'approval_policy = "on-request" # ask first',
      '',
      '[projects."/Users/me/Projects/wheems"]',
      'trust_level = "trusted"',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      "args = ['-y', 'docs-mcp']",
      '',
    ].join('\n');

    it('adds a table for the folder, leaving every other line as it was', async () => {
      const file = join(root, 'config.toml');
      writeFileSync(file, config, { mode: 0o644 });
      chmodSync(file, 0o644);
      expect(await codexTrusts(install, file)).toBe(false);
      expect(await markCodexTrusted(install, file, closed)).toBe('marked');
      const text = readFileSync(file, 'utf8');
      expect(text).toBe(`${config}\n[projects."${install}"]\ntrust_level = "trusted"\n`);
      expect(statSync(file).mode & 0o777).toBe(0o644);
      expect(await codexTrusts(install, file)).toBe(true);
      expect(await codexTrusts(join(install, '.wheems', 'sessions', 'acme'), file)).toBe(true);
      expect(await markCodexTrusted(install, file, closed)).toBe('already');
      expect(readFileSync(file, 'utf8')).toBe(text);
      expect(files(root)).toEqual(['config.toml', 'wheems']);
    });

    it('sets trust_level in the folder’s table when it has one', async () => {
      const file = join(root, 'config.toml');
      writeFileSync(
        file,
        `model = "o3"\n\n[projects."${install}"]\ntrust_level = "untrusted"  # said no once\nnote = "keep"\n`,
      );
      await markCodexTrusted(install, file, closed);
      expect(readFileSync(file, 'utf8')).toBe(
        `model = "o3"\n\n[projects."${install}"]\ntrust_level = "trusted"\nnote = "keep"\n`,
      );
    });

    it('adds trust_level under the table’s header when it has none', async () => {
      const file = join(root, 'config.toml');
      writeFileSync(file, `[projects."${install}"]\nnote = "keep"\n\n[other]\nx = 1\n`);
      await markCodexTrusted(install, file, closed);
      expect(readFileSync(file, 'utf8')).toBe(
        `[projects."${install}"]\ntrust_level = "trusted"\nnote = "keep"\n\n[other]\nx = 1\n`,
      );
    });

    it('keeps values TOML has and JSON lacks, such as dates', async () => {
      const file = join(root, 'config.toml');
      const text = 'updated = 2026-11-15T08:00:00Z\nday = 2026-11-15\nbig = 9007199254740991\n';
      writeFileSync(file, text);
      await markCodexTrusted(install, file, closed);
      expect(readFileSync(file, 'utf8')).toBe(
        `${text}\n[projects."${install}"]\ntrust_level = "trusted"\n`,
      );
    });

    it('makes the file when Codex has none yet', async () => {
      const file = join(root, 'config.toml');
      await markCodexTrusted(install, file, closed);
      expect(readFileSync(file, 'utf8')).toBe(`[projects."${install}"]\ntrust_level = "trusted"\n`);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('escapes a folder name TOML needs escaped, and keeps Windows line endings', async () => {
      const odd = join(root, 'my "odd" \\ folder');
      mkdirSync(odd);
      const file = join(root, 'config.toml');
      writeFileSync(file, 'model = "o3"\r\n');
      await markCodexTrusted(odd, file, closed);
      const text = readFileSync(file, 'utf8');
      expect(text).toBe(
        `model = "o3"\r\n\r\n[projects."${odd.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]\r\ntrust_level = "trusted"\r\n`,
      );
      expect(parseToml(text)).toEqual({
        model: 'o3',
        projects: { [odd]: { trust_level: 'trusted' } },
      });
    });

    it('changes nothing while Codex runs, checking again just before it writes', async () => {
      const file = join(root, 'config.toml');
      writeFileSync(file, 'model = "o3"\n');
      await expect(
        markCodexTrusted(install, file, { codexRunning: () => Promise.resolve(true) }),
      ).rejects.toThrow(/Codex is running, and it may save .* at any moment/);
      // Codex starts after Wheems read the file: it stops before writing.
      let checks = 0;
      await expect(
        markCodexTrusted(install, file, {
          codexRunning: () => Promise.resolve(++checks > 1),
        }),
      ).rejects.toThrow(/Codex is running/);
      expect(checks).toBe(2);
      // Can't tell: it doesn't guess.
      await expect(
        markCodexTrusted(install, file, { codexRunning: () => Promise.resolve(null) }),
      ).rejects.toThrow(/can't tell whether Codex is running/);
      expect(readFileSync(file, 'utf8')).toBe('model = "o3"\n');
      expect(files(root)).toEqual(['config.toml', 'wheems']);
    });

    it.each([
      ['not TOML', 'model = "o3\n', "isn't valid TOML"],
      [
        'projects as an inline table',
        `projects = { "/x" = { trust_level = "trusted" } }\n`,
        'without changing anything else',
      ],
      [
        'the folder as dotted keys',
        '[projects]\n"/FOLDER".trust_level = "untrusted"\n',
        "in a form Wheems doesn't edit",
      ],
      ['projects not a table', 'projects = 3\n', "projects in .* isn't a table"],
    ])('refuses a file with %s, and leaves it as it was', async (_what, template, why) => {
      const file = join(root, 'config.toml');
      const text = template.replace('/FOLDER', install);
      writeFileSync(file, text);
      await expect(markCodexTrusted(install, file, closed)).rejects.toThrow(new RegExp(why));
      expect(readFileSync(file, 'utf8')).toBe(text);
      expect(files(root)).toEqual(['config.toml', 'wheems']);
    });
  });
});
