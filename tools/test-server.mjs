#!/usr/bin/env node
//
// What the port itself does — the part the engine's own 624 tests cannot reach.
//
//   node tools/test-server.mjs              build if needed, serve, test, tear down
//   node tools/test-server.mjs --port 3999  pin the port instead of finding one
//   node tools/test-server.mjs --keep       leave the server up afterwards
//   node tools/test-server.mjs --url http://127.0.0.1:3009   test something already running
//
// ── what this is for ─────────────────────────────────────────────────────────
//
// The vendored crates arrive with 624 tests and they cover the DSP thoroughly.
// None of them know this is a web application. Everything between the engine
// and the browser — the component, the assets it serves, the manifest, the
// exports the page calls across the C ABI — had no test at all, and that is
// exactly where every defect of the last two days has been:
//
//   * `/vendor/babylon.js` 404s. Twelve visuals dead. Nothing noticed, because
//     nothing had ever asked the server for the list of things the page loads.
//   * A patch anchored on a comment deleted two rack routes. `node --check`
//     passed. They simply stopped existing.
//   * `alloc` leaked 128 KB per meter poll — 150 MB a minute of playback.
//   * Four separate features shipped with a dead control above them, each one
//     a route that was never written and answered 501 into a swallowed error.
//
// So the shape of this file follows the shape of those bugs: ask the server for
// every asset the page will ask for, instantiate the engine and call it, and
// refuse to let a route that used to be answered quietly stop being answered.
//
// ── two things it deliberately does not do ───────────────────────────────────
//
// **It never opens a browser.** Node has no audio, so this cannot make a sound
// no matter what it renders. That is not an accident of the design; it is the
// design. A test suite that plays audio at whoever runs it is a bad test suite.
//
// **It starts its own server on its own port**, and kills it. Running it while
// you are working must not disturb what you are working on.
//
// What it therefore cannot cover: the fetch shim in `ui/local-server.js` runs
// in a page and needs a DOM and Web Audio to be exercised honestly. Faking
// those in Node would test the fake. That gap is real and stays open.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

// ── the smallest test harness that says something useful ─────────────────────
let pass = 0;
const failures = [];
let group = '';

const section = (t) => { group = t; console.log(`\n\x1b[1m${t}\x1b[0m`); };

function ok(what, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${what}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failures.push(`${group} › ${what}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${what}\x1b[0m${detail ? `  ${detail}` : ''}`);
  }
  return cond;
}

// ── the routes this build is known to answer ─────────────────────────────────
//
// **Generated from the shim, not written from memory.** The first version of
// this list was hand-typed and named three routes that do not exist —
// `/api/racks`, `/api/rack/set`, `/api/fx/catalogue`, where the real ones are
// `/api/rack` and `/api/fx`. The test duly failed, and it was the baseline that
// was wrong. That is the same mistake as inventing a request shape and then
// verifying against the invention.
//
// To regenerate after deliberately adding a route:
//
//   node -e "import('./tools/port-status.mjs').then(m=>console.log([...m.answered()].sort().join('\n')))"
//
// What it protects against is a route silently *disappearing*, which has
// happened: a patch anchored on a comment took two rack routes with it and
// `node --check` was perfectly happy. Removing a line here should take a
// sentence in the commit message saying why.
const ANSWERED = [
  '/api/audio/buffer', '/api/automation', '/api/edit', '/api/engine/grains',
  '/api/engine/load', '/api/engine/load/reset', '/api/engine/master',
  '/api/engine/shed', '/api/engine/state', '/api/engine/transport',
  '/api/files', '/api/folders', '/api/fx', '/api/grains', '/api/grains/cap',
  '/api/markers', '/api/order', '/api/peaks', '/api/rack',
  '/api/rack/param', '/api/spectrogram', '/api/state',
];

// ── find a port nobody is using ──────────────────────────────────────────────
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return true; }
    catch { /* not yet */ }
    await wait(500);
  }
  return false;
}

// ── go ───────────────────────────────────────────────────────────────────────
let child = null;
let base = arg('--url', null);

if (!base) {
  console.log('\x1b[2mbuilding…\x1b[0m');
  const b = spawnSync('spin', ['build'], { cwd: ROOT, encoding: 'utf8' });
  if (b.status !== 0) {
    console.error('spin build failed:\n' + (b.stderr || b.stdout));
    process.exit(1);
  }
  const port = +arg('--port', 0) || await freePort();
  base = `http://127.0.0.1:${port}`;
  console.log(`\x1b[2mserving on ${base}\x1b[0m`);
  child = spawn('spin', ['up', '--listen', `127.0.0.1:${port}`], { cwd: ROOT, stdio: 'ignore' });
  if (!await serverUp(base)) {
    console.error(`server never came up on ${base}`);
    child.kill(); process.exit(1);
  }
}

const get = (p) => fetch(base + p, { signal: AbortSignal.timeout(15000) });

try {
  // ═══ the page and everything it pulls in ═══════════════════════════════════
  section('The page, and every asset it asks for');

  const rootRes = await get('/');
  ok('GET / is 200', rootRes.status === 200);
  ok('  serves HTML', (rootRes.headers.get('content-type') || '').includes('text/html'),
     rootRes.headers.get('content-type') || 'no content-type');

  const html = await rootRes.text();
  ok('  is the interface, not a placeholder', html.includes('<script') && html.length > 10_000,
     `${html.length} bytes`);

  // **The test that would have caught babylon.** Read what the served page
  // actually references — not a list kept in this file, which would go stale
  // the moment someone adds a script tag.
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(refs)];
  ok(`  references ${uniq.length} local assets`, uniq.length > 0);

  const missing = [];
  for (const p of uniq) {
    const r = await get(p);
    if (r.status !== 200) missing.push(`${p} → ${r.status}`);
  }
  ok('every referenced asset serves', missing.length === 0,
     missing.length ? missing.join(', ') : `all ${uniq.length} return 200`);

  const nope = await get('/definitely-not-here-' + 'x'.repeat(8));
  ok('unknown paths 404', nope.status === 404, `got ${nope.status}`);

  // ═══ the sounds ════════════════════════════════════════════════════════════
  section('Sounds, and the manifest that describes them');

  const manRes = await get('/sounds/manifest.json');
  ok('manifest serves', manRes.status === 200);

  let manifest = [];
  try { manifest = await manRes.json(); } catch { /* caught below */ }
  ok('  is a non-empty array', Array.isArray(manifest) && manifest.length > 0,
     `${manifest.length} sound(s)`);

  const badSounds = [];
  for (const s of manifest) {
    for (const k of ['name', 'path', 'bytes', 'duration', 'sampleRate', 'channels']) {
      if (s[k] === undefined) badSounds.push(`${s.name || '?'} missing ${k}`);
    }
    const r = await get('/sounds/' + s.name);
    if (r.status !== 200) { badSounds.push(`${s.name} → ${r.status}`); continue; }
    const bytes = (await r.arrayBuffer()).byteLength;
    // The manifest carries a size, and a manifest that disagrees with the file
    // is how a page ends up drawing a waveform for something else.
    if (bytes !== s.bytes) badSounds.push(`${s.name}: manifest says ${s.bytes}, served ${bytes}`);
  }
  ok('every sound serves and matches its manifest entry', badSounds.length === 0,
     badSounds.length ? badSounds.join('; ') : `${manifest.length} checked`);

  // ═══ the engine, instantiated and called ═══════════════════════════════════
  section('The engine, across the C ABI');

  const wasmRes = await get('/engine.wasm');
  ok('engine.wasm serves', wasmRes.status === 200);
  const wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
  ok('  is a wasm module', wasmBytes[0] === 0x00 && wasmBytes[1] === 0x61 &&
     wasmBytes[2] === 0x73 && wasmBytes[3] === 0x6d,
     `${wasmBytes.length} bytes, magic ${[...wasmBytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const ex = instance.exports;
  ok('  instantiates with no imports', !!ex.memory);

  // The page calls these by name across a C ABI. A rename is a silent break:
  // `ex.doc_open is not a function` inside a promise nobody awaited.
  const NEEDED = ['memory', 'scratch', 'text_ptr', 'out_ptr', 'doc_open', 'doc_json',
    'doc_apply', 'render', 'peaks_json', 'meter_json', 'grains_json',
    'spectrogram_json', 'rack_json', 'rack_set', 'rack_param', 'fx_catalogue_json'];
  const absent = NEEDED.filter((n) => ex[n] === undefined);
  ok(`exports all ${NEEDED.length} symbols the page calls`, absent.length === 0,
     absent.length ? `missing: ${absent.join(', ')}` : '');

  ok('`alloc` is gone', ex.alloc === undefined,
     ex.alloc ? 'still exported — it leaked 128 KB per meter poll' : 'replaced by scratch');

  // ── the leak, as a regression test ──
  //
  // The master bus polls twenty times a second for a 16,384-frame stereo
  // window. Every one of those used to be forgotten: 2.5 MB a second, 150 MB a
  // minute, in memory that can never be returned. One minute's worth here.
  const SCOPE = 16384 * 2;
  const before = ex.memory.buffer.byteLength;
  for (let i = 0; i < 1200; i++) ex.scratch(SCOPE);
  const grew = ex.memory.buffer.byteLength - before;
  ok('scratch() does not leak', grew < 1_048_576,
     `1,200 polls (a minute at 20 Hz) grew memory ${(grew / 1024).toFixed(0)} KB; ` +
     `the old alloc would have leaked ${((SCOPE * 4 * 1200) / 1048576).toFixed(0)} MB`);

  // ── open a document and render it ──
  const said = (n) => {
    const at = ex.text_ptr();
    return JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer).slice(at, at + n)));
  };

  const RATE = 48000, CH = 2, FRAMES = RATE; // one second
  const src = new Float32Array(FRAMES * CH);
  for (let i = 0; i < FRAMES; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.5;
    src[i * CH] = v; src[i * CH + 1] = v;
  }
  const ptr = ex.scratch(src.length);
  new Float32Array(ex.memory.buffer).set(src, ptr >>> 2);
  const doc = said(ex.doc_open(ptr, src.length, CH, RATE));

  ok('doc_open returns a document', !!doc && !doc.error, doc?.error || '');
  ok('  with the frames it was given', doc?.baseFrames === FRAMES || doc?.frames === FRAMES,
     `baseFrames=${doc?.baseFrames} frames=${doc?.frames} expected ${FRAMES}`);

  const n = ex.render();
  ok('render() produces samples', n > 0, `${n} floats = ${(n / CH / RATE).toFixed(2)}s of stereo`);

  const out = new Float32Array(ex.memory.buffer, ex.out_ptr(), Math.min(n, 4096));
  ok('  and they are finite', out.every(Number.isFinite));
  ok('  and not silence', out.some((v) => Math.abs(v) > 1e-4),
     `peak ${Math.max(...[...out].map(Math.abs)).toFixed(4)}`);

  // ── the engine picker picks an engine ──
  //
  // Five buttons on the stretch tray, and for a while all five rendered the
  // same grain cloud: the engine called `grain::granular` directly instead of
  // `Stretch::process`, which is the function that dispatches on `algorithm`.
  // Nothing caught it, because a stretch that runs is indistinguishable from
  // the right stretch unless something compares two of them.
  //
  // So this compares all five. Distinct output is the whole assertion — what
  // each engine *sounds* like is the vendored crate's 624 tests' business, and
  // they already cover it.
  const ALGS = ['wsola', 'vocoder', 'pvsola', 'hybrid', 'granular'];
  const digest = (buf) => {
    // FNV-1a over the bytes. A hash, not a checksum with opinions.
    let h = 0x811c9dc5;
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 97) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  const renders = new Map();
  for (const algorithm of ALGS) {
    const body = new TextEncoder().encode(JSON.stringify({ op: 'stretch', algorithm, ratio: 2 }));
    const at = ex.scratch(Math.ceil(body.length / 4));
    new Uint8Array(ex.memory.buffer).set(body, at);
    const said2 = said(ex.doc_apply(at, body.length));
    if (said2 && said2.error) { renders.set(algorithm, `refused: ${said2.error}`); continue; }
    const len = ex.render();
    const buf = ex.memory.buffer.slice(ex.out_ptr(), ex.out_ptr() + len * 4);
    renders.set(algorithm, `${len / CH}f ${digest(buf)}`);
  }
  const distinct = new Set(renders.values());
  ok(`the engine picker picks an engine`, distinct.size === ALGS.length,
     distinct.size === ALGS.length
       ? `${ALGS.length} engines, ${distinct.size} different renders`
       : `${ALGS.length} engines but only ${distinct.size} distinct: ` +
         [...renders].map(([a, d]) => `${a}=${d}`).join(', '));

  // Every engine stretched to the length that was asked for. A stretcher that
  // returns the input untouched would pass the test above on its hash alone.
  const wrongLength = [...renders].filter(([, d]) => !d.startsWith(`${FRAMES * 2}f`));
  ok('  and every one of them doubled the length', wrongLength.length === 0,
     wrongLength.length ? wrongLength.map(([a, d]) => `${a}: ${d}`).join(', ')
                        : `all ${ALGS.length} returned ${FRAMES * 2} frames`);

  // Back to unity, so nothing below inherits a 2x document.
  {
    const body = new TextEncoder().encode(JSON.stringify({ op: 'stretch', ratio: 1 }));
    const at = ex.scratch(Math.ceil(body.length / 4));
    new Uint8Array(ex.memory.buffer).set(body, at);
    ex.doc_apply(at, body.length);
  }

  // ── the readouts the interface draws from ──
  const BANDS = 256;
  const mPtr = ex.scratch(src.length);
  new Float32Array(ex.memory.buffer).set(src, mPtr >>> 2);
  const meter = said(ex.meter_json(mPtr, src.length, CH, RATE, 4096, BANDS));
  ok('meter_json answers', !!meter && !meter.error, meter?.error || '');
  const bands = meter?.bands || meter?.spectrum || [];
  ok(`  with ${BANDS} bands`, bands.length === BANDS, `got ${bands.length}`);

  ok('peaks_json answers', (() => {
    try { const p = said(ex.peaks_json(1024)); return !!p && !p.error; } catch { return false; }
  })());
  ok('fx_catalogue_json answers', (() => {
    try { const c = said(ex.fx_catalogue_json()); return !!c && !c.error; } catch { return false; }
  })());
  ok('rack_json answers', (() => {
    try { const r = said(ex.rack_json()); return !!r && !r.error; } catch { return false; }
  })());

  // ═══ routes that used to be answered, still answered ═══════════════════════
  section('Route coverage, against the baseline');

  const { answered } = await import('./port-status.mjs');
  const have = answered();
  const covers = (p) => have.has(p) ||
    [...have].some((h) => h.endsWith('*') && p.startsWith(h.slice(0, -1)));

  const lost = ANSWERED.filter((r) => !covers(r));
  ok(`all ${ANSWERED.length} baseline routes still answered`, lost.length === 0,
     lost.length ? `LOST: ${lost.join(', ')}` : '');

} catch (e) {
  failures.push(`threw: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  console.log(`\n\x1b[31m✗ threw\x1b[0m ${e && e.message ? e.message : e}`);
} finally {
  if (child && !has('--keep')) child.kill();
  else if (child) console.log(`\n\x1b[2mleft running on ${base} (--keep)\x1b[0m`);
}

console.log();
if (failures.length === 0) {
  console.log(`\x1b[32m${pass} passed.\x1b[0m`);
  process.exit(0);
}
console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${pass} passed:`);
for (const f of failures) console.log(`  \x1b[31m•\x1b[0m ${f}`);
process.exit(1);
