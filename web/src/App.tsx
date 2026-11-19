import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import type { InstallSummary, WorkspaceSummary } from '../../src/web/data.js';
import { token, useView } from './api.js';
import { AboutYou } from './pages/AboutYou.js';
import { Connections } from './pages/Connections.js';
import { Overview } from './pages/Overview.js';
import { Review } from './pages/Review.js';
import { Sessions } from './pages/Sessions.js';
import { Settings } from './pages/Settings.js';
import { Setup } from './pages/Setup.js';
import { Icon, Loading, Logo } from './ui.js';

export function App() {
  if (token() === null) return <Locked />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="w/:id" element={<Overview />} />
        <Route path="w/:id/sessions" element={<Sessions />} />
        <Route path="w/:id/review" element={<Review />} />
        <Route path="w/:id/settings" element={<Settings />} />
        <Route path="connections" element={<Connections />} />
        <Route path="about-you" element={<AboutYou />} />
        <Route path="setup" element={<Setup />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

const REMEMBERED = 'wheems-workspace';

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

/** The workspace the sidebar is on: the page's, else the last one chosen, else the first. */
function useWorkspace(install: InstallSummary | undefined): WorkspaceSummary | null {
  // Read from the address: a layout doesn't see the params of the page inside it.
  const { pathname } = useLocation();
  const raw = /^\/w\/([^/]+)/.exec(pathname)?.[1];
  const id = raw === undefined ? undefined : decodeURIComponent(raw);
  useEffect(() => {
    if (id === undefined) return;
    try {
      localStorage.setItem(REMEMBERED, id);
    } catch {
      // Not remembered, then: the first workspace is shown on install pages.
    }
  }, [id]);
  const all = install?.workspaces ?? [];
  const wanted = id ?? remembered();
  return all.find((w) => w.id === wanted) ?? all[0] ?? null;
}

function Home() {
  const install = useView<InstallSummary>('/install');
  if (install.isPending) return <Loading />;
  const first = remembered() ?? install.data?.workspaces[0]?.id;
  const known = install.data?.workspaces.some((w) => w.id === first) === true;
  return (
    <Navigate
      to={known && first !== undefined ? `/w/${encodeURIComponent(first)}` : '/setup'}
      replace
    />
  );
}

function Layout() {
  const install = useView<InstallSummary>('/install', 10_000);
  const workspace = useWorkspace(install.data);
  if (install.error?.status === 401) return <Locked />;
  return (
    <div className="app">
      <aside className="side">
        <div className="brandrow">
          <Link className="brand" to="/">
            <Logo />
            Wheems
          </Link>
          <ThemeSwitch />
        </div>
        {workspace && install.data && <Switcher install={install.data} current={workspace} />}
        <nav className="nav" aria-label="Main">
          {workspace && (
            <>
              <span className="navlabel">{workspace.name}</span>
              <NavLink to={`/w/${encodeURIComponent(workspace.id)}`} end>
                <Icon name="home" />
                Overview
              </NavLink>
              <NavLink to={`/w/${encodeURIComponent(workspace.id)}/sessions`}>
                <Icon name="chat" />
                Sessions
              </NavLink>
              <NavLink to={`/w/${encodeURIComponent(workspace.id)}/review`}>
                <Icon name="check" />
                <span style={{ flex: 1 }}>Review</span>
                {workspace.waiting > 0 && (
                  <span className="badge warn" style={{ height: 20, padding: '0 8px' }}>
                    {workspace.waiting}
                  </span>
                )}
              </NavLink>
              <NavLink to={`/w/${encodeURIComponent(workspace.id)}/settings`}>
                <Icon name="gear" />
                Settings
              </NavLink>
            </>
          )}
          <span className="navlabel">Install</span>
          <NavLink to="/connections">
            <Icon name="link" />
            Connections
          </NavLink>
          <NavLink to="/about-you">
            <Icon name="person" />
            About you
          </NavLink>
          <NavLink to="/setup">
            <Icon name="tool" />
            Setup and health
          </NavLink>
        </nav>
        <div className="foot">
          {install.error?.status === 0 ? (
            <>
              <span className="badge no">● Can&apos;t reach Wheems</span>
              <span className="soft small">
                Check with <span className="mono">wheems status</span>
              </span>
            </>
          ) : install.data?.service.running === true ? (
            <>
              <span className="badge ok">● Service running</span>
              {install.data.service.report?.version !== undefined && (
                <span className="version">Wheems {install.data.service.report.version}</span>
              )}
            </>
          ) : install.data ? (
            <>
              <span className="badge no">● Service not running</span>
              <span className="soft small">
                Start it with <span className="mono">wheems start</span>
              </span>
            </>
          ) : null}
        </div>
      </aside>
      <main className="mainp">
        <div className="wrap">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function Switcher({ install, current }: { install: InstallSummary; current: WorkspaceSummary }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // Switching keeps you on the same kind of page.
  const page = /^\/w\/[^/]+(\/(sessions|review|settings))?/.exec(location.pathname)?.[1] ?? '';
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  return (
    <div className="switcher">
      <button
        type="button"
        className="switcher-button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="av">{current.initial}</span>
        <span className="grow">
          <span className="muted" style={{ fontSize: 11, fontWeight: 700 }}>
            WORKSPACE
          </span>
          <span style={{ fontWeight: 800 }}>{current.name}</span>
        </span>
        <Icon name="updown" size={16} />
      </button>
      {open && (
        <>
          <div
            className="switcher-menu-backdrop"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className="menu" role="menu">
            {install.workspaces.map((w) => (
              <Link
                key={w.id}
                className="mi"
                role="menuitem"
                to={`/w/${encodeURIComponent(w.id)}${page}`}
                aria-current={w.id === current.id ? 'true' : undefined}
              >
                <span className="av">{w.initial}</span>
                <span className="grow">
                  <span style={{ fontWeight: 700 }}>{w.name}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {w.chat}
                  </span>
                </span>
                {w.id === current.id && <span aria-hidden="true">✓</span>}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Light or dark: follows the computer until you choose, then remembers your choice. */
function ThemeSwitch() {
  const [theme, setTheme] = useState(currentTheme);
  return (
    <button
      type="button"
      className="theme"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        setTheme(next);
      }}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}

function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('wheems-theme', theme);
  } catch {
    // Not remembered, then.
  }
}

function Locked() {
  return (
    <main className="mainp" style={{ minHeight: '100vh' }}>
      <div className="wrap" style={{ maxWidth: 560 }}>
        <section className="card pad stack">
          <h1 style={{ fontSize: 24 }}>Open it from Wheems</h1>
          <p className="soft">
            For your privacy, the web app only opens from this computer, with the link{' '}
            <span className="mono">wheems web open</span> gives you.
          </p>
        </section>
      </div>
    </main>
  );
}

function NotFound() {
  return (
    <section className="card pad stack">
      <h1 style={{ fontSize: 24 }}>Not found</h1>
      <p className="soft">
        There's no page here. <Link to="/">Go to the start</Link>.
      </p>
    </section>
  );
}
