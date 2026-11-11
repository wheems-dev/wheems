#!/usr/bin/env node
// A stand-in for Herdr core's hc command, so the Herdr runtime driver can be
// tested where Herdr is not installed (such as CI). It keeps terminals in a JSON
// file (FAKE_HC_STATE) and simulates two programs: anything with `sleep` in its
// command runs until killed; anything else echoes the first line it reads as
// `got:<line>` and exits 0. FAKE_HC_VERSION sets the version it reports and
// FAKE_HC_LOG, when set, gets one JSON line of arguments per call.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_HC_STATE;
const version = process.env.FAKE_HC_VERSION ?? '0.1.20';
if (process.env.FAKE_HC_LOG) appendFileSync(process.env.FAKE_HC_LOG, `${JSON.stringify(args)}\n`);

if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write(`hc ${version}\n`);
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
      long: positional.join(' ').includes('sleep'),
    };
    state.terminals.push(t);
    save();
    out(view(t));
    break;
  }
  case 'send': {
    const t = find(positional[0]);
    const text = positional[1] ?? '';
    if (t.state === 'finished') fail('finished', `${t.address} has finished`, 11);
    t.screen.push(text);
    if (!t.long) {
      // Echo programs print `<prefix>$line`; the prefix comes from an `echo "<prefix>$line"` in the command.
      const prefix = /echo "([^"$]*)\$line"/.exec(t.argv.join(' '))?.[1] ?? 'got:';
      t.screen.push(`${prefix}${text}`);
      t.state = 'finished';
      t.exit_code = 0;
    }
    save();
    out({
      turn: t.turn,
      status: t.status,
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
    out({ terminals: terminals.map(view), hidden_finished: 0, machines: [] });
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

function view(t) {
  const { screen: _screen, long: _long, ...rest } = t;
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
