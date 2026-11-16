import { useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { ConversationsFlash, Flash } from '../../../src/web/actions.js';
import type { OpenConversation, RestartOutcome } from '../../../src/service/conversations.js';
import type { SettingsView } from '../../../src/web/data.js';
import { useAction, useView } from '../api.js';
import { FlashBanner, Kv, Loading, Problem, ago } from '../ui.js';

/** The values the form edits, as the page sends them. */
interface Values {
  name: string;
  description: string;
  postsAs: string;
  engine: string;
  model: string;
  account: string;
  permissions: string;
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
    engine: v.chief?.engine ?? '',
    model: v.chief?.model ?? '',
    account: v.chief?.account ?? '',
    permissions: v.chief?.permissions ?? 'ask',
    maxOpenPerOwner: String(v.sessions.maxOpenPerOwner),
    maxDepth: String(v.sessions.maxDepth),
    noteAfterIdle: String(v.knowledge.noteAfterIdle),
    tidy: v.knowledge.tidyAt !== 'off',
    tidyAt: v.knowledge.tidyAt === 'off' ? '03:00' : v.knowledge.tidyAt,
    skillBudget: String(v.skillBudget),
  };
}

/** The chief of staff's own settings, in its agent file: a change reaches open conversations
 * only as the person chooses for each. */
const CHIEF: (keyof Values)[] = ['engine', 'model', 'account', 'permissions'];

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
  // A saved change to the chief: open conversations need a choice before the restart.
  const [chiefChange, setChiefChange] = useState<{ engine: boolean } | null>(null);
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
    if (result.text.startsWith('Saved') && CHIEF.some((key) => key in sent)) {
      setChiefChange((was) => ({ engine: (was?.engine ?? false) || 'engine' in sent }));
    }
    setEdits((now) =>
      Object.fromEntries(
        Object.entries(now).filter(([key, typed]) => sent[key as keyof Values] !== typed),
      ),
    );
  });
  const restart = useAction('/restart', (result) => {
    setFlash(result);
    if (result.ok) {
      setSaved(false);
      setChiefChange(null);
    }
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
          Saved to <span className="mono">workspaces/{w.id}/workspace.yaml</span> and the chief of
          staff&apos;s agent file, keeping your comments, so you can still edit the files. The
          service uses a change once it restarts.
        </p>
      </header>
      {refreshError !== null && (
        <p className="card pad flash no" role="alert">
          {refreshError} What you&apos;ve typed is kept here.
        </p>
      )}
      <FlashBanner flash={flash} />
      {saved && chiefChange !== null && running && (
        <OpenConversations
          id={id}
          engineChanged={chiefChange.engine}
          restarting={restart.isPending}
          onApplied={(result) => {
            setFlash(result);
            restart.mutate({});
          }}
        />
      )}
      {saved && (chiefChange === null || !running) && (
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
              <Field label="Engine">
                <select
                  className="field"
                  value={values.engine}
                  onChange={(e) => {
                    set('engine')(e.target.value);
                  }}
                >
                  {[...new Set([values.engine, ...v.engines])].map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model" hint="The engine's model id">
                <input
                  className="field mono"
                  value={values.model}
                  onChange={(e) => {
                    set('model')(e.target.value);
                  }}
                />
              </Field>
              <Field label="Account" hint="Who pays, from this workspace's accounts">
                <select
                  className="field"
                  value={values.account}
                  onChange={(e) => {
                    set('account')(e.target.value);
                  }}
                >
                  {[...new Set([values.account, ...v.accounts])].map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Permissions">
                <select
                  className="field"
                  value={values.permissions}
                  onChange={(e) => {
                    set('permissions')(e.target.value);
                  }}
                >
                  {Object.entries(PERMISSIONS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="muted small">
                Saving a change here asks what happens to the conversations already open: carry on,
                hand over to a new session, or start fresh.
              </p>
              {values.permissions === 'skip' && (
                <p className="small flash no card pad">
                  With skip, the chief never asks before acting, even for risky actions.
                </p>
              )}
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

type Choice = 'carry-on' | 'hand-over' | 'fresh';

const CHOICE_LABELS: Record<Choice, string> = {
  'carry-on': 'Carry on',
  'hand-over': 'Hand over',
  fresh: 'Start fresh',
};

/** A week: threads quieter than this start fresh by default rather than hand over. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * After a change to the chief: what happens to each conversation already open, chosen before the
 * restart, while the running service still has the old chief to write handovers. Carry on is the
 * default unless the engine changed, when a thread can't carry on: then recent threads hand over
 * and older ones start fresh (docs/session-handover.md).
 */
function OpenConversations({
  id,
  engineChanged,
  restarting,
  onApplied,
}: {
  id: string;
  engineChanged: boolean;
  restarting: boolean;
  onApplied: (result: Flash) => void;
}) {
  const view = useView<{ conversations: OpenConversation[]; problem: string | null }>(
    `/w/${encodeURIComponent(id)}/conversations`,
  );
  const [picked, setPicked] = useState<Record<string, Choice>>({});
  const [outcomes, setOutcomes] = useState<RestartOutcome[]>([]);
  const apply = useAction(`/w/${encodeURIComponent(id)}/conversations`, (result) => {
    setOutcomes('outcomes' in result ? (result as ConversationsFlash).outcomes : []);
    onApplied(result);
  });
  if (view.isPending) return <Loading />;
  const conversations = view.data?.conversations ?? [];
  const fallback = (c: OpenConversation): Choice =>
    !engineChanged
      ? 'carry-on'
      : Date.now() - Date.parse(c.lastActiveAt) < RECENT_MS
        ? 'hand-over'
        : 'fresh';
  const choiceOf = (c: OpenConversation) => picked[c.session] ?? fallback(c);
  const choices: Choice[] = engineChanged
    ? ['hand-over', 'fresh']
    : ['carry-on', 'hand-over', 'fresh'];
  const busy = apply.isPending || restarting;
  return (
    <section className="card pad stack" aria-labelledby="open-conversations">
      <h2 id="open-conversations">Conversations already open</h2>
      <p className="soft small">
        {engineChanged
          ? "The chief's engine changed, so an open conversation can't carry on: hand it over to a new session, from a handover its chief writes now, or start it fresh."
          : 'Carry on resumes each with the new settings and everything it remembers. Hand over starts a new session from a handover its chief writes now; start fresh starts one with only the ask.'}
      </p>
      {view.data?.problem !== null && view.data?.problem !== undefined && (
        <p className="flash no card pad small">{view.data.problem}</p>
      )}
      {conversations.length === 0 ? (
        <p className="muted small">None are open.</p>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          {conversations.map((c) => {
            const outcome = outcomes.find((o) => o.key === c.key);
            return (
              <div key={c.session} className="kv">
                <span className="stack" style={{ gap: 2 }}>
                  <span>{c.ask ?? 'A conversation'}</span>
                  <span className="muted small">
                    {ago(c.lastActiveAt)} ago
                    {c.running ? ' · running' : ''}
                    {c.busy ? ' · answering a message, so it will be left as it is' : ''}
                    {outcome !== undefined ? ` · ${outcome.text}` : ''}
                  </span>
                </span>
                <select
                  className="field"
                  style={{ width: 'auto' }}
                  aria-label={`What happens to ${c.ask ?? 'this conversation'}`}
                  value={choiceOf(c)}
                  disabled={busy || outcomes.length > 0}
                  onChange={(e) => {
                    setPicked((now) => ({ ...now, [c.session]: e.target.value as Choice }));
                  }}
                >
                  {choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {CHOICE_LABELS[choice]}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
      <div className="row">
        <button
          className="btn primary"
          type="button"
          disabled={busy || view.data?.problem !== null}
          onClick={() => {
            // Applied already: only the restart is left, so nothing is handed over twice.
            if (conversations.length === 0 || outcomes.length > 0) {
              onApplied({
                ok: true,
                text: outcomes.length > 0 ? 'Restarting.' : 'No conversations to set up.',
              });
              return;
            }
            apply.mutate(
              Object.fromEntries(conversations.map((c) => [`s:${c.session}`, choiceOf(c)])),
            );
          }}
        >
          {apply.isPending
            ? 'Asking for handovers…'
            : restarting
              ? 'Restarting…'
              : outcomes.length > 0
                ? 'Restart now'
                : 'Apply and restart'}
        </button>
        <span className="muted small">
          A handover can take a few minutes: each chief writes its own.
        </span>
      </div>
    </section>
  );
}
