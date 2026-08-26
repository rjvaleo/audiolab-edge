// Record, as a window rather than a side panel.
//
// ─────────────────────────────────────────────────────────────────────────────
// PORTING THIS BACK TO THE DESKTOP BUILD
//
//   1. copy `record-modal.js` and `record-modal.css`
//   2. add `<link rel="stylesheet" href="/record-modal.css">`
//   3. add `<script src="/record-modal.js"></script>` **after** `app.js`
//
// After, not before — this file moves markup `app.js` has already bound its
// handlers to, and overrides one of them. The handlers survive the move because
// they are bound to the elements, not to where the elements sit.
//
// The desktop can take this as it is. What it would *not* take is the shim
// behind it: over there `/api/record` opens a sound card and writes a WAV, and
// here it opens `getUserMedia` and keeps the take in memory. The panel does not
// know the difference, which is the point.
// ─────────────────────────────────────────────────────────────────────────────
//
// **The markup is `paneRecord`, moved.** The device picker, the stereo meter,
// the transport and the readout are the desktop's own, already built and
// already driven by `app.js` — `refreshRecord` polls `/api/record` ten times a
// second and `drawRecordPanel` writes the levels into them. Rebuilding any of
// that as modal markup would have produced a second record panel, worse than
// the first, diverging from the day it was written.
//
// What is genuinely new is three things: the window, the scope, and what
// happens when you stop.

(() => {
  /// How the modal reads the level poll it did not ask for.
  ///
  /// `app.js` already polls `/api/record` and hands the answer to
  /// `drawRecordPanel`. Rather than run a second timer against the same route,
  /// this wraps that function: the original still draws the meter and the
  /// readout, and the scope is drawn from the same response. One poll, one
  /// source of truth, and if the panel ever stops polling the scope stops with
  /// it rather than carrying on against stale data.
  const wrapDraw = () => {
    if (typeof drawRecordPanel !== 'function') return false;
    const original = drawRecordPanel;
    window.drawRecordPanel = (st) => {
      original(st);
      try { paint(st); } catch { /* a scope must never break the meter */ }
    };
    return true;
  };

  let scope, ctx2d, hold = [];

  /// The waveform going in, and the readout over it.
  ///
  /// **A rolling history, not the instant.** `st.wave` is the last frame the
  /// analyser saw — about 40 ms — and drawn on its own it is a twitching
  /// squiggle that says nothing about the take. Kept and scrolled, it is the
  /// shape of what has been recorded, which is the thing worth looking at while
  /// deciding whether to keep it.
  const HISTORY = 320;

  function paint(st) {
    if (!scope || !ctx2d) return;
    const w = scope.clientWidth, h = scope.clientHeight;
    if (!w || !h) return; // laid out only while the modal is up
    const dpr = window.devicePixelRatio || 1;
    if (scope.width !== Math.round(w * dpr) || scope.height !== Math.round(h * dpr)) {
      scope.width = Math.round(w * dpr);
      scope.height = Math.round(h * dpr);
    }
    const g = ctx2d;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--accent').trim() || '#6ea8ff';
    const dim = css.getPropertyValue('--line-2').trim() || '#2a2f3a';
    const bg = css.getPropertyValue('--surface-3').trim() || '#0f1218';

    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // The zero line, so silence is visibly silence rather than an empty box.
    g.strokeStyle = dim;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h / 2 + .5);
    g.lineTo(w, h / 2 + .5);
    g.stroke();

    const pairs = st && st.wave && st.wave.length ? st.wave : null;
    if (pairs) {
      let lo = 0, hi = 0;
      for (let i = 0; i < pairs.length; i += 2) {
        if (pairs[i] < lo) lo = pairs[i];
        if (pairs[i + 1] > hi) hi = pairs[i + 1];
      }
      hold.push([lo, hi]);
      while (hold.length > HISTORY) hold.shift();
    }

    if (!hold.length) return;
    const step = w / HISTORY;
    const mid = h / 2;
    g.strokeStyle = ink;
    g.lineWidth = Math.max(1, step * .8);
    g.beginPath();
    for (let i = 0; i < hold.length; i++) {
      const x = (i + (HISTORY - hold.length)) * step + step / 2;
      const [lo, hi] = hold[i];
      // A floor of one pixel, so a signal that is present but quiet still
      // reads as present.
      const top = mid - Math.max(hi * mid, .5);
      const bot = mid - Math.min(lo * mid, -.5);
      g.moveTo(x, top);
      g.lineTo(x, bot);
    }
    g.stroke();
  }

  /// Build the window once, moving the panel into it.
  function build() {
    if (document.getElementById('recModal')) return true;
    const pane = document.getElementById('paneRecord');
    if (!pane) return false;

    const modal = document.createElement('div');
    modal.className = 'modal hidden';
    modal.id = 'recModal';
    modal.innerHTML = `
      <div class="modal-box rec-box">
        <div class="modal-head">
          <span>Record</span>
          <button class="x" id="recModalClose" title="Close">&times;</button>
        </div>
        <div class="rec-scope-wrap">
          <canvas id="recScope"></canvas>
          <div class="rec-scope-read mono" id="recScopeRead"></div>
        </div>
        <div class="rec-problem hidden" id="recProblem"></div>
        <div class="rec-modal-body" id="recModalBody"></div>
      </div>`;
    document.body.appendChild(modal);

    // The panel's own contents, moved rather than copied. `app.js` bound its
    // handlers to these elements at parse time and those bindings travel with
    // them.
    const body = modal.querySelector('#recModalBody');
    while (pane.firstChild) body.appendChild(pane.firstChild);

    scope = modal.querySelector('#recScope');
    ctx2d = scope.getContext('2d');

    // Arming is what opening the window means, so the button that did it has
    // no job left. Kept in the DOM because `drawRecordPanel` writes to it.
    const arm = document.getElementById('recArm');
    if (arm) arm.classList.add('rec-hidden-arm');

    // The readout is drawn over the waveform now, so the copy underneath it is
    // the same words twice. Hidden rather than removed — `drawRecordPanel`
    // still writes to it, and the overlay reads it from there.
    const read = document.getElementById('recReadout');
    if (read) read.classList.add('rec-hidden-read');

    // The desktop's note describes writing a WAV into the library. There is
    // no library and no disk here, so it would be a lie in the one place a
    // person looks to find out what happens to their take.
    const note = document.getElementById('recNote');
    if (note) {
      note.textContent = 'The input is live and metered while this window is '
        + 'open, and nothing is kept until you press record. Stopping loads the '
        + 'take straight into the granular player. It lives in memory only — a '
        + 'reload loses it.';
    }

    modal.querySelector('#recModalClose').onclick = close;
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    return true;
  }

  async function open() {
    if (!build()) return;
    hold = [];
    document.getElementById('recModal').classList.remove('hidden');
    // Opening arms: the window is the ambient state — the input is live and
    // metered and nothing is being kept. Recording is the next press.
    problem('');
    if (typeof recordPost === 'function') {
      const device = document.getElementById('recDevice')?.value || undefined;
      const r = await recordPost({ action: 'arm', ...(device ? { device } : {}) });
      // **Say why, in the window.** A refused permission prompt leaves the
      // panel reading 'not armed' with no record button and no reason — which
      // looks like the feature is broken rather than like the browser saying
      // no. This is the one thing a person needs to be told here.
      if (!r || r.error) {
        problem((r && r.error) || 'the microphone could not be opened');
      }
    }
    if (typeof recordPanelShown === 'function') recordPanelShown(true);
  }

  async function close() {
    const modal = document.getElementById('recModal');
    if (modal) modal.classList.add('hidden');
    if (typeof recordPanelShown === 'function') recordPanelShown(false);
    // Let the microphone go. A tab holding an open input shows a recording
    // indicator for as long as it is open, and leaving one on because a window
    // was shut is the kind of thing that loses trust in a page.
    if (typeof recordPost === 'function') await recordPost({ action: 'disarm' });
    hold = [];
  }

  /// **Stop keeps the take and hands it to the player.**
  ///
  /// `app.js`'s own handler toasts a file path and triggers a rescan, because
  /// on the desktop a take is a new WAV in the library. There is no library and
  /// no disk here: the shim has already decoded it, added it to the same list
  /// the shipped sounds are in, and made it the open document. So all that is
  /// left is to tell the interface to select it — through `selectFile`, the
  /// ordinary door every other sound goes through — and to land in Grain.
  function takeOver() {
    const stop = document.getElementById('recStop');
    if (!stop) return;
    stop.onclick = async () => {
      const name = document.getElementById('recName')?.value.trim();
      const done = await recordPost({ action: 'stop', ...(name ? { name } : {}) });
      if (!done || done.error) {
        if (done && done.error) toast(done.error);
        return;
      }
      const nameField = document.getElementById('recName');
      if (nameField) nameField.value = '';

      await close();

      try {
        const files = await api(`/api/files?folder=${encodeURIComponent('Sounds')}`);
        const it = (files || []).find((f) => f.path === done.path);
        if (it && typeof selectFile === 'function') {
          await selectFile(it);
          if (typeof setMode === 'function') setMode('edit');
        }
      } catch (e) {
        toast(`Recorded, but could not open it: ${e.message}`);
        return;
      }
      toast(`Recorded ${done.seconds.toFixed(2)}s — loaded into the player`);
    };
  }

  /// Why it will not arm, said in the window.
  function problem(text) {
    const box = document.getElementById('recProblem');
    if (!box) return;
    box.textContent = text || '';
    box.classList.toggle('hidden', !text);
  }

  /// The readout, over the waveform rather than under it.
  const readout = () => {
    const from = document.getElementById('recReadout');
    const to = document.getElementById('recScopeRead');
    if (from && to) to.textContent = from.textContent;
  };

  // `app.js` runs before this file, but its own boot is asynchronous. Wait for
  // the fact rather than for a duration.
  const READY_MS = 8000;
  const started = Date.now();
  const tick = setInterval(() => {
    if (typeof drawRecordPanel === 'function' && document.getElementById('paneRecord')) {
      clearInterval(tick);
      build();
      wrapDraw();
      takeOver();
      setInterval(readout, 120);
      window.openRecordModal = open;
      window.closeRecordModal = close;
    } else if (Date.now() - started > READY_MS) {
      clearInterval(tick);
      console.warn('[record-modal] app.js never became ready');
    }
  }, 60);
})();
