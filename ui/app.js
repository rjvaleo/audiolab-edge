// The page: load the engine, make a cloud, play it, and draw the Room from it.

import { loadEngine, interleave, upmix, toAudioBuffer } from './engine.js';
import { listen, run } from './room.js';

const $ = (id) => document.getElementById(id);
const go = $('go');

/// `?silent` draws the room without connecting anything to the speakers.
///
/// The analyser taps are branches off the source, so the picture is identical —
/// the sound is generated, measured and drawn, it simply is not heard.
///
/// This exists because of a real cost rather than a hypothetical one: checking
/// the visuals meant a browser playing a granular cloud through the machine's
/// speakers, in a tab whose owner was not the person at the keyboard. Their
/// Stop button could not reach it, and there is no reason a picture should need
/// a sound card to be looked at.
const SILENT = new URLSearchParams(location.search).has('silent');

let ctx, engine, src, info, playing = null, room = null;

/// One cloud's worth of settings.
///
/// Chosen to show the engine off rather than to be neutral: eight times as long
/// as the source, four layers, and enough position jitter that the cloud is
/// made of the whole file at once instead of sweeping through it.
const CAM = {
  depth: 1.9, floorY: -0.38, ceilY: 0.62, shiftX: 0,
  skyAt: 0.72, ring: 0.17, lead: 0.012, backW: 1, backH: 1,
};
const GEOM = { ridge: 0.62, history: 56, span: 14, body: 0.032 };

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

/// Everything the Room is handed each frame: colour, camera, shape.
///
/// One object, mutated in place and exposed as `window.view`, so the camera can
/// be posed by looking at it rather than by rebuilding between guesses. The
/// desktop build has a whole editor for this; here the numbers are the output
/// of that exercise and this is how they were arrived at.
const view = {
  cold: [0.29, 0.62, 0.85],
  hot: [0.37, 0.83, 0.48],
  core: [0.50, 0.82, 1.0],
  cam: { ...CAM },
  geom: { ...GEOM },
};
window.view = view;

/// Print the pose, ready to paste back into this file.
///
/// The camera is nine numbers and the shape is four, and the only way to choose
/// them is to look at the room while they move. So they are live: change
/// `view.cam.depth` in the console and the next frame is drawn with it, because
/// `frame(view)` reads the object every time rather than copying it once.
///
///     view.cam.depth = 2.4        // the back wall, further away
///     view.cam.floorY = -0.5      // the floor, lower
///     view.cam.skyAt = 0.6        // the figure, down a little
///     view.geom.ridge = 0.9       // the terrain, taller
///     pose()                      // and print the lot
window.pose = () => {
  const out = { cam: view.cam, geom: view.geom };
  console.log(JSON.stringify(out, null, 2));
  return out;
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
    go.textContent = SILENT ? 'Draw (silent)' : 'Play';
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
    go.textContent = SILENT ? 'Draw (silent)' : 'Play';
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
  if (!SILENT) node.connect(ctx.destination);
  node.start();
  playing = node;

  room = run($('room'), tap, view);
  if (!room) $('s-note').innerHTML = '<span class="bad">no WebGL on this display</span>';

  go.disabled = false;
  go.textContent = 'Stop';
});

boot();
