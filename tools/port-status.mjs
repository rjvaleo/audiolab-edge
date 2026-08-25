#!/usr/bin/env node
//
// Which `/api/*` does the interface ask for, and which does the shim answer?
//
//   node tools/port-status.mjs           the gap, as a table
//   node tools/port-status.mjs --all     every route, answered ones included
//   node tools/port-status.mjs --quiet   exit 1 if anything is unanswered, print nothing
//
// ── why this exists ──────────────────────────────────────────────────────────
//
// The desktop build is where the work happens; this build follows it. When it
// gains a feature, two things have to come across: the *format* (which is
// vendored, so it arrives by itself when `tools/sync-core.sh` runs) and the
// *routes* (which are hand-written in `ui/local-server.js` and do not).
//
// Routes are therefore the whole of the porting friction, and the friction is
// invisible: `ui/port/app.js` is the desktop's file, so it calls routes this
// build has never heard of, and the shim's fall-through answers them with a
// 501 that a button swallows. Four separate features were reported working here
// while the control above them did nothing, every one of them a route that was
// never written.
//
// So: read the call sites out of the interface, read the cases out of the shim,
// and print the difference. Generated rather than remembered.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (f) => process.argv.includes(f);

// ── what the interface asks for ──────────────────────────────────────────────
//
// Every call goes through `api()` or `postJSON()` — that is the seam the whole
// port hangs off — plus the handful of raw `fetch()` calls the video export
// makes. A path is taken literally up to the first `?` or template hole; a
// route built out of a variable is reported as the prefix it is built from,
// which is enough to see whether the shim has a case for it.
function asked() {
  const found = new Map(); // path -> Set of "file:line"
  for (const rel of ['ui/port/app.js', 'ui/port/video-export.js', 'ui/port/first-sound.js',
                     'ui/port/rail.js', 'ui/port/stage.js', 'ui/port/room3d.js']) {
    let text;
    try { text = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      // api('/api/x'), postJSON('/api/x', …), fetch('/api/x…'), fetch(`/api/x?y=${z}`)
      const re = /(?:api|postJSON|fetch)\s*\(\s*[`'"](\/api\/[^`'"?]*)/g;
      let m;
      while ((m = re.exec(line))) {
        let p = m[1].replace(/\$\{[^}]*\}/g, ':x').replace(/\/+$/, '');
        if (!p) continue;
        if (!found.has(p)) found.set(p, new Set());
        found.get(p).add(`${rel}:${i + 1}`);
      }
    });
  }
  return found;
}

// ── what the shim answers ────────────────────────────────────────────────────
//
// `case '/api/x':` in the switch, plus any `startsWith('/api/x')` guard for the
// routes that carry an id in the path.
function answered() {
  const text = readFileSync(join(ROOT, 'ui/local-server.js'), 'utf8');
  const set = new Set();
  for (const m of text.matchAll(/case\s+[`'"](\/api\/[^`'"]*)[`'"]\s*:/g)) set.add(m[1]);
  for (const m of text.matchAll(/startsWith\(\s*[`'"](\/api\/[^`'"]+)[`'"]/g)) {
    // `/api/` on its own is not a route guard — it is the shim deciding whether
    // to intercept at all (`if (!path.startsWith('/api/')) return realFetch`).
    // Counting it as a prefix marks every route in the program as answered,
    // which is how the first run of this script reported a perfect score for a
    // build whose export button does nothing.
    if (m[1] === '/api/' || m[1] === '/api') continue;
    set.add(m[1] + '*');
  }
  return set;
}

const want = asked();
const have = answered();

// A path counts as answered if it is a case, or if some prefix guard covers it.
const covered = (p) => have.has(p) ||
  [...have].some((h) => h.endsWith('*') && p.startsWith(h.slice(0, -1)));

const rows = [...want.entries()]
  .map(([path, where]) => ({ path, where: [...where], ok: covered(path) }))
  .sort((a, b) => (a.ok - b.ok) || a.path.localeCompare(b.path));

const missing = rows.filter((r) => !r.ok);

if (flag('--quiet')) process.exit(missing.length ? 1 : 0);

const show = flag('--all') ? rows : missing;
const w = Math.max(4, ...show.map((r) => r.path.length));

console.log();
console.log(`${'route'.padEnd(w)}  called from`);
console.log(`${'-'.repeat(w)}  ${'-'.repeat(40)}`);
for (const r of show) {
  const mark = flag('--all') ? (r.ok ? '  ' : '! ') : '';
  console.log(`${mark}${r.path.padEnd(w)}  ${r.where.slice(0, 2).join(', ')}${r.where.length > 2 ? ` (+${r.where.length - 2})` : ''}`);
}
console.log();
console.log(`${want.size} routes called, ${want.size - missing.length} answered, ${missing.length} not.`);
if (missing.length && !flag('--all')) console.log('--all to see the answered ones too.');
console.log();
process.exit(0);
