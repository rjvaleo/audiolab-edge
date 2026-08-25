// Build `sounds/manifest.json` from whatever is in `sounds/`.
//
// The desktop build indexes a library off disk; there is no disk here and no
// library — there is a fixed set of sounds compiled into the component. This
// produces the same *shape* the interface already expects from `/api/files`,
// so the browser, the picker and everything that reads a file's details work
// unchanged.
//
//   node tools/manifest.mjs

import { readdirSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'sounds');

const probe = (file) => {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-of', 'json',
    '-show_entries', 'stream=sample_rate,channels:format=duration',
    file,
  ]).toString();
  const j = JSON.parse(out);
  const s = (j.streams || [])[0] || {};
  return {
    sampleRate: +(s.sample_rate || 48000),
    channels: +(s.channels || 1),
    duration: +(+(j.format || {}).duration || 0).toFixed(3),
  };
};

const files = readdirSync(dir)
  .filter((f) => /\.(opus|webm|ogg|wav|flac)$/i.test(f))
  .sort()
  .map((f) => {
    const full = join(dir, f);
    const { sampleRate, channels, duration } = probe(full);
    const name = basename(f, extname(f));
    return {
      name: f,
      path: `Sounds/${f}`,
      subdir: '',
      bytes: statSync(full).size,
      duration,
      sampleRate,
      channels,
      bits: 16,
      format: extname(f).slice(1).toUpperCase(),
      // The columns the browser shows. Nothing here is inferred from the audio
      // the way the desktop indexer infers it — these are hand-picked sounds,
      // so what they are is known rather than guessed.
      category: duration <= 2 ? 'ONE-SHOT' : 'SAMPLE',
      confidence: 'high',
      instrument: '',
      machine: '',
      bpm: '',
      why: `${duration.toFixed(2)}s, shipped`,
    };
  });

writeFileSync(join(dir, 'manifest.json'), JSON.stringify(files, null, 1));
console.log(`${files.length} sound${files.length === 1 ? '' : 's'} → sounds/manifest.json`);
for (const f of files) console.log(`  ${f.name.padEnd(28)} ${f.duration}s  ${(f.bytes / 1024).toFixed(0)} KB`);
