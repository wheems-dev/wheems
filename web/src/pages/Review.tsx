import { useState } from 'react';
import { useParams } from 'react-router';
import type { Flash } from '../../../src/web/actions.js';
import type { ApprovalView, ProposalView, ReviewView } from '../../../src/web/data.js';
import { useAction, useView } from '../api.js';
import { Badge, FlashBanner, Loading, Problem, ago, ConfirmButton } from '../ui.js';

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
          Agents propose and ask; you decide. Nothing here takes effect until you approve it.
        </p>
      </header>
      <FlashBanner flash={flash} />
      {view.data.storeProblem !== null && (
        <section className="card pad">
          <p className="muted">Approvals can't be read: {view.data.storeProblem}</p>
        </section>
      )}
      {view.data.approvals.open.map((a) => (
        <OpenApproval key={a.id} workspace={w.id} approval={a} done={setFlash} />
      ))}
      {view.data.proposals.map((p) => (
        <Proposal
          key={`${p.id}-${p.seen}`}
          workspace={w.id}
          workspaceName={w.name}
          proposal={p}
          done={setFlash}
        />
      ))}
      {view.data.proposals.length === 0 && view.data.approvals.open.length === 0 && (
        <section className="card pad">
          <p className="muted">Nothing waits for review in this workspace.</p>
        </section>
      )}
      <section className="card pad stack">
        <h2 style={{ fontSize: 16 }}>Approvals history</h2>
        {view.data.approvals.history.length === 0 ? (
          <p className="soft small">
            No approvals yet. When an agent asks before acting, its question and the answer are
            listed here.
          </p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {view.data.approvals.history.map((a) => (
              <li key={a.id} className="stack" style={{ gap: 4 }}>
                <div className="row">
                  <Badge kind={a.state === 'answered' ? 'ok' : 'idle'}>{outcome(a)}</Badge>
                  <span>{a.question}</span>
                </div>
                <span className="muted small">
                  Asked by {a.askedBy}
                  {a.working !== null && <> for “{a.working}”</>} · {ago(a.askedAt)} ago
                  {a.reason !== null && <> · Reason: {a.reason}</>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** How a closed approval ended, in a word or two. */
function outcome(a: ApprovalView): string {
  if (a.state === 'answered') {
    return `${a.answer ?? ''} by ${a.answeredBy === 'person' ? 'you' : 'your chief'}`;
  }
  return a.state === 'expired' ? 'Expired' : 'Withdrawn';
}

function OpenApproval({
  workspace,
  approval: a,
  done,
}: {
  workspace: string;
  approval: ApprovalView;
  done: (flash: Flash) => void;
}) {
  const act = useAction(
    `/w/${encodeURIComponent(workspace)}/approvals/${encodeURIComponent(a.id)}`,
    done,
  );
  const [reason, setReason] = useState('');
  const last = a.choices.length - 1;
  return (
    <article className="card pad stack" style={{ gap: 14 }}>
      <div className="row">
        <Badge kind="warn">
          {a.waitingOn === 'chief' ? 'Approval, with your chief' : 'Approval needed'}
        </Badge>
        <span className="muted small">
          Asked by {a.askedBy}
          {a.working !== null && <> for “{a.working}”</>} · {ago(a.askedAt)} ago · open until{' '}
          {new Date(a.expiresAt).toLocaleString()}
        </span>
      </div>
      <h2>{a.question}</h2>
      {a.details !== null && <p style={{ whiteSpace: 'pre-wrap' }}>{a.details}</p>}
      {a.note !== null && <p className="soft">Your chief's note: {a.note}</p>}
      {a.ask !== null && (
        <p className="soft small">
          Your original ask: <q>{a.ask}</q>
        </p>
      )}
      {a.waitingOn === 'chief' && (
        <p className="soft small">
          Your chief of staff is deciding this one. You can answer it yourself instead.
        </p>
      )}
      <label className="stack small">
        Reason (optional, passed on with your answer)
        <input
          className="field"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>
      <div className="row">
        {a.choices.map((choice, index) => (
          <button
            key={choice}
            className={index === 0 ? 'btn primary' : index === last ? 'btn danger' : 'btn'}
            type="button"
            disabled={act.isPending}
            onClick={() => {
              act.mutate({ choice, reason });
            }}
          >
            {choice}
          </button>
        ))}
      </div>
    </article>
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
  const act = useAction(
    `/w/${encodeURIComponent(workspace)}/review/${encodeURIComponent(p.id)}`,
    done,
  );
  const [text, setText] = useState(p.text);
  const [agents, setAgents] = useState(
    () => new Set(p.agents.filter((a) => a.checked).map((a) => a.name)),
  );
  const decide = (decision: 'approve' | 'decline') => {
    act.mutate({ decision, seen: p.seen, text, agents: [...agents] });
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
        <ConfirmButton
          label="Decline"
          question="Decline it? The proposal is removed, and no agent gets it."
          yes="Yes, decline"
          disabled={act.isPending}
          onConfirm={() => {
            decide('decline');
          }}
        />
      </div>
    </article>
  );
}
