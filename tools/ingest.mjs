#!/usr/bin/env node
//
// Take everything in `ingest/`, convert it to Opus, and add it to the library.
//
//   node tools/ingest.mjs              convert, move, rewrite the manifest
//   node tools/ingest.mjs --keep       leave the originals in ingest/
//   node tools/ingest.mjs --bitrate 128k
//
// Opus at 96k because it is small and the browser decodes it natively —
// `decodeAudioData` reads it, so there is no decoder here to maintain. Roughly
// 12 KB a second, and everything in `sounds/` is compiled into the component,
// so each sound adds its own size to what gets deployed.
//
// Needs ffmpeg and ffprobe on the path.

import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'ingest');
const OUT = join(ROOT, 'sounds');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const BITRATE = arg('--bitrate', '96k');

const TAKES = /\.(wav|aiff?|mp3|flac|m4a|aac|ogg|oga|opus|webm|wma|caf)$/i;

function have(cmd) {
  try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

if (!have('ffmpeg') || !have('ffprobe')) {
  console.error('ingest needs ffmpeg and ffprobe on the path.\n  brew install ffmpeg');
  process.exit(1);
}

mkdirSync(IN, { recursive: true });
mkdirSync(OUT, { recursive: true });

const files = readdirSync(IN).filter((f) => TAKES.test(f));
if (!files.length) {
  console.log(`Nothing to ingest. Drop sounds into ${IN.replace(ROOT + '/', '')}/ and run this again.`);
  process.exit(0);
}

console.log(`Ingesting ${files.length} file${files.length === 1 ? '' : 's'} at Opus ${BITRATE}\n`);

let added = 0, skipped = 0;
for (const f of files) {
  const stem = basename(f, extname(f))
    // Kept readable rather than slugged — the name is what the file list shows,
    // and a person chose it.
    .replace(/[\/\\:]/g, '-')
    .trim();
  const target = join(OUT, `${stem}.opus`);

  if (existsSync(target)) {
    console.log(`  = ${stem}.opus already in sounds/, left alone`);
    skipped++;
    continue;
  }

  const src = join(IN, f);
  try {
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-i', src,
      // 48 kHz because that is what the AudioContext runs at, so nothing
      // resamples on the way in.
      '-ar', '48000',
      '-c:a', 'libopus', '-b:a', BITRATE,
      // Music rather than speech: the library is samples and texture, and the
      // speech model spends its bits on intelligibility.
      '-application', 'audio',
      '-vn',
      target,
    ], { stdio: 'pipe' });
  } catch (e) {
    console.error(`  ! ${f} — ffmpeg refused it: ${String(e.stderr || e).slice(0, 160)}`);
    continue;
  }

  const before = statSync(src).size;
  const after = statSync(target).size;
  console.log(`  + ${stem}.opus  ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
  added++;

  if (!flag('--keep')) unlinkSync(src);
}

console.log(`\n${added} added, ${skipped} already there.`);

if (added) {
  console.log('\nRewriting the manifest…');
  execFileSync('node', [join(ROOT, 'tools', 'manifest.mjs')], { stdio: 'inherit' });

  const total = readdirSync(OUT)
    .filter((f) => f.endsWith('.opus'))
    .reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
  console.log(`\nsounds/ is now ${(total / 1024).toFixed(0)} KB across ` +
    `${readdirSync(OUT).filter((f) => f.endsWith('.opus')).length} file(s).`);
  console.log('Run `spin build` to compile them into the component.');
}
