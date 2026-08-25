# audiolab-edge

Granular audio, at the edge. One page: it plays a short sound, mangles it with
the granular engine from [audiolab](../__Audio-Edit---Tag), and draws one big
thing while it does.

A **Spin** component, deployed to **Akamai Functions**. See
[`docs/PLAN.md`](docs/PLAN.md) for what is being built and why.

## The shape of it

**The component serves. The browser computes.**

There is no sound card on an edge node, so the audio plays in the browser — and
once it does, the server has nothing left to hold. No engine, no session, no
document, and no meter poll. An `AnalyserNode` reads the sound that is already
playing.

Everything is compiled into the component with `include_str!` and
`include_bytes!`. No static-file serving in front of it, no WASI filesystem.

## Building and running

    brew install spinframework/tap/spin      # 4.0.2
    rustup target add wasm32-wasip1
    spin build
    spin up --listen 127.0.0.1:3009

`spin build` shells out to `cargo build --release --target wasm32-wasip1`, so
cargo alone compiles it if the CLI is not to hand. The CLI is what *runs* it,
and running it is the only way to know it serves rather than merely links.

Verified 25 Aug 2026:

    GET /       200  text/html; charset=utf-8   the embedded page
    GET /nope   404  no such file in this build

Note that Homebrew's plain `spin` is a different program — the SPIN model
checker. The tap above is the right one; `fermyon/tap` is the old home and no
longer carries it.

## Where it is up to

**Step 1 of 6.** The component serves one page that says hello. Nothing makes a
sound yet.

| | |
|---|---|
| 1 | **the repository** — `spin.toml`, a page, and a component that serves it ✅ |
| 2 | the engine in an AudioWorklet, playing one shipped sound — *the hinge* |
| 3 | the Room |
| 4 | Ridgeline, the theme, the controls |
| 5 | the sounds: encode, pack, check the container in a real Safari |
| 6 | deploy |

Step 2 is where the approach either works or does not. Everything after it is
carrying across code that already runs.

## What it weighs

An empty component — the page, the routing and the Spin runtime, and nothing
else — is **211 KB**, or 60 KB brotli'd. That is the floor everything else sits
on. The budget it has to fit inside:

| | raw |
|---|---|
| this, today | 211 KB |
| the granular engine, measured | 53 KB |
| Room + Ridgeline | 269 KB |
| interface, before trimming | 848 KB |
| twenty sounds, Opus 96k | ~1,480 KB |

Under 2 MB, sounds and all.

## The other repository

The desktop build lives next door and **does not change**. This one was seeded
by copying rather than by forking history — nothing here shares a commit with
it, and the 87.83 MB of audio in its history should not follow it anywhere.
