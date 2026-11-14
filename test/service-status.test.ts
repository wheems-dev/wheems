import { describe, expect, it } from 'vitest';
import { formatStatus, since, type StatusFacts } from '../src/cli/commands/service.js';

const stopped = { loaded: false, running: false, pid: null, lastExit: null };
const facts = (over: Partial<StatusFacts>): StatusFacts => ({
  launchd: stopped,
  installed: false,
  answering: false,
  report: null,
  logFile: '/Users/me/wheems/.wheems/logs/service.log',
  env: { HOME: '/Users/me' },
  now: Date.parse('2026-11-14T12:00:00Z'),
  ...over,
});

describe('wheems status', () => {
  it('shows each workspace, and what stops one from chatting', () => {
    const { text, ok } = formatStatus(
      facts({
        answering: true,
        report: {
          version: '0.0.4',
          pid: 4242,
          startedAt: '2026-11-14T09:46:00Z',
          home: '/Users/me/wheems',
          connections: ['slack'],
          workspaces: [
            { id: 'personal', chat: 'direct messages on slack' },
            {
              id: 'marketing',
              chat: '#marketing-chat on slack',
              problem: "the app can't see #marketing-chat on slack.",
            },
            { id: 'quiet', chat: null },
          ],
        },
      }),
      false,
    );
    expect(ok).toBe(true);
    expect(text).toBe(
      [
        '✓ Running: Wheems 0.0.4, pid 4242, up 2h 14m',
        '✓ Connected to slack',
        '✓ personal: direct messages on slack',
        "! marketing: the app can't see #marketing-chat on slack.",
        '- quiet: no chat channel',
        'Log: ~/wheems/.wheems/logs/service.log',
        '',
      ].join('\n'),
    );
  });

  it('says how to start it, or why it is down', () => {
    const first = (f: Partial<StatusFacts>) => formatStatus(facts(f), false).text.split('\n')[0];
    expect(first({})).toBe(
      '! Not running yet, so nothing answers in chat. Start it with: wheems start',
    );
    expect(first({ installed: true })).toBe(
      '! Stopped, so nothing answers in chat. Start it with: wheems start',
    );
    expect(first({ installed: true, launchd: { ...stopped, loaded: true, lastExit: '1' } })).toBe(
      '✗ Not running: it stopped (last exit 1), and launchd tries again every 30 seconds. See why: wheems logs',
    );
    expect(
      first({ installed: true, launchd: { loaded: true, running: true, pid: 7, lastExit: null } }),
    ).toMatch(/^! Starting, or stuck: launchd runs it \(pid 7\)/);
    expect(first({ answering: true, version: '0.0.3' })).toBe(
      '✓ Running: Wheems 0.0.3. Restart it (wheems restart) to see its channels here.',
    );
    expect(formatStatus(facts({ installed: true }), false).ok).toBe(false);
  });

  it('says how long it has been up, roughly', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(since('2026-11-14T11:59:30Z', now)).toBe('under a minute');
    expect(since('2026-11-14T11:56:00Z', now)).toBe('4m');
    expect(since('2026-11-14T09:46:00Z', now)).toBe('2h 14m');
    expect(since('2026-11-11T10:00:00Z', now)).toBe('3d 2h');
  });
});
