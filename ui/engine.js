// The granular engine, driven from the page.
//
// No wasm-bindgen: the whole surface is four exported functions and a flat
// buffer of f32. See `engine/src/lib.rs`.
//
// **Re-read `memory.buffer` after every call into wasm.** A render allocates,
// allocation can grow the memory, and growing it detaches every existing
// ArrayBuffer view. A view taken before a call and used after it is empty, and
// nothing warns you — the numbers just come back zero.

export async function loadEngine(url) {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {});
  const ex = instance.exports;
  const mem = () => new Float32Array(ex.memory.buffer);

  return {
    /// Hand the engine a mono or interleaved buffer. Returns the pointer it
    /// lives at, which stays valid for the life of the page.
    put(samples) {
      const ptr = ex.alloc(samples.length);
      mem().set(samples, ptr >>> 2);
      return { ptr, len: samples.length };
    },

    /// One cloud. `src` is what `put` returned.
    render(src, channels, sampleRate, p) {
      const n = ex.render(
        src.ptr, src.len, channels, sampleRate,
        p.ratio, p.semitones, p.windowMs,
        p.densityHz, p.overlap, p.positionJitterMs, p.pitchJitterSemis,
        p.layers, p.panSpread, p.seed,
      );
      if (!n) return null;
      // Pointer *after* the render, and a fresh view with it.
      const at = ex.out_ptr() >>> 2;
      return mem().slice(at, at + n);
    },
  };
}

/// Planar channels from Web Audio, interleaved the way the engine expects.
export function interleave(buffer) {
  const ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0).slice();
  const n = buffer.length;
  const out = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) {
    const src = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i * ch + c] = src[i];
  }
  return out;
}

/// One channel into two, interleaved. The engine's grain panning needs a
/// stereo field to place grains in, and most of the library is mono.
export function upmix(mono) {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[i * 2] = mono[i];
    out[i * 2 + 1] = mono[i];
  }
  return out;
}

/// And back again, into something Web Audio will play.
export function toAudioBuffer(ctx, interleaved, channels, sampleRate) {
  const frames = Math.floor(interleaved.length / channels);
  const buf = ctx.createBuffer(channels, frames, sampleRate);
  for (let c = 0; c < channels; c++) {
    const dst = buf.getChannelData(c);
    for (let i = 0; i < frames; i++) dst[i] = interleaved[i * channels + c];
  }
  return buf;
}
