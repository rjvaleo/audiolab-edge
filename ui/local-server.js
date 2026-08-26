// The server, in the page.
//
// **`ui/port/app.js` is the desktop build's file, and this does not touch it.**
// It replaces what is *under* it. That was once literally true — the file was
// byte-for-byte identical — and it is now 206 lines divergent, all of it the
// rail rebuild and the removal of tagging, neither of which this file is
// involved in. The rule that survives is the one in `docs/EDGE-PARITY.md`: the
// engine and the file formats stay level with the desktop, the interface is
// ours.
//
// The whole interface talks to the server through one function: seventy-five
// calls through `api()` and `postJSON()`, reaching forty-eight distinct routes,
// and the only raw `fetch(` in fifteen thousand lines is the one inside
// `api()`. That call goes to the global `fetch`, so swapping the global swaps
// the server, and every line above it carries on believing there is one.
//
// What answers those calls now is the same engine — `fx`, `edit` and
// `audio-core` compiled to WebAssembly — plus the sounds compiled into the
// component. Twenty-two of the forty-eight are answered here; `node
// tools/port-status.mjs` lists the rest, and `docs/PORT.md` says which are
// meant to travel at all.

(() => {
  const realFetch = window.fetch.bind(window);

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /// Raw bytes. The reel and the sound are Float32Arrays of millions of
  /// numbers; as JSON they would be four times the size and a parse at both
  /// ends, and `videoFetchFrames` already reads them with `arrayBuffer()`.
  const binary = (view) =>
    new Response(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });

  /// A route that has not been ported yet, said out loud.
  ///
  /// **Not silence, and not a plausible empty answer.** A route that returns
  /// `[]` lets the interface carry on and hides the gap; the whole method here
  /// is to let the running program name what is missing, one error at a time.
  const notPorted = (path) => {
    console.warn(`[local-server] not ported: ${path}`);
    return json({ error: `not ported: ${path}` }, 501);
  };

  /// Everything the page knows about, loaded once.
  const shipped = { sounds: null };
  async function shippedSounds() {
    if (!shipped.sounds) {
      shipped.sounds = await (await realFetch('/sounds/manifest.json')).json();
    }
    return shipped.sounds;
  }

  // ── takes ──
  //
  // **A recording is a sound like any other, and that is the whole trick.**
  // The desktop writes a take to `Recordings/` on disk and rescans; there is no
  // disk here, so a take joins the same list the shipped sounds are in, with
  // the same manifest shape, and its samples are kept beside it. Everything
  // downstream — `selectFile`, `/api/edit`, the waveform, the grain engine, the
  // rack, the visuals — then works on it without knowing where it came from.
  //
  // In memory only. A reload loses them, which is honest for a page with no
  // storage, and is why the modal offers the take back as a file.
  const takes = [];
  const takePcm = new Map(); // path -> { flat, rate, channels, frames }

  async function sounds() {
    return [...(await shippedSounds()), ...takes];
  }

  const FOLDER = 'Sounds';

  // ── the engine ──
  //
  // The same `fx`, `edit` and `audio-core` the desktop links, plus the four
  // wire-format files it answers `/api/edit` with. It holds the document; this
  // file only carries messages to it.
  const wasm = {
    ex: null,
    /// Re-read after every call. A render allocates, allocation can grow the
    /// memory, and growing it detaches every existing view — one taken before a
    /// call and used after it reads as zeros, with no warning.
    f32: () => new Float32Array(wasm.ex.memory.buffer),
    u8: () => new Uint8Array(wasm.ex.memory.buffer),
    /// Whatever the last call left behind, as parsed JSON.
    said: (n) => {
      const at = wasm.ex.text_ptr();
      return JSON.parse(new TextDecoder().decode(wasm.u8().slice(at, at + n)));
    },
  };

  let engineReady = null;
  function engine() {
    if (!engineReady) {
      engineReady = WebAssembly.instantiateStreaming(realFetch('/engine.wasm'), {})
        .then(({ instance }) => { wasm.ex = instance.exports; return wasm; });
    }
    return engineReady;
  }

  // ── the sound ──
  //
  // One at a time, which is as true on the desktop as it is here. Decoded by
  // the browser rather than by us: `decodeAudioData` reads Opus, and writing a
  // decoder in Rust to avoid it would be a decoder to maintain.
  const audio = { ctx: null, path: null, buffer: null, channels: 2, rate: 48000 };

  function context() {
    if (!audio.ctx) {
      audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // **The master gain, which the transport has always tried to set and
      // never had.** `/api/engine/transport` did `bus.gain.value = ...` against
      // an identifier declared nowhere in this file, so any request carrying a
      // gain threw a ReferenceError, was caught by the shim's own handler and
      // returned as a 500 — a volume control that silently failed and took the
      // seek, loop and play in the same request down with it.
      //
      // It lives out here rather than in `start()` because a BufferSource is
      // built fresh for every play and the gain has to survive them.
      audio.bus = audio.ctx.createGain();
      audio.bus.connect(audio.ctx.destination);

      // **The analyser the FX panels draw from.**
      //
      // The EQ paints a live spectrum behind its curve, the compressor paints
      // the signal against its threshold, and the rack meters want levels —
      // all three read `engine.spectrum`, `engine.waveform` and
      // `r.rackLevels` off the `/api/engine/grains` poll. That route was
      // returning empty arrays for all of them, so every one of those panels
      // drew its static curve over nothing and looked dead while the effects
      // were audibly working.
      //
      // Everything plays through it: `source -> analyser -> bus -> destination`.
      // A node with no path to the destination is not pulled, so metering has
      // to be *in* the path rather than tapped off the side of it.
      audio.scope = audio.ctx.createAnalyser();
      audio.scope.fftSize = 2048;
      audio.scope.smoothingTimeConstant = 0.72;
      // **The window, matched to what this material measures.** Web Audio
      // defaults to -100..-30 dB, which is set for a mastered track. A grain
      // cloud here peaks around -37 dBFS and its loudest FFT bin measures -77,
      // so on the default window every bin landed in the bottom third and the
      // spectrum drew as a flat smear along the floor of the EQ.
      audio.scope.minDecibels = -110;
      audio.scope.maxDecibels = -45;
      audio.scope.connect(audio.bus);
      audio.bins = new Uint8Array(audio.scope.frequencyBinCount);
      audio.time = new Float32Array(audio.scope.fftSize);
    }
    return audio.ctx;
  }

  /// Interleave the way the engine expects, and give a mono file two channels.
  ///
  /// **Stereo even from a mono source**, because `pan_spread` places grains
  /// across the stereo field and has nowhere to place them in one channel. Most
  /// of the library is mono, so this is the normal case rather than an edge one.
  function interleaved(buf) {
    const n = buf.length;
    if (buf.numberOfChannels === 1) {
      const one = buf.getChannelData(0);
      const out = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { out[i * 2] = one[i]; out[i * 2 + 1] = one[i]; }
      return out;
    }
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { out[i * 2] = l[i]; out[i * 2 + 1] = r[i]; }
    return out;
  }

  /// Open a sound as the document, if it is not open already.
  async function open(path) {
    if (audio.path === path) return;
    const list = await sounds();
    const it = list.find((f) => f.path === path);
    if (!it) throw new Error(`no such sound: ${path}`);

    const e = await engine();

    // A take is already decoded and already interleaved — it never went to a
    // server and there is nothing to fetch.
    const held = takePcm.get(path);
    let flat, rate;
    if (held) {
      flat = held.flat;
      rate = held.rate;
      audio.buffer = held.buffer;
    } else {
      const bytes = await (await realFetch(`/sounds/${it.name}`)).arrayBuffer();
      const decoded = await context().decodeAudioData(bytes);
      flat = interleaved(decoded);
      rate = decoded.sampleRate;
      audio.buffer = decoded;
    }

    const ptr = e.ex.scratch(flat.length);
    e.f32().set(flat, ptr >>> 2);
    e.ex.doc_open(ptr, flat.length, 2, rate);

    audio.path = path;
    audio.channels = 2;
    audio.rate = rate;
  }

  // ── the microphone ──────────────────────────────────────────────────────
  //
  // **The desktop opens a sound card; this opens `getUserMedia`.** The panel
  // above is the desktop's own, unchanged: it arms, it meters, it records, it
  // stops, and it polls this route ten times a second for the levels. What it
  // gets back here is a browser input instead of an ALSA one.
  //
  // Arming and recording are deliberately separate, and that separation is the
  // desktop's: arming opens the input and shows its level while keeping
  // nothing, so a gain can be set before anything that matters is played.
  //
  // Capture is `MediaRecorder` rather than a `ScriptProcessorNode` (deprecated)
  // or an `AudioWorklet` (a second file, a second build step, and a message
  // port to marshal samples across). MediaRecorder hands back one blob that
  // `decodeAudioData` already knows how to read — the same call the shipped
  // Opus goes through — so a take arrives in exactly the shape the engine
  // takes.
  const MAX_SECONDS = 120;
  const SCOPE_POINTS = 240;

  const mic = {
    stream: null, source: null, analyser: null, recorder: null,
    armed: false, recording: false,
    chunks: [], startedAt: 0, takeNo: 0,
    fft: null, peak: null,
  };

  function micLevels() {
    if (!mic.analyser) return { left: 0, right: 0, wave: [] };
    mic.fft.set(new Float32Array(mic.fft.length));
    mic.analyser.getFloatTimeDomainData(mic.fft);

    let peak = 0;
    for (let i = 0; i < mic.fft.length; i++) {
      const v = Math.abs(mic.fft[i]);
      if (v > peak) peak = v;
    }

    // The scope, decimated to what the modal actually draws. Min and max per
    // bucket rather than every nth sample: picking one sample in nine misses
    // the transient that made the take clip, which is the one thing a person
    // watching a level meter is watching for.
    const wave = [];
    const step = Math.max(1, Math.floor(mic.fft.length / SCOPE_POINTS));
    for (let i = 0; i < mic.fft.length; i += step) {
      let lo = 0, hi = 0;
      for (let j = i; j < i + step && j < mic.fft.length; j++) {
        if (mic.fft[j] < lo) lo = mic.fft[j];
        if (mic.fft[j] > hi) hi = mic.fft[j];
      }
      wave.push(Math.round(lo * 1000) / 1000, Math.round(hi * 1000) / 1000);
    }

    // One input, two bars. A mono microphone is the normal case and two
    // identical bars is the truth about it, not a fudge.
    return { left: peak, right: peak, wave };
  }

  async function micDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      // Labels are empty until permission has been granted once — that is the
      // browser's rule, not a bug to work around.
      return all.filter((d) => d.kind === 'audioinput')
                .map((d, i) => d.label || `Input ${i + 1}`);
    } catch { return []; }
  }

  async function micArm(deviceLabel) {
    if (mic.armed) return;
    let deviceId;
    if (deviceLabel) {
      const all = await navigator.mediaDevices.enumerateDevices();
      const found = all.find((d) => d.kind === 'audioinput' && d.label === deviceLabel);
      if (found) deviceId = found.deviceId;
    }
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    const ctx = context();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* gesture */ } }
    mic.source = ctx.createMediaStreamSource(mic.stream);
    mic.analyser = ctx.createAnalyser();
    mic.analyser.fftSize = 2048;
    mic.fft = new Float32Array(mic.analyser.fftSize);
    // **Not connected to the destination.** Monitoring a microphone through
    // the speakers it is sitting next to is feedback, every time.
    mic.source.connect(mic.analyser);
    mic.armed = true;
  }

  function micDisarm() {
    if (mic.recording) { try { mic.recorder.stop(); } catch { /* already */ } }
    if (mic.stream) for (const t of mic.stream.getTracks()) t.stop();
    mic.stream = null; mic.source = null; mic.analyser = null;
    mic.recorder = null; mic.chunks = []; mic.fft = null;
    mic.armed = false; mic.recording = false;
  }

  function micStart() {
    if (!mic.armed || mic.recording) return;
    mic.chunks = [];
    mic.recorder = new MediaRecorder(mic.stream);
    mic.recorder.ondataavailable = (e) => { if (e.data.size) mic.chunks.push(e.data); };
    mic.recorder.start(200);
    mic.recording = true;
    mic.startedAt = context().currentTime;
  }

  /// Stop, decode, and make the take the open document.
  async function micStop(name) {
    if (!mic.recording) return null;
    const rec = mic.recorder;
    const ended = new Promise((done) => { rec.onstop = done; });
    rec.stop();
    await ended;
    mic.recording = false;

    const blob = new Blob(mic.chunks, { type: rec.mimeType || 'audio/webm' });
    mic.chunks = [];
    if (!blob.size) return null;

    const decoded = await context().decodeAudioData(await blob.arrayBuffer());
    const flat = interleaved(decoded);
    const frames = decoded.length;
    const seconds = frames / decoded.sampleRate;

    mic.takeNo += 1;
    const label = (name || `Take ${mic.takeNo}`).replace(/[\\/]/g, '-');
    const file = `${label}.wav`;
    const path = `${FOLDER}/${file}`;

    takePcm.set(path, { flat, rate: decoded.sampleRate, channels: 2, frames, buffer: decoded });
    takes.push({
      name: file, path, subdir: '', bytes: flat.length * 4,
      duration: seconds, sampleRate: decoded.sampleRate,
      channels: decoded.numberOfChannels, bits: 32, format: 'PCM',
      category: 'RECORDING', confidence: 'high',
      instrument: '', machine: '', bpm: '',
      why: `${seconds.toFixed(2)}s, recorded here`,
    });

    // Make it the document straight away. The modal then only has to tell the
    // interface to select it, and everything downstream is the ordinary path.
    audio.path = null;
    await open(path);
    play.dirty = true;
    play.offset = 0;

    return { ok: true, seconds, rel: path, path, file, outside: false, overruns: 0 };
  }

  // ── the transport ──
  //
  // **Web Audio is the device.** The desktop server owns a sound card and keeps
  // a scope ring of the last 16,384 frames it sent out; here the browser plays
  // a buffer we rendered, so the same window is a slice of that buffer at the
  // playhead. Same number, same purpose — `SCOPE_FRAMES` in `transport.rs`.
  const SCOPE_FRAMES = 16384;

  /// `?silent` renders, meters and draws without connecting to the speakers.
  /// A picture should not need a sound card to be looked at.
  const SILENT = new URLSearchParams(location.search).has('silent');

  const play = {
    node: null,
    buffer: null,     // the rendered cloud, as a Float32Array, interleaved
    frames: 0,
    startedAt: 0,     // ctx.currentTime when it began
    offset: 0,        // where in the cloud it began, in frames
    looping: false,
    dirty: true,      // the document moved, so the cloud is stale
  };

  /// The sound just gone, as one window — **wrapping at the loop point.**
  ///
  /// A loop has no beginning. Two hundred milliseconds after it turns over, the
  /// sound that has just been heard is the *end* of the buffer followed by the
  /// start of it, and a window that stops at frame zero is a window over
  /// silence that was never played.
  ///
  /// Which is what the meter did, and the mechanism is worth naming exactly
  /// because it is not the obvious one. The window was not empty — it was
  /// *short*, a hundred frames instead of sixteen thousand. `meter::spectrum`
  /// returns its floor when it is handed fewer samples than the transform size:
  ///
  ///     if n < size { return vec![FLOOR_DB; bands] }
  ///
  /// So for the first 16,384 frames of every pass — **341 milliseconds at
  /// 48 kHz** — every band came back at -120 dB and the terrain drew flat. Live
  /// was `true` throughout; the numbers were simply the floor. A third of a
  /// second of nothing, once a loop, in time with the music, which is exactly
  /// what makes it read as a performance problem rather than as arithmetic.
  ///
  /// One scratch buffer, reused. This is asked for twenty times a second and a
  /// fresh 128 KB each time is a garbage collection every few seconds.
  let scopeBuf = null;

  function scope(at, ch) {
    const frames = play.frames;
    if (!frames) return null;
    const want = Math.min(SCOPE_FRAMES, frames);
    if (want < 64) return null;

    const need = want * ch;
    if (!scopeBuf || scopeBuf.length !== need) scopeBuf = new Float32Array(need);

    // Where the window starts, which may be before the beginning.
    let from = at - want;
    if (from >= 0) {
      scopeBuf.set(play.buffer.subarray(from * ch, at * ch));
      return scopeBuf;
    }

    // It does. When looping, the missing part is the tail of the buffer; when
    // not, there genuinely is nothing there yet and the window is short.
    if (!play.looping) {
      const have = at * ch;
      if (have < ch * 64) return null;
      return play.buffer.subarray(0, have);
    }
    from += frames;
    const tail = (frames - from) * ch;
    scopeBuf.set(play.buffer.subarray(from * ch, frames * ch), 0);
    scopeBuf.set(play.buffer.subarray(0, at * ch), tail);
    return scopeBuf;
  }

  // ── filming ─────────────────────────────────────────────────────────────
  //
  // **The server's half of the video export, which is analysis and nothing
  // else.** The encoding is the page's: `video-export.js` drives WebCodecs and
  // `mp4.js` muxes. What it needs from here is a *reel* — one row of numbers per
  // video frame, describing the sound at that instant — plus the sound itself
  // to mux against.
  //
  // On the desktop that analysis is a thread. Here it is a loop that yields, so
  // the 200 ms status poll the page is already making keeps being answered
  // while it runs. Same protocol either way: post to start, poll until
  // `phase: 'ready'`, then pull the reel in runs.
  /// Give the event loop a turn, without `setTimeout`'s background clamp.
  ///
  /// A hidden tab throttles timers to roughly one a second; a `MessageChannel`
  /// message is an ordinary task and is delivered immediately either way. This
  /// is the difference between an export that survives being switched away
  /// from and one that stops.
  const yieldChannel = new MessageChannel();
  const yieldWaiters = [];
  yieldChannel.port1.onmessage = () => { const r = yieldWaiters.shift(); if (r) r(); };
  const yieldTask = () => new Promise((resolve) => {
    yieldWaiters.push(resolve);
    yieldChannel.port2.postMessage(0);
  });

  const reel = {
    running: false, phase: 'idle', error: null,
    frames: 0, bands: 0, liss: 0, done: 0,
    channels: 2, rate: 48000,
    data: null,   // Float32Array, frames x (bands + liss*2)
    audio: null,  // Float32Array, interleaved
    cancel: false,
  };

  const reelStatus = () => ({
    running: reel.running,
    phase: reel.phase,
    ...(reel.error ? { error: reel.error } : {}),
    frames: reel.frames,
    bands: reel.bands,
    liss: reel.liss,
    channels: reel.channels,
    rate: reel.rate,
    // The page shows these while it waits.
    done: reel.done,
    fraction: reel.frames ? reel.done / reel.frames : 0,
  });

  async function film(body) {
    reel.running = true;
    reel.phase = 'rendering';
    reel.error = null;
    reel.done = 0;
    reel.cancel = false;
    reel.data = null;
    reel.audio = null;

    try {
      const e = await engine();
      if (body.p) await open(body.p);

      // The sound first. `cloud()` is the same render the transport plays, so
      // the film is of the thing you heard rather than of a second render that
      // might not match it.
      const flat = await cloud();
      if (!flat || !flat.length) throw new Error('there is nothing rendered to film');

      const ch = audio.channels;
      const rate = audio.rate;
      const frames = Math.floor(flat.length / ch);
      reel.channels = ch;
      reel.rate = rate;
      reel.audio = flat;

      const fps = Math.max(1, +body.fps || 20);
      const bands = Math.max(1, +body.bands || 280);
      const liss = Math.max(1, +body.liss || 1024);
      const fft = Math.max(64, +body.fft || 4096);
      const outro = Math.max(0, +body.outro || 0);

      const seconds = frames / rate + outro;
      const total = Math.max(1, Math.ceil(seconds * fps));
      const per = bands + liss * 2;

      reel.frames = total;
      reel.bands = bands;
      reel.liss = liss;
      reel.data = new Float32Array(total * per);
      reel.phase = 'analysing';

      // One window per video frame, ending at that frame's position — the same
      // window the live meter uses, so the film's terrain is the terrain the
      // room was drawing.
      const win = Math.min(SCOPE_FRAMES, frames);
      const scratchLen = win * ch;
      const ptr = e.ex.scratch(scratchLen);
      const buf = new Float32Array(scratchLen);

      for (let f = 0; f < total; f++) {
        if (reel.cancel) { reel.phase = 'cancelled'; reel.running = false; return; }

        const at = Math.min(frames, Math.round((f / fps) * rate));
        const from = Math.max(0, at - win);
        buf.fill(0);
        if (at > from) buf.set(flat.subarray(from * ch, at * ch), 0);

        e.f32().set(buf, ptr >>> 2);
        const m = e.said(e.ex.meter_json(ptr, scratchLen, ch, rate, fft, bands));

        const row = f * per;
        const spec = m.spectrum || [];
        for (let i = 0; i < bands; i++) reel.data[row + i] = spec[i] ?? -120;
        const xy = m.lissajous || [];
        for (let i = 0; i < liss * 2; i++) reel.data[row + bands + i] = xy[i] ?? 0;

        reel.done = f + 1;

        // Yield often enough that the page's 200 ms poll is answered. Without
        // this the whole analysis is one task and the status request driving
        // the progress bar cannot run until it is over.
        //
        // **Not `setTimeout`.** A background tab clamps it to about a second,
        // so an export begun and then switched away from crawled and then
        // stopped outright — measured at 0 frames a second with the pane
        // hidden, stuck at 145 of 184. `yieldTask` posts to itself instead,
        // which is a real task the event loop runs at once and which the
        // background throttle does not touch.
        if ((f & 15) === 0) await yieldTask();
      }

      reel.phase = 'ready';
      reel.running = false;
    } catch (err) {
      reel.error = (err && err.message) || String(err);
      reel.phase = 'failed';
      reel.running = false;
    }
  }

  // ── what the FX panels draw ──────────────────────────────────────────────
  const SPECTRUM_BINS = 320;
  const WAVE_POINTS = 256;

  function fxSpectrum() {
    if (!audio.scope || !play.node) return [];
    audio.scope.getByteFrequencyData(audio.bins);
    const src = audio.bins;
    const step = src.length / SPECTRUM_BINS;
    const out = new Array(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      // The loudest bin in the bucket, not the average. An average of a peak
      // and its neighbours flattens exactly the resonance the EQ is being
      // used to find.
      let hi = 0;
      const from = Math.floor(i * step), to = Math.min(src.length, Math.floor((i + 1) * step) || from + 1);
      for (let j = from; j < to; j++) if (src[j] > hi) hi = src[j];
      out[i] = hi;
    }
    return out;
  }

  /// The compressor's LIVE SIGNAL trace.
  ///
  /// **Signed, and scaled to ±127.** `drawVisualCompressor` plots
  /// `mid - sample / 127 * amp`, which is the range `getByteTimeDomainData`
  /// gives once 128 is taken off it. Sending absolute floats in 0..1 meant
  /// every point came out as `0.01 / 127` — a flat line on the midline, which
  /// is exactly the dead trace being complained about.
  ///
  /// Signed rather than absolute so it draws as a waveform rather than as a
  /// hump, and the signed extreme of each bucket rather than the average,
  /// because averaging a peak with its neighbours is how a transient
  /// disappears from a display whose job is to show you transients.
  function fxWaveform() {
    if (!audio.scope || !play.node) return [];
    audio.scope.getFloatTimeDomainData(audio.time);
    const src = audio.time;
    const step = Math.max(1, Math.floor(src.length / WAVE_POINTS));
    const out = [];
    for (let i = 0; i < src.length; i += step) {
      let far = 0;
      for (let j = i; j < i + step && j < src.length; j++) {
        if (Math.abs(src[j]) > Math.abs(far)) far = src[j];
      }
      // **Not rounded to an integer.** `Math.round(far * 127)` turned a
      // -36 dBFS peak into 2 and every quieter sample into 0, and the panel
      // plots dB — so a 0 became -60 and the whole trace lay flat on the floor
      // of the graph. Two decimals keeps about 0.1 dB of resolution at the
      // quiet end, which is where this material lives.
      out.push(Math.round(far * 127 * 100) / 100);
    }
    return out;
  }

  function fxRackLevels() {
    if (!audio.scope || !play.node) return [];
    audio.scope.getFloatTimeDomainData(audio.time);
    let peak = 0;
    for (let i = 0; i < audio.time.length; i++) {
      const v = Math.abs(audio.time[i]);
      if (v > peak) peak = v;
    }
    // **One measurement, given at every tap — not nulls.**
    //
    // The analyser sits after the whole chain, so there is one real number and
    // no per-slot taps. The first version left the middle entries null on the
    // grounds that a per-slot figure would be invented. That was wrong in a way
    // that mattered: `paintRackMeters` feeds `levels[i]` to
    // `recordCompressorLevel`, which is the ONLY thing that fills
    // `compressorLevels` — so a null at the compressor's index left that map
    // empty and the panel drew `{db: -60, reduction: 0}` for ever. A dead
    // meter, which is the thing being complained about.
    //
    // The compressor works out its own gain reduction from this level against
    // its own threshold and ratio, so a real level is all it needs and the
    // reduction it draws is genuinely computed. In a chain whose stages are
    // near-unity the taps really are almost the same number; when they are not,
    // this reads as the output at every point rather than as a lie about any
    // one of them. Per-slot taps are engine work — `rack.process` would have to
    // report between stages.
    const slots = RACK_SLOTS.n || 0;
    const pair = [peak, peak];
    return new Array(slots + 1).fill(pair);
  }

  /// How many slots the rack has, so the levels array is the right length.
  ///
  /// Two to begin with, because `RackSpec::default_chain()` is an EQ and a
  /// compressor — but it is written by both `/api/rack` handlers rather than
  /// assumed, so adding an effect lengthens the meters with it.
  const RACK_SLOTS = { n: 2 };

  /// Where the playhead is, in frames of the rendered cloud.
  function position() {
    if (!play.node) return play.offset;
    const on = (context().currentTime - play.startedAt) * audio.rate;
    const at = play.offset + on;
    return play.frames ? (play.looping ? at % play.frames : Math.min(at, play.frames)) : 0;
  }

  /// Make the cloud, if the document has moved since the last one.
  ///
  /// The engine renders from `list.stretch`, so this needs no parameters: what
  /// the twenty-two grain controls wrote to the document *is* what comes out.
  async function cloud() {
    if (!play.dirty && play.buffer) return play.buffer;
    const e = await engine();
    const n = e.ex.render();
    if (!n) return null;
    const at = e.ex.out_ptr() >>> 2;
    play.buffer = e.f32().slice(at, at + n);
    play.frames = Math.floor(n / audio.channels);
    play.dirty = false;
    return play.buffer;
  }

  function stop() {
    if (play.node) {
      play.offset = position();
      try { play.node.stop(); } catch { /* already stopped */ }
      play.node = null;
    }
  }

  async function start() {
    const flat = await cloud();
    if (!flat) return;
    stop();
    const ctx = context();
    const buf = ctx.createBuffer(audio.channels, play.frames, audio.rate);
    for (let c = 0; c < audio.channels; c++) {
      const dst = buf.getChannelData(c);
      for (let i = 0; i < play.frames; i++) dst[i] = flat[i * audio.channels + c];
    }
    // A context built outside a user gesture starts suspended, and a source
    // started into a suspended context plays nothing while `currentTime` sits
    // still — so the playhead would not move either, and it would look like the
    // render had failed rather than like the browser withholding sound. This is
    // reached from a click on Play, which is a gesture, so the resume is
    // allowed; it is a no-op once running.
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.loop = play.looping;
    // **`?silent` is a gain of zero, not a missing wire.** Disconnecting the
    // source left the analyser out of the graph, so nothing was pulled through
    // it and the meters were dead in exactly the mode meant for looking at
    // pictures without making a noise.
    node.connect(audio.scope);
    audio.bus.gain.value = SILENT ? 0 : audio.bus.gain.value || 1;
    node.start(0, Math.min(play.offset, play.frames - 1) / audio.rate);
    play.node = node;
    play.startedAt = ctx.currentTime;
  }

  async function handle(path) {
    const url = new URL(path, location.origin);
    const p = url.pathname;
    const list = await sounds();

    switch (p) {
      // ── the shape of the thing ──
      case '/api/state':
        return json({
          files: list.length,
          folders: 1,
          indexed: true,
          library: FOLDER,
          scan: { current: '', done: 0, running: false, total: 0 },
          uiBuild: 'edge',
        });

      // **One folder, because there is one set of sounds.** The library panel
      // is not deleted and does not need to be: it is a picker, and what it is
      // picking from is now a fixed set rather than a scanned disk.
      case '/api/folders':
        return json([{
          name: FOLDER,
          files: list.length,
          audioFiles: list.length,
          headerFiles: list.length,
          bytes: list.reduce((n, f) => n + f.bytes, 0),
          minutes: list.reduce((n, f) => n + f.duration, 0) / 60,
          formats: 'OPUS:' + list.length,
          categories: '',
          instruments: '',
          machine: '',
          level1: 'Sample',
          level2: 'General',
          confidence: 'high',
          tags: 'shipped',
        }]);

      // ── the microphone, as the record panel expects it ──
      //
      // Polled ten times a second while the modal is open. `wave` is this
      // build's own addition to the shape: the desktop's panel has a level
      // meter and no scope, and the modal here draws what is going in.
      // The reel's progress, polled every 200 ms while it is built.
      case '/api/video':
        return json(reelStatus());

      // A run of rows, as raw floats. `i` is the first frame, `n` how many.
      case '/api/video/frames': {
        if (!reel.data) return json({ error: 'no reel has been analysed' }, 409);
        const per = reel.bands + reel.liss * 2;
        const i = Math.max(0, +url.searchParams.get('i') || 0);
        const n = Math.max(0, +url.searchParams.get('n') || 0);
        const from = Math.min(i, reel.frames) * per;
        const to = Math.min(i + n, reel.frames) * per;
        return binary(reel.data.subarray(from, to));
      }

      // The sound the film is muxed against — interleaved, the engine's own
      // render, the one the transport plays.
      case '/api/video/audio': {
        if (!reel.audio) return json({ error: 'no reel has been analysed' }, 409);
        return binary(reel.audio);
      }

      case '/api/record': {
        const lv = micLevels();
        const seconds = mic.recording
          ? Math.max(0, context().currentTime - mic.startedAt) : 0;
        return json({
          armed: mic.armed,
          recording: mic.recording,
          devices: await micDevices(),
          left: lv.left,
          right: lv.right,
          wave: lv.wave,
          seconds,
          maxSeconds: MAX_SECONDS,
          channels: mic.stream ? (mic.stream.getAudioTracks().length ? 1 : 0) : 0,
          sampleRate: mic.armed ? context().sampleRate : 0,
          // Honestly zero. MediaRecorder does not report dropped blocks, and
          // inventing a number for a field whose whole purpose is to warn you
          // that a take has a hole in it would be worse than saying none.
          overruns: 0,
        });
      }

      case '/api/files':
        return json(url.searchParams.get('folder') === FOLDER ? list : []);

      // Nothing has been reordered because there is one folder to order.
      case '/api/order':
        return json([]);

      // ── the document ──

      case '/api/edit': {
        const path = url.searchParams.get('p');
        if (!path) return json({ error: 'no path given' }, 400);
        await open(path);
        const e = await engine();
        return json(e.said(e.ex.doc_json()));
      }

      // `cols`, not `n` — the interface asks for one column per pixel of the
      // lane it is about to draw into, and passes a window when zoomed.
      case '/api/peaks': {
        const path = url.searchParams.get('p');
        if (!path) return json({ error: 'no path given' }, 400);
        await open(path);
        // A stretched document is only as long as its render, so make sure
        // there is one before measuring it.
        await cloud();
        const e = await engine();
        const cols = Math.max(1, Math.min(20000, +url.searchParams.get('cols') || 2048));
        const n = e.ex.peaks_json(cols, +url.searchParams.get('from') || 0, +url.searchParams.get('to') || 0);
        return json(e.said(n));
      }

      // What the desktop reports about the buffer it is filling. There is no
      // ring here — the sound is rendered whole — so the honest answer is that
      // it is as full as it gets.
      case '/api/audio/buffer':
        return json({ frames: 4096, running: 4096, sampleRate: audio.rate });

      // The ceiling on how many grains will be drawn at once. The desktop makes
      // this adjustable because a real library has files long enough to matter.
      case '/api/grains/cap':
        return json({ cap: 4000 });

      // ── the engine ──

      case '/api/engine/state': {
        const at = position();
        return json({
          capturedFrames: 0,
          capturing: false,
          channels: audio.channels,
          // Web Audio is the device, and it is always there. The desktop
          // reports false when there is no sound card; a browser tab that has
          // an `AudioContext` has an output by definition.
          device: true,
          inFrames: 0,
          load: { late: 0, layerCap: 64, layersRunning: 1, mean: 0, now: 0, shedding: false, worst: 0 },
          overflows: 0,
          path: audio.path || '',
          playing: !!play.node,
          position: Math.round(at),
          sampleRate: audio.rate,
          stream: {},
        });
      }

      // **The window behind the playhead**, which is what the desktop's scope
      // ring holds for exactly this. Not the whole cloud: a meter reads the
      // moment, and an FFT of fifty seconds is not a spectrum of now.
      case '/api/engine/master': {
        const e = await engine();
        if (!play.buffer || !play.node || !play.frames) return json({ live: false });
        const ch = audio.channels;
        const at = Math.floor(position()) % play.frames;
        const win = scope(at, ch);
        if (!win) return json({ live: false });
        const ptr = e.ex.scratch(win.length);
        e.f32().set(win, ptr >>> 2);
        const n = e.ex.meter_json(
          ptr, win.length, ch, audio.rate,
          +url.searchParams.get('fft') || 4096,
          +url.searchParams.get('bands') || 256,
        );
        return json(e.said(n));
      }

      case '/api/spectrogram': {
        const path = url.searchParams.get('p');
        if (path) await open(path);
        const e = await engine();
        const n = e.ex.spectrogram_json(
          +url.searchParams.get('cols') || 600,
          +url.searchParams.get('fft') || 1024,
          +url.searchParams.get('from') || 0,
          +url.searchParams.get('to') || 0,
        );
        return json(e.said(n));
      }

      // The catalogue of shapers. Whatever `fx::shape::ShapeKind::ALL` has —
      // the crate decides what is on offer, not this file.
      case '/api/fx': {
        const e = await engine();
        return json(e.said(e.ex.fx_catalogue_json()));
      }

      case '/api/rack': {
        const e = await engine();
        const spec = e.said(e.ex.rack_json(+url.searchParams.get('sr') || audio.rate));
        RACK_SLOTS.n = (spec.slots || []).length;
        return json(spec);
      }

      // ── two that are empty, and are supposed to be ──
      //
      // These are not unported routes wearing a plausible answer. Markers live
      // in a sidecar file in the desktop's data directory and there is no data
      // directory here; automation is not travelling, which the engine says the
      // same way — `docs::edit_json` writes no automation key at all when there
      // are no lanes, which is what the desktop writes for any unautomated
      // document. Empty is the truth about this build, not a way of quietening
      // the console.
      case '/api/markers':
        return json({ markers: [], regions: [] });

      case '/api/automation':
        return json({
          bypassed: false, channels: audio.channels, frames: play.frames,
          lanes: [], sampleRate: audio.rate, stale: false, targets: [],
        });

      // ── the poll that drives the playhead ──
      //
      // **Not `/api/engine/state`.** That one is asked once, on arrival. This
      // is the one asked twenty times a second while a sound plays, and the
      // playhead is drawn from it: `lockClock` takes `position`, and
      // `enginePosition` carries it forward on the wall clock in between.
      //
      // Without it the clock was never anchored and never wrapped, so the
      // playhead ran forward for ever and vanished the moment it passed the end
      // of the view — one pass, then gone, while the sound went round happily.
      //
      // `loop` is the important field and the desktop says why: *"Only it knows
      // what a loop end of zero resolves to, so anything drawing a playhead is
      // told rather than left to work it out and be wrong."* Zero to zero means
      // the whole document; here that is the whole rendered cloud, and this is
      // the only place that knows how long that came out.
      case '/api/engine/grains': {
        return json({
          position: Math.round(position()),
          sampleRate: audio.rate,
          playing: !!play.node,
          // No device latency to report. The desktop measures the gap between
          // what the callback has written and what the card has played; a
          // `BufferSource` starts when it is told and `currentTime` already
          // accounts for the output.
          latency: 0,
          // The grains that *fired* since the last poll. The desktop drains
          // them from the audio thread as it renders; nothing renders
          // incrementally here — the cloud is made whole before it plays — so
          // there is no stream of events to drain. The visuals that want them
          // read the schedule from `/api/grains` instead, which is the same
          // enumeration.
          grains: [],

          // **What the FX panels draw.** The EQ wants byte magnitudes across
          // the linear bin range up to nyquist, which is exactly what
          // `getByteFrequencyData` gives; the compressor wants the signal.
          // Decimated to what those canvases actually plot — 320 bins and 256
          // samples — because sending 1,024 floats twenty times a second to
          // draw a 309-pixel-wide box is bytes nobody looks at.
          spectrum: fxSpectrum(),
          waveform: fxWaveform(),

          // One pair per point in the chain: the input, then one after each
          // module. Only the ends are honest — the rack is rendered in a
          // single pass and the engine exposes no taps between slots, so a
          // per-slot number would be invented. `paintRackMeters` skips a pair
          // it is not given, which leaves those meters still rather than
          // wrong.
          rackLevels: fxRackLevels(),

          load: { now: 0, mean: 0, worst: 0 },
          ...(play.looping && play.frames
            ? { loop: { a: 0, b: play.frames } }
            : {}),
        });
      }

      case '/api/grains': {
        const path = url.searchParams.get('p');
        if (path) await open(path);
        const e = await engine();
        const n = e.ex.grains_json(
          +url.searchParams.get('from') || 0,
          +url.searchParams.get('to') || 0,
          +url.searchParams.get('cap') || 4000,
        );
        return json(e.said(n));
      }

      default:
        return notPorted(p + url.search);
    }
  }

  /// The routes that change something. Split out because the desktop splits
  /// them: `GET /api/edit` reads the document and `POST /api/edit` moves it.
  async function change(path, init) {
    const url = new URL(path, location.origin);
    const p = url.pathname;
    let body = {};
    try { body = JSON.parse(init.body); } catch { /* some routes send nothing */ }

    switch (p) {
      case '/api/edit': {
        if (body.p) await open(body.p);
        const e = await engine();
        const text = new TextEncoder().encode(JSON.stringify(body));
        const ptr = e.ex.scratch((text.length + 3) >> 2);
        e.u8().set(text, ptr);
        const out = e.said(e.ex.doc_apply(ptr, text.length));

        // ── the cloud in the air is now of the old document ──
        //
        // **On release, not on every movement.** The desktop changes the sound
        // *while* a control is dragged, because it has a real-time engine and
        // the grains are being emitted as you move. There is no such engine
        // here: `granular` takes a whole buffer and gives a whole buffer, so
        // "change the sound" means "make it again", a quarter of a second at a
        // time. Doing that at the drag's rate would be work thrown away before
        // it was heard.
        //
        // The panel already says which is which. A drag posts `quality:
        // "draft"` — the desktop's signal for *this one is provisional* — and
        // the release posts the real quality. So a drag moves the numbers and
        // the release moves the sound.
        //
        // Marking it stale was all this did before, and the cloud was only ever
        // made again inside `start()`. So every control worked, the document
        // changed, and nothing you could hear did — which reads as the controls
        // doing nothing at all.
        play.dirty = true;
        if (play.node && body.quality !== 'draft') {
          // `stop` banks the playhead and `start` resumes from it, so the swap
          // happens where you were rather than at the beginning.
          await start();
        }
        return json(out);
      }

      // ── the transport ──
      //
      // **Not an action, a set of things to apply.** The desktop's message is
      // every field it wants changed, and each is optional: `seek` to a frame,
      // `gain`, `loop: {on, a, b}`, and `play: true|false` for play and pause.
      // It applies whatever is present, in that order, and answers with the
      // position.
      //
      // I had this as `{ a: 'play' }` — read out of a grep for quoted strings
      // in the route, which turned up `"a"` and looked like an action key. It
      // is the `a` of the *loop range*. So every press of play fell through to
      // "not ported" and nothing made a sound, while calling the route by hand
      // with the shape I had invented worked perfectly.
      // Start the analysis and answer at once. The page polls `/api/video`
      // for the rest; blocking here would leave its progress bar at zero for
      // the whole run and time the request out on a long one.
      case '/api/video': {
        if (reel.running) return json({ error: 'a reel is already being analysed' }, 409);
        film(body);
        return json({ ok: true, started: true });
      }

      case '/api/video/stop': {
        reel.cancel = true;
        return json({ ok: true });
      }

      // Arm opens the input and meters it while keeping nothing; record and
      // stop are their own acts. That separation is the desktop's and it is
      // worth keeping: it is how you set a gain before playing the thing you
      // only get to play once.
      case '/api/record': {
        try {
          switch (body.action) {
            case 'arm':
              await micArm(body.device);
              return json({ ok: true, armed: mic.armed });
            case 'disarm':
              micDisarm();
              return json({ ok: true, armed: false });
            case 'start':
              micStart();
              return json({ ok: true, recording: mic.recording });
            case 'stop': {
              const done = await micStop(body.name);
              return done ? json(done) : json({ error: 'nothing was recorded' }, 400);
            }
            default:
              return json({ error: `unknown record action: ${body.action}` }, 400);
          }
        } catch (e) {
          // A refused permission prompt lands here, and it is the most likely
          // thing to land here. Said plainly rather than as a 500.
          const why = e && e.name === 'NotAllowedError'
            ? 'microphone permission was refused'
            : (e && e.message) || String(e);
          micDisarm();
          return json({ error: why }, 400);
        }
      }

      case '/api/engine/transport': {
        if (typeof body.seek === 'number' && isFinite(body.seek)) {
          play.offset = Math.max(0, body.seek);
          if (play.node) await start();
        }
        if (typeof body.gain === 'number' && isFinite(body.gain)) {
          // `context()` for its side effect: the bus is built with the context
          // and a gain can arrive before anything has been played.
          context();
          audio.bus.gain.value = Math.max(0, body.gain);
        }
        if (body.loop && typeof body.loop === 'object') {
          play.looping = !!body.loop.on;
          if (play.node) play.node.loop = play.looping;
        }
        if (body.play === true) await start();
        else if (body.play === false) stop();
        return json({ position: Math.round(position()) });
      }

      // Loading is what the desktop does to get a document into its engine.
      // There is nothing to load into here — the document is already in the
      // engine, and the cloud is made from it on demand.
      // ── the rack ──
      //
      // A new chain is a different sound, so the cloud is made again and
      // resumes where it was — the same rule the grain controls follow.
      case '/api/rack': {
        const e = await engine();
        const text = new TextEncoder().encode(JSON.stringify(body));
        const ptr = e.ex.scratch((text.length + 3) >> 2);
        e.u8().set(text, ptr);
        const out = e.said(e.ex.rack_set(ptr, text.length, audio.rate));
        RACK_SLOTS.n = (out.slots || body.slots || []).length;
        play.dirty = true;
        if (play.node) await start();
        return json(out);
      }

      // **One control, without rebuilding the chain.** The desktop is emphatic:
      // posting the whole spec on every movement builds every effect again from
      // nothing — delay lines cleared, filters restarted, reverb tails cut off
      // — which is why the effects stopped feeling connected to the sound. This
      // changes one number in the spec and nothing else.
      //
      // The cloud is made again on release: a drag moves the number, letting go
      // moves the sound. There is no live engine here for a drag to feed.
      case '/api/rack/param': {
        const e = await engine();
        const text = new TextEncoder().encode(JSON.stringify(body));
        const ptr = e.ex.scratch((text.length + 3) >> 2);
        e.u8().set(text, ptr);
        const out = e.said(e.ex.rack_param(ptr, text.length));
        play.dirty = true;
        if (play.node && body.live !== true) await start();
        return json(out);
      }

      // `engineLoad` reads `sampleRate` off this and keeps it as the device's
      // rate — every frame conversion in the app goes through it, so answering
      // without it silently pins the playhead to a default.
      case '/api/engine/load':
      case '/api/engine/load/reset':
        play.dirty = true;
        return json({ ok: true, sampleRate: audio.rate, path: audio.path || '' });

      // The layer governor lives on the desktop's audio thread. There is no
      // audio thread here — the cloud is rendered whole before it plays — so
      // there is nothing to shed and nothing to tell.
      case '/api/engine/shed':
        return json({ ok: true });

      default:
        return notPorted(p);
    }
  }

  window.fetch = async (input, init) => {
    const path = typeof input === 'string' ? input : (input && input.url) || '';
    if (!path.startsWith('/api/')) return realFetch(input, init);
    const method = ((init && init.method) || 'GET').toUpperCase();
    try {
      return method === 'GET' ? await handle(path) : await change(path, init || {});
    } catch (e) {
      // A thrown error would reject the fetch, and `api()` reads `.error` off a
      // parsed body — so a failure has to arrive as a response, not as a throw,
      // or the interface reports "bad response from server" and hides what
      // actually went wrong.
      console.error('[local-server]', path, e);
      return json({ error: String((e && e.message) || e) }, 500);
    }
  };

  console.log('[local-server] the server is in the page now');
})();
