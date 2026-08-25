// Open a sound on arrival, so Grain has something to be.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS THE EDGE BUILD'S, AND SHOULD NOT BE PORTED BACK.
//
// The desktop opens onto a library of thousands and asks which one you want.
// That is right there and wrong here: this build ships a fixed handful, and
// landing on an empty editor with Grain greyed out — "open a sound first" —
// makes the page look broken to somebody who has just arrived at a URL.
//
// So it picks the first one. If the desktop ever wants this, it wants it as a
// preference, not as a default.
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  /// Which sound. The first in the manifest, which is alphabetical, which is
  /// as good an answer as any until somebody says otherwise.
  const FOLDER = 'Sounds';

  /// Where to land. Grain, because that is what this build is for — the room
  /// and the theme are things you go to *from* a sound.
  const MODE = 'edit';

  /// Give the app time to have its own boot. `refresh()` fetches the state, the
  /// folders and the first folder's files before anything can be selected, and
  /// there is no event for "done" — so this waits for the fact rather than for
  /// a duration, and gives up rather than spinning for ever.
  const READY_MS = 8000;
  const TICK_MS = 60;

  const ready = () =>
    typeof state !== 'undefined' &&
    typeof selectFile === 'function' &&
    typeof setMode === 'function' &&
    Array.isArray(state.folders) &&
    state.folders.length > 0;

  async function go() {
    // Somebody got there first — a reload with a document already open, or a
    // link that named one. Leave it alone.
    if (state.selectedFile || (state.tabs && state.tabs.length)) return;

    let files;
    try {
      files = await api(`/api/files?folder=${encodeURIComponent(FOLDER)}`);
    } catch {
      return; // No sounds shipped. An empty page is then the honest answer.
    }
    if (!files || !files.length) return;

    await selectFile(files[0]);
    setMode(MODE);
  }

  const started = Date.now();
  const wait = setInterval(() => {
    if (ready()) {
      clearInterval(wait);
      go();
    } else if (Date.now() - started > READY_MS) {
      clearInterval(wait);
      console.warn('[first-sound] the app never became ready; leaving it alone');
    }
  }, TICK_MS);
})();
