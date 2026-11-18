import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { ConversationsFlash, Flash } from '../../../src/web/actions.js';
import type { SessionMessage, TreeItem, WorkspacePage } from '../../../src/web/data.js';
import type { Handover } from '../../../src/state/store.js';
import { useAction, useView } from '../api.js';
import { ConfirmButton, FlashBanner, Loading, Problem, SessionBadge, ago } from '../ui.js';
import { TreeLinks } from './Overview.js';

interface SessionView {
  item: TreeItem;
  messages: SessionMessage[];
  /** A chat thread's handovers, newest first. */
  handovers: Handover[];
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
          <Detail key={chosen} workspace={w.id} session={chosen} />
        )}
      </div>
    </>
  );
}

function Detail({ workspace, session }: { workspace: string; session: string }) {
  const [, setSearch] = useSearchParams();
  // Always with ended sessions, so one you've just ended stays in view, with how it went.
  const path = `/w/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}?ended=1`;
  const view = useView<SessionView>(path, 3000);
  const [text, setText] = useState('');
  const [flash, setFlash] = useState<Flash | null>(null);
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
  return (
    <section className="card detail" aria-label="Session detail">
      <FlashBanner flash={flash} />
      <div className="stack">
        <SessionBadge session={s} />
        <h2 style={{ fontSize: 18, fontWeight: 800 }}>{item.label}</h2>
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
            No messages yet. Chat from before Wheems kept a copy here is only in the chat app.
          </p>
        ) : (
          <div className="msg-list">
            {messages.map((m) => (
              <div key={m.key} className="msg">
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
      {view.data.handovers.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <h3>Handovers</h3>
          {view.data.handovers.map((h) => (
            <details key={h.id} className="handover">
              <summary className="small">
                {h.author === 'agent'
                  ? 'Written by its chief'
                  : 'Written by Wheems from the thread'}
                {h.fromEngine !== null &&
                  ` · from ${h.fromEngine}${h.fromModel !== null ? ` (${h.fromModel})` : ''}`}
                {` · ${ago(h.writtenAt)} ago`}
                {h.usedAt !== null
                  ? ` · taken over by ${h.toEngine ?? 'a new session'}${h.toModel !== null ? ` (${h.toModel})` : ''}`
                  : ' · waiting for the next message'}
              </summary>
              <pre className="preview">{h.text}</pre>
            </details>
          ))}
        </div>
      )}
      {s.state === 'ended' ? (
        <p className="muted small">It has ended; it stays as a record.</p>
      ) : s.kind === 'thread' ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted small">
            It&apos;s a conversation in chat: to talk to it, reply in its chat thread. To start it
            over, hand it over to a new session, or start fresh.
          </p>
          <div className="row">
            <ConfirmButton
              label="Hand over"
              question="Hand over? Its chief writes a handover, and the thread's next message starts a new session from it."
              yes="Yes, hand over"
              disabled={restart.isPending || act.isPending}
              onConfirm={() => {
                restart.mutate({ [`s:${s.id}`]: 'hand-over' });
              }}
            />
            <ConfirmButton
              label="Start fresh"
              question="Start fresh? The thread's next message starts a new session that doesn't remember this one."
              yes="Yes, start fresh"
              disabled={restart.isPending || act.isPending}
              onConfirm={() => {
                restart.mutate({ [`s:${s.id}`]: 'fresh' });
              }}
            />
            {restart.isPending && <span className="muted small">Asking for its handover…</span>}
          </div>
        </div>
      ) : s.kind !== 'adhoc' ? (
        <p className="muted small">It runs a task, and stops when the task is done.</p>
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
              {act.isPending && doing === 'send' ? 'Sending…' : 'Send'}
            </button>
            <EndButton
              disabled={act.isPending}
              onEnd={() => {
                run({ action: 'end' });
              }}
            />
          </div>
        </form>
      )}
      {s.state !== 'ended' && (
        <p className="muted small">
          Watch it work with <span className="mono">hc attach {s.herdrName ?? s.id}</span>.
        </p>
      )}
    </section>
  );
}

/** Ending can't be undone, so it asks first. */
function EndButton({ disabled, onEnd }: { disabled: boolean; onEnd: () => void }) {
  return (
    <ConfirmButton
      label="End this session"
      question="End it? It writes its note, then stops for good."
      yes="Yes, end it"
      disabled={disabled}
      onConfirm={onEnd}
    />
  );
}
