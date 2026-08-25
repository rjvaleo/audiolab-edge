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

    const ptr = e.ex.alloc(flat.length);
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
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.loop = play.looping;
    if (!SILENT) node.connect(ctx.destination);
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

      case '/api/peaks': {
        const path = url.searchParams.get('p');
        if (!path) return json({ error: 'no path given' }, 400);
        await open(path);
        const e = await engine();
        const n = Math.max(1, Math.min(100000, +url.searchParams.get('n') || 2048));
        return json(e.said(e.ex.peaks_json(n)));
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
        if (!play.buffer || !play.node) return json({ live: false });
        const ch = audio.channels;
        const at = Math.floor(position());
        const end = Math.max(0, Math.min(play.frames, at));
        const from = Math.max(0, end - SCOPE_FRAMES);
        const slice = play.buffer.subarray(from * ch, end * ch);
        if (slice.length < ch * 64) return json({ live: false });
        const ptr = e.ex.alloc(slice.length);
        e.f32().set(slice, ptr >>> 2);
        const n = e.ex.meter_json(
          ptr, slice.length, ch, audio.rate,
          +url.searchParams.get('fft') || 4096,
          +url.searchParams.get('bands') || 256,
        );
        return json(e.said(n));
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
        const ptr = e.ex.alloc((text.length + 3) >> 2);
        e.u8().set(text, ptr);
        const out = e.said(e.ex.doc_apply(ptr, text.length));
        // The document moved, so the cloud in the air is of the old one. Marked
        // rather than re-rendered: a slider sends one of these per movement and
        // rendering each would be a quarter of a second of work thrown away.
        play.dirty = true;
        return json(out);
      }

      // ── the transport ──
      //
      // `a` is the action, the way the desktop names it. Everything here is a
      // Web Audio `BufferSource`; there is no engine to load and nothing to
      // stream, because the cloud is rendered whole before it plays.
      case '/api/engine/transport': {
        switch (body.a) {
          case 'play': await start(); break;
          case 'stop': stop(); play.offset = 0; break;
          case 'pause': stop(); break;
          case 'seek':
            play.offset = Math.max(0, +body.seek || 0);
            if (play.node) await start();
            break;
          case 'loop':
            play.looping = !!body.on;
            if (play.node) play.node.loop = play.looping;
            break;
          default: return notPorted(`/api/engine/transport a=${body.a}`);
        }
        return json({ ok: true, playing: !!play.node, position: Math.round(position()) });
      }

      // Loading is what the desktop does to get a document into its engine.
      // There is nothing to load into here — the document is already in the
      // engine, and the cloud is made from it on demand.
      case '/api/engine/load':
      case '/api/engine/load/reset':
        play.dirty = true;
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
