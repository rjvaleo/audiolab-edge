// The Room, fed from the sound the page is already playing.
//
// `vis-gl.js` came across from the desktop build **unchanged** — it turned out
// to reach for nothing outside itself, and every field of `frame(f)` is
// optional, so a caller that says nothing gets the room it has always drawn.
//
// What is new is only where the numbers come from. On the desktop the server
// owns the audio device and the interface asks it for a spectrum twenty times a
// second. Here the browser is playing the sound, so it can look at it directly:
// an `AnalyserNode` for the spectrum, and one per channel for the figure. No
// network, no polling, and a shorter path than the desktop build has.

/// How often a row is pushed into the terrain, in Hz.
///
/// The desktop build pushes at its meter's rate — twenty a second — and the
/// room's depth is measured in rows, so this is what sets how fast the floor
/// travels towards the back wall. Drawing is a separate rate entirely; the
/// terrain slides between pushes.
const PUSH_HZ = 20;

/// The band layout the Room is drawn for.
///
/// **Logarithmic, 20 Hz to 20 kHz, 256 of them.** Not a preference — it is what
/// the desktop server sends, and the Room's floor is laid out expecting it:
/// `audio_core::meter::spectrum` walks `edge *= (hi/lo)^(1/bands)` and takes
/// the loudest bin in each band.
///
/// An `AnalyserNode` gives *linear* bins to Nyquist instead, and handing those
/// over unchanged crushes every audible thing into the left few percent of the
/// floor — which is exactly what it did: a spike in one corner and an empty
/// room beside it. This is the same arithmetic, on this side of the wire.
const LO_HZ = 20;
const HI_HZ = 20000;
const BANDS = 256;

/// Linear FFT bins into log-spaced bands, by the loudest bin in each.
///
/// The maximum rather than the mean, for the reason the desktop file gives:
/// an analyser that averages a tone away is not an analyser.
function logBands(bins, out, binHz) {
  const ratio = Math.pow(HI_HZ / LO_HZ, 1 / out.length);
  const half = bins.length;
  let edge = LO_HZ;
  for (let k = 0; k < out.length; k++) {
    const next = edge * ratio;
    const a = Math.min(Math.max(Math.floor(edge / binHz), 1), half - 1);
    const b = Math.min(Math.max(Math.ceil(next / binHz), a + 1), half);
    let m = -Infinity;
    for (let i = a; i < b; i++) if (bins[i] > m) m = bins[i];
    out[k] = m === -Infinity ? -120 : m;
    edge = next;
  }
  return out;
}

/// Taps the sound and gives the Room what it asks for.
export function listen(ctx, node) {
  // **Frequency, from the sum.** One analyser on the whole signal: the floor is
  // a spectrum of the sound, not of one side of it.
  const spectrum = ctx.createAnalyser();
  spectrum.fftSize = 2048;
  spectrum.smoothingTimeConstant = 0.55;
  node.connect(spectrum);

  // **Time, per channel.** The figure in the sky is left against right, so it
  // needs the two sides separately — a mono sum would draw a diagonal line and
  // nothing else.
  const split = ctx.createChannelSplitter(2);
  node.connect(split);
  const left = ctx.createAnalyser();
  const right = ctx.createAnalyser();
  for (const a of [left, right]) { a.fftSize = 1024; a.smoothingTimeConstant = 0; }
  split.connect(left, 0);
  split.connect(right, 1);

  const bins = new Float32Array(spectrum.frequencyBinCount);
  const bands = new Float32Array(BANDS);
  const binHz = ctx.sampleRate / spectrum.fftSize;
  const l = new Float32Array(left.fftSize);
  const r = new Float32Array(right.fftSize);
  const pairs = new Float32Array(left.fftSize * 2);

  return {
    /// One row: the spectrum in dBFS, and the figure as interleaved pairs.
    /// Both are what `vgAttach().push` already expects.
    read() {
      spectrum.getFloatFrequencyData(bins);
      logBands(bins, bands, binHz);
      left.getFloatTimeDomainData(l);
      right.getFloatTimeDomainData(r);
      for (let i = 0; i < l.length; i++) {
        pairs[i * 2] = l[i];
        pairs[i * 2 + 1] = r[i];
      }
      return { bands, pairs };
    },
  };
}

/// Draw the Room until told to stop.
export function run(canvas, tap, paint) {
  const room = window.vgAttach(canvas);
  if (!room) return null;

  let raf = null;
  let lastPush = 0;
  const step = 1000 / PUSH_HZ;

  const tick = (now) => {
    raf = requestAnimationFrame(tick);

    // The backing store follows the element, at the display's density and
    // capped at 2x — nine times the fill at 3x buys nothing on a glow.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (w && h && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
    }

    // **Pushed on its own clock, drawn on the display's.** A row per frame
    // would make the floor travel at whatever rate the machine manages, so the
    // same sound would scroll differently on two laptops.
    if (now - lastPush >= step) {
      lastPush = now;
      const { bands, pairs } = tap.read();
      room.push(bands, pairs);
    }

    room.frame(paint);
  };

  raf = requestAnimationFrame(tick);
  return {
    stop() { if (raf) cancelAnimationFrame(raf); raf = null; },
    clear() { room.clear(); },
  };
}
