import type { DoctorReport } from '../../../src/doctor/doctor.js';
import type { InstallSummary } from '../../../src/web/data.js';
import { useView } from '../api.js';
import { Badge, Problem } from '../ui.js';

function Status({ status }: { status: string }) {
  if (status === 'pass') return <Badge kind="ok">Passed</Badge>;
  if (status === 'warn') return <Badge kind="warn">Warning</Badge>;
  if (status === 'fail') return <Badge kind="no">Failed</Badge>;
  return <Badge kind="idle">Skipped</Badge>;
}

export function Setup() {
  const view = useView<{ install: InstallSummary; report: DoctorReport }>('/setup');
  if (view.isPending)
    return (
      <>
        <header className="stack">
          <h1>Setup and health</h1>
        </header>
        <p className="loading">Running doctor's checks…</p>
      </>
    );
  if (view.error) return <Problem error={view.error} />;
  const failing = view.data.report.sections
    .flatMap((s) => s.checks)
    .filter((c) => c.status === 'fail').length;
  return (
    <>
      <header className="stack">
        <h1>Setup and health</h1>
        <p className="muted">
          The checks from <span className="mono">wheems doctor</span>, run just now.{' '}
          {failing === 0
            ? 'Nothing is failing.'
            : `${String(failing)} ${failing === 1 ? 'check is' : 'checks are'} failing.`}{' '}
          To change the setup, run <span className="mono">wheems setup</span>.
        </p>
      </header>
      {view.data.report.sections.map((section) => (
        <section key={section.title} className="card" style={{ overflow: 'hidden' }}>
          <div className="group">
            <h2>{section.title}</h2>
          </div>
          {section.checks.map((c) => (
            <div key={`${c.name}-${c.message}`} className="check">
              <Status status={c.status} />
              <span className="grow">
                <span>{c.message}</span>
                {c.hint !== undefined && <span className="muted small">{c.hint}</span>}
              </span>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
