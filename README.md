# audiolab-edge

**Granular audio synthesis running on Akamai's edge network.** One page: it
plays a short sound, mangles it with a real granular engine compiled to
WebAssembly, and draws one big thing while it does.

[![build](https://github.com/rjvaleo/audiolab-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/rjvaleo/audiolab-edge/actions/workflows/ci.yml)
[![Akamai Functions](https://img.shields.io/badge/deploys%20to-Akamai%20Functions-FF6600?style=flat-square)](https://techdocs.akamai.com/)
[![Spin](https://img.shields.io/badge/Spin-4.0.2-04B4C7?style=flat-square)](https://spinframework.dev)
[![wasm32-wasip2](https://img.shields.io/badge/wasm32--wasip2-component%20model-654FF0?style=flat-square&logo=webassembly&logoColor=white)](https://component-model.bytecodealliance.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust)](https://www.rust-lang.org/)
[![component](https://img.shields.io/badge/component-2.5%20MB-blue?style=flat-square)](#what-it-weighs)
[![engine tests](https://img.shields.io/badge/engine%20tests-624%20passing-success?style=flat-square)](#tests)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue?style=flat-square)](#license)

The engine is the one from
[**audiolab**](https://github.com/rjvaleo/__Audio-Edit---Tag) — a desktop audio
editor — vendored here byte for byte rather than reimplemented. Same DSP, same
file formats, different host.

> **Status: a working proof, not a product.** It runs locally and builds from a
> bare clone. It has never been deployed to Akamai. See
> [what works and what doesn't](#what-works-and-what-doesnt).

---

## Why the edge, and why this is hard

An edge node has **no sound card**. The desktop build owns an audio device
directly and streams from a real-time callback; none of that survives the trip.

The port answers it by moving the line: **the component serves, the browser
computes.**

```
   Akamai Functions                            the visitor's browser
   ┌────────────────────────┐                  ┌──────────────────────────┐
   │  audiolab_edge.wasm    │   one GET each   │  index.html · app.js     │
   │  wasm32-wasip2         │ ───────────────► │  local-server.js         │
   │                        │                  │      ↓ swaps window.fetch│
   │  every asset inlined   │                  │  engine.wasm  ◄──────────┼── the granular
   │  include_bytes!        │                  │  wasm32-unknown-unknown  │   engine, in
   │                        │                  │      ↓                   │   the page
   │  stateless             │                  │  Web Audio · WebGL       │
   └────────────────────────┘                  └──────────────────────────┘
```

Once the audio plays in the browser, the server has nothing left to hold — no
engine, no session, no document, no meter poll. **The component is stateless**,
which is exactly what an edge runtime wants.

### The seam that made a whole-app port possible

The desktop interface is 15,143 lines and talks to its server through **one
function**. Seventy-five calls go through `api()`/`postJSON()`, reaching 48
distinct routes, and the only raw `fetch(` in the entire file is the one inside
`api()`.

So [`ui/local-server.js`](ui/local-server.js) replaces the global `fetch` and
every line above it carries on believing there is a server. That is the whole
trick, and it is why this is a port rather than a rewrite.

---

## Build and run

```bash
brew install spinframework/tap/spin      # 4.0.2
rustup target add wasm32-wasip2 wasm32-unknown-unknown
spin build
spin up --listen 127.0.0.1:3009
```

> Homebrew's plain `spin` is a different program — the SPIN model checker. The
> tap above is the right one; `fermyon/tap` is the old home and no longer
> carries it.

**Two targets, because there are two WebAssembly builds here and they are not
the same kind:**

| | target | why |
|---|---|---|
| the engine | `wasm32-unknown-unknown` | runs in the browser, reaches the page over a C ABI |
| the component | `wasm32-wasip2` | runs on Spin — a **component**, not a core module, which is what Akamai Functions requires |

`spin build` runs both, in that order, because the component embeds the engine's
`.wasm` and would otherwise embed the previous one:

```bash
cargo build --release --manifest-path ../engine/Cargo.toml --target wasm32-unknown-unknown
cargo build --release --target wasm32-wasip2
```

So cargo alone compiles it if the CLI is not to hand. The CLI is what *runs* it,
and running it is the only way to know it serves rather than merely links.

`?silent` renders, meters and draws without connecting to the speakers — a
picture should not need a sound card to be looked at.

### Tests

```bash
cd engine && cargo test --release     # the engine: 624 tests, 28 binaries
node tools/test-server.mjs            # the port: the component, assets, C ABI
```

The first is the vendored crates' own — the DSP, the edit list, the grain
envelope, all five stretchers, the rack. They came across with the source, at no
cost, and they cover the audio thoroughly. None of them know this is a web
application.

The second covers what they cannot reach, and its shape follows the shape of the
bugs this port has actually had:

- **every asset the served page references returns 200** — read out of the HTML
  at runtime, not from a list, so a new `<script>` is covered the day it lands.
  This is the check that catches `/vendor/babylon.js`, and it currently fails on
  exactly that.
- **every sound in the manifest serves, and its byte count matches** the file
  that comes back.
- **the engine instantiates and answers**: all sixteen exports the page calls
  across the C ABI are present, a document opens, a render produces finite
  non-silent samples, and the meter returns its bands.
- **`scratch()` does not leak** — 1,200 calls, a minute of metering at 20 Hz,
  asserted under 1 MB. The `alloc` it replaced would have leaked 150 MB.
- **no route that used to be answered has stopped being answered**, against a
  baseline generated from the shim itself.

It builds, serves on a port nobody is using, and tears the server down after —
so running it never disturbs whatever you have open. **It never opens a browser,
which means it cannot make a sound.**

Still uncovered: `ui/local-server.js` runs in a page and needs a DOM and Web
Audio to be exercised honestly. Faking those in Node would test the fake.

---

## Deploying to Akamai Functions

**Not yet attempted — but the component is validated against Akamai's own world
on every build**, and the whole deploy is two commands.

```bash
spin aka login
spin aka deploy --build --create-name audiolab-edge
```

`--build` builds first, so there is no separate step. The app comes up on
`https://<uuid>.fwf.app` as a wildcard route. `--create-name` is accepted **only
on the first deploy** — after that the plugin writes `.spin-aka/config.toml`
into the project and later deploys are just `spin aka deploy --no-confirm`.

You need the `aka` plugin (`spin plugins install aka`) and an Akamai account
with Functions enabled. Akamai's docs still describe the service as limited
availability behind an onboarding form, while Fermyon announced GA in November
2025 — so the docs may be stale, and the fastest answer is to ask Akamai
directly.

### It is checked against Akamai before it is sent

`spin.toml` carries `targets = ["akamai-functions"]`. `spin build` resolves that
against [spinframework/spin-environments](https://github.com/spinframework/spin-environments),
fetches the WIT world Akamai actually provides, and validates this component's
imports and exports against it. It is quiet when it passes; to watch it work:

```bash
RUST_LOG=spin_environments=info spin build
```

```
INFO spin_environments: Validated component audiolab-edge … against target world
                        akamai:functions/http-trigger@1.0.0
INFO spin_environments: Validated component audiolab-edge … against all target worlds
```

It tries each world the environment offers. The two async worlds
(`http-trigger-async@1.1.0`) are **rejected**, and correctly — they require a
`wasi:http/handler@0.3.0` export, which is wasip3, and Rust cannot emit wasip3.
It then validates against `akamai:functions/http-trigger@1.0.0` and passes.

> A note for anyone who goes looking with `strings`: this component imports WASI
> at `@0.2.9` and exports `wasi:http/incoming-handler@0.2.0`, while Akamai
> provides `@0.2.6`. That is not a skew, it is the component model's version
> matching working as specified — `0.2.x` canonicalises to `@0.2` and matches by
> string equality, in both directions. The `@0.2.0` strings a grep turns up are
> inside the core module's own import section, bridged by `wit-component`, and
> no host ever sees them.

`spin targets update` does **not** exist in Spin 4.0.2 — that subcommand is
unreleased. Nothing needs to run first.

### The limits that matter

From [Akamai's quotas and limits](https://techdocs.akamai.com/akamai-functions/docs/quotas-and-limits),
with this build measured against them:

| | limit | this build |
|---|---|---|
| app size | 50 MiB | **2.65 MB** — 5% |
| request/response | 10 MiB | largest response **1.78 MB** gzipped |
| memory per invocation | 128 MiB | 2.4 MB of embedded assets |
| handler duration | 30 s | a render is ~260 ms |

The response cap is the one worth designing around, and it is why compression
matters here beyond politeness: `babylon.js` uncompressed is 8.26 MB against a
10 MiB ceiling — inside it, but with the whole safety margin spent on one file.
Gzipped it is 1.78 MB and the question goes away.

Akamai's docs hedge that these are public-preview defaults and say to contact a
representative for higher limits. No pricing or free tier is published anywhere
public; third-party figures found in search conflate Functions with EdgeWorkers
or Linode compute and should not be trusted.

## What works, and what doesn't

**Working:** the granular engine end to end, transport with looping, the
waveform, the spectrogram, the meters, the Room and the Ridgeline visuals, the
effect rack (EQ, compressor, shapers, maximiser), the theme editor, and the
four-button rail.

**Not working, honestly:**

| | |
|---|---|
| **26 of 48 routes unanswered** | Presets, export, video, stats, measure. `node tools/port-status.mjs` prints the list. Roughly half the remainder — scan, library, tagging, recording — are features that legitimately do not travel. |
| **the toolbar is mostly inert** | `doc_apply` implements one operation, `stretch`. Cut, crop, fade, reverse, undo and export all answer 501. |
| **the stretch tray opens on WSOLA** | while `render()` unconditionally calls `granular` and ignores `stretch.algorithm`. |

### Not an AudioWorklet, and that turned out to be right

The plan said worklet. What it needed was an offline render: `granular` takes a
whole buffer and returns a whole buffer, so the cloud is made in one call and
then played and looped. A quarter of a second of work for fifty seconds of
sound, once — against a worklet's obligation to keep up 128 samples at a time,
for ever.

The consequence, which is visible in the interface: a control **drag** moves the
number and **release** moves the sound. A worklet becomes worth having when a
control has to move *while* it plays.

**The page does not play on its own.** `first-sound.js` opens a sound so the
waveform, the spectrogram and the controls have something to show on arrival,
and stops there. Landing on the URL gives you a loaded document and a silent
one; play is a press.

### Speed

```
tv snips · 6.38s · 48 kHz mono, as 44 KB of Opus
259 ms to render 51.0s of stereo cloud
197x faster than real time
```

Native, the same render is 179 ms — so **WebAssembly costs about 1.5×**, with no
SIMD and nothing tuned. There is no argument for rendering on the server.

---

## What it weighs

Measured 25 Aug 2026 with `stat`, on the build in this repository.

**Everything text is stored gzipped**, compressed by `build.rs` at build time
and served with `content-encoding: gzip`. This component *is* the web server —
nothing sits in front of it to do that, and it is a CDN.

| | raw | as stored |
|---|---|---|
| 25 embedded assets | 10,225,801 | **2,441,946** (4.2×) |
| — `babylon.js` | 8,258,950 | 1,775,012 |
| — the granular engine | 348,862 | 128,899 |
| — `app.js` | 644,901 | 198,307 |
| — one sound, Opus 96k | 45,262 | 45,262 (already compressed) |
| **the component, deployable** | | **2,646,209** |

A cold visit transfers **2,435,997 bytes** and delivers **10,169,116** worth of
assets.

Compression is what made babylon affordable. Raw, it would have taken the
component past 10 MB and twelve visuals stayed dead rather than pay it;
gzipped it costs 530 KB of component and the question stopped being
interesting.

A client that does not send `accept-encoding: gzip` — `curl` without
`--compressed` — is served the decompressed bytes instead, so nothing has to
know this is happening. `vary: accept-encoding` is set.

---

## Sounds

One so far — `tv-snips.opus`, 6.38 s, Opus 96k, 45,262 bytes. More are coming.

Everything under `sounds/` is compiled into the component, and
`sounds/manifest.json` is what the interface reads as its file list. To add one:

```bash
cp yoursound.wav sounds/
node tools/manifest.mjs      # re-probes with ffprobe, rewrites manifest.json
spin build
```

Opus at 96k is the format because it is small and the browser decodes it
natively — writing a decoder in Rust to avoid `decodeAudioData` would be a
decoder to maintain. Nineteen more at ~45 KB would add roughly 860 KB to the
component, taking it to just under 3 MB.

---

## The engine is vendored, not linked

[`engine/vendor/`](engine/vendor/) holds `audio-core`, `fx`, `edit` and four
wire-format files, copied **byte for byte** from a named commit of the desktop
repository. [`engine/vendor/SOURCE.md`](engine/vendor/SOURCE.md) records which
commit.

Until 25 Aug these were absolute paths into a home directory, which meant the
repository built on exactly one machine in the world. A submodule was the
obvious fix and the wrong one: the desktop repository is a **407 MB fetch and a
1,028 MB checkout**, because a large audio library is tracked at HEAD. That is a
gigabyte of someone's personal audio to obtain 1.2 MB of source.

**The rule between the two builds**, which is deliberate and not a compromise:

- **the engine and the file formats — identical.** A preset, a session, a rack
  spec or an exported AIFF written by either build opens in the other. That is
  the contract, and it is why these seven things are copied rather than
  reimplemented.
- **the features — this build is a subset.** No disk, no device, no library, no
  tags. It lags the desktop, and that is normal.

```bash
tools/sync-core.sh            # re-copy from a desktop checkout, rewrite the provenance
tools/sync-core.sh --check    # or just ask whether anything has moved
node tools/port-status.mjs    # which /api routes the interface calls but this build doesn't answer
```

Both find the desktop tree at `$AUDIOLAB_CORE` or beside this one at
`../__Audio-Edit---Tag/core`, and both pass quietly where there is neither —
which is the normal case for anyone but the author.

The full method is written up in the desktop repository as `docs/EDGE-PARITY.md`.

---

## The other repository

[**rjvaleo/__Audio-Edit---Tag**](https://github.com/rjvaleo/__Audio-Edit---Tag)
— the desktop build, and it **does not change** for this. Ten crates, ~53,700
lines of Rust, 1,033 Rust tests and 222 browser tests.

This repository was seeded by copying rather than by forking history: nothing
here shares a commit with it.

## License

Dual-licensed under either of

- **Apache License, Version 2.0** — [`LICENSE-APACHE`](LICENSE-APACHE)
- **MIT license** — [`LICENSE-MIT`](LICENSE-MIT)

at your option. This is the Rust ecosystem's convention and it is what the Cargo
manifests here have declared from the start; the files now exist to back that up.

**That includes `engine/vendor/`.** The vendored crates are the same DSP the
desktop build runs — `audio-core`, `fx`, `edit` and the four wire-format files —
and they carry the same terms, which is what makes the port honest: the engine
you can read here is the engine that produced the sound.

Unless you state otherwise, any contribution intentionally submitted for
inclusion in this work shall be dual-licensed as above, without additional terms
or conditions.

## Documents

| | |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | what was decided before any of it existed, and why |
| [`docs/PORT.md`](docs/PORT.md) | route by route: what travels, what does not, what is stubbed |
| [`docs/RAIL.md`](docs/RAIL.md) | the four-button rail, and the first deliberate divergence from the desktop interface |
