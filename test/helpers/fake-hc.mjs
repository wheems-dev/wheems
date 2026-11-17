#!/usr/bin/env node
// A stand-in for Herdr core's hc command, so the Herdr runtime driver can be
// tested where Herdr is not installed (such as CI). It keeps terminals in a JSON
// file (FAKE_HC_STATE) and simulates two programs: anything with `sleep` in its
// command runs until killed; anything else echoes the first line it reads as
// `got:<line>` and exits 0. FAKE_HC_VERSION sets the version it reports and
// FAKE_HC_LOG, when set, gets one JSON line of arguments per call. FAKE_HC_SKILL is its
// manual for agents.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_HC_STATE;
const version = process.env.FAKE_HC_VERSION ?? '0.1.20';
if (process.env.FAKE_HC_LOG) appendFileSync(process.env.FAKE_HC_LOG, `${JSON.stringify(args)}\n`);

if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write(`hc ${version}\n`);
  process.exit(0);
}
// FAKE_HC_SKILL is what `hc --skill` prints; without it, hc has none and fails.
if (args[0] === '--skill') {
  if (process.env.FAKE_HC_SKILL === undefined) {
    process.stderr.write('unknown option --skill\n');
    process.exit(2);
  }
  process.stdout.write(process.env.FAKE_HC_SKILL);
  process.exit(0);
}
if (process.env.FAKE_HC_BAD_OUTPUT) {
  process.stdout.write('this is not json\n');
  process.exit(0);
}
if (!statePath) fail('usage', 'FAKE_HC_STATE is not set', 2);

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { next: 1, terminals: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state));

const [command, ...rest] = args;
const { options, positional } = parse(rest);

switch (command) {
  case 'server': {
    if (positional[0] === 'status') out({ version, pid: 1, live: live().length });
    else if (positional[0] === 'stop') out({ stopped: true });
    else fail('usage', `unknown server command ${positional[0]}`, 2);
    break;
  }
  case 'run': {
    const name = options.name?.[0];
    if (name && live().some((t) => t.name === name)) fail('usage', `name ${name} is taken`, 2);
    const t = {
      address: `t${state.next++}`,
      name: name ?? null,
      argv: positional,
      cwd: options.cwd?.[0] ?? process.cwd(),
      state: 'live',
      status: null,
      turn: 0,
      exit_code: null,
      labels: Object.fromEntries((options.label ?? []).map((l) => l.split('=', 2))),
      screen: [],
      long: positional.join(' ').includes('sleep') || positional.join(' ').includes('fake-agent'),
    };
    // A fake agent reports statuses like Claude Code: idle at start, done after each message.
    if (positional.join(' ').includes('fake-agent')) t.status = 'idle';
    state.terminals.push(t);
    save();
    out(view(t));
    break;
  }
  case 'send': {
    const t = find(positional[0]);
    const text = positional[1] ?? '';
    if (t.state === 'finished') fail('finished', `${t.address} has finished`, 11);
    // Like hc: the result reports the turn and status when the text went in.
    const before = { turn: t.turn, status: t.status };
    t.screen.push(text);
    if (t.status !== null) {
      t.turn += 1;
      t.status = 'done';
    }
    if (!t.long) {
      // Echo programs run `echo "<prefix>$<var>"`: $line is what was typed, anything else
      // comes from the VAR=value assignments of an /usr/bin/env prefix.
      const echo = /echo "([^"$]*)\$([A-Za-z_]+)"/.exec(t.argv.join(' '));
      const prefix = echo?.[1] ?? 'got:';
      const variable = echo?.[2] ?? 'line';
      const assignments =
        t.argv[0] === '/usr/bin/env'
          ? t.argv.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a))
          : [];
      const env = Object.fromEntries(
        assignments.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]),
      );
      t.screen.push(`${prefix}${variable === 'line' ? text : (env[variable] ?? '')}`);
      t.state = 'finished';
      t.exit_code = 0;
    }
    save();
    out({
      turn: before.turn,
      status: before.status,
      started: null,
      ...(options.wait ? { wait: waitResult(t) } : {}),
    });
    break;
  }
  case 'read': {
    const t = find(positional[0]);
    out({ text: t.screen.join('\n'), complete: true, how: 'screen' });
    break;
  }
  case 'wait': {
    out(waitResult(find(positional[0])));
    break;
  }
  case 'get': {
    out(view(find(positional[0])));
    break;
  }
  case 'ls': {
    const labels = Object.fromEntries((options.label ?? []).map((l) => l.split('=', 2)));
    const terminals = (options.all ? state.terminals : live()).filter((t) =>
      Object.entries(labels).every(([k, v]) => t.labels[k] === v),
    );
    out({
      // Like real hc, ls leaves labels out; get reports them.
      terminals: terminals.map(({ labels: _labels, ...t }) => view(t, { statusWord: true })),
      hidden_finished: 0,
      machines: [],
    });
    break;
  }
  case 'kill': {
    const t = find(positional[0]);
    t.state = 'finished';
    save();
    out(view(t));
    break;
  }
  case 'rm': {
    const t = find(positional[0]);
    if (t.state === 'live') fail('live', `${t.address} is still running`, 1);
    state.terminals = state.terminals.filter((x) => x !== t);
    save();
    out({ removed: t.address });
    break;
  }
  default:
    fail('usage', `unknown command ${command}`, 2);
}

function live() {
  return state.terminals.filter((t) => t.state === 'live');
}

function find(address) {
  const byAddress = state.terminals.find((t) => t.address === address);
  if (byAddress) return byAddress;
  const named = state.terminals.filter((t) => t.name === address);
  const found = named.find((t) => t.state === 'live') ?? named.at(-1);
  if (!found) fail('not_found', `no terminal "${address}"`, 3, 'see `hc ls --all`');
  return found;
}

function waitResult(t) {
  if (t.state === 'live' && t.status !== null && t.status !== 'working') {
    return {
      terminal: t.address,
      ended: true,
      reason: 'status',
      status: t.status,
      exit_code: null,
      signal: null,
      turn: t.turn,
      children: [],
    };
  }
  if (t.state === 'finished') {
    return {
      terminal: t.address,
      ended: true,
      reason: 'exit',
      status: null,
      exit_code: t.exit_code,
      signal: null,
      turn: t.turn,
      children: [],
    };
  }
  return {
    terminal: t.address,
    ended: false,
    reason: 'timeout',
    status: null,
    exit_code: null,
    signal: null,
    turn: t.turn,
    children: [],
  };
}

// Like real hc: `get`, `run` and `kill` report the status record, `ls` reports the word.
function view(t, { statusWord = false } = {}) {
  const { screen: _screen, long: _long, ...rest } = t;
  if (rest.status != null && !statusWord) rest.status = { app: 'fake', state: rest.status };
  return rest;
}

function parse(list) {
  const flags = new Set([
    'json',
    'bg',
    'no-parent',
    'no-notify',
    'wait',
    'all',
    'rm',
    'keep',
    'force',
  ]);
  const options = {};
  const positional = [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === '--') {
      positional.push(...list.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (flags.has(key)) options[key] = true;
      else (options[key] ??= []).push(list[++i]);
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(kind, message, code, hint) {
  process.stderr.write(`${JSON.stringify({ error: { kind, message, hint: hint ?? null } })}\n`);
  process.exit(code);
}
