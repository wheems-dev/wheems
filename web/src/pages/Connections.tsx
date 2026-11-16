import type { ConnectionView, ConnectionsView } from '../../../src/web/data.js';
import { useView } from '../api.js';
import { Badge, Loading, Problem } from '../ui.js';

function Uses({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="muted small">Not used by any workspace</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      {names.map((n) => (
        <span key={n} className="tag small">
          {n}
        </span>
      ))}
    </span>
  );
}

function Row({ c }: { c: ConnectionView }) {
  return (
    <div className="check">
      <Badge kind={c.connected ? 'ok' : 'warn'}>
        {c.connected ? 'Connected' : 'No credentials'}
      </Badge>
      <span className="grow">
        <span>
          <b>{c.name}</b>{' '}
          <span className="muted small">
            {c.driver}
            {c.kind === 'chat' &&
              ` · ${String(c.allowedUsers)} ${c.allowedUsers === 1 ? 'person' : 'people'} allowed`}
          </span>
        </span>
        <Uses names={c.usedBy} />
      </span>
    </div>
  );
}

export function Connections() {
  const view = useView<ConnectionsView>('/connections');
  if (view.isPending) return <Loading />;
  if (view.error) return <Problem error={view.error} />;
  const chats = view.data.connections.filter((c) => c.kind === 'chat');
  const integrations = view.data.connections.filter((c) => c.kind === 'integration');
  return (
    <>
      <header className="stack">
        <h1>Connections</h1>
        <p className="muted">
          Connected once for the whole install, with credentials kept outside the install folder.
          Each workspace then chooses which it may use.
        </p>
      </header>
      <section className="card" style={{ overflow: 'hidden' }}>
        <div className="group">
          <h2>Chat channels</h2>
        </div>
        {chats.length === 0 ? (
          <p className="empty">
            None yet. Connect one with <span className="mono">wheems channel connect slack</span>.
          </p>
        ) : (
          chats.map((c) => <Row key={c.name} c={c} />)
        )}
      </section>
      <section className="card" style={{ overflow: 'hidden' }}>
        <div className="group">
          <span className="grow">
            <h2>Integrations and MCP servers</h2>
            <span className="muted small" style={{ fontWeight: 500 }}>
              Outside services agents use, reached through Wheems's broker. Connecting and granting
              them arrives in milestone 9.
            </span>
          </span>
        </div>
        {integrations.length === 0 ? (
          <p className="empty">None connected.</p>
        ) : (
          integrations.map((c) => <Row key={c.name} c={c} />)
        )}
      </section>
      <section className="card" style={{ overflow: 'hidden' }}>
        <div className="group">
          <span className="grow">
            <h2>Engine accounts</h2>
            <span className="muted small" style={{ fontWeight: 500 }}>
              The subscriptions and API keys agents run on. Sign in with{' '}
              <span className="mono">wheems engine login &lt;engine&gt;</span>.
            </span>
          </span>
        </div>
        {view.data.accounts.map((a) => (
          <div key={a.name} className="check">
            <Badge kind={a.needsSecret && !a.hasSecret ? 'warn' : 'idle'}>
              {a.needsSecret ? (a.hasSecret ? 'Key saved' : 'No key yet') : 'Signs in'}
            </Badge>
            <span className="grow">
              <span>
                <b className="mono">{a.name}</b>{' '}
                <span className="muted small">
                  {a.driver}
                  {a.maxSessions !== null && ` · up to ${String(a.maxSessions)} sessions`}
                </span>
              </span>
              <Uses names={a.usedBy} />
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
