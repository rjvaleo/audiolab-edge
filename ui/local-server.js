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

      default:
        return notPorted(p + url.search);
    }
  }

  window.fetch = (input, init) => {
    const path = typeof input === 'string' ? input : (input && input.url) || '';
    if (path.startsWith('/api/')) return handle(path, init);
    return realFetch(input, init);
  };

  console.log('[local-server] the server is in the page now');
})();
