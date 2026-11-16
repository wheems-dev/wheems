import { Link, useParams } from 'react-router';
import type { InstallSummary, TreeItem, WorkspacePage } from '../../../src/web/data.js';
import { useView } from '../api.js';
import { Icon, Loading, Problem, SessionBadge, ago } from '../ui.js';

export function Overview() {
  const id = useParams().id ?? '';
  const page = useView<WorkspacePage>(`/w/${encodeURIComponent(id)}`, 5000);
  if (page.isPending) return <Loading />;
  if (page.error) return <Problem error={page.error} />;
  const { workspace: w, chief } = page.data;
  return (
    <>
      <header className="row">
        <span className="av big">{w.initial}</span>
        <div className="stack" style={{ flex: '1 1 280px' }}>
          <h1>{w.name}</h1>
          <span className="muted">
            Chats in {w.chat}
            {chief && (
              <>
                {' · its chief runs on '}
                {chief.engine} (<span className="mono">{chief.model}</span>)
              </>
            )}
          </span>
        </div>
        <span className="live">Live</span>
      </header>
      <Health install={page.data.install} />
      {page.data.proposals > 0 && (
        <section className="card pad notice row between" aria-labelledby="needs">
          <div className="stack">
            <h2 id="needs">Needs you</h2>
            <p className="soft">
              {page.data.proposals} skill{' '}
              {page.data.proposals === 1 ? 'proposal waits' : 'proposals wait'} for your review.
            </p>
          </div>
          <Link className="pill" to={`/w/${encodeURIComponent(w.id)}/review`}>
            Review {page.data.proposals}
          </Link>
        </section>
      )}
      <section className="card" aria-labelledby="team" style={{ overflow: 'hidden' }}>
        <div className="group">
          <span className="av inv">C</span>
          <span className="grow">
            <h2 id="team">Chief of staff</h2>
            <span className="muted small" style={{ fontWeight: 500 }}>
              The agent you talk to. It starts sessions to work on things, and a session can start
              its own.
            </span>
          </span>
          <Link className="small" to={`/w/${encodeURIComponent(w.id)}/sessions`}>
            All sessions
          </Link>
        </div>
        {page.data.storeProblem && (
          <p className="empty">Couldn't read the session store: {page.data.storeProblem}</p>
        )}
        {page.data.chiefTree.length === 0 ? (
          <p className="empty">
            No open conversations or sessions. Message the chief in chat to start one.
          </p>
        ) : (
          <TreeLinks items={page.data.chiefTree} workspace={w.id} />
        )}
      </section>
      {page.data.mine.length > 0 && (
        <section className="card" aria-labelledby="mine" style={{ overflow: 'hidden' }}>
          <div className="group">
            <span className="av">Y</span>
            <h2 id="mine">Started by you</h2>
          </div>
          <TreeLinks items={page.data.mine} workspace={w.id} />
        </section>
      )}
      <div className="grid">
        <section className="card pad stack" aria-labelledby="kb" style={{ gap: 12 }}>
          <h2 id="kb">Knowledge base</h2>
          <div className="stats">
            <div className="stat">
              <b>{page.data.knowledge.pages}</b>
              <span>pages</span>
            </div>
            <div className="stat">
              <b>{page.data.knowledge.inbox}</b>
              <span>notes in the inbox</span>
            </div>
            <div className="stat">
              <b>{page.data.skills.length}</b>
              <span>skills</span>
            </div>
          </div>
          <p className="muted small">
            Search it with <span className="mono">wheems knowledgebase search "…"</span>.
          </p>
        </section>
        <section className="card pad stack" aria-labelledby="sk" style={{ gap: 12 }}>
          <h2 id="sk">Skills</h2>
          {page.data.skills.length === 0 ? (
            <p className="muted">No skills pinned in skills.yaml yet.</p>
          ) : (
            <div className="row">
              {page.data.skills.map((s) => (
                <span key={s.name} className="mono tag">
                  {s.name} v{s.version}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

export function Health({ install }: { install: InstallSummary }) {
  return (
    <div className="row" aria-label="Install health">
      <Link className="pill" to="/setup">
        <span className={install.service.running ? 'dot-ok' : 'dot-no'}>●</span>
        {install.service.running ? 'Service running' : 'Service not running'}
      </Link>
      {(install.service.report?.connections ?? []).map((c) => (
        <Link key={c} className="pill" to="/connections">
          <span className="dot-ok">●</span>
          {c.charAt(0).toUpperCase() + c.slice(1)} connected
        </Link>
      ))}
      {install.problems > 0 && (
        <Link className="pill" to="/setup">
          <span className="dot-no">●</span>
          {install.problems} config {install.problems === 1 ? 'problem' : 'problems'}
        </Link>
      )}
    </div>
  );
}

/** The session tree as links to each session's page. */
export function TreeLinks({
  items,
  workspace,
  selected,
  ended,
}: {
  items: TreeItem[];
  workspace: string;
  selected?: string | null;
  ended?: boolean;
}) {
  return (
    <>
      {items.map((item) => {
        const s = item.session;
        const query = new URLSearchParams({ s: s.id, ...(ended === true && { ended: '1' }) });
        return (
          <Link
            key={s.id}
            className={`tree${s.id === selected ? ' sel' : ''}${s.state === 'ended' ? ' ended' : ''}`}
            style={{ paddingLeft: 20 + (item.depth - 1) * 28 }}
            to={`/w/${encodeURIComponent(workspace)}/sessions?${query.toString()}`}
          >
            <Icon name="twig" />
            <span className="grow">
              <span className="title">{item.label}</span>
              <span className="muted small">
                {item.kind} · {ago(s.lastActiveAt)} ago
              </span>
            </span>
            <SessionBadge session={s} />
          </Link>
        );
      })}
    </>
  );
}
