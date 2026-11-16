/**
 * The web app's stylesheet and script, served as /app.css and /app.js. Colours are tokens with
 * a light and a dark value: the page follows the computer's setting until the person picks one,
 * which the script remembers. The look is wheems.dev's.
 */

const LIGHT = `--bg:#f4f2ea;--main:#fbfaf6;--surface:#ffffff;--sunk:#f6f4ec;--chip:#ebe8dc;--line:#e3e0d4;--hair:#efece2;--ink:#25272c;--soft:#4a4d54;--muted:#686b72;--link:#3156c8;--link-hover:#23409a;--hover:#faf9f4;--navhover:#e9e6da;--sel:#eef2fc;--notice:#fff8e8;--notice-line:#f0dcae;--field-line:#d6d2c3;--logo:#45474c;--inv-bg:#25272c;--inv-ink:#f4f2ea;--twig:#b6b2a3;--ok-bg:#e3f1e8;--ok:#1d6640;--warn-bg:#fbefd6;--warn:#7a4b00;--info-bg:#e3eafb;--info:#2a4aa8;--idle-bg:#ecebe4;--idle:#4a4d54;--no-bg:#f8e1df;--no:#9a2f29;--good:#23784a;--amber:#b07600;--shadow:rgba(37,39,44,.16);--ws-bg:#c9daf5;--ws-ink:#23409a;color-scheme:light`;

const DARK = `--bg:#17181c;--main:#1c1d21;--surface:#24262b;--sunk:#2b2d33;--chip:#26282d;--line:#34363c;--hair:#2e3035;--ink:#eceae2;--soft:#c3c5ca;--muted:#a3a6ad;--link:#9db4ff;--link-hover:#c3d1ff;--hover:#2a2c31;--navhover:#26282d;--sel:#26314d;--notice:#2c2516;--notice-line:#5a4520;--field-line:#3e4047;--logo:#c9cacd;--inv-bg:#eceae2;--inv-ink:#17181c;--twig:#55585f;--ok-bg:#1c3527;--ok:#6fdca6;--warn-bg:#3a2e16;--warn:#ffc46b;--info-bg:#26314d;--info:#a9bfff;--idle-bg:#2f3136;--idle:#c4c6ca;--no-bg:#42221f;--no:#ff9b92;--good:#5fd39a;--amber:#ffc46b;--shadow:rgba(0,0,0,.5);--ws-bg:#2b3a63;--ws-ink:#c3d1ff;color-scheme:dark`;

export const CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Manrope,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.45}
a{color:var(--link)}a:hover{color:var(--link-hover)}
.app{display:flex;flex-wrap:wrap;min-height:100vh}
.side{flex:1 1 240px;max-width:100%;padding:20px 16px;display:flex;flex-direction:column;gap:14px;border-right:1px solid var(--line)}
.mainp{flex:999 1 560px;min-width:0;padding:32px clamp(16px,4vw,48px) 48px;background:var(--main)}
.wrap{max-width:1080px;margin:0 auto;display:flex;flex-direction:column;gap:24px}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px;font-weight:800;font-size:17px;color:var(--ink);text-decoration:none}
.brand svg .cloud{fill:var(--logo)}.brand svg .face{fill:var(--bg)}.brand svg .smile{stroke:var(--bg)}
.switcher{position:relative}
.switcher summary{list-style:none;display:flex;align-items:center;gap:10px;min-height:56px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--surface);cursor:pointer}
.switcher summary::-webkit-details-marker{display:none}
.switcher summary:hover{background:var(--hover)}
.switcher .menu{position:absolute;top:62px;left:0;right:0;z-index:5;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px var(--shadow);padding:6px;display:flex;flex-direction:column;gap:2px}
.mi{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 10px;border-radius:8px;color:var(--ink);text-decoration:none}
.mi:hover{background:var(--hover);color:var(--ink)}
.av{flex:none;width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;background:var(--ws-bg);color:var(--ws-ink)}
.av.inv{background:var(--inv-bg);color:var(--inv-ink)}
.av.big{width:56px;height:56px;border-radius:16px;font-size:22px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 12px;border-radius:10px;color:var(--ink);text-decoration:none;font-weight:600;font-size:14px}
.nav a:hover{background:var(--navhover);color:var(--ink)}
.nav a[aria-current="page"]{background:var(--inv-bg);color:var(--inv-ink)}
.navlabel{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:14px 12px 4px}
.foot{margin-top:auto;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;background:var(--chip)}
.theme{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-family:inherit;font-weight:600;font-size:13px;cursor:pointer}
.theme:hover{background:var(--hover)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px}
.pad{padding:20px}
.notice{background:var(--notice);border-color:var(--notice-line)}
.mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)}.soft{color:var(--soft)}.small{font-size:13px}
h1{margin:0;font-size:30px;font-weight:800;letter-spacing:-.02em}
h2{margin:0;font-size:18px;font-weight:700}
h3{margin:0;font-size:15px;font-weight:700}
p{margin:0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.between{justify-content:space-between}
.stack{display:flex;flex-direction:column;gap:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
.ok{background:var(--ok-bg);color:var(--ok)}.warn{background:var(--warn-bg);color:var(--warn)}.info{background:var(--info-bg);color:var(--info)}.idle{background:var(--idle-bg);color:var(--idle)}.no{background:var(--no-bg);color:var(--no)}
.pill{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-size:13px;font-weight:600;color:var(--ink);text-decoration:none}
.pill:hover{background:var(--hover);color:var(--ink)}
.dot-ok{color:var(--good)}.dot-warn{color:var(--amber)}.dot-no{color:var(--no)}
.stat{display:flex;flex-direction:column;gap:2px;padding:12px;border-radius:12px;background:var(--sunk)}
.stat b{font-size:24px;font-weight:800}.stat span{font-size:12px;color:var(--soft)}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.tag{font-size:13px;padding:6px 10px;border-radius:8px;background:var(--sunk)}
.tree{display:flex;align-items:center;gap:12px;padding:12px 20px;text-decoration:none;color:var(--ink);border-top:1px solid var(--hair)}
.tree:hover{background:var(--hover);color:var(--ink)}
.tree.sel{background:var(--sel);box-shadow:inset 3px 0 0 var(--link)}
.tree.ended{opacity:.65}
.tree svg{flex:none;stroke:var(--twig)}
.grow{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.title{font-weight:600;overflow-wrap:anywhere}
.group{display:flex;align-items:center;gap:10px;padding:16px 20px;font-weight:800}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:14px;border-radius:12px;background:var(--sunk);font-size:13px}
.facts span:first-child{color:var(--soft)}.facts span:last-child{font-weight:600;overflow-wrap:anywhere}
.msg{display:flex;gap:12px}
.msg .av{font-size:12px}
.msg pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px}
.split{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.split>.list{flex:1 1 320px;min-width:0;overflow:hidden}
.split>.detail{flex:2 1 420px;min-width:0;padding:24px;display:flex;flex-direction:column;gap:18px}
.check{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;padding:12px 20px;border-top:1px solid var(--hair);font-size:14px}
.check .grow{flex:1 1 300px}
.empty{padding:20px;color:var(--muted)}
.code{display:inline-block;padding:2px 6px;border-radius:6px;background:var(--sunk)}
.kv{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--hair);font-size:14px}
.kv span:first-child{color:var(--muted)}.kv span:last-child{font-weight:600;text-align:right;overflow-wrap:anywhere}
.preview{margin:0;padding:14px 16px;border-radius:12px;background:#202735;color:#e7e9ef;font:400 13px/1.6 "IBM Plex Mono",ui-monospace,monospace;white-space:pre-wrap;overflow-x:auto;overflow-wrap:anywhere}
.later{background:var(--sunk);border-style:dashed}
`;

/** The theme switch: remembers the person's choice, and otherwise follows the computer. */
export const SCRIPT = `
(function () {
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem('wheems-theme'); } catch (e) {}
  if (stored === 'light' || stored === 'dark') root.setAttribute('data-theme', stored);
  function current() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function label() {
    var button = document.getElementById('theme');
    if (button) button.textContent = current() === 'dark' ? 'Light mode' : 'Dark mode';
  }
  document.addEventListener('DOMContentLoaded', function () {
    label();
    var button = document.getElementById('theme');
    if (!button) return;
    button.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('wheems-theme', next); } catch (e) {}
      label();
    });
  });
})();
`;
