# A build for the edge

Written 25 Aug 2026. **A plan, not a description — none of this exists yet.**

## What it is

One page that plays a sound, mangles it with the granular engine this program
already has, and draws one big beautiful thing while it does. Land on the URL
and it is already running. Share the link.

It is a **separate repository and a separate build**. This one does not change.
The trimming described below happens over there, on a copy, and nothing here is
deleted to make room for it.

## What it is for

Two things, and the second is the one that pays.

1. **Your friend's edge node**, which is where this started.
2. **A shop window for the standalone.** A link that shows what the engine
   sounds and looks like, running the *same* engine — not a demo
   reimplementation that drifts away from the product over a year until it is
   showing something we no longer sell.

## The platform

`fibonacci1729/spinup.dev` is a GUI for building **Spin** applications, and it
deploys to **Akamai Functions**. So the target is not a Linux box with no sound
card. It is **WebAssembly**: Spin components, `wasm32-wasip1`, invoked per HTTP
request.

That matters more than the sound card ever did, and it retires the assumption
this work started from. `--no-default-features` was the right fix for
`libasound.so.2` (`EDGE-BUILD.md`) and it is still necessary. It is nowhere near
sufficient.

## What was measured

Not guessed. Both targets, on 25 Aug 2026, against the tree as it stands:

| crate | `wasm32-wasip1` (Spin) | `wasm32-unknown-unknown` (browser) |
|---|---|---|
| `audio-core` | **builds** | **builds** |
| `fx` | **builds** | **builds** |
| `edit` | **builds** | **builds** |
| `catalog` | **builds** | — |
| `search` | **builds** | — |
| `indexer` | **builds** | — |
| `server` (`--no-default-features`) | **builds** | — |

**The engine is already portable.** `fx` is 19,910 lines of it and `edit`
another 4,293, and neither needed a line changed. That is the finding this plan
rests on: there is no DSP port. There is only a shell to replace.

## The two things that do not port

And the compiler will not tell you, because both **compile** on WASI and fail at
run time:

- `server/src/serve.rs:18`, `:24` — `TcpListener::bind`. Spin owns the socket
  and hands you a request.
- `server/src/serve.rs:37`, and `routes.rs:2512`, `:2646`, `:3149` —
  `std::thread::spawn`. One thread per connection, and three background workers
  for rendering and export. WASI has no threads to give, and a long render does
  not fit inside a request budget in any case.

Six call sites. That is the whole of it, and it is why the answer below is not
"port the server" but "need almost no server".

## The shape: Spin serves, the browser computes

The move that dissolves the problem is not a build flag. It is this:

> **On the edge there is no sound card, so the sound does not play on the
> server. It plays in the browser.**

Today the server owns the audio device, which is why the interface has to ask it
what the sound looks like twenty times a second — `/api/engine/master`, the
route that `mbTick` exists to poll and the one that hung on CI
(`NO-AUDIO-DEVICE.md`). Move playback into Web Audio and that entire axis is
gone:

- no engine, no cpal, no real-time thread, no `try_lock` discipline
- **no `/api/engine/*` at all**, so no polling and no meter round trip
- an `AnalyserNode` gives the visual its numbers from the sound already playing,
  on the same machine, with no network in the loop — which is *better* than what
  the desktop build does, not a concession

And the visuals were never the problem: they are already WebGL and canvas 2D
running in the browser. They cross over as they are.

So:

**The component** (Rust → `wasm32-wasip1`) serves the page, the WASM module and
the sound. It is stateless because it has nothing to remember — no engine, no
document, no session. Whether it needs to do *any* computation depends on the
last open question below.

**The browser** runs `audio-core` + `fx` + `edit` as WASM in an AudioWorklet,
plays the result through Web Audio, and draws the visual from an `AnalyserNode`.

## What crosses over

- `audio-core`, `fx`, `edit` — the engine, unchanged
- `ui/vis-gl.js` (108 KB) and `ui/ridge.js` + `ridge-data.js` (161 KB) — no
  third-party rendering library between them
- the theme engine, and the palette work that goes with it
- the control model for the stretchers, cut down to the granular one

## What does not

Each of these is dead weight on an edge node, not a feature we are sorry to
lose:

| gone | why |
|---|---|
| `yamnet` (1,453 lines + a model) | an ML model inside a size-limited component |
| `indexer`, `search`, `catalog` | there is no local library to index |
| the three tagging systems | same |
| export to disk, recording | no disk, no input |
| the video export and `mp4.js` | a film is minutes of encoding in a request budget |
| `stage.js`, `room3d.js` and Babylon | 7.9 MB for looks we are not shipping |
| `engine` (6,366 lines) | Web Audio is the transport now |
| most of `server` (15,110 lines) | replaced by a handler |
| four of the five stretchers | this is about the granular one |

## The visuals: two, not twenty-five

Twenty-five today — four on the bus, ten p5 grain views in an iframe, ten stage
arrangements, and a 2D swarm. **Two go:**

1. **Room** — `ui/vis-gl.js`, 108 KB. The box in perspective: the spectrum
   travelling to the back wall, the Lissajous in the sky, the terrain along the
   floor. **Hand-written WebGL 1 with no library behind it** — not three.js, not
   Babylon, nothing vendored. It is the signature look and it is also the
   cheapest thing in the build.
2. **Ridgeline** — `ui/ridge.js` + `ridge-data.js`, 161 KB, canvas 2D. Cheap,
   legible, and what draws when a machine will not give WebGL at all.

**Dropped: the Stage and Surfaces**, and with them **Babylon.js entirely — 7.9
MB, gone.** Dropped: all ten p5 views and the `grainFrame` iframe, which takes
the second vendored library out too.

So the build has **no third-party rendering dependency of any kind**, and the
whole visual payload is about 270 KB. That is the single biggest thing this
decision buys, and it makes the size question below very nearly moot.

Chosen 25 Aug 2026.

## The repository

New, and seeded by copying rather than by forking history — the 87.83 MB AIFF in
this one should not follow it anywhere.

    audiolab-edge/
      spin.toml
      component/        Rust, wasm32-wasip1 — serves the page and the sound
      engine/           audio-core + fx + edit, wasm32-unknown-unknown
      ui/               the page, two visuals, the theme engine
      sounds/           ten to twenty, Opus, under ten seconds each

## Answered  *(25 Aug 2026, from Akamai)*

**Compile the assets into the component.** No static-file serving in front of
it, no assets mounted into a WASI filesystem — `include_bytes!` and serve from
memory.

Which is what this program already does. The desktop binary embeds its whole
interface with `include_str!` and has since the beginning; the component does
the same thing with a different macro. Nothing to design.

Two consequences follow, and the second is the one to watch:

- **No storage is needed**, as long as the sounds ship with the build. That was
  the open product question and the answer above settles it by making the
  cheapest option also the natural one.
- **Everything now counts against the component's size.** The interface, both
  visuals, the compiled engine and the sounds are all inside the `.wasm`. The
  size limit stops being a footnote and becomes the budget the whole build lives
  in.

### What it all weighs  *(measured 25 Aug 2026)*

The engine was the unknown, so it was compiled rather than asked about:
`audio-core` + `fx` + `edit` as a `cdylib` for `wasm32-unknown-unknown`, with a
real call into `fx::grain::granular` so nothing could be dead-stripped.

| | raw | brotli |
|---|---|---|
| the granular engine, as WASM | **53 KB** | **19 KB** |
| Room — `vis-gl.js` | 108 KB | |
| Ridgeline — `ridge.js` + `ridge-data.js` | 161 KB | ~60 KB together |
| interface — `index.html`, `app.js`, `app.css`, before any trimming | 848 KB | ~200 KB |
| the sounds — see below | ~74 KB each | — |

**The first attempt at that measurement said 14 KB and was wrong.** The stub
only referenced a type's size, so the linker discarded the engine and the number
described an empty module. It took a genuine call into the granular render to
get one that means anything — worth remembering, because a size that comes back
suspiciously good usually is.

**So the sounds are the heaviest thing in the build**, by a wide margin. Every
worry that started this — Babylon, the component limit, the engine — is smaller
than one audio file.

## The sounds  *(decided 25 Aug 2026)*

**Ten to twenty of them, each under ten seconds, hand-picked, as Opus at 96
kbps.**

Short because that is what a granular engine wants: you make the big sound out
of the little one, so a five-second source is not a compromise, it is the
material. Ten to twenty because the range is the demo — one source shown five
ways is one trick, and five very different sources is a repertoire.

**Lossy is a non-issue here and worth saying why**, rather than treating it as a
concession. The sources are already resampled and grainy, several of them
deliberately low-rate, and every one of them is about to be sliced into grains
and rebuilt. Codec artefacts are far below the floor of what the engine does to
the sound on purpose.

Measured on five genuinely different sources from the library, eight-second
excerpts:

| source | wav | flac | opus 96k | opus 64k |
|---|---|---|---|---|
| `pikDrone.aif` | 1,378 KB | 142 KB | **90 KB** | 64 KB |
| `bottom heavy atmos.wav` | 552 KB | 234 KB | **75 KB** | 50 KB |
| `saturday ripp'd - 1.wav` | 188 KB | 98 KB | **32 KB** | 21 KB |
| `tv snips.wav` | 598 KB | 431 KB | **70 KB** | 44 KB |
| `Ceramic_hi1*ePianCerami2.aif` | 1,378 KB | 344 KB | **105 KB** | 72 KB |

**Opus 96k averages 74 KB.** Twenty sounds is about **1.5 MB**, and the whole
component with them in it lands under 2 MB.

**96 rather than 64.** The difference across the whole set is half a megabyte,
and granular slicing is precisely the processing that exposes a codec. Not worth
economising on.

**FLAC was measured and rejected.** It looked competitive on the drone at 142 KB
— drones compress well — but across real material it ranges 98 KB to 431 KB and
averages 3.4× Opus. Twenty sounds would be 5 MB, for losslessness nobody will
hear through a grain cloud.

**The container needs testing, not assuming.** The same Opus stream is 90 KB as
Ogg (`.opus`) and 92 KB as WebM. Ogg Opus is fine in Chrome and Firefox; Safari
is the one to check. WebM costs two kilobytes and may be the safer wrapper —
a five-minute test in step 3 rather than a decision now.

**Chosen for grain character, not for genre.** Something transient-dense,
something sustained and tonal, something noisy and textural, something with
speech in it, something metallic. The selection is Richard's; the packing is
mechanical once it is made.

## Open

1. **Does the platform compress responses, or should the embedded bytes already
   be compressed?** Text goes four or five to one. If we have to do it
   ourselves, we embed the brotli'd form and set `content-encoding`, which
   shrinks the component *and* the transfer.
2. **wasip1 or wasip2, and which Spin SDK version.**
3. **How the decoded sound reaches `edit::render`.** It takes a
   `Reader<S: RandomAccessSource>`, which is shaped for files; in the browser
   the samples arrive as a decoded `AudioBuffer`. An adapter, not an obstacle,
   but it is the one real integration point and it belongs to step 3.

`simd128` and the per-request budget are no longer open: they only mattered if
DSP ran server-side, and none does.

## Phases

1. **This document, agreed.** The two visuals were chosen on 25 Aug 2026.
2. **The repository**, empty, with `spin.toml` and a page that says hello from
   `wasm32-wasip1`. Proves the toolchain end to end before anything real is in
   it.
3. **The engine in the browser.** `audio-core` + `fx` + `edit` in an
   AudioWorklet, playing a shipped sound. No visuals. This is the risky part and
   it goes first.
4. **The Room** — the cheapest and the most ours.
5. **Ridgeline**, the theme, the controls.
6. **Deploy**, and see what the edge actually does with it.

Step 3 is where this either works or does not. Everything after it is carrying
across code that already runs.
