import { useState } from 'react';
import { useParams } from 'react-router';
import type { Flash } from '../../../src/web/actions.js';
import type { ProposalView, ReviewView } from '../../../src/web/data.js';
import { useAction, useView } from '../api.js';
import { Badge, FlashBanner, Loading, Problem, ago } from '../ui.js';

export function Review() {
  const id = useParams().id ?? '';
  const view = useView<ReviewView>(`/w/${encodeURIComponent(id)}/review`, 10_000);
  const [flash, setFlash] = useState<Flash | null>(null);
  if (view.isPending) return <Loading />;
  if (view.error) return <Problem error={view.error} />;
  const w = view.data.workspace;
  return (
    <>
      <header className="stack">
        <h1>Review in {w.name}</h1>
        <p className="muted">
          Agents propose; you decide. Nothing here takes effect until you approve it.
        </p>
      </header>
      <FlashBanner flash={flash} />
      {view.data.proposals.length === 0 ? (
        <section className="card pad">
          <p className="muted">Nothing waits for review in this workspace.</p>
        </section>
      ) : (
        view.data.proposals.map((p) => (
          <Proposal
            key={`${p.id}-${p.seen}`}
            workspace={w.id}
            workspaceName={w.name}
            proposal={p}
            done={setFlash}
          />
        ))
      )}
      <section className="card pad stack later">
        <h2 style={{ fontSize: 16 }}>Approvals history</h2>
        <p className="soft small">
          When agents ask before acting (milestone 3), each request and your answer will be listed
          here, with what the agent knew and your original ask.
        </p>
      </section>
    </>
  );
}

function Proposal({
  workspace,
  workspaceName,
  proposal: p,
  done,
}: {
  workspace: string;
  workspaceName: string;
  proposal: ProposalView;
  done: (flash: Flash) => void;
}) {
  const act = useAction(`/w/${encodeURIComponent(workspace)}/review/${encodeURIComponent(p.id)}`);
  const [text, setText] = useState(p.text);
  const [agents, setAgents] = useState(
    () => new Set(p.agents.filter((a) => a.checked).map((a) => a.name)),
  );
  const decide = (decision: 'approve' | 'decline') => {
    act.mutate(
      { decision, seen: p.seen, text, agents: [...agents] },
      {
        onSuccess: done,
        onError: (error) => {
          done({ ok: false, text: error.message });
        },
      },
    );
  };
  return (
    <article className="card pad stack" style={{ gap: 14 }}>
      <div className="row">
        <Badge kind="info">
          {p.basedOn === null ? 'New skill' : `New version of v${String(p.basedOn)}`}
        </Badge>
        <span className="muted small">
          Proposed by {p.agent} · {ago(p.created)} ago
        </span>
      </div>
      <h2>
        <span className="mono">{p.name}</span>
      </h2>
      {p.similar.length > 0 && <p className="soft small">Close to: {p.similar.join(', ')}</p>}
      <label className="stack small">
        SKILL.md, as it will be added (edit it first if you like)
        <textarea
          className="field mono"
          rows={14}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>
      {p.agents.length > 0 && (
        <fieldset className="choices">
          <legend className="small">Which agents in {workspaceName} get it?</legend>
          {p.agents.map((a) => (
            <label key={a.name} className="choice">
              <input
                type="checkbox"
                checked={agents.has(a.name)}
                onChange={(event) => {
                  const next = new Set(agents);
                  if (event.target.checked) next.add(a.name);
                  else next.delete(a.name);
                  setAgents(next);
                }}
              />{' '}
              <span className="mono">{a.name}</span>
              {a.name === p.agent && <span className="muted small"> proposed it</span>}
            </label>
          ))}
        </fieldset>
      )}
      <div className="row">
        <button
          className="btn primary"
          type="button"
          disabled={act.isPending}
          onClick={() => {
            decide('approve');
          }}
        >
          Approve
        </button>
        <button
          className="btn"
          type="button"
          disabled={act.isPending}
          onClick={() => {
            decide('decline');
          }}
        >
          Decline
        </button>
      </div>
    </article>
  );
}
