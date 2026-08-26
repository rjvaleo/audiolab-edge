# audiolab-edge

**Granular audio synthesis running on Akamai's edge network.** One page: it
plays a sound, mangles it with a real granular engine compiled to WebAssembly,
and draws one big thing while it does.

[![build](https://github.com/rjvaleo/audiolab-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/rjvaleo/audiolab-edge/actions/workflows/ci.yml)
[![Akamai Functions](https://img.shields.io/badge/deploys%20to-Akamai%20Functions-FF6600?style=flat-square)](https://techdocs.akamai.com/akamai-functions/docs/welcome)
[![Spin](https://img.shields.io/badge/Spin-4.0.2-04B4C7?style=flat-square)](https://spinframework.dev)
[![wasm32-wasip2](https://img.shields.io/badge/wasm32--wasip2-component%20model-654FF0?style=flat-square&logo=webassembly&logoColor=white)](https://component-model.bytecodealliance.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust)](https://www.rust-lang.org/)
[![component](https://img.shields.io/badge/component-2.54%20MB-blue?style=flat-square)](#what-it-weighs)
[![engine tests](https://img.shields.io/badge/engine%20tests-624%20passing-success?style=flat-square)](#tests)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue?style=flat-square)](#license)

The engine is the one from
[**audiolab**](https://github.com/rjvaleo/__Audio-Edit---Tag) — a desktop audio
editor — vendored here byte for byte. Same DSP, same file formats, different
host.

> **A working proof.** It runs locally, builds from a bare clone, and validates
> against Akamai's own component world on every build. It has not been deployed.

---

## Why the edge is the hard part

An edge node has no sound card. The desktop build owns an audio device and
streams from a real-time callback; none of that survives the trip.

So the line moves: **the component serves, the browser computes.**

```
   Akamai Functions                            the visitor's browser
   ┌────────────────────────┐                  ┌──────────────────────────┐
   │  audiolab_edge.wasm    │   one GET each   │  index.html · app.js     │
   │  wasm32-wasip2         │ ───────────────► │  local-server.js         │
   │                        │                  │      ↓ swaps window.fetch│
   │  every asset inlined   │                  │  engine.wasm  ◄──────────┼── the granular
   │  gzipped at build time │                  │  wasm32-unknown-unknown  │   engine, in
   │                        │                  │      ↓                   │   the page
   │  stateless             │                  │  Web Audio · WebGL       │
   └────────────────────────┘                  └──────────────────────────┘
```

The audio plays in the browser, so the server holds nothing between one request
and the next — no engine, no session, no document. **The component is
stateless**, which is what an edge runtime wants.

### One function, and a whole app ports

The desktop interface is 15,143 lines and reaches its server through a single
function: seventy-five calls to `api()`/`postJSON()` covering 48 routes, and the
only raw `fetch(` in the file is the one inside `api()`.

[`ui/local-server.js`](ui/local-server.js) replaces the global `fetch`. Every
line above it carries on believing there is a server, and 29 of those 48 routes
are answered by the engine in the page.

---

## Build and run

```bash
brew install spinframework/tap/spin      # 4.0.2
rustup target add wasm32-wasip2 wasm32-unknown-unknown
spin build
spin up --listen 127.0.0.1:3009
```

> Homebrew's plain `spin` is the SPIN model checker, a different program. The
> tap above is the right one.

**Two WebAssembly targets, and they are not the same kind of thing:**

| | target | why |
|---|---|---|
| the engine | `wasm32-unknown-unknown` | runs in the browser, reached over a C ABI |
| the component | `wasm32-wasip2` | runs on Spin — a **component**, which is what Akamai Functions requires |

`spin build` runs both in order, because the component embeds the engine's
`.wasm`:

```bash
cargo build --release --manifest-path ../engine/Cargo.toml --target wasm32-unknown-unknown
cargo build --release --target wasm32-wasip2
```

`?silent` renders, meters and draws without connecting to the speakers.

### Tests

```bash
cd engine && cargo test --release     # the engine: 624 tests, 28 binaries
node tools/test-server.mjs            # the port: component, assets, C ABI
```

The engine's tests are the vendored crates' own — the DSP, the edit list, the
grain envelope, all five stretchers, the rack. They cover the audio thoroughly
and know nothing about the web.

The port's test covers what they cannot reach:

- **every asset the served page references returns 200**, read out of the HTML
  at runtime so a new `<script>` is covered the day it lands
- **every sound in the manifest serves**, and its byte count matches the file
- **the engine instantiates and answers** — all eighteen exports the page calls,
  a document opens, a render produces finite non-silent samples, the meter
  returns its bands
- **`scratch()` does not leak**, asserted under 1 MB across a minute of metering
- **no route that is answered stops being answered**, against a baseline
  generated from the shim

It builds, serves on a free port, and tears the server down after. It never
opens a browser, so it cannot make a sound.

`ui/local-server.js` runs in a page and needs a DOM and Web Audio to be
exercised honestly; that is not covered.

---

## Deploying to Akamai Functions

```bash
spin aka login
spin aka deploy --build --create-name audiolab-edge
```

`--build` builds first. The app comes up on `https://<uuid>.fwf.app` as a
wildcard route. `--create-name` is for the first deploy only — after that the
plugin writes `.spin-aka/config.toml` and later deploys are
`spin aka deploy --no-confirm`.

You need the `aka` plugin (`spin plugins install aka`) and an Akamai account
with Functions enabled.

### The build checks itself against Akamai

`spin.toml` carries `targets = ["akamai-functions"]`. `spin build` resolves that
against [spinframework/spin-environments](https://github.com/spinframework/spin-environments),
fetches the WIT world Akamai provides, and validates this component's imports
and exports against it. It is quiet on success:

```bash
RUST_LOG=spin_environments=info spin build
```

```
INFO spin_environments: Validated component audiolab-edge … against target world
                        akamai:functions/http-trigger@1.0.0
INFO spin_environments: Validated component audiolab-edge … against all target worlds
```

It tries each world the environment offers. The two async worlds
(`http-trigger-async@1.1.0`) require a `wasi:http/handler@0.3.0` export, which is
wasip3 and Rust cannot emit, so they are rejected; it validates against
`akamai:functions/http-trigger@1.0.0`.

The component imports WASI at `@0.2.9` and exports
`wasi:http/incoming-handler@0.2.0` against Akamai's `@0.2.6`. That is the
component model's version matching working as specified — `0.2.x` canonicalises
to `@0.2` and matches in both directions.

`spin targets update` does not exist in Spin 4.0.2. Nothing needs to run first.

### Limits

From [Akamai's quotas and limits](https://techdocs.akamai.com/akamai-functions/docs/quotas-and-limits),
measured against this build:

| | limit | this build |
|---|---|---|
| app size | 50 MiB | **2.54 MB** — 5% |
| request/response | 10 MiB | largest response **1.78 MB** gzipped |
| memory per invocation | 128 MiB | 2.4 MB of embedded assets |
| handler duration | 30 s | a render is ~260 ms |

Akamai's docs describe these as public-preview defaults and direct you to a
representative for higher ones. No pricing or free tier is published.

---

## What works

The granular engine end to end. Transport with looping. Waveform, spectrogram
and meters. The Room and the Ridgeline, and — with babylon embedded — Surfaces,
Stage and the ten grain arrangements. The effect rack: EQ, compressor, shapers,
maximiser, with a live spectrum behind the EQ curve and the signal drawn against
the compressor's threshold. The theme editor. Recording from the microphone
straight into the player. Audio export to 24-bit AIFF, time stretch included.
Video export to H.264 + AAC MP4 at 1920×1080.

## What does not

| | |
|---|---|
| **19 of 48 routes** | presets (all five), `/api/stats`, `/api/measure`, and the library routes — scan, tagging, recording to disk — which are features that do not travel |
| **the toolbar** | `doc_apply` implements one operation, `stretch`. Cut, crop, fade, reverse and undo answer 501 |
| **the stretch tray** | opens on the WSOLA tab while `render()` calls `granular` and ignores `stretch.algorithm` |
| **takes are private** | a recording lives in that browser tab's memory. Nothing is uploaded, nothing is shared, a reload loses it. Export is how a take is kept |

### Offline render, not an AudioWorklet

`granular` takes a whole buffer and returns a whole buffer, so the cloud is made
in one call and then played and looped — a quarter of a second of work for fifty
seconds of sound, against a worklet's obligation to keep up 128 samples at a
time for ever.

The consequence is visible in the interface: a control **drag** moves the number
and **release** moves the sound.

The page does not play on arrival. `first-sound.js` opens a sound so the
waveform, spectrogram and controls have something to show; play is a press.

### Speed

```
tv snips · 6.38s · 48 kHz mono, as 44 KB of Opus
259 ms to render 51.0s of stereo cloud
197x faster than real time
```

Native, the same render is 179 ms — WebAssembly costs about **1.5×** with no
SIMD and nothing tuned. There is no argument for rendering on the server.

---

## What it weighs

Everything text is stored gzipped, compressed by `build.rs` and served with
`content-encoding: gzip`. This component is the web server; nothing sits in
front of it.

| | raw | as stored |
|---|---|---|
| embedded assets | 10,256,404 | **2,452,609** (4.2×) |
| — `babylon.js` | 8,258,950 | 1,775,012 |
| — the granular engine | 355,108 | ~129,000 |
| — `app.js` | 644,901 | 198,307 |
| — one sound, Opus 96k | 45,262 | 45,262 (already compressed) |
| **the component, deployable** | | **2,668,089** |

A cold visit transfers about 2.4 MB and delivers 10.2 MB of assets. A client
that does not send `accept-encoding: gzip` is served decompressed bytes;
`vary: accept-encoding` is set.

---

## Sounds

Drop anything into [`ingest/`](ingest/) — wav, aiff, mp3, flac, m4a, ogg — and:

```bash
node tools/ingest.mjs
spin build
```

It converts to Opus 96k, moves the result into `sounds/`, and rewrites
`sounds/manifest.json`, which is what the interface reads as its file list.
Everything in `sounds/` is compiled into the component, so each sound adds its
own size to the deployable — roughly 12 KB a second at Opus 96k.

---

## The engine is vendored

[`engine/vendor/`](engine/vendor/) holds `audio-core`, `fx`, `edit` and four
wire-format files, copied byte for byte from a named commit of the desktop
repository. [`engine/vendor/SOURCE.md`](engine/vendor/SOURCE.md) records which.

It is vendored rather than submoduled because the desktop repository is a 407 MB
fetch and a 1,028 MB checkout — a gigabyte of audio to obtain 1.2 MB of source.

**The rule between the two builds:**

- **the engine and the file formats — identical.** A preset, a session, a rack
  spec or an exported AIFF written by either build opens in the other.
- **the features — this build is a subset.** No disk, no device, no library, no
  tags. It lags the desktop.

```bash
tools/sync-core.sh            # re-copy from a desktop checkout
tools/sync-core.sh --check    # or ask whether anything has moved
node tools/port-status.mjs    # which /api routes are called but not answered
```

All three find the desktop tree at `$AUDIOLAB_CORE` or at
`../__Audio-Edit---Tag/core`, and pass quietly where there is neither. The
method is written up in the desktop repository as `docs/EDGE-PARITY.md`.

---

## License

Dual-licensed under either of

- **Apache License, Version 2.0** — [`LICENSE-APACHE`](LICENSE-APACHE)
- **MIT license** — [`LICENSE-MIT`](LICENSE-MIT)

at your option, which is the Rust ecosystem's convention and what the Cargo
manifests declare. That includes `engine/vendor/`: the vendored crates are the
same DSP the desktop runs and carry the same terms.

Unless you state otherwise, any contribution intentionally submitted for
inclusion shall be dual-licensed as above.

## The other repository

[**rjvaleo/__Audio-Edit---Tag**](https://github.com/rjvaleo/__Audio-Edit---Tag)
— the desktop build, which does not change for this. Ten crates, ~53,700 lines
of Rust, 1,033 Rust tests and 222 browser tests. Nothing here shares a commit
with it.

## Documents

| | |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | the architecture and the decisions behind it |
| [`docs/PORT.md`](docs/PORT.md) | route by route: what travels, what does not |
| [`docs/RAIL.md`](docs/RAIL.md) | the four-button rail |
