import { useState } from 'react';
import type { Flash } from '../../../src/web/actions.js';
import type { AboutYouView } from '../../../src/web/data.js';
import { useAction, useView } from '../api.js';
import { Badge, FlashBanner, Loading, Problem, ConfirmButton } from '../ui.js';

export function AboutYou() {
  const view = useView<AboutYouView>('/about-you', 10_000);
  const [flash, setFlash] = useState<Flash | null>(null);
  if (view.isPending) return <Loading />;
  if (view.error) return <Problem error={view.error} />;
  return (
    <>
      <header className="stack">
        <h1>About you</h1>
        <p className="muted">
          What every agent in every workspace knows about you, from{' '}
          <span className="mono">about-you.md</span> in the install folder. The nightly tidy
          suggests changes from what you tell your chiefs; none is made until you approve it.
        </p>
      </header>
      <FlashBanner flash={flash} />
      {view.data.suggestions.map((s) => (
        <Suggestion key={`${s.name}-${s.seen}`} suggestion={s} done={setFlash} />
      ))}
      <section className="card pad stack" style={{ gap: 12 }}>
        <h2>about-you.md now</h2>
        {view.data.current === null ? (
          <p className="muted">
            Empty so far. Your chiefs fill it in as they learn about you, with your approval.
          </p>
        ) : (
          <pre className="preview">{view.data.current}</pre>
        )}
      </section>
    </>
  );
}

function Suggestion({
  suggestion: s,
  done,
}: {
  suggestion: AboutYouView['suggestions'][number];
  done: (flash: Flash) => void;
}) {
  const act = useAction(`/about-you/${encodeURIComponent(s.name)}`, done);
  const decide = (decision: 'approve' | 'decline') => {
    act.mutate({ decision, seen: s.seen });
  };
  return (
    <article className="card pad stack" style={{ gap: 12 }}>
      <div className="row">
        <Badge kind="info">Suggested new version</Badge>
        {s.workspace !== null && <span className="muted small">From {s.workspace}</span>}
      </div>
      <pre className="preview">{s.text}</pre>
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
          question="Decline it? about-you.md stays as it is, and the suggestion is removed."
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
