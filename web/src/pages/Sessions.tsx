import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import type { ConversationsFlash, Flash } from '../../../src/web/actions.js';
import type { SessionMessage, TreeItem, WorkspacePage } from '../../../src/web/data.js';
import type { Handover, SessionRecord } from '../../../src/state/store.js';
import { useAction, useView } from '../api.js';
import { FlashBanner, Icon, Loading, Problem, SessionBadge, ago } from '../ui.js';

interface SessionView {
  item: TreeItem;
  messages: SessionMessage[];
  /** A chat thread's handovers, newest first. */
  handovers: Handover[];
  /** How a slow send or end turned out, given once. */
  outcome: Flash | null;
}

/**
 * Sessions, at the same width as every other page: a switcher at the top to choose one, then the
 * chosen session's messages with its actions and reply box, and its details, which can be
 * hidden. On a wide screen the page fills the window's height, and each part scrolls on its own.
 */
export function Sessions() {
  const id = useParams().id ?? '';
  const [search] = useSearchParams();
  const ended = search.get('ended') === '1';
  const base = `/w/${encodeURIComponent(id)}/sessions`;
  const page = useView<WorkspacePage>(`${base}${ended ? '?ended=1' : ''}`, 5000);
  const [details, setDetails] = useState(detailsShown);
  if (page.isPending) return <Loading />;
  if (page.error) return <Problem error={page.error} />;
  const w = page.data.workspace;
  const all = [...page.data.chiefTree, ...page.data.mine];
  const chosen = search.get('s') ?? all[0]?.session.id ?? null;
  const toggleDetails = () => {
    setDetails((now) => {
      rememberDetails(!now);
      return !now;
    });
  };
  return (
    <div className="bench-page">
      <header className="row between">
        <h1>Sessions</h1>
        <span className="live">Live</span>
      </header>
      {page.data.storeProblem && (
        <p className="card pad">Couldn't read the session store: {page.data.storeProblem}</p>
      )}
      <div className={`bench${details && chosen !== null ? ' with-details' : ''}`}>
        {chosen === null ? (
          <section className="card convo empty-convo">
            {ended ? (
              <p className="muted">
                No sessions yet. They show up here as soon as the chief starts one.
              </p>
            ) : (
              <p className="muted">
                None is open right now.{' '}
                <Link to={withS(base, null, true)}>Show ended sessions</Link>
              </p>
            )}
          </section>
        ) : (
          <Conversation
            key={chosen}
            workspace={w.id}
            session={chosen}
            items={all}
            base={base}
            ended={ended}
            details={details}
            onToggleDetails={toggleDetails}
            switcher={
              <SessionSwitcher
                groups={[
                  { title: 'With you', items: page.data.chiefTree },
                  { title: 'Started by you', items: page.data.mine },
                ]}
                current={all.find((i) => i.session.id === chosen)}
                base={base}
                ended={ended}
              />
            }
          />
        )}
      </div>
    </div>
  );
}

interface Group {
  title: string;
  items: TreeItem[];
}

/**
 * Chooses the session to show, like the workspace switcher: the chosen one's name is the button,
 * at the top of its conversation, and opens a menu of them all, open or with ended ones too, that
 * a few letters narrow down.
 */
function SessionSwitcher({
  groups,
  current,
  base,
  ended,
}: {
  groups: Group[];
  current: TreeItem | undefined;
  base: string;
  ended: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const location = useLocation();
  // Choosing a session, or switching tabs, closes the menu.
  useEffect(() => {
    setOpen(false);
    setFilter('');
  }, [location.search]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const words = filter.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      items: words === '' ? g.items : g.items.filter((i) => i.label.toLowerCase().includes(words)),
    }))
    .filter((g) => g.items.length > 0 || (words === '' && g.title === 'With you'));
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const s = current?.session;
  return (
    <div className="sswitch">
      <button
        type="button"
        className="sswitch-button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {s !== undefined && current !== undefined ? (
          <span className="grow">
            <span className="sswitch-title">
              <span className="convo-title">{current.label}</span>
              <Icon name="updown" />
            </span>
            <span className="row convo-sub">
              <SessionBadge session={s} />
              <span className="muted small">{current.kind}</span>
            </span>
          </span>
        ) : (
          <span className="grow muted">Choose a session</span>
        )}
      </button>
      {open && (
        <>
          <div
            className="switcher-menu-backdrop"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className="menu sswitch-menu" role="menu">
            <div className="tabs" role="tablist" aria-label="Which sessions">
              <Link
                role="tab"
                aria-selected={!ended}
                className={ended ? '' : 'on'}
                to={withS(base, s?.id ?? null, false)}
              >
                Open{ended ? '' : ` · ${String(count)}`}
              </Link>
              <Link
                role="tab"
                aria-selected={ended}
                className={ended ? 'on' : ''}
                to={withS(base, s?.id ?? null, true)}
              >
                All, with ended{ended ? ` · ${String(count)}` : ''}
              </Link>
            </div>
            <input
              className="field sswitch-filter"
              type="search"
              placeholder="Find a session…"
              aria-label="Find a session"
              value={filter}
              autoFocus
              onChange={(event) => {
                setFilter(event.target.value);
              }}
            />
            <div className="sswitch-list">
              {shown.length === 0 ? (
                <p className="muted small lempty">No session's name has that in it.</p>
              ) : (
                shown.map((g) => (
                  <ListGroup
                    key={g.title}
                    title={g.title}
                    items={g.items}
                    base={base}
                    chosen={s?.id ?? null}
                    ended={ended}
                    flat={words !== ''}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One group in the menu: the chief's conversations with their team nested under them, or yours. */
function ListGroup({
  title,
  items,
  base,
  chosen,
  ended,
  flat,
}: {
  title: string;
  items: TreeItem[];
  base: string;
  chosen: string | null;
  ended: boolean;
  /** Narrowed by a filter: no nesting, since a match's parent may not be shown. */
  flat: boolean;
}) {
  return (
    <div className="lgroup">
      <div className="lgroup-head">
        <span>{title}</span>
      </div>
      {items.length === 0 ? (
        <p className="muted small lempty">Nothing here yet.</p>
      ) : (
        items.map((item) => {
          const s = item.session;
          return (
            <Link
              key={s.id}
              role="menuitem"
              className={`lrow${s.id === chosen ? ' sel' : ''}${s.state === 'ended' ? ' ended' : ''}`}
              style={{ paddingLeft: 10 + (flat ? 0 : (item.depth - 1) * 16) }}
              to={withS(base, s.id, ended)}
              aria-current={s.id === chosen ? 'true' : undefined}
            >
              <span className={`sdot ${s.state}`} title={stateName(s)} />
              <span className="grow">
                <span className="lrow-title">{item.label}</span>
                <span className="lrow-sub">
                  {item.depth > 1 ? 'On the team · ' : ''}
                  {ago(s.lastActiveAt)} ago
                </span>
              </span>
              {s.id === chosen && <span aria-hidden="true">✓</span>}
            </Link>
          );
        })
      )}
    </div>
  );
}

/** What an action asks before it runs, shown in a strip under the header. */
interface Asking {
  question: string;
  yes: string;
  run: () => void;
}

function Conversation({
  workspace,
  session,
  items,
  base,
  ended,
  details,
  onToggleDetails,
  switcher,
}: {
  workspace: string;
  session: string;
  items: TreeItem[];
  base: string;
  ended: boolean;
  details: boolean;
  onToggleDetails: () => void;
  /** The switcher, which names this session and chooses another. */
  switcher: ReactNode;
}) {
  const [, setSearch] = useSearchParams();
  // Always with ended sessions, so one you've just ended stays in view, with how it went.
  const path = `/w/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}?ended=1`;
  const view = useView<SessionView>(path, 3000);
  const [text, setText] = useState('');
  const [flash, setFlash] = useState<Flash | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  // The draft that was sent, cleared once it's delivered, unless you've written another since.
  const sent = useRef<string | null>(null);
  const [doing, setDoing] = useState<string | null>(null);
  const act = useAction(
    `/w/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}`,
    (result) => {
      setFlash(result);
      const draft = sent.current;
      sent.current = null;
      if (result.ok && draft !== null) setText((now) => (now === draft ? '' : now));
    },
  );
  // Starting a chat thread over: hand over, or start fresh.
  const restart = useAction(`/w/${encodeURIComponent(workspace)}/conversations`, (result) => {
    // A failed request says only how it went, with no outcomes.
    const outcome = 'outcomes' in result ? (result as ConversationsFlash).outcomes[0] : undefined;
    setFlash(outcome ? { ok: outcome.done, text: outcome.text } : result);
  });
  // A slow send's or end's result, once the service has it.
  useEffect(() => {
    if (view.data?.outcome) setFlash(view.data.outcome);
  }, [view.data?.outcome]);

  // The newest messages are at the bottom: start there, and follow new ones while you're there.
  // Their size settles after the first paint (fonts, line wraps), so it follows any change.
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loaded = view.data !== undefined;
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const follow = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    const watch = new ResizeObserver(follow);
    watch.observe(inner);
    return () => {
      watch.disconnect();
    };
  }, [loaded]);

  if (view.isPending)
    return (
      <section className="card convo">
        <Loading />
      </section>
    );
  if (view.error)
    return (
      <section className="card convo">
        <p className="soft pad">{view.error.message}</p>
      </section>
    );
  const { item, messages, handovers } = view.data;
  const s = item.session;
  const busy = act.isPending || restart.isPending;
  const run = (fields: Record<string, string>) => {
    sent.current = fields.action === 'send' ? (fields.text ?? null) : null;
    setDoing(fields.action ?? null);
    // Keep this session chosen in the address, so it stays in view once the list changes,
    // as it does when an ended session drops out of it.
    setSearch(
      (now) => {
        const next = new URLSearchParams(now);
        next.set('s', session);
        return next;
      },
      { replace: true },
    );
    act.mutate(fields);
  };
  const send = () => {
    if (text.trim() !== '' && !busy) run({ action: 'send', text });
  };
  return (
    <>
      <section className="card convo" aria-label="Session">
        <header className="convo-head">
          <div className="grow">{switcher}</div>
          <div className="row convo-actions">
            {s.state !== 'ended' && s.kind === 'thread' && (
              <>
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setAsking({
                      question:
                        "Hand over? Its chief writes a handover, and the thread's next message starts a new session from it.",
                      yes: 'Yes, hand over',
                      run: () => {
                        restart.mutate({ [`s:${s.id}`]: 'hand-over' });
                      },
                    });
                  }}
                >
                  Hand over
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setAsking({
                      question:
                        "Start fresh? The thread's next message starts a new session that doesn't remember this one.",
                      yes: 'Yes, start fresh',
                      run: () => {
                        restart.mutate({ [`s:${s.id}`]: 'fresh' });
                      },
                    });
                  }}
                >
                  Start fresh
                </button>
              </>
            )}
            {s.state !== 'ended' && s.kind === 'adhoc' && (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setAsking({
                    question: 'End it? It writes its note, then stops for good.',
                    yes: 'Yes, end it',
                    run: () => {
                      run({ action: 'end' });
                    },
                  });
                }}
              >
                {act.isPending && doing === 'end' ? 'Ending…' : 'End'}
              </button>
            )}
            <button
              className={`iconbtn${details ? ' on' : ''}`}
              type="button"
              aria-pressed={details}
              aria-label={details ? 'Hide details' : 'Show details'}
              title={details ? 'Hide details' : 'Show details'}
              onClick={onToggleDetails}
            >
              <Icon name="info" />
            </button>
          </div>
        </header>
        {asking !== null && (
          <div className="asking" role="group" aria-label={asking.question}>
            <span className="small grow">{asking.question}</span>
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => {
                const what = asking;
                setAsking(null);
                what.run();
              }}
            >
              {asking.yes}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setAsking(null);
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {restart.isPending && <p className="asking muted small">Asking for its handover…</p>}
        <FlashBanner flash={flash} />
        <div
          className="convo-msgs"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          <div className="convo-msgs-inner" ref={content}>
            {messages.length === 0 ? (
              <p className="muted small convo-none">
                {s.kind === 'thread'
                  ? 'No messages yet. Chat from before Wheems kept a copy here is only in the chat app.'
                  : 'Nothing has been said to it yet. Its work is in Herdr: open Details to watch it.'}
              </p>
            ) : (
              messages.map((m) => {
                const mine = m.who === 'You';
                return (
                  <div key={m.key} className={`bubble-row${mine ? ' mine' : ''}`}>
                    {!mine && (
                      <span className={`av${m.who === 'This session' ? ' inv' : ''}`}>
                        {m.initial}
                      </span>
                    )}
                    <div className="bubble">
                      <span className="bubble-who">
                        {mine ? '' : `${m.who} · `}
                        {ago(m.when)} ago
                      </span>
                      <pre>{m.text}</pre>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <footer className="convo-foot">
          {s.state === 'ended' ? (
            <p className="muted small">It has ended, and stays here as a record.</p>
          ) : s.kind === 'thread' ? (
            <p className="muted small">
              It&apos;s a conversation in chat: reply in its chat thread, and it hears you there.
            </p>
          ) : s.kind !== 'adhoc' ? (
            <p className="muted small">It runs a task, and stops when the task is done.</p>
          ) : (
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <textarea
                className="field"
                name="text"
                rows={2}
                aria-label="Send it a message"
                placeholder="Send it a message… (⌘ Enter sends)"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <button className="btn primary" type="submit" disabled={busy || text.trim() === ''}>
                {act.isPending && doing === 'send' ? 'Sending…' : 'Send'}
              </button>
            </form>
          )}
        </footer>
      </section>
      {details && (
        <Details
          session={s}
          items={items}
          base={base}
          ended={ended}
          handovers={handovers}
          onClose={onToggleDetails}
        />
      )}
    </>
  );
}

/** The session's facts, the sessions around it, and how to watch it work. */
function Details({
  session: s,
  items,
  base,
  ended,
  handovers,
  onClose,
}: {
  session: SessionRecord;
  items: TreeItem[];
  base: string;
  ended: boolean;
  handovers: Handover[];
  onClose: () => void;
}) {
  const parent = s.parent === null ? undefined : items.find((i) => i.session.id === s.parent);
  const team = items.filter((i) => i.session.parent === s.id);
  return (
    <aside className="card pane-details" aria-label="Details">
      <div className="row between">
        <h3>Details</h3>
        <button
          className="iconbtn"
          type="button"
          aria-label="Hide details"
          title="Hide details"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      <dl className="dlist">
        {s.ask !== null && <Fact label="Your original ask">{s.ask}</Fact>}
        {s.purpose !== null && <Fact label="What it's for">{s.purpose}</Fact>}
        {s.doneWhen !== null && <Fact label="Done when">{s.doneWhen}</Fact>}
        <Fact label="Started">{ago(s.createdAt)} ago</Fact>
        <Fact label="Last active">{ago(s.lastActiveAt)} ago</Fact>
        {s.endedAt !== null && <Fact label="Ended">{ago(s.endedAt)} ago</Fact>}
        {s.agent !== null && <Fact label="Agent">{s.agent.split('/').pop()}</Fact>}
        {parent !== undefined && (
          <Fact label="Working for">
            <Link to={withS(base, parent.session.id, ended)}>{parent.label}</Link>
          </Fact>
        )}
      </dl>
      {team.length > 0 && (
        <div className="stack">
          <span className="dlabel">Its team</span>
          {team.map((t) => (
            <Link key={t.session.id} className="teamrow" to={withS(base, t.session.id, ended)}>
              <span className={`sdot ${t.session.state}`} title={stateName(t.session)} />
              {t.label}
            </Link>
          ))}
        </div>
      )}
      {handovers.length > 0 && (
        <div className="stack">
          <span className="dlabel">Handovers</span>
          {handovers.map((h) => (
            <details key={h.id} className="handover">
              <summary className="small">
                {h.author === 'agent' ? 'By its chief' : 'By Wheems'} · {ago(h.writtenAt)} ago
                {h.usedAt !== null
                  ? ` · taken over by ${h.toEngine ?? 'a new session'}`
                  : ' · waiting for the next message'}
              </summary>
              <pre className="preview">{h.text}</pre>
            </details>
          ))}
        </div>
      )}
      <div className="stack">
        <span className="dlabel">In Herdr</span>
        {s.state !== 'ended' && (
          <span className="small">
            Watch it work with <span className="code mono">hc attach {s.herdrName ?? s.id}</span>
          </span>
        )}
        <span className="mono muted tiny">{s.id}</span>
      </div>
    </aside>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The address that shows a session, keeping whether ended ones are listed. */
function withS(base: string, session: string | null, ended: boolean): string {
  const query = new URLSearchParams({
    ...(session !== null && { s: session }),
    ...(ended && { ended: '1' }),
  }).toString();
  return query === '' ? base : `${base}?${query}`;
}

function stateName(s: SessionRecord): string {
  return {
    starting: 'Starting',
    working: 'Working',
    idle: 'Idle',
    stopped: 'Stopped',
    ended: 'Ended',
  }[s.state];
}

/** Whether the details pane is open: as you left it, or open on a wide screen. */
function detailsShown(): boolean {
  try {
    const kept = localStorage.getItem('wheems-session-details');
    if (kept !== null) return kept === '1';
  } catch {
    // Storage may be off; fall back to the screen's width.
  }
  return window.innerWidth >= 1200;
}

function rememberDetails(open: boolean): void {
  try {
    localStorage.setItem('wheems-session-details', open ? '1' : '0');
  } catch {
    // Not remembered, then.
  }
}
