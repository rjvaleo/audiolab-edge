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
// **`app.js` is not modified, and must not be.** It reaches into the rail in
// exactly three ways, and this file emits markup that answers all three:
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
      icon: '◉', label: 'Grain', mode: 'edit',
      title: 'The granular engine — the sound you are working on',
    },
    {
      icon: '◈', label: 'Visual', mode: 'room',
      title: 'The room, full size, and everything that draws it',
    },
    {
      icon: '◑', label: 'Theme', panel: 'theme',
      title: 'Palette and colours',
    },
    {
      icon: '▤', label: 'Browse', mode: 'overview', children: 'library',
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
    { icon: '●', label: 'Record', panel: 'record', disk: true },
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

  const icon = (glyph) => {
    const s = el('span', 'rl-ic');
    s.textContent = glyph;
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

    // Browse's children follow Browse. Watched rather than hooked, because
    // `setMode` is `app.js`'s and this file does not modify it — the class it
    // puts on the button is a fact this can read without owning.
    const follow = () => {
      const browse = rail.querySelector('.rl-item[data-mode="overview"]');
      const sub = rail.querySelector('.rl-sub');
      if (browse && sub) sub.classList.toggle('shown', browse.classList.contains('active'));
    };
    new MutationObserver(follow).observe(rail, {
      subtree: true, attributes: true, attributeFilter: ['class'],
    });
    follow();
  }

  // Immediately: `app.js` reads the rail at parse time and this script is
  // loaded before it, so the DOM has to be there now rather than on ready.
  build();
})();
