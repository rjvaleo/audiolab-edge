// The left rail. See `docs/RAIL.md`.
//
// ─────────────────────────────────────────────────────────────────────────────
// PORTING THIS BACK TO THE DESKTOP BUILD
//
// Four steps, and none of them touch `app.js`:
//
//   1. copy `rail.js` and `rail.css`
//   2. in `index.html`, replace the whole `<nav class="rail" id="leftRail">…`
//      block with:  <nav class="rail rl" id="leftRail"></nav>
//   3. add `<link rel="stylesheet" href="/rail.css">` beside the other stylesheet
//   4. add `<script src="/rail.js"></script>` **before** `<script src="/app.js">`
//
// Step 4 is the one that matters. `app.js` finds the rail at parse time with
// three selectors, so the buttons have to exist before it runs.
// ─────────────────────────────────────────────────────────────────────────────
//
// **This file does not modify `app.js`.** It reaches into the rail in exactly
// three ways, and this file emits markup that answers all three — which is what
// lets the rail be replaced without touching the interface that drives it.
// (`app.js` itself has since been edited for other reasons, 206 lines of rail
// wiring and tag removal; the point here is that *this* file needs none of it.)
//
//   `#leftRail .mode-btn` + `dataset.mode`    `setMode` toggles `.active`
//   `#leftRail .rail-btn` + `dataset.panel`   `showPane` toggles `.active`,
//                                             and `app.js` attaches the onclick
//   `#leftRail [data-panel="…"]`              hidden while editing
//
// So every button below carries the class and the data attribute the app
// already looks for, *as well as* the rail's own. The old markup's behaviour is
// unchanged; only its arrangement and its clothes are new.

(() => {
  /// Open or closed, remembered. A rail you have to re-open every time is one
  /// you leave open, and then it is not a collapsible rail.
  const STORE = 'audiolab.rail.open';

  /// The four destinations.
  ///
  /// **One kind of thing.** The rail used to answer two questions at once —
  /// which workspace am I in, and which panel of the library is open — with
  /// three kinds of button at two sizes. These four are all the same question:
  /// where am I.
  ///
  /// `mode` and `panel` are what `app.js` already understands. Grain, Visual
  /// and Browse are workspaces; Theme opens a panel, which is why it carries a
  /// `panel` instead — the difference is real and it is the app's, not the
  /// rail's.
  const ITEMS = [
    {
      icon: 'grain', label: 'Grain', mode: 'edit',
      title: 'The granular engine — the sound you are working on',
    },
    {
      icon: 'visual', label: 'Visual', mode: 'room',
      title: 'The room, full size, and everything that draws it',
    },
    {
      icon: 'theme', label: 'Theme', panel: 'theme',
      title: 'Palette and colours',
    },
    {
      icon: 'browse', label: 'Browse', mode: 'overview', children: 'library',
      title: 'Every sound, and everything to do with the library',
    },
  ];

  /// What lives under Browse.
  ///
  /// These are the library's own parts and they were never workspaces: you do
  /// not *go* to Scan, you scan the library. Indented under the thing they
  /// belong to, and only visible when you are there.
  ///
  /// `record`, `scan` and `import` need a disk. They are listed here because
  /// this is the rail's shape; whether this build shows them is decided by
  /// `EDGE_HAS_DISK` below.
  const LIBRARY = [
    { icon: '≡', label: 'All sounds', panel: 'browse' },
    { icon: '⌕', label: 'Search', panel: 'search' },
    { icon: '◴', label: 'Scan', panel: 'scan', disk: true },
    { icon: '⌂', label: 'Folder', panel: 'import', disk: true },
    // **No disk needed any more.** The desktop's record writes a WAV to the
    // library; this one opens the browser's microphone and hands the take
    // straight to the player, so it travels after all.
    { icon: '●', label: 'Record', panel: 'record' },
  ];

  /// **There is no disk in a browser.** Scanning a library, choosing its folder
  /// and recording into it all need one. The desktop build sets this true and
  /// gets its five; this build gets two.
  ///
  /// A flag rather than a deletion, so the port back is a one-line change and
  /// not an archaeology exercise.
  const EDGE_HAS_DISK = false;

  /// **The rail owns `--rail`.**
  ///
  /// `app.css` positions three other things off that variable — the drawer at
  /// `left: var(--rail)`, its closed transform, and the docked left panel — so
  /// a rail that changes width without telling anyone leaves the panel sitting
  /// underneath it. Setting the variable is how the rail says how wide it is,
  /// and everything anchored to it follows without a single one of those rules
  /// having to know this file exists.
  const width = (open) => {
    const px = getComputedStyle(document.documentElement)
      .getPropertyValue(open ? '--rail-open' : '--rail-icon').trim();
    document.documentElement.style.setProperty('--rail', px);
  };

  const el = (tag, cls, ...kids) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids) n.append(k);
    return n;
  };

  /// The four destinations, drawn rather than spelled.
  ///
  /// They were abstract glyphs — ◉ ◈ ◑ ▤ — which say nothing about where they
  /// go. These say it: a cloud of grains, the Ridgeline pulse in its frame, a
  /// painter's palette, a folder.
  ///
  /// Inline SVG rather than a font or a sprite, because it is four shapes and
  /// they inherit `currentColor` — the accent when a destination is lit, the
  /// dim text when it is not, without a second rule anywhere. The library's own
  /// sub-items keep their glyphs; they are smaller and they are not
  /// destinations.
  const SVGS = {
    grain:
      '<path d="M7.6 18.5h9.2a3.4 3.4 0 0 0 .35-6.78 5.35 5.35 0 0 0-10.03-2.3 4.1 4.1 0 0 0 .48 9.08z"/><circle cx="9.6" cy="13.4" r=".85" fill="currentColor" stroke="none"/><circle cx="13" cy="11.9" r=".85" fill="currentColor" stroke="none"/><circle cx="15.4" cy="14.6" r=".85" fill="currentColor" stroke="none"/><circle cx="11.7" cy="15.6" r=".85" fill="currentColor" stroke="none"/>',
    visual:
      '<rect x="3.5" y="3.5" width="17" height="17" rx="1.6"/><path d="M5.5 7.2 Q12 5.4 18.5 7.2"/><path d="M5.5 9.4 Q12 5.8 18.5 9.4"/><path d="M5.5 11.6 Q12 6.2 18.5 11.6"/><path d="M5.5 13.8 Q12 8.4 18.5 13.8"/><path d="M5.5 16.0 Q12 12.4 18.5 16.0"/><path d="M5.5 18.2 Q12 16.4 18.5 18.2"/>',
    theme:
      '<path d="M12 3.6c-4.8 0-8.6 3.5-8.6 7.8s3.8 7.8 8.6 7.8c1 0 1.75-.8 1.75-1.75 0-.45-.18-.86-.46-1.16-.28-.3-.46-.7-.46-1.15 0-.96.78-1.74 1.74-1.74h2.05 c2.85 0 5.16-2.3 5.16-5.15 0-2.9-4.2-4.65-9.82-4.65z"/><circle cx="7.6" cy="10.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="10.4" cy="7.3" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.6" cy="7.1" r="1.15" fill="currentColor" stroke="none"/><circle cx="17.6" cy="9.6" r="1.15" fill="currentColor" stroke="none"/>',
    browse:
      '<path d="M3.4 7.3A1.6 1.6 0 0 1 5 5.7h3.9a1.6 1.6 0 0 1 1.28.64l1.06 1.42 h7.76A1.6 1.6 0 0 1 20.6 9.36v8.34A1.6 1.6 0 0 1 19 19.3H5 a1.6 1.6 0 0 1-1.6-1.6z"/>'
  };

  const icon = (glyph) => {
    const s = el('span', 'rl-ic');
    if (SVGS[glyph]) {
      s.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true">' + SVGS[glyph] + '</svg>';
    } else {
      s.textContent = glyph;
    }
    return s;
  };

  const label = (text) => {
    const s = el('span', 'rl-lb');
    s.textContent = text;
    return s;
  };

  function build() {
    const rail = document.getElementById('leftRail');
    if (!rail) return;
    rail.className = 'rail rl';
    rail.replaceChildren();

    let open = false;
    try { open = localStorage.getItem(STORE) === '1'; } catch { /* blocked */ }
    rail.classList.toggle('open', open);
    width(open);

    for (const item of ITEMS) {
      // The classes and data attributes `app.js` looks for. A workspace is a
      // `.mode-btn`; a panel is a `.rail-btn`. Both also carry `.rl-item`,
      // which is what this file's stylesheet dresses.
      const b = el('button', item.mode ? 'rl-item mode-btn' : 'rl-item rail-btn');
      if (item.mode) b.dataset.mode = item.mode;
      if (item.panel) b.dataset.panel = item.panel;
      b.title = item.title;
      b.append(icon(item.icon), label(item.label));
      rail.append(b);

      if (item.children !== 'library') continue;

      // Browse's own parts, indented beneath it.
      const sub = el('div', 'rl-sub');
      sub.dataset.for = item.mode;
      for (const child of LIBRARY) {
        if (child.disk && !EDGE_HAS_DISK) continue;
        // `.rail-btn` again, because these are the same panel buttons the app
        // has always had — moved, not rewritten. `app.js` attaches their
        // click handlers itself.
        const c = el('button', 'rl-child rail-btn');
        c.dataset.panel = child.panel;
        c.title = child.label;
        c.append(icon(child.icon), label(child.label));
        sub.append(c);
      }
      rail.append(sub);
    }

    rail.append(el('div', 'rl-spacer'));

    // The handle. At the bottom and under a rule, because it is the one control
    // here that changes the rail rather than the app.
    const toggle = el('button', 'rl-toggle');
    toggle.type = 'button';
    toggle.title = 'Show or hide the labels';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(icon('›'), label('Collapse'));
    toggle.onclick = () => {
      const now = rail.classList.toggle('open');
      width(now);
      toggle.setAttribute('aria-expanded', String(now));
      try { localStorage.setItem(STORE, now ? '1' : '0'); } catch { /* blocked */ }
    };
    rail.append(toggle);

    // ── which one is lit, and what a second click does ──────────────────────
    //
    // **`.active` cannot be the highlight, and this is why.** `app.js` toggles
    // it on `.mode-btn` from `setMode`, and on `.rail-btn` from `showPane` —
    // two independent sets. Theme is a panel and Browse is a mode, so opening
    // Theme lit Theme *and left Browse lit*, which is the rail saying you are
    // in two places at once.
    //
    // So the rail keeps its own mark, `.rl-on`, and there is exactly one. The
    // app's `.active` is left alone; it is still true, it just is not the
    // question this column is answering.
    const items = () => [...rail.querySelectorAll('.rl-item')];

    /// **Where you are, worked out — not remembered.**
    ///
    /// The first version lit whatever was last clicked and lit `overview` at
    /// startup. `first-sound.js` then moved the app to Grain without clicking
    /// anything, so the rail said Browse while the app was in Grain — and the
    /// second-click check trusted that, decided Browse was already current, and
    /// swallowed the click.
    ///
    /// Theme is checked first because it is a pane rather than a mode. That is
    /// only safe because leaving Theme now genuinely closes it — see `go()`.
    /// While it did not, the light stuck on Theme for ever: you could click
    /// Browse, land in `overview`, and the rail still said Theme because the
    /// pane was still open behind it.
    const current = () => {
      const theme = document.getElementById('paneTheme');
      const panel = document.getElementById('leftPanel');
      const themeShown = theme && !theme.classList.contains('hidden') &&
        panel && !panel.classList.contains('collapsed') &&
        !panel.classList.contains('drawer-closed');
      if (themeShown) return rail.querySelector('.rl-item[data-panel="theme"]');
      const mode = (typeof state !== 'undefined' && state.mode) || 'overview';
      return rail.querySelector(`.rl-item[data-mode="${mode}"]`);
    };

    const sync = () => {
      const now = current();
      items().forEach((b) => b.classList.toggle('rl-on', b === now));
    };

    // ── the tray each destination owns ──────────────────────────────────────
    //
    // **All four behave the same.** Every destination has its own controls and
    // they are already in the page — they were simply never wired to the rail:
    //
    //   Grain   `#dock`        the stretch, splice, scan and shape controls
    //   Visual  `.room-edit`   the room editor — layers, streams, colour
    //   Theme   `#leftPanel`   showing `paneTheme`
    //   Browse  `#leftPanel`   showing `paneBrowse`, and the only place sound
    //                          files appear
    //
    // The left panel opens and shuts by class; the dock and the room editor by
    // `.hidden`. Two mechanisms, so this says which one a destination uses
    // rather than assuming.
    const tray = (item) => {
      if (item.dataset.panel || item.dataset.mode === 'overview') {
        return document.getElementById('leftPanel');
      }
      if (item.dataset.mode === 'edit') return document.getElementById('dock');
      // Whichever editor the current visual owns — Room, Ridgeline and the rest
      // each have their own, and `setMode` decides which.
      return document.querySelector('.room-edit:not(.hidden)') ||
             document.getElementById('roomEdit');
    };

    const trayOpen = (item) => {
      const t = tray(item);
      if (!t) return false;
      if (t.id === 'leftPanel') {
        return !(t.classList.contains('collapsed') || t.classList.contains('drawer-closed'));
      }
      return !t.classList.contains('hidden');
    };

    const shutTray = (item) => {
      const t = tray(item);
      if (!t) return;
      if (t.id === 'leftPanel') closeDrawer();
      else t.classList.add('hidden');
    };

    const openTray = (item) => {
      const t = tray(item);
      if (!t) return;
      if (t.id === 'leftPanel') openDrawer();
      else t.classList.remove('hidden');
    };

    // ── going somewhere ─────────────────────────────────────────────────────
    //
    // **The button you press is the space you get, and nothing else comes with
    // it.** This file used to do half the job — let `app.js` change the mode,
    // then force the drawer open on top of wherever you landed. Two faults
    // followed and both were reported as "the nav doesn't work":
    //
    //   * Visual put you in the Room and opened the *file list* over it in a
    //     330px drawer, because the drawer still held whatever pane was last
    //     shown. The room is the entire point of that button.
    //   * Grain and Browse never closed the Theme editor, because `setMode`
    //     has no opinion about panes. You left Theme and Theme stayed.
    //
    // So the rail does the whole transition: which mode, which pane, and which
    // tray is on screen. Every other destination's tray is shut by the same
    // act, so there is nowhere for the previous space to survive.
    const go = (item) => {
      const mode = item.dataset.mode;
      const pane = item.dataset.panel;

      // `app.js`'s own guard, kept: Grain with nothing open has nothing to
      // show, and it says so rather than arriving empty.
      if (mode === 'edit' && !state.selectedFile && !state.tabs.length) {
        toast('Open a sound first — double-click one in the library');
        return false;
      }

      // Shut everything first, so a swap cannot leave two trays open.
      items().forEach((b) => { if (b !== item) shutTray(b); });

      if (pane === 'theme') {
        showPane('left', 'theme');
      } else {
        setMode(mode);
        // Reset the pane before showing, so the panel can never come back
        // holding Theme, and so sound files stay in Browse.
        if (mode === 'overview') showPane('left', 'browse');
      }
      openTray(item);
      return true;
    };

    // Capture, and stop there. `app.js` binds its own `onclick` to these same
    // buttons — `setMode` on `.mode-btn`, `showPane` on `.rail-btn` — and each
    // knows about half the transition. Letting them also run is what produced a
    // Room with the file list over it.
    rail.addEventListener('click', (e) => {
      const item = e.target.closest('.rl-item');
      if (!item || !rail.contains(item)) return;
      e.stopPropagation();
      e.preventDefault();

      // **Once to open, once to close.** Clicking the space you are already in
      // shuts its tray. Clicking a different one goes there, and the previous
      // tray is gone in the same act — which is why a swap looks instant while
      // opening from nothing slides.
      if (item === current() && trayOpen(item)) {
        shutTray(item);
        sync();
        return;
      }
      if (go(item)) sync();
    }, true);

    // **Record opens a window, not a tray.** It is a `.rail-btn` like the
    // other library children, so `app.js` would otherwise `showPane` it into
    // the left panel — which is where its markup used to live and no longer
    // does. Caught here and sent to the modal instead.
    rail.addEventListener('click', (e) => {
      const child = e.target.closest('.rl-child[data-panel="record"]');
      if (!child || !rail.contains(child)) return;
      e.stopPropagation();
      e.preventDefault();
      if (typeof openRecordModal === 'function') openRecordModal();
    }, true);

    // Browse's children follow Browse.
    const follow = () => {
      const browse = rail.querySelector('.rl-item[data-mode="overview"]');
      const sub = rail.querySelector('.rl-sub');
      if (browse && sub) sub.classList.toggle('shown', browse.classList.contains('rl-on'));
    };
    new MutationObserver(follow).observe(rail, {
      subtree: true, attributes: true, attributeFilter: ['class'],
    });

    // The app moves without the rail being touched — `first-sound.js` opens in
    // Grain, a double-click in Browse goes there too. `setMode` writes these
    // two classes on `<body>`, so watching them is how the rail hears about it.
    new MutationObserver(() => { sync(); follow(); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });

    sync();
    follow();
  }

  // Immediately: `app.js` reads the rail at parse time and this script is
  // loaded before it, so the DOM has to be there now rather than on ready.
  build();
})();
