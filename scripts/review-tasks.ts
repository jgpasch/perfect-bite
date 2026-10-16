// Moves finished tasks (`- [x]` and `- [m]`) out of tasks.md into the review checklist, then rebuilds
// review/index.html from review/tasks.json. A section left with no tasks is removed from tasks.md (its
// goal travels with its tasks). Each task carries Ralph's progress.md notes and any manual-checks.md
// entries that name it. Run it by hand, not while ralph-parallel is merging:
//
//   yarn review:tasks            # move finished tasks and rebuild the page
//   yarn review:tasks --dry-run  # show what would move
//   yarn review:tasks --force    # run even if Ralph worktrees exist
//
// Open review/index.html in a browser. Ticks are saved in that browser (localStorage), keyed by task.

const ROOT = new URL('..', import.meta.url).pathname;
const TASKS = `${ROOT}tasks.md`;
const REVIEW_DIR = `${ROOT}review`;
const DATA = `${REVIEW_DIR}/tasks.json`;
const PAGE = `${REVIEW_DIR}/index.html`;

type ReviewTask = {
  id: string;
  section: string;
  goal: string;
  title: string;
  text: string;
  status: 'done' | 'manual';
  movedAt: string;
  notes: string[];
  manualChecks: string[];
};

const args = new Set(Deno.args);
const dryRun = args.has('--dry-run');

async function ralphRunning(): Promise<boolean> {
  const base = `${ROOT}../.${ROOT.split('/').filter(Boolean).pop()}-ralph`;
  try {
    for await (const e of Deno.readDir(base)) if (e.isDirectory && e.name.startsWith('wt-')) return true;
  } catch {
    // No Ralph folder: nothing running.
  }
  return false;
}

async function readText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return '';
  }
}

async function hash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/** "Members' names on the device (spec 4.7, 5, 7). The device…" → "Members' names on the device". */
function titleOf(text: string): string {
  return (text.match(/^(.+?)(?: \(|\. |$)/)?.[1] ?? text).trim();
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'can', 'a', 'an', 'of', 'to', 'in', 'on']);
const words = (s: string) =>
  new Set(s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 1 && !STOP_WORDS.has(w)) ?? []);

/**
 * Whether a progress.md or manual-checks.md line is about this task. Ralph rewords titles a little
 * ("Saving the step match on the recipe" for "Saving the match on the recipe"), so besides the exact
 * title, the line's own lead (before " (" or ":") counts when most of the shorter side's words match.
 */
function mentions(line: string, title: string): boolean {
  if (line.toLowerCase().includes(title.toLowerCase())) return true;
  const line_ = line.replace(/^NOT CHECKED OFF \([^)]*\) /, '');
  const b = words(title);
  return [line_.split(' (')[0], line_.split(/ \(|: /)[0]].some((lead) => {
    const a = words(lead);
    if (Math.min(a.size, b.size) < 3) return false;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size) >= 0.75;
  });
}

const TASK = /^\s*[-*] \[( |x|X|m)\] (.*)$/;

type Section = { heading: string | null; body: string[]; lines: string[]; open: number };

function parse(md: string): Section[] {
  const sections: Section[] = [{ heading: null, body: [], lines: [], open: 0 }];
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) sections.push({ heading: line.slice(3).trim(), body: [], lines: [line], open: 0 });
    else {
      const s = sections[sections.length - 1];
      s.lines.push(line);
      const m = line.match(TASK);
      if (m && m[1] === ' ') s.open++;
      else if (!m && line.trim() && !line.startsWith('<!--')) s.body.push(line.trim());
    }
  }
  return sections;
}

async function main() {
  if (!args.has('--force') && (await ralphRunning())) {
    console.error('Ralph worktrees exist (ralph-parallel is running or was interrupted). Wait, or pass --force.');
    Deno.exit(1);
  }

  const md = await Deno.readTextFile(TASKS);
  const progress = (await readText(`${ROOT}progress.md`)).split('\n').filter((l) => l.startsWith('- '));
  const checks = (await readText(`${ROOT}manual-checks.md`)).split('\n').filter((l) => /^- \[[ x]\] /.test(l));
  const existing: ReviewTask[] = JSON.parse((await readText(DATA)) || '[]');
  const known = new Set(existing.map((t) => t.id));
  const movedAt = new Date().toISOString();

  const moved: ReviewTask[] = [];
  const out: string[] = [];
  for (const s of parse(md)) {
    const keep: string[] = [];
    for (const line of s.lines) {
      const m = line.match(TASK);
      if (!m || m[1] === ' ') {
        keep.push(line);
        continue;
      }
      const text = m[2].trim();
      const title = titleOf(text);
      const id = await hash(`${s.heading ?? ''}\n${text}`);
      if (known.has(id)) continue;
      moved.push({
        id,
        section: s.heading ?? 'Tasks',
        goal: s.body.join(' '),
        title,
        text,
        status: m[1] === 'm' ? 'manual' : 'done',
        movedAt,
        notes: progress.map((l) => l.slice(2)).filter((l) => mentions(l, title)),
        manualChecks: checks.map((l) => l.replace(/^- \[[ x]\] /, '')).filter((l) => mentions(l, title)),
      });
    }
    // A section with nothing left to do goes, goal and all. The preamble always stays.
    if (s.heading !== null && s.open === 0) continue;
    out.push(...keep);
  }

  console.log(moved.length ? `Moving ${moved.length} task(s):` : 'No finished tasks in tasks.md.');
  for (const t of moved) console.log(`  ${t.status === 'manual' ? '[m]' : '[x]'} ${t.section} › ${t.title}`);
  if (dryRun) return;

  const all = [...existing, ...moved];
  await Deno.mkdir(REVIEW_DIR, { recursive: true });
  if (moved.length) {
    await Deno.writeTextFile(DATA, JSON.stringify(all, null, 2) + '\n');
    await Deno.writeTextFile(TASKS, out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n'));
  }
  await Deno.writeTextFile(PAGE, page(all));
  console.log(`Wrote ${PAGE.replace(ROOT, '')} (${all.length} tasks). Open it with: open review/index.html`);
}

function page(tasks: ReviewTask[]): string {
  const data = JSON.stringify(tasks).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ralph Review</title>
<style>
:root {
  --bg: #EEF3EC; --surface: #FFFFFF; --muted: #DCE4DA; --border: #E3E9E1; --control: #B9C4BC;
  --ink: #1D2A22; --ink2: #55635A; --ink3: #7C877F; --primary: #2E6B45; --on-primary: #FFFFFF;
  --primary-soft: #DDEFE2; --on-primary-soft: #1F5233; --pending: #8A5C0C; --pending-soft: #FFF7E6;
  --header: #1F4D33; --on-header: #FFFFFF; --on-header2: #B7D2BF;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #111915; --surface: #1B241F; --muted: #26312B; --border: #26312B; --control: #4A5850;
  --ink: #E6EDE7; --ink2: #A9B6AD; --ink3: #7F8C84; --primary: #7CC395; --on-primary: #10301D;
  --primary-soft: #1F3A2A; --on-primary-soft: #BFE5CC; --pending: #E7B866; --pending-soft: #2E2516;
  --header: #163A26; --on-header: #FFFFFF; --on-header2: #9FC2AA;
} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
header { background: var(--header); color: var(--on-header); padding: 28px 16px 20px; }
.wrap { max-width: 860px; margin: 0 auto; }
h1 { margin: 0; font-size: 28px; letter-spacing: -0.01em; }
.sub { color: var(--on-header2); margin-top: 4px; }
.bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.18); margin-top: 14px; overflow: hidden; }
.bar > div { height: 100%; background: var(--on-header2); transition: width .2s; }
.filters { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.filters button { border: 0; border-radius: 999px; padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer;
  background: rgba(255,255,255,.14); color: var(--on-header); }
.filters button[aria-pressed="true"] { background: var(--on-header); color: var(--header); }
main { padding: 8px 16px 48px; }
.batch { margin-top: 22px; color: var(--ink2); font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.section { background: var(--surface); border-radius: 16px; margin-top: 10px; overflow: hidden; }
.section > h2 { margin: 0; padding: 14px 16px 4px; font-size: 17px; display: flex; gap: 8px; align-items: baseline; }
.section > h2 .count { margin-left: auto; color: var(--ink2); font-size: 13px; font-weight: 600; white-space: nowrap; }
.goal { padding: 0 16px 10px; color: var(--ink2); font-size: 13px; }
.goal summary { cursor: pointer; font-weight: 600; }
.task { border-top: 1px solid var(--border); padding: 12px 16px; display: grid; grid-template-columns: 28px 1fr; gap: 4px 12px; }
.task input { appearance: none; width: 24px; height: 24px; margin: 1px 0 0; border-radius: 50%; border: 2px solid var(--control);
  cursor: pointer; display: grid; place-items: center; }
.task input:checked { background: var(--primary); border-color: var(--primary); }
.task input:checked::after { content: ""; width: 6px; height: 11px; border: solid var(--on-primary); border-width: 0 2.5px 2.5px 0; transform: translateY(-1px) rotate(45deg); }
.task input:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
.title { font-weight: 600; cursor: pointer; }
.task.reviewed .title { color: var(--ink2); text-decoration: line-through; }
.badges { display: inline-flex; gap: 6px; margin-left: 6px; vertical-align: 1px; }
.badge { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 2px 8px; background: var(--primary-soft); color: var(--on-primary-soft); }
.badge.warn { background: var(--pending-soft); color: var(--pending); }
details.more { grid-column: 2; font-size: 14px; }
details.more > summary { color: var(--ink2); cursor: pointer; font-size: 13px; }
.block { margin-top: 8px; }
.block h3 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink2); }
.block p, .block li { margin: 0 0 6px; }
.block ul { margin: 0; padding-left: 18px; }
.check { background: var(--pending-soft); border-radius: 10px; padding: 8px 10px; }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--muted); border-radius: 4px; padding: 1px 4px; word-break: break-word; }
a { color: var(--primary); }
.empty { text-align: center; color: var(--ink2); padding: 40px 0; }
.tools { display: flex; gap: 12px; justify-content: flex-end; margin-top: 18px; font-size: 13px; }
.tools button { border: 0; background: none; color: var(--primary); font: inherit; font-weight: 600; cursor: pointer; padding: 0; }
</style>
</head>
<body>
<header><div class="wrap">
  <h1>Ralph review</h1>
  <div class="sub" id="sub"></div>
  <div class="bar"><div id="fill"></div></div>
  <div class="filters" role="group" aria-label="Show">
    <button data-f="todo">To review</button><button data-f="manual">Manual checks</button>
    <button data-f="done">Reviewed</button><button data-f="all">All</button>
  </div>
</div></header>
<main class="wrap">
  <div id="list"></div>
  <div class="tools"><button id="expand">Expand all</button><button id="export">Copy reviewed state</button></div>
</main>
<script>
const TASKS = ${data};
const KEY = 'ralph-review:v1';
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
let filter = 'todo';
try { filter = localStorage.getItem(KEY + ':filter') || 'todo'; } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function md(s) {
  const codes = [];
  let h = esc(s).replace(/\`([^\`]+)\`/g, (_, c) => (codes.push(c), '\\u0000' + (codes.length - 1) + '\\u0000'));
  h = h.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
       .replace(/(^|[\\s(])\\*([^*\\s][^*]*)\\*/g, '$1<em>$2</em>')
       .replace(/https?:\\/\\/[^\\s)<]*[^\\s)<.,;:]/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
  return h.replace(/\\u0000(\\d+)\\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
}
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const needsCheck = (t) => t.status === 'manual' || t.manualChecks.length > 0 || /NEEDS A MANUAL CHECK/.test(t.text);
const visible = (t) => filter === 'all' || (filter === 'done' ? !!state[t.id] : filter === 'manual' ? needsCheck(t) && !state[t.id] : !state[t.id]);

function render() {
  const done = TASKS.filter((t) => state[t.id]).length;
  document.getElementById('sub').textContent = TASKS.length
    ? done + ' of ' + TASKS.length + ' reviewed · ' + (TASKS.length - done) + ' to go'
    : 'Nothing moved here yet. Run yarn review:tasks.';
  document.getElementById('fill').style.width = (TASKS.length ? (100 * done) / TASKS.length : 0) + '%';
  document.querySelectorAll('.filters button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === filter)));

  // Newest batch first; sections in the order they were in tasks.md.
  const batches = new Map();
  for (const t of TASKS.filter(visible)) {
    const b = batches.get(t.movedAt) || new Map();
    const s = b.get(t.section) || [];
    s.push(t); b.set(t.section, s); batches.set(t.movedAt, b);
  }
  const list = document.getElementById('list');
  if (!batches.size) { list.innerHTML = '<p class="empty">' + (filter === 'todo' ? 'All caught up.' : 'Nothing here.') + '</p>'; return; }
  list.innerHTML = [...batches.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([at, secs]) =>
    '<div class="batch">Moved ' + day(at) + '</div>' + [...secs.entries()].map(([name, ts]) => {
      const all = TASKS.filter((t) => t.section === name && t.movedAt === at);
      const n = all.filter((t) => state[t.id]).length;
      return '<section class="section"><h2>' + md(name) + '<span class="count">' + n + ' / ' + all.length + '</span></h2>' +
        (ts[0].goal ? '<details class="goal"><summary>Goal</summary><p>' + md(ts[0].goal) + '</p></details>' : '') +
        ts.map(task).join('') + '</section>';
    }).join('')).join('');
}

function task(t) {
  const badges = [];
  if (t.status === 'manual') badges.push('<span class="badge warn">Hands-on</span>');
  else if (needsCheck(t)) badges.push('<span class="badge warn">Manual check</span>');
  const rest = t.text.slice(t.title.length).replace(/^\\s*/, '');
  return '<div class="task' + (state[t.id] ? ' reviewed' : '') + '">' +
    '<input type="checkbox" data-id="' + t.id + '" aria-label="Reviewed: ' + esc(t.title) + '"' + (state[t.id] ? ' checked' : '') + '>' +
    '<div><span class="title" data-toggle="' + t.id + '">' + md(t.title) + '</span><span class="badges">' + badges.join('') + '</span></div>' +
    '<details class="more" id="d-' + t.id + '"><summary>Details</summary>' +
      '<div class="block"><h3>Task</h3><p>' + md(rest || t.text) + '</p></div>' +
      (t.manualChecks.length ? '<div class="block"><h3>Manual check</h3>' + t.manualChecks.map((c) => '<p class="check">' + md(c) + '</p>').join('') + '</div>' : '') +
      (t.notes.length ? '<div class="block"><h3>What Ralph did</h3><ul>' + t.notes.map((n) => '<li>' + md(n) + '</li>').join('') + '</ul></div>' : '') +
    '</details></div>';
}

document.addEventListener('change', (e) => {
  const id = e.target.dataset && e.target.dataset.id;
  if (!id) return;
  if (e.target.checked) state[id] = new Date().toISOString(); else delete state[id];
  save();
  e.target.closest('.task').classList.toggle('reviewed', e.target.checked);
  setTimeout(render, filter === 'all' ? 0 : 350);
});
document.addEventListener('click', (e) => {
  const f = e.target.dataset && e.target.dataset.f;
  if (f) { filter = f; try { localStorage.setItem(KEY + ':filter', f); } catch {} render(); }
  const tg = e.target.closest && e.target.closest('[data-toggle]');
  if (tg) { const d = document.getElementById('d-' + tg.dataset.toggle); d.open = !d.open; }
});
document.getElementById('expand').onclick = () => {
  const ds = [...document.querySelectorAll('details.more')];
  const open = !ds.every((d) => d.open);
  ds.forEach((d) => (d.open = open));
};
document.getElementById('export').onclick = async (e) => {
  try { await navigator.clipboard.writeText(JSON.stringify(state)); e.target.textContent = 'Copied'; }
  catch { e.target.textContent = 'Copy failed'; }
  setTimeout(() => (e.target.textContent = 'Copy reviewed state'), 1500);
};
render();
</script>
</body>
</html>
`;
}

await main();
