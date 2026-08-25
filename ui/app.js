// The page: load the engine, make a cloud, play it, draw the Room from it, and
// let the cloud be changed while it plays.

import { loadEngine, interleave, upmix, toAudioBuffer } from './engine.js';
import { listen, run } from './room.js';
import { mount } from './controls.js';

const $ = (id) => document.getElementById(id);
const go = $('go');

/// `?silent` draws the room without connecting anything to the speakers.
///
/// The analyser taps are branches off the bus, so the picture is identical —
/// the cloud is rendered, measured and drawn, it simply is not heard.
///
/// This exists because of a real cost rather than a hypothetical one: checking
/// the visuals meant a browser playing a granular cloud through the machine's
/// speakers, in a tab whose owner was not the person at the keyboard. Their
/// Stop button could not reach it, and there is no reason a picture should need
/// a sound card to be looked at.
const SILENT = new URLSearchParams(location.search).has('silent');

const CAM = {
  depth: 1.9, floorY: -0.38, ceilY: 0.62, shiftX: 0,
  skyAt: 0.72, ring: 0.17, lead: 0.012, backW: 1, backH: 1,
};
const GEOM = { ridge: 0.62, history: 56, span: 14, body: 0.032 };

/// One cloud's worth of settings. Chosen to show the engine off rather than to
/// be neutral: eight times as long as the source, four layers, and enough
/// position jitter that the cloud is made of the whole file at once instead of
/// sweeping through it.
const params = {
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
window.params = params;

/// Everything the Room is handed each frame: colour, camera, shape.
///
/// One object, mutated in place and exposed as `window.view`, so the camera can
/// be posed by looking at it rather than by rebuilding between guesses.
const view = {
  cold: [0.29, 0.62, 0.85],
  hot: [0.37, 0.83, 0.48],
  core: [0.50, 0.82, 1.0],
  cam: { ...CAM },
  geom: { ...GEOM },
};
window.view = view;

/// Print the pose, ready to paste back into this file.
window.pose = () => {
  const out = { cam: view.cam, geom: view.geom };
  console.log(JSON.stringify(out, null, 2));
  return out;
};

let ctx, engine, src, info;
/// **One bus, for the life of the page.**
///
/// The analysers hang off this rather than off the source, so re-rendering
/// swaps the source underneath a Room that never notices. Tapping the source
/// directly meant every parameter change threw the terrain away and started the
/// floor again from nothing.
let bus, tap, room = null, node = null, rendering = false;

async function boot() {
  try {
    engine = await loadEngine('./engine.wasm');
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    bus = ctx.createGain();
    tap = listen(ctx, bus);
    if (!SILENT) bus.connect(ctx.destination);

    const bytes = await (await fetch('./tv-snips.opus')).arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes);

    // Stereo on the way in even from a mono file, or `pan_spread` has nowhere
    // to place a grain and the cloud comes back flat in the middle.
    const flat = interleave(decoded);
    src = engine.put(decoded.numberOfChannels === 1 ? upmix(flat) : flat);
    info = { seconds: decoded.duration, rate: decoded.sampleRate, channels: 2 };

    mount($('ctls'), params, () => { if (node) recloud(); });

    $('s-src').innerHTML =
      `<b>tv snips</b> · ${decoded.duration.toFixed(1)}s · ${(decoded.sampleRate / 1000)} kHz`;
    go.disabled = false;
    go.textContent = SILENT ? 'Draw (silent)' : 'Play';
  } catch (e) {
    go.textContent = 'Failed';
    $('s-note').innerHTML = `<span class="bad">${e.message}</span>`;
    throw e;
  }
}

/// Make the cloud again and put it on the bus, without disturbing the Room.
async function recloud() {
  if (rendering) return;
  rendering = true;
  $('s-note').textContent = 'rendering…';
  // A timeout rather than a frame: a hidden tab never gets a frame, and this
  // would hang for ever without ever calling the engine.
  await new Promise((r) => setTimeout(r, 0));

  const t0 = performance.now();
  const out = engine.render(src, info.channels, info.rate, params);
  const ms = performance.now() - t0;
  rendering = false;
  $('s-note').textContent = '';

  if (!out) { $('s-note').innerHTML = '<span class="bad">nothing came back</span>'; return; }

  const buf = toAudioBuffer(ctx, out, info.channels, info.rate);
  $('s-ren').innerHTML =
    `<b>${buf.duration.toFixed(0)}s</b> in ${ms.toFixed(0)} ms · ` +
    `<span class="on">${(buf.duration * 1000 / ms).toFixed(0)}× real time</span>`;

  if (node) { try { node.stop(); } catch { /* already done */ } }
  node = ctx.createBufferSource();
  node.buffer = buf;
  node.loop = true;
  node.connect(bus);
  node.start();
}

go.addEventListener('click', async () => {
  if (node) {
    try { node.stop(); } catch { /* already done */ }
    node = null;
    if (room) { room.stop(); room = null; }
    go.textContent = SILENT ? 'Draw (silent)' : 'Play';
    return;
  }
  if (ctx.state === 'suspended') await ctx.resume();
  go.disabled = true;
  await recloud();
  room = run($('room'), tap, view);
  if (!room) $('s-note').innerHTML = '<span class="bad">no WebGL on this display</span>';
  go.disabled = false;
  go.textContent = 'Stop';
});

boot();
