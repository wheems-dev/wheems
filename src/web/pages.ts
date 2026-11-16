import type { DoctorReport } from '../doctor/doctor.js';
import type { SessionRecord } from '../state/store.js';
import type {
  AboutYouView,
  ConnectionsView,
  InstallSummary,
  ReviewView,
  SettingsView,
  SessionMessage,
  TreeItem,
  WorkspacePage,
  WorkspaceSummary,
} from './data.js';

/** Text made safe to put in HTML, in an element or a quoted attribute. */
export function esc(text: string | number | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Current = 'overview' | 'sessions' | 'review' | 'settings' | 'connections' | 'about' | 'setup';

const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  check: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  link: '<path d="M9 7H7a5 5 0 0 0 0 10h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  twig: '<path d="M5 2v10a4 4 0 0 0 4 4h12"/>',
  updown: '<path d="M8 9l4-4 4 4"/><path d="M8 15l4 4 4-4"/>',
};

function icon(paths: string, size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const LOGO = `<svg width="30" height="25" viewBox="78 94 372 306" aria-hidden="true"><path class="cloud" d="M170 400C116 400 78 364 78 315C78 278 100 248 132 234C124 195 148 158 183 158C195 158 208 162 220 170C230 123 267 94 311 94C370 94 414 138 414 200C414 222 408 243 396 259C430 271 450 296 450 326C450 369 415 400 372 400Z"/><circle class="face" cx="170" cy="272" r="26"/><path class="smile" d="M144 330Q172 354 200 330" fill="none" stroke-width="28" stroke-linecap="round"/></svg>`;

/** The page around every view: the sidebar with the workspace switcher, then the content. */
function layout(options: {
  title: string;
  install: InstallSummary;
  workspace: WorkspaceSummary | null;
  current: Current;
  body: string;
}): string {
  const { install, workspace, current } = options;
  const here = (page: Current) => (page === current ? ' aria-current="page"' : '');
  const switcher =
    workspace === null
      ? ''
      : `<details class="switcher">
  <summary><span class="av">${esc(workspace.initial)}</span><span class="grow"><span class="muted small" style="font-size:11px;font-weight:700">WORKSPACE</span><span style="font-weight:800">${esc(workspace.name)}</span></span>${icon(ICONS.updown, 16)}</summary>
  <div class="menu">
    ${install.workspaces
      .map(
        (w) =>
          `<a class="mi" href="/w/${encodeURIComponent(w.id)}${current === 'sessions' || current === 'review' || current === 'settings' ? `/${current}` : ''}"${w.id === workspace.id ? ' aria-current="true"' : ''}><span class="av">${esc(w.initial)}</span><span class="grow"><span style="font-weight:700">${esc(w.name)}</span><span class="muted" style="font-size:12px">${esc(w.chat)}</span></span>${w.id === workspace.id ? '<span aria-hidden="true">✓</span>' : ''}</a>`,
      )
      .join('\n    ')}
  </div>
</details>`;
  // Install pages keep the chosen workspace in the switcher.
  const inWorkspace = workspace === null ? '' : `?w=${encodeURIComponent(workspace.id)}`;
  const workspaceNav =
    workspace === null
      ? ''
      : `<span class="navlabel">${esc(workspace.name)}</span>
    <a href="/w/${encodeURIComponent(workspace.id)}"${here('overview')}>${icon(ICONS.home)}Overview</a>
    <a href="/w/${encodeURIComponent(workspace.id)}/sessions"${here('sessions')}>${icon(ICONS.chat)}Sessions</a>
    <a href="/w/${encodeURIComponent(workspace.id)}/review"${here('review')}>${icon(ICONS.check)}<span style="flex:1">Review</span>${workspace.waiting > 0 ? `<span class="badge warn" style="height:20px;padding:0 8px">${String(workspace.waiting)}</span>` : ''}</a>
    <a href="/w/${encodeURIComponent(workspace.id)}/settings"${here('settings')}>${icon(ICONS.gear)}Settings</a>`;
  const service = install.service.running
    ? `<span class="badge ok">● Service running</span><span class="soft small">Wheems ${esc(install.service.report?.version)}</span>`
    : `<span class="badge no">● Service not running</span><span class="soft small">Start it with <span class="mono">wheems start</span></span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)} · Wheems</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js"></script>
</head>
<body>
<div class="app">
  <aside class="side">
    <a class="brand" href="/">${LOGO}Wheems</a>
    ${switcher}
    <nav class="nav" aria-label="Main">
    ${workspaceNav}
    <span class="navlabel">Install</span>
    <a href="/connections${inWorkspace}"${here('connections')}>${icon(ICONS.link)}Connections</a>
    <a href="/about-you${inWorkspace}"${here('about')}>${icon(ICONS.person)}About you</a>
    <a href="/setup${inWorkspace}"${here('setup')}>${icon(ICONS.tool)}Setup and health</a>
    </nav>
    <div class="foot">${service}<button class="theme" id="theme" type="button">Dark mode</button></div>
  </aside>
  <main class="mainp"><div class="wrap">
${options.body}
  </div></main>
</div>
</body>
</html>`;
}

function badgeFor(s: SessionRecord): string {
  const [cls, text] =
    s.state === 'working'
      ? ['info', 'Working']
      : s.state === 'starting'
        ? ['info', 'Starting']
        : s.state === 'idle'
          ? ['idle', 'Idle']
          : s.state === 'stopped'
            ? ['warn', 'Stopped']
            : ['idle', 'Ended'];
  return `<span class="badge ${cls}">${text}</span>`;
}

function treeRows(
  items: TreeItem[],
  workspace: string,
  selected: string | null,
  showingEnded = false,
): string {
  return items
    .map((item) => {
      const s = item.session;
      const indent = 20 + (item.depth - 1) * 28;
      const cls = `tree${s.id === selected ? ' sel' : ''}${s.state === 'ended' ? ' ended' : ''}`;
      return `<a class="${cls}" style="padding-left:${String(indent)}px" href="/w/${encodeURIComponent(workspace)}/sessions?s=${encodeURIComponent(s.id)}${showingEnded ? '&amp;ended=1' : ''}">${icon(ICONS.twig)}<span class="grow"><span class="title">${esc(item.label)}</span><span class="muted small">${esc(item.kind)} · ${esc(ago(s.lastActiveAt))} ago</span></span>${badgeFor(s)}</a>`;
    })
    .join('\n');
}

function healthPills(install: InstallSummary): string {
  const service = install.service.running
    ? '<a class="pill" href="/setup"><span class="dot-ok">●</span>Service running</a>'
    : '<a class="pill" href="/setup"><span class="dot-no">●</span>Service not running</a>';
  const connections = (install.service.report?.connections ?? []).map(
    (c) =>
      `<a class="pill" href="/setup"><span class="dot-ok">●</span>${esc(c.charAt(0).toUpperCase() + c.slice(1))} connected</a>`,
  );
  const problems =
    install.problems > 0
      ? `<a class="pill" href="/setup"><span class="dot-no">●</span>${String(install.problems)} config ${install.problems === 1 ? 'problem' : 'problems'}</a>`
      : '';
  return `<div class="row" aria-label="Install health">${[service, ...connections, problems].join('')}</div>`;
}

export function overviewPage(page: WorkspacePage): string {
  const w = page.workspace;
  const chief = page.chief;
  const needs =
    page.proposals > 0
      ? `<section class="card pad notice row between" aria-labelledby="needs"><div class="stack"><h2 id="needs">Needs you</h2><p class="soft">${String(page.proposals)} skill ${page.proposals === 1 ? 'proposal waits' : 'proposals wait'} for your review.</p></div><a class="pill" href="/w/${encodeURIComponent(w.id)}/review">Review ${String(page.proposals)}</a></section>`
      : '';
  const tree =
    page.chiefTree.length === 0
      ? '<p class="empty">No open conversations or sessions. Message the chief in chat to start one.</p>'
      : treeRows(page.chiefTree, w.id, null);
  const store = page.storeProblem
    ? `<p class="empty">Couldn't read the session store: ${esc(page.storeProblem)}</p>`
    : '';
  const skills =
    page.skills.length === 0
      ? '<p class="muted">No skills pinned in skills.yaml yet.</p>'
      : `<div class="row">${page.skills.map((s) => `<span class="mono tag">${esc(s.name)} v${String(s.version)}</span>`).join('')}</div>`;
  const body = `
<header class="row">
  <span class="av big">${esc(w.initial)}</span>
  <div class="stack" style="flex:1 1 280px">
    <h1>${esc(w.name)}</h1>
    <span class="muted">Chats in ${esc(w.chat)}${chief ? ` · its chief runs on ${esc(chief.engine)} (<span class="mono">${esc(chief.model)}</span>)` : ''}</span>
  </div>
</header>
${healthPills(page.install)}
${needs}
<section class="card" aria-labelledby="team" style="overflow:hidden">
  <div class="group"><span class="av inv">C</span><span class="grow"><h2 id="team">Chief of staff</h2><span class="muted small" style="font-weight:500">The agent you talk to. It starts sessions to work on things, and a session can start its own.</span></span><a class="small" href="/w/${encodeURIComponent(w.id)}/sessions">All sessions</a></div>
  ${store}${tree}
</section>
${page.mine.length > 0 ? `<section class="card" aria-labelledby="mine" style="overflow:hidden"><div class="group"><span class="av">Y</span><h2 id="mine">Started by you</h2></div>${treeRows(page.mine, w.id, null)}</section>` : ''}
<div class="grid">
  <section class="card pad stack" aria-labelledby="kb" style="gap:12px">
    <h2 id="kb">Knowledge base</h2>
    <div class="stats"><div class="stat"><b>${String(page.knowledge.pages)}</b><span>pages</span></div><div class="stat"><b>${String(page.knowledge.inbox)}</b><span>notes in the inbox</span></div><div class="stat"><b>${String(page.skills.length)}</b><span>skills</span></div></div>
    <p class="muted small">Search it with <span class="mono">wheems knowledgebase search "…"</span>. Search from this page comes next.</p>
  </section>
  <section class="card pad stack" aria-labelledby="sk" style="gap:12px">
    <h2 id="sk">Skills</h2>
    ${skills}
  </section>
</div>`;
  return layout({ title: w.name, install: page.install, workspace: w, current: 'overview', body });
}

export function sessionsPage(
  page: WorkspacePage,
  selected: SessionRecord | null,
  messages: SessionMessage[],
  showingEnded: boolean,
): string {
  const w = page.workspace;
  const base = `/w/${encodeURIComponent(w.id)}/sessions`;
  const all = [...page.chiefTree, ...page.mine];
  const list = `
<section class="card list" aria-label="Session tree">
  <div class="group"><span class="av inv">C</span><span class="grow">Chief of staff<span class="muted small" style="font-weight:500">${page.chief ? esc(`${page.chief.engine} · ${page.chief.model}`) : ''}</span></span></div>
  ${page.chiefTree.length === 0 ? '<p class="empty">Nothing here yet.</p>' : treeRows(page.chiefTree, w.id, selected?.id ?? null, showingEnded)}
  ${page.mine.length > 0 ? `<div class="group" style="border-top:1px solid var(--hair)"><span class="av">Y</span>Started by you</div>${treeRows(page.mine, w.id, selected?.id ?? null, showingEnded)}` : ''}
  <p class="empty small"><a href="${showingEnded ? base : `${base}?ended=1`}">${showingEnded ? 'Hide ended sessions' : 'Show ended sessions'}</a></p>
</section>`;
  const detail =
    selected === null
      ? `<section class="card detail" aria-label="Session detail"><p class="muted">${all.length === 0 ? 'No sessions yet.' : 'Choose a session to see what it was asked and its latest messages.'}</p></section>`
      : `<section class="card detail" aria-label="Session detail">
  <div class="stack">
    ${badgeFor(selected)}
    <h2 style="font-size:22px;font-weight:800">${esc(all.find((i) => i.session.id === selected.id)?.label ?? selected.id)}</h2>
    <span class="mono muted small">${esc(selected.id)}${selected.herdrName ? ` · ${esc(selected.herdrName)} in Herdr` : ''}</span>
  </div>
  <div class="facts">
    ${selected.ask !== null ? `<div class="stack" style="gap:2px"><span>Your original ask</span><span>${esc(selected.ask)}</span></div>` : ''}
    ${selected.purpose !== null ? `<div class="stack" style="gap:2px"><span>Purpose</span><span>${esc(selected.purpose)}</span></div>` : ''}
    <div class="stack" style="gap:2px"><span>Started</span><span>${esc(ago(selected.createdAt))} ago</span></div>
    <div class="stack" style="gap:2px"><span>Last active</span><span>${esc(ago(selected.lastActiveAt))} ago</span></div>
  </div>
  <div class="stack" style="gap:12px">
    <h3>Latest messages</h3>
    ${
      messages.length === 0
        ? '<p class="muted small">No messages through Wheems yet. A chat thread\'s messages are in the chat.</p>'
        : messages
            .map(
              (m) =>
                `<div class="msg"><span class="av${m.who === 'This session' ? ' inv' : ''}">${esc(m.initial)}</span><div class="grow"><span class="small"><b>${esc(m.who)}</b> <span class="muted">· ${esc(ago(m.when))} ago</span></span><pre>${esc(m.text)}</pre></div></div>`,
            )
            .join('\n')
    }
  </div>
  ${
    selected.state === 'ended'
      ? '<p class="muted small">It has ended; it stays as a record.</p>'
      : `<form method="post" action="/w/${encodeURIComponent(w.id)}/sessions/${encodeURIComponent(selected.id)}" class="stack" style="gap:8px">
    <label class="stack small">Send it a message
      <textarea class="field" name="text" rows="3" placeholder="Ask it something…"></textarea>
    </label>
    <div class="row"><button class="btn primary" type="submit" name="action" value="send">Send</button><button class="btn" type="submit" name="action" value="end">End this session</button></div>
  </form>`
  }
  <p class="muted small">Watch it work with <span class="mono">hc attach ${esc(selected.herdrName ?? selected.id)}</span>.</p>
</section>`;
  const body = `
<header class="stack"><h1>Sessions in ${esc(w.name)}</h1><p class="muted">The chief of staff and the sessions working for it, each in Herdr.</p></header>
${page.storeProblem ? `<p class="card pad">Couldn't read the session store: ${esc(page.storeProblem)}</p>` : ''}
<div class="split">${list}${detail}</div>`;
  return layout({
    title: `Sessions · ${w.name}`,
    install: page.install,
    workspace: w,
    current: 'sessions',
    body,
  });
}

export function setupPage(
  install: InstallSummary,
  workspace: WorkspaceSummary | null,
  report: DoctorReport,
): string {
  const status = (s: string) =>
    s === 'pass'
      ? '<span class="badge ok">Passed</span>'
      : s === 'warn'
        ? '<span class="badge warn">Warning</span>'
        : s === 'fail'
          ? '<span class="badge no">Failed</span>'
          : '<span class="badge idle">Skipped</span>';
  const sections = report.sections
    .map(
      (section) =>
        `<section class="card" style="overflow:hidden"><div class="group"><h2>${esc(section.title)}</h2></div>${section.checks
          .map(
            (c) =>
              `<div class="check">${status(c.status)}<span class="grow"><span>${esc(c.message)}</span>${c.hint ? `<span class="muted small">${esc(c.hint)}</span>` : ''}</span></div>`,
          )
          .join('')}</section>`,
    )
    .join('\n');
  const failing = report.sections
    .flatMap((s) => s.checks)
    .filter((c) => c.status === 'fail').length;
  const body = `
<header class="stack"><h1>Setup and health</h1><p class="muted">The checks from <span class="mono">wheems doctor</span>, run just now. ${failing === 0 ? 'Nothing is failing.' : `${String(failing)} ${failing === 1 ? 'check is' : 'checks are'} failing.`} To change the setup, run <span class="mono">wheems setup</span>; doing it from here comes next.</p></header>
${sections}`;
  return layout({ title: 'Setup and health', install, workspace, current: 'setup', body });
}

export function messagePage(title: string, text: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Wheems</title><link rel="stylesheet" href="/app.css"><script src="/app.js"></script></head>
<body><main class="mainp" style="min-height:100vh"><div class="wrap" style="max-width:560px"><section class="card pad stack"><h1 style="font-size:24px">${esc(title)}</h1><p class="soft">${text}</p></section></div></main></body>
</html>`;
}

/** How long ago a time was, in the largest whole unit. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'a while';
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h`;
  return `${String(Math.round(hours / 24))} days`;
}

/** A label and its value, as a row in a card. */
function kv(label: string, value: string, mono = false): string {
  return `<div class="kv"><span>${esc(label)}</span><span${mono ? ' class="mono"' : ''}>${esc(value)}</span></div>`;
}

export function reviewPage(view: ReviewView): string {
  const w = view.workspace;
  const cards =
    view.proposals.length === 0
      ? '<section class="card pad"><p class="muted">Nothing waits for review in this workspace.</p></section>'
      : view.proposals
          .map(
            (p) => `<article class="card pad stack" style="gap:14px">
  <div class="row"><span class="badge info">${p.basedOn === null ? 'New skill' : `New version of v${String(p.basedOn)}`}</span><span class="muted small">Proposed by ${esc(p.agent)} · ${esc(ago(p.created))} ago</span></div>
  <h2><span class="mono">${esc(p.name)}</span></h2>
  ${p.similar.length > 0 ? `<p class="soft small">Close to: ${esc(p.similar.join(', '))}</p>` : ''}
  <form method="post" action="/w/${encodeURIComponent(w.id)}/review/${encodeURIComponent(p.id)}" class="stack" style="gap:12px">
    <details><summary class="small" style="cursor:pointer">Read or edit SKILL.md before approving</summary>
      <label class="stack small" style="margin-top:8px">The skill as it will be added
        <textarea class="field mono" name="text" rows="14">${esc(p.text)}</textarea>
      </label>
    </details>
    ${
      p.agents.length > 0
        ? `<fieldset class="choices"><legend class="small">Which agents in ${esc(w.name)} get it?</legend>${p.agents
            .map(
              (a) =>
                `<label class="choice"><input type="checkbox" name="agents" value="${esc(a.name)}"${a.checked ? ' checked' : ''}> <span class="mono">${esc(a.name)}</span>${a.name === p.agent ? ' <span class="muted small">proposed it</span>' : ''}</label>`,
            )
            .join('')}</fieldset>`
        : ''
    }
    <div class="row"><button class="btn primary" type="submit" name="decision" value="approve">Approve</button><button class="btn" type="submit" name="decision" value="decline">Decline</button></div>
  </form>
</article>`,
          )
          .join('\n');
  const body = `
<header class="stack"><h1>Review in ${esc(w.name)}</h1><p class="muted">Agents propose; you decide. Nothing here takes effect until you approve it.</p></header>
${cards}
<section class="card pad stack later"><h2 style="font-size:16px">Approvals history</h2><p class="soft small">When agents ask before acting (milestone 3), each request and your answer will be listed here, with what the agent knew and your original ask.</p></section>`;
  return layout({
    title: `Review · ${w.name}`,
    install: view.install,
    workspace: w,
    current: 'review',
    body,
  });
}

export function settingsPage(view: SettingsView): string {
  const w = view.workspace;
  const chief = view.chief;
  const body = `
<header class="stack"><h1>${esc(w.name)} settings</h1><p class="muted">From <span class="mono">workspaces/${esc(w.id)}/workspace.yaml</span>, its agent files and <span class="mono">skills.yaml</span>. Edit those files, then <span class="mono">wheems restart</span>; editing here comes next.</p></header>
<div class="grid">
  <section class="card pad stack" aria-labelledby="chief"><h2 id="chief">Chief of staff</h2>
    ${chief ? kv('Agent file', chief.file, true) + kv('Engine', chief.engine) + kv('Model', chief.model, true) + kv('Account', chief.account, true) + kv('Permissions', chief.permissions) : '<p class="muted">No chief of staff agent file found.</p>'}
    ${view.postsAs !== null ? kv('Posts as', view.postsAs) : ''}
  </section>
  <section class="card pad stack" aria-labelledby="chat"><h2 id="chat">Chat and sessions</h2>
    ${view.channels.map((c) => kv(c.name === 'chat' ? 'Chats in' : `Channel ${c.name}`, c.place)).join('')}
    ${kv('Open sessions per owner', `up to ${String(view.sessions.maxOpenPerOwner)}`)}
    ${kv('Sessions may start sessions', `${String(view.sessions.maxDepth)} levels deep`)}
  </section>
  <section class="card pad stack" aria-labelledby="kb"><h2 id="kb">Knowledge base</h2>
    ${kv('Folder', `workspaces/${w.id}/knowledge`, true)}
    ${kv('A note is asked for after', view.knowledge.noteAfterIdle === 0 ? 'never' : `${String(view.knowledge.noteAfterIdle)} min quiet`)}
    ${kv('Nightly tidy', view.knowledge.tidyAt)}
  </section>
  <section class="card pad stack" aria-labelledby="skills"><h2 id="skills">Skills</h2>
    ${view.skills.length === 0 ? '<p class="muted">None pinned yet.</p>' : view.skills.map((s) => kv(s.name, `v${String(s.version)}`, true)).join('')}
    ${kv('Budget', `${String(view.skills.length)} of ${String(view.skillBudget)}`)}
  </section>
  <section class="card pad stack" aria-labelledby="access"><h2 id="access">Accounts and connections it may use</h2>
    ${view.accounts.map((a) => kv('Account', a, true)).join('')}
    ${view.integrations.length === 0 ? '<p class="muted small">No integrations granted. They arrive in milestone 9.</p>' : view.integrations.map((i) => kv(i.name, i.access, true)).join('')}
    <a class="small" href="/connections">All connections</a>
  </section>
  <section class="card pad stack" aria-labelledby="agents"><h2 id="agents">Agents</h2>
    ${view.agents.map((a) => kv(a.name, `${a.engine} · ${a.model}`)).join('')}
  </section>
</div>
<section class="card pad stack" aria-labelledby="careful"><h2 id="careful">Archive or remove ${esc(w.name)}</h2>
  <p class="soft">Archive stops its chief and sessions and keeps everything, to bring back later: <span class="mono">wheems workspace archive ${esc(w.id)}</span>. Remove deletes its folder, knowledge base, sessions and records for good: <span class="mono">wheems workspace remove ${esc(w.id)}</span>.</p>
</section>`;
  return layout({
    title: `Settings · ${w.name}`,
    install: view.install,
    workspace: w,
    current: 'settings',
    body,
  });
}

export function connectionsPage(view: ConnectionsView, workspace: WorkspaceSummary | null): string {
  const uses = (names: string[]) =>
    names.length === 0
      ? '<span class="muted small">Not used by any workspace</span>'
      : names.map((n) => `<span class="tag small">${esc(n)}</span>`).join(' ');
  const chats = view.connections.filter((c) => c.kind === 'chat');
  const integrations = view.connections.filter((c) => c.kind === 'integration');
  const row = (c: (typeof view.connections)[number]) =>
    `<div class="check"><span class="badge ${c.connected ? 'ok' : 'warn'}">${c.connected ? 'Connected' : 'No credentials'}</span><span class="grow"><span><b>${esc(c.name)}</b> <span class="muted small">${esc(c.driver)}${c.kind === 'chat' ? ` · ${String(c.allowedUsers)} ${c.allowedUsers === 1 ? 'person' : 'people'} allowed` : ''}</span></span><span>${uses(c.usedBy)}</span></span></div>`;
  const body = `
<header class="stack"><h1>Connections</h1><p class="muted">Connected once for the whole install, with credentials kept outside the install folder. Each workspace then chooses which it may use.</p></header>
<section class="card" style="overflow:hidden"><div class="group"><h2>Chat channels</h2></div>
  ${chats.length === 0 ? '<p class="empty">None yet. Connect one with <span class="mono">wheems channel connect slack</span>.</p>' : chats.map(row).join('')}
</section>
<section class="card" style="overflow:hidden"><div class="group"><span class="grow"><h2>Integrations and MCP servers</h2><span class="muted small" style="font-weight:500">Outside services agents use, reached through Wheems's broker. Connecting and granting them arrives in milestone 9.</span></span></div>
  ${integrations.length === 0 ? '<p class="empty">None connected.</p>' : integrations.map(row).join('')}
</section>
<section class="card" style="overflow:hidden"><div class="group"><span class="grow"><h2>Engine accounts</h2><span class="muted small" style="font-weight:500">The subscriptions and API keys agents run on. Sign in with <span class="mono">wheems engine login &lt;engine&gt;</span>.</span></span></div>
  ${view.accounts
    .map(
      (a) =>
        `<div class="check"><span class="badge ${a.needsSecret && !a.hasSecret ? 'warn' : 'idle'}">${a.needsSecret ? (a.hasSecret ? 'Key saved' : 'No key yet') : 'Signs in'}</span><span class="grow"><span><b class="mono">${esc(a.name)}</b> <span class="muted small">${esc(a.driver)}${a.maxSessions !== null ? ` · up to ${String(a.maxSessions)} sessions` : ''}</span></span><span>${uses(a.usedBy)}</span></span></div>`,
    )
    .join('')}
</section>`;
  return layout({
    title: 'Connections',
    install: view.install,
    workspace,
    current: 'connections',
    body,
  });
}

export function aboutYouPage(view: AboutYouView, workspace: WorkspaceSummary | null): string {
  const body = `
<header class="stack"><h1>About you</h1><p class="muted">What every agent in every workspace knows about you, from <span class="mono">about-you.md</span> in the install folder. The nightly tidy suggests changes from what you tell your chiefs; none is made until you approve it.</p></header>
${view.suggestions.length > 0 ? view.suggestions.map((s) => `<article class="card pad stack" style="gap:12px"><div class="row"><span class="badge info">Suggested new version</span>${s.workspace !== null ? `<span class="muted small">From ${esc(s.workspace)}</span>` : ''}</div><pre class="preview">${esc(s.text)}</pre><form method="post" action="/about-you/${encodeURIComponent(s.name)}${workspace ? `?w=${encodeURIComponent(workspace.id)}` : ''}" class="row"><button class="btn primary" type="submit" name="decision" value="approve">Approve</button><button class="btn" type="submit" name="decision" value="decline">Decline</button></form></article>`).join('\n') : ''}
<section class="card pad stack" style="gap:12px"><h2>about-you.md now</h2>${view.current === null ? '<p class="muted">Empty so far. Your chiefs fill it in as they learn about you, with your approval.</p>' : `<pre class="preview">${esc(view.current)}</pre>`}</section>`;
  return layout({ title: 'About you', install: view.install, workspace, current: 'about', body });
}
