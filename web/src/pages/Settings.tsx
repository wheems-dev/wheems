import { Link, useParams } from 'react-router';
import type { SettingsView } from '../../../src/web/data.js';
import { useView } from '../api.js';
import { Kv, Loading, Problem } from '../ui.js';

export function Settings() {
  const id = useParams().id ?? '';
  const view = useView<SettingsView>(`/w/${encodeURIComponent(id)}/settings`);
  if (view.isPending) return <Loading />;
  if (view.error) return <Problem error={view.error} />;
  const v = view.data;
  const w = v.workspace;
  return (
    <>
      <header className="stack">
        <h1>{w.name} settings</h1>
        <p className="muted">
          From <span className="mono">workspaces/{w.id}/workspace.yaml</span>, its agent files and{' '}
          <span className="mono">skills.yaml</span>. Edit those files, then{' '}
          <span className="mono">wheems restart</span>.
        </p>
      </header>
      <div className="grid">
        <section className="card pad stack" aria-labelledby="chief">
          <h2 id="chief">Chief of staff</h2>
          {v.chief ? (
            <>
              <Kv label="Agent file" value={v.chief.file} mono />
              <Kv label="Engine" value={v.chief.engine} />
              <Kv label="Model" value={v.chief.model} mono />
              <Kv label="Account" value={v.chief.account} mono />
              <Kv label="Permissions" value={v.chief.permissions} />
            </>
          ) : (
            <p className="muted">No chief of staff agent file found.</p>
          )}
          {v.postsAs !== null && <Kv label="Posts as" value={v.postsAs} />}
        </section>
        <section className="card pad stack" aria-labelledby="chat">
          <h2 id="chat">Chat and sessions</h2>
          {v.channels.map((c) => (
            <Kv
              key={c.name}
              label={c.name === 'chat' ? 'Chats in' : `Channel ${c.name}`}
              value={c.place}
            />
          ))}
          <Kv
            label="Open sessions per owner"
            value={`up to ${String(v.sessions.maxOpenPerOwner)}`}
          />
          <Kv
            label="Sessions may start sessions"
            value={`${String(v.sessions.maxDepth)} levels deep`}
          />
        </section>
        <section className="card pad stack" aria-labelledby="kb">
          <h2 id="kb">Knowledge base</h2>
          <Kv label="Folder" value={`workspaces/${w.id}/knowledge`} mono />
          <Kv
            label="A note is asked for after"
            value={
              v.knowledge.noteAfterIdle === 0
                ? 'never'
                : `${String(v.knowledge.noteAfterIdle)} min quiet`
            }
          />
          <Kv label="Nightly tidy" value={v.knowledge.tidyAt} />
        </section>
        <section className="card pad stack" aria-labelledby="skills">
          <h2 id="skills">Skills</h2>
          {v.skills.length === 0 ? (
            <p className="muted">None pinned yet.</p>
          ) : (
            v.skills.map((s) => (
              <Kv key={s.name} label={s.name} value={`v${String(s.version)}`} mono />
            ))
          )}
          <Kv label="Budget" value={`${String(v.skills.length)} of ${String(v.skillBudget)}`} />
        </section>
        <section className="card pad stack" aria-labelledby="access">
          <h2 id="access">Accounts and connections it may use</h2>
          {v.accounts.map((a) => (
            <Kv key={a} label="Account" value={a} mono />
          ))}
          {v.integrations.length === 0 ? (
            <p className="muted small">No integrations granted. They arrive in milestone 9.</p>
          ) : (
            v.integrations.map((i) => <Kv key={i.name} label={i.name} value={i.access} mono />)
          )}
          <Link className="small" to="/connections">
            All connections
          </Link>
        </section>
        <section className="card pad stack" aria-labelledby="agents">
          <h2 id="agents">Agents</h2>
          {v.agents.map((a) => (
            <Kv key={a.name} label={a.name} value={`${a.engine} · ${a.model}`} />
          ))}
        </section>
      </div>
      <section className="card pad stack" aria-labelledby="careful">
        <h2 id="careful">Archive or remove {w.name}</h2>
        <p className="soft">
          Archive stops its chief and sessions and keeps everything, to bring back later:{' '}
          <span className="mono">wheems workspace archive {w.id}</span>. Remove deletes its folder,
          knowledge base, sessions and records for good:{' '}
          <span className="mono">wheems workspace remove {w.id}</span>.
        </p>
      </section>
    </>
  );
}
