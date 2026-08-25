// The page: load the engine, make a cloud, play it, and draw the Room from it.

import { loadEngine, interleave, upmix, toAudioBuffer } from './engine.js';
import { listen, run } from './room.js';

const $ = (id) => document.getElementById(id);
const go = $('go');

let ctx, engine, src, info, playing = null, room = null;

/// One cloud's worth of settings.
///
/// Chosen to show the engine off rather than to be neutral: eight times as long
/// as the source, four layers, and enough position jitter that the cloud is
/// made of the whole file at once instead of sweeping through it.
const PARAMS = {
  ratio: 8.0,
  semitones: 0,
  windowMs: 90,
  densityHz: 26,
  overlap: 3,
  positionJitterMs: 260,
  pitchJitterSemis: 5,
  layers: 4,
  panSpread: 0.9,
  seed: 7,
};

/// What the Room is drawn in. The desktop build takes these from the theme;
/// here they are the three the room shipped with.
const PAINT = {
  cold: [0.29, 0.62, 0.85],
  hot: [0.37, 0.83, 0.48],
  core: [0.50, 0.82, 1.0],
};

async function boot() {
  try {
    engine = await loadEngine('./engine.wasm');
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    const bytes = await (await fetch('./tv-snips.opus')).arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes);

    // Stereo on the way in even from a mono file, or `pan_spread` has nowhere
    // to place a grain and the cloud comes back flat in the middle.
    const flat = interleave(decoded);
    src = engine.put(decoded.numberOfChannels === 1 ? upmix(flat) : flat);
    info = { seconds: decoded.duration, rate: decoded.sampleRate, channels: 2 };

    $('s-src').innerHTML =
      `<b>tv snips</b> · ${decoded.duration.toFixed(1)}s · ${(decoded.sampleRate / 1000)} kHz`;
    go.disabled = false;
    go.textContent = 'Play';
  } catch (e) {
    go.textContent = 'Failed';
    $('s-note').innerHTML = `<span class="bad">${e.message}</span>`;
    throw e;
  }
}

go.addEventListener('click', async () => {
  if (playing) {
    playing.stop();
    playing = null;
    if (room) { room.stop(); room = null; }
    go.textContent = 'Play';
    return;
  }

  if (ctx.state === 'suspended') await ctx.resume();
  go.disabled = true;
  go.textContent = 'Rendering…';
  // A timeout rather than a frame: a hidden tab never gets a frame, and the
  // click would hang for ever without ever calling the engine.
  await new Promise((r) => setTimeout(r, 0));

  const t0 = performance.now();
  const out = engine.render(src, info.channels, info.rate, PARAMS);
  const ms = performance.now() - t0;
  if (!out) { go.textContent = 'Nothing came back'; go.disabled = false; return; }

  const buf = toAudioBuffer(ctx, out, info.channels, info.rate);
  $('s-ren').innerHTML =
    `<b>${buf.duration.toFixed(0)}s</b> rendered in ${ms.toFixed(0)} ms · ` +
    `<span class="on">${(buf.duration * 1000 / ms).toFixed(0)}× real time</span>`;

  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.loop = true;

  // **The Room reads the sound, and the sound still reaches the speakers.**
  // An analyser is a pass-through, but the taps are branches off the source
  // rather than links in a chain — so the output has to be connected on its
  // own, or the page draws beautifully in silence.
  const tap = listen(ctx, node);
  node.connect(ctx.destination);
  node.start();
  playing = node;

  room = run($('room'), tap, PAINT);
  if (!room) $('s-note').innerHTML = '<span class="bad">no WebGL on this display</span>';

  go.disabled = false;
  go.textContent = 'Stop';
});

boot();
