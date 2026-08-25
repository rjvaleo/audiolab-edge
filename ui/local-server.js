// The server, in the page.
//
// **`ui/port/app.js` is byte-for-byte the desktop build's.** It has to stay
// that way — the moment it is edited there are two granular interfaces and one
// of them is worse. So this does not touch it. It replaces what is *under* it.
//
// The whole interface talks to the server through one function: seventy-six
// calls through `api()` and `postJSON()`, and the only raw `fetch(` in fifteen
// thousand lines is the one inside `api()`. That call goes to the global
// `fetch`, so swapping the global swaps the server, and every line above it
// carries on believing there is one.
//
// What answers those calls now is the same engine — `fx`, `edit` and
// `audio-core` compiled to WebAssembly — plus the sounds compiled into the
// component. See `docs/PORT.md` for which of the forty-three routes travel.

(() => {
  const realFetch = window.fetch.bind(window);

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
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
  async function sounds() {
    if (!shipped.sounds) {
      shipped.sounds = await (await realFetch('/sounds/manifest.json')).json();
    }
    return shipped.sounds;
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
    const bytes = await (await realFetch(`/sounds/${it.name}`)).arrayBuffer();
    const decoded = await context().decodeAudioData(bytes);
    const flat = interleaved(decoded);

    const ptr = e.ex.scratch(flat.length);
    e.f32().set(flat, ptr >>> 2);
    e.ex.doc_open(ptr, flat.length, 2, decoded.sampleRate);

    audio.path = path;
    audio.buffer = decoded;
    audio.channels = 2;
    audio.rate = decoded.sampleRate;
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
    if (!SILENT) node.connect(audio.bus);
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
        return json(e.said(e.ex.rack_json(+url.searchParams.get('sr') || audio.rate)));
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
          spectrum: [],
          waveform: [],
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
