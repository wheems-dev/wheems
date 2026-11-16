import { useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { Flash } from '../../../src/web/actions.js';
import type { SettingsView } from '../../../src/web/data.js';
import { useAction, useView } from '../api.js';
import { FlashBanner, Kv, Loading, Problem } from '../ui.js';

/** The values the form edits, as the page sends them. */
interface Values {
  name: string;
  description: string;
  postsAs: string;
  maxOpenPerOwner: string;
  maxDepth: string;
  noteAfterIdle: string;
  tidy: boolean;
  tidyAt: string;
  skillBudget: string;
}

function valuesOf(v: SettingsView): Values {
  return {
    name: v.workspace.name,
    description: v.description ?? '',
    postsAs: v.postsAs ?? '',
    maxOpenPerOwner: String(v.sessions.maxOpenPerOwner),
    maxDepth: String(v.sessions.maxDepth),
    noteAfterIdle: String(v.knowledge.noteAfterIdle),
    tidy: v.knowledge.tidyAt !== 'off',
    tidyAt: v.knowledge.tidyAt === 'off' ? '03:00' : v.knowledge.tidyAt,
    skillBudget: String(v.skillBudget),
  };
}

const PERMISSIONS: Record<string, string> = {
  ask: "Ask: the engine's normal prompts",
  auto: 'Auto: routine actions without asking, risky ones ask',
  skip: 'Skip: never asks',
};

export function Settings() {
  const id = useParams().id ?? '';
  const view = useView<SettingsView>(`/w/${encodeURIComponent(id)}/settings`);
  if (view.isPending) return <Loading />;
  // Settings already shown stay, with what you've typed, when a refresh fails (the service
  // stopped, say): the error shows above them instead.
  if (view.data === undefined) return <Problem error={view.error} />;
  // A new form only for another workspace: a refresh keeps what you've typed.
  return <SettingsForm key={id} v={view.data} id={id} refreshError={view.error?.message ?? null} />;
}

function SettingsForm({
  v,
  id,
  refreshError,
}: {
  v: SettingsView;
  id: string;
  refreshError: string | null;
}) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const [saved, setSaved] = useState(false);
  // Only the fields you've edited, over what the file says now, so a refresh (after a save, or
  // a save refused because the file changed) never loses them, and never undoes a field you
  // didn't touch.
  const [edits, setEdits] = useState<Partial<Values>>({});
  const submitted = useRef<Partial<Values>>({});
  const w = v.workspace;
  const start = valuesOf(v);
  const values: Values = { ...start, ...edits };
  const save = useAction(`/w/${encodeURIComponent(id)}/settings`, (result) => {
    setFlash(result);
    if (!result.ok) return;
    setSaved((was) => was || result.text.startsWith('Saved'));
    // What was saved is in the file now; keep anything typed since.
    const sent = submitted.current;
    setEdits((now) =>
      Object.fromEntries(
        Object.entries(now).filter(([key, typed]) => sent[key as keyof Values] !== typed),
      ),
    );
  });
  const restart = useAction('/restart', (result) => {
    setFlash(result);
    if (result.ok) setSaved(false);
  });
  const changed = (Object.keys(start) as (keyof Values)[]).filter(
    (key) => values[key] !== start[key],
  );
  const set =
    <K extends keyof Values>(key: K) =>
    (next: Values[K]) => {
      setEdits((now) => ({ ...now, [key]: next }));
    };
  const submit = () => {
    submitted.current = { ...edits };
    const fields: Record<string, string> = { seen: v.seen };
    for (const key of changed) {
      if (key === 'tidy' || key === 'tidyAt') fields.tidyAt = values.tidy ? values.tidyAt : 'off';
      else fields[key] = values[key];
    }
    save.mutate(fields);
  };
  const running = v.install.service.running;

  return (
    <form
      className="stack"
      style={{ gap: 16 }}
      // Settings, not personal details: no browser or password manager offers to fill or keep them.
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header className="stack">
        <h1>{w.name} settings</h1>
        <p className="muted">
          Saved to <span className="mono">workspaces/{w.id}/workspace.yaml</span>, keeping your
          comments, so you can still edit the file. The service uses a change once it restarts.
        </p>
      </header>
      {refreshError !== null && (
        <p className="card pad flash no" role="alert">
          {refreshError} What you&apos;ve typed is kept here.
        </p>
      )}
      <FlashBanner flash={flash} />
      {saved && (
        <div className="card pad row between">
          <span>
            {running
              ? 'Restart the service to use the new settings.'
              : 'Start the service to use them: wheems start'}
          </span>
          {running && (
            <button
              className="btn primary"
              type="button"
              disabled={restart.isPending}
              onClick={() => {
                restart.mutate({});
              }}
            >
              {restart.isPending ? 'Restarting…' : 'Restart now'}
            </button>
          )}
        </div>
      )}
      <div className="grid">
        <Section id="ws" title="Workspace">
          <Field label="Name">
            <input
              className="field"
              value={values.name}
              onChange={(e) => {
                set('name')(e.target.value);
              }}
            />
          </Field>
          <Field label="Description" hint="Optional, one line">
            <input
              className="field"
              value={values.description}
              onChange={(e) => {
                set('description')(e.target.value);
              }}
            />
          </Field>
          <Kv label="Folder" value={`workspaces/${w.id}`} mono />
        </Section>

        <Section id="chief" title="Chief of staff">
          {v.chief ? (
            <>
              <Kv label="Agent file" value={v.chief.file} mono />
              <Kv label="Engine" value={v.chief.engine} />
              <Kv label="Model" value={v.chief.model} mono />
              <Kv label="Account" value={v.chief.account} mono />
              <Kv
                label="Permissions"
                value={PERMISSIONS[v.chief.permissions] ?? v.chief.permissions}
              />
              <p className="muted small">
                Change these in its agent file. A conversation that&apos;s already open keeps its
                chief as it started, even after a restart; new ones use the change.
              </p>
            </>
          ) : (
            <p className="muted">No chief of staff agent file found.</p>
          )}
          <Field label="Posts as" hint="The name its messages appear under, where chat allows">
            <input
              className="field"
              value={values.postsAs}
              onChange={(e) => {
                set('postsAs')(e.target.value);
              }}
            />
          </Field>
        </Section>

        <Section id="chat" title="Chat and sessions">
          {v.channels.map((c) => (
            <Kv
              key={c.name}
              label={c.name === 'chat' ? 'Chats in' : `Channel ${c.name}`}
              value={c.place}
            />
          ))}
          <Field label="Open sessions per owner" hint="A chief, a session or you">
            <input
              className="field"
              type="number"
              min={1}
              value={values.maxOpenPerOwner}
              onChange={(e) => {
                set('maxOpenPerOwner')(e.target.value);
              }}
            />
          </Field>
          <Field
            label="Levels of sessions starting sessions"
            hint="2 lets a chief's session start one, and that one start one more"
          >
            <input
              className="field"
              type="number"
              min={1}
              value={values.maxDepth}
              onChange={(e) => {
                set('maxDepth')(e.target.value);
              }}
            />
          </Field>
        </Section>

        <Section id="kb" title="Knowledge base">
          <Kv label="Folder" value={`workspaces/${w.id}/knowledge`} mono />
          <Field label="Ask for a note after this many quiet minutes" hint="0 never asks">
            <input
              className="field"
              type="number"
              min={0}
              value={values.noteAfterIdle}
              onChange={(e) => {
                set('noteAfterIdle')(e.target.value);
              }}
            />
          </Field>
          <label className="choice small">
            <input
              type="checkbox"
              checked={values.tidy}
              onChange={(e) => {
                set('tidy')(e.target.checked);
              }}
            />
            Run the nightly tidy
          </label>
          {values.tidy && (
            <Field label="At, in local time">
              <input
                className="field"
                type="time"
                value={values.tidyAt}
                onChange={(e) => {
                  set('tidyAt')(e.target.value);
                }}
              />
            </Field>
          )}
        </Section>

        <Section id="skills" title="Skills">
          {v.skills.length === 0 ? (
            <p className="muted">None pinned yet.</p>
          ) : (
            v.skills.map((s) => (
              <Kv key={s.name} label={s.name} value={`v${String(s.version)}`} mono />
            ))
          )}
          <Field
            label="Skill budget"
            hint={`Doctor warns past this many. ${String(v.skills.length)} pinned now.`}
          >
            <input
              className="field"
              type="number"
              min={1}
              value={values.skillBudget}
              onChange={(e) => {
                set('skillBudget')(e.target.value);
              }}
            />
          </Field>
        </Section>

        <Section id="access" title="Accounts and connections it may use">
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
        </Section>

        <Section id="agents" title="Agents">
          {v.agents.map((a) => (
            <Kv key={a.name} label={a.name} value={`${a.engine} · ${a.model}`} />
          ))}
        </Section>
      </div>

      <div className="card pad row between save-bar">
        <span className="muted small">
          {changed.length === 0
            ? 'No changes.'
            : `${String(changed.length)} ${changed.length === 1 ? 'change' : 'changes'} not saved yet.`}
        </span>
        <div className="row">
          <button
            className="btn"
            type="button"
            disabled={changed.length === 0 || save.isPending}
            onClick={() => {
              setEdits({});
            }}
          >
            Undo changes
          </button>
          <button
            className="btn primary"
            type="submit"
            disabled={changed.length === 0 || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
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
    </form>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card pad stack" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="stack small" style={{ gap: 4 }}>
      <span>
        {label}
        {hint !== undefined && <span className="muted"> · {hint}</span>}
      </span>
      {children}
    </label>
  );
}
