import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Flash } from '../../src/web/actions.js';
import type { SessionRecord } from '../../src/state/store.js';

/** Stroke icons, drawn in the current text colour. */
const PATHS = {
  home: ['M3 11l9-7 9 7', 'M5 10v10h14V10'],
  chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
  check: ['M9 12l2 2 4-4'],
  gear: ['M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1'],
  link: ['M9 7H7a5 5 0 0 0 0 10h2', 'M15 7h2a5 5 0 0 1 0 10h-2', 'M8 12h8'],
  person: ['M4 21a8 8 0 0 1 16 0'],
  tool: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z'],
  twig: ['M5 2v10a4 4 0 0 0 4 4h12'],
  updown: ['M8 9l4-4 4 4', 'M8 15l4 4 4-4'],
} as const;

const CIRCLES: Partial<Record<keyof typeof PATHS, [number, number, number]>> = {
  check: [12, 12, 9],
  gear: [12, 12, 3],
  person: [12, 8, 4],
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
  const circle = CIRCLES[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
      {circle && <circle cx={circle[0]} cy={circle[1]} r={circle[2]} />}
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="30" height="25" viewBox="78 94 372 306" aria-hidden="true">
      <path
        className="cloud"
        d="M170 400C116 400 78 364 78 315C78 278 100 248 132 234C124 195 148 158 183 158C195 158 208 162 220 170C230 123 267 94 311 94C370 94 414 138 414 200C414 222 408 243 396 259C430 271 450 296 450 326C450 369 415 400 372 400Z"
      />
      <circle className="face" cx="170" cy="272" r="26" />
      <path
        className="smile"
        d="M144 330Q172 354 200 330"
        fill="none"
        strokeWidth="28"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Badge({
  kind,
  children,
}: {
  kind: 'ok' | 'warn' | 'info' | 'idle' | 'no';
  children: ReactNode;
}) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function SessionBadge({ session }: { session: SessionRecord }) {
  switch (session.state) {
    case 'working':
      return <Badge kind="info">Working</Badge>;
    case 'starting':
      return <Badge kind="info">Starting</Badge>;
    case 'idle':
      return <Badge kind="idle">Idle</Badge>;
    case 'stopped':
      return <Badge kind="warn">Stopped</Badge>;
    case 'ended':
      return <Badge kind="idle">Ended</Badge>;
  }
}

/** A label and its value, as a row in a card. */
export function Kv({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="kv">
      <span>{label}</span>
      <span className={mono ? 'mono' : undefined}>{value}</span>
    </div>
  );
}

export function FlashBanner({ flash }: { flash: Flash | null | undefined }) {
  if (!flash) return null;
  return (
    <p className={`card pad flash ${flash.ok ? 'ok' : 'no'}`} role="status">
      {flash.text}
    </p>
  );
}

/**
 * A button for something that can't be undone: the first click asks, in the page, and only
 * "yes" acts. No browser dialog, so nothing blocks the page.
 */
export function ConfirmButton({
  label,
  question,
  yes,
  disabled = false,
  onConfirm,
}: {
  label: string;
  question: string;
  yes: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        className="btn"
        type="button"
        disabled={disabled}
        onClick={() => {
          setAsking(true);
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="row confirm" role="group" aria-label={question}>
      <span className="small">{question}</span>
      <button
        className="btn danger"
        type="button"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {yes}
      </button>
      <button
        className="btn"
        type="button"
        autoFocus
        onClick={() => {
          setAsking(false);
        }}
      >
        Cancel
      </button>
    </span>
  );
}

export function Loading() {
  return <p className="loading">Loading…</p>;
}

export function Problem({ error }: { error: Error }) {
  return (
    <section className="card pad">
      <p className="soft">{error.message}</p>
    </section>
  );
}

/** How long ago a time was, in the largest whole unit. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'a while';
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h`;
  return `${String(Math.round(hours / 24))} days`;
}
