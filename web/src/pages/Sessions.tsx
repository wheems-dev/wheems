import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { Flash } from '../../../src/web/actions.js';
import type { SessionMessage, TreeItem, WorkspacePage } from '../../../src/web/data.js';
import { useAction, useView } from '../api.js';
import { FlashBanner, Loading, Problem, SessionBadge, ago } from '../ui.js';
import { TreeLinks } from './Overview.js';

interface SessionView {
  item: TreeItem;
  messages: SessionMessage[];
  /** How a slow send or end turned out, given once. */
  outcome: Flash | null;
}

export function Sessions() {
  const id = useParams().id ?? '';
  const [search] = useSearchParams();
  const ended = search.get('ended') === '1';
  const base = `/w/${encodeURIComponent(id)}/sessions`;
  const page = useView<WorkspacePage>(`${base}${ended ? '?ended=1' : ''}`, 5000);
  if (page.isPending) return <Loading />;
  if (page.error) return <Problem error={page.error} />;
  const w = page.data.workspace;
  const all = [...page.data.chiefTree, ...page.data.mine];
  const chosen = search.get('s') ?? all[0]?.session.id ?? null;
  return (
    <>
      <header className="row between">
        <div className="stack">
          <h1>Sessions in {w.name}</h1>
          <p className="muted">
            The chief of staff and the sessions working for it, each in Herdr.
          </p>
        </div>
        <span className="live">Live</span>
      </header>
      {page.data.storeProblem && (
        <p className="card pad">Couldn't read the session store: {page.data.storeProblem}</p>
      )}
      <div className="split">
        <section className="card list" aria-label="Session tree">
          <div className="group">
            <span className="av inv">C</span>
            <span className="grow">
              Chief of staff
              <span className="muted small" style={{ fontWeight: 500 }}>
                {page.data.chief ? `${page.data.chief.engine} · ${page.data.chief.model}` : ''}
              </span>
            </span>
          </div>
          {page.data.chiefTree.length === 0 ? (
            <p className="empty">Nothing here yet.</p>
          ) : (
            <TreeLinks
              items={page.data.chiefTree}
              workspace={w.id}
              selected={chosen}
              ended={ended}
            />
          )}
          {page.data.mine.length > 0 && (
            <>
              <div className="group" style={{ borderTop: '1px solid var(--hair)' }}>
                <span className="av">Y</span>Started by you
              </div>
              <TreeLinks items={page.data.mine} workspace={w.id} selected={chosen} ended={ended} />
            </>
          )}
          <p className="empty small">
            <Link to={ended ? base : `${base}?ended=1`}>
              {ended ? 'Hide ended sessions' : 'Show ended sessions'}
            </Link>
          </p>
        </section>
        {chosen === null ? (
          <section className="card detail" aria-label="Session detail">
            <p className="muted">No sessions yet.</p>
          </section>
        ) : (
          <Detail key={chosen} workspace={w.id} session={chosen} ended={ended} />
        )}
      </div>
    </>
  );
}

function Detail({
  workspace,
  session,
  ended,
}: {
  workspace: string;
  session: string;
  ended: boolean;
}) {
  const path = `/w/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}${ended ? '?ended=1' : ''}`;
  const view = useView<SessionView>(path, 3000);
  const act = useAction(
    `/w/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}`,
  );
  const [text, setText] = useState('');
  const [flash, setFlash] = useState<Flash | null>(null);
  // A slow send's or end's result, once the service has it.
  useEffect(() => {
    if (view.data?.outcome) setFlash(view.data.outcome);
  }, [view.data?.outcome]);

  if (view.isPending)
    return (
      <section className="card detail">
        <Loading />
      </section>
    );
  if (view.error)
    return (
      <section className="card detail">
        <p className="soft">{view.error.message}</p>
      </section>
    );
  const { item, messages } = view.data;
  const s = item.session;
  const run = (fields: Record<string, string>) => {
    act.mutate(fields, {
      onSuccess: (result) => {
        setFlash(result);
        if (result.ok && fields.action === 'send') setText('');
      },
      onError: (error) => {
        setFlash({ ok: false, text: error.message });
      },
    });
  };
  return (
    <section className="card detail" aria-label="Session detail">
      <FlashBanner flash={flash} />
      <div className="stack">
        <SessionBadge session={s} />
        <h2 style={{ fontSize: 22, fontWeight: 800 }}>{item.label}</h2>
        <span className="mono muted small">
          {s.id}
          {s.herdrName !== null && ` · ${s.herdrName} in Herdr`}
        </span>
      </div>
      <div className="facts">
        {s.ask !== null && (
          <div className="stack" style={{ gap: 2 }}>
            <span>Your original ask</span>
            <span>{s.ask}</span>
          </div>
        )}
        {s.purpose !== null && (
          <div className="stack" style={{ gap: 2 }}>
            <span>Purpose</span>
            <span>{s.purpose}</span>
          </div>
        )}
        <div className="stack" style={{ gap: 2 }}>
          <span>Started</span>
          <span>{ago(s.createdAt)} ago</span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span>Last active</span>
          <span>{ago(s.lastActiveAt)} ago</span>
        </div>
      </div>
      <div className="stack" style={{ gap: 12 }}>
        <h3>Latest messages</h3>
        {messages.length === 0 ? (
          <p className="muted small">
            No messages through Wheems yet. A chat thread's messages are in the chat.
          </p>
        ) : (
          <div className="msg-list">
            {messages.map((m) => (
              <div key={`${m.when}-${m.who}`} className="msg">
                <span className={`av${m.who === 'This session' ? ' inv' : ''}`}>{m.initial}</span>
                <div className="grow">
                  <span className="small">
                    <b>{m.who}</b> <span className="muted">· {ago(m.when)} ago</span>
                  </span>
                  <pre>{m.text}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {s.state === 'ended' ? (
        <p className="muted small">It has ended; it stays as a record.</p>
      ) : (
        <form
          className="stack"
          style={{ gap: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            run({ action: 'send', text });
          }}
        >
          <label className="stack small">
            Send it a message
            <textarea
              className="field"
              name="text"
              rows={3}
              placeholder="Ask it something…"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          </label>
          <div className="row">
            <button
              className="btn primary"
              type="submit"
              disabled={act.isPending || text.trim() === ''}
            >
              {act.isPending ? 'Sending…' : 'Send'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={act.isPending}
              onClick={() => {
                run({ action: 'end' });
              }}
            >
              End this session
            </button>
          </div>
        </form>
      )}
      <p className="muted small">
        Watch it work with <span className="mono">hc attach {s.herdrName ?? s.id}</span>.
      </p>
    </section>
  );
}
