# audiolab-edge

Granular audio, at the edge. One page: it plays a short sound, mangles it with
the granular engine from [audiolab](https://github.com/rjvaleo/__Audio-Edit---Tag),
and draws one big thing while it does.

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

**Step 3 of 6.** The granular
engine runs in the browser, on a sound compiled into the component, and it is
not close:

    tv snips · 6.38s · 48 kHz mono, as 44 KB of Opus
    259 ms to render 51.0s of stereo cloud
    197x faster than real time

Native, the same render is 179 ms — so **WebAssembly costs about 1.5x**, with no
SIMD and nothing tuned. There is no argument for rendering on the server.

| | |
|---|---|
| 1 | **the repository** — `spin.toml`, a page, and a component that serves it ✅ |
| 2 | **the engine in the browser, playing a shipped sound** ✅ |
| 3 | **the Room, drawn from an `AnalyserNode`** ✅ |
| 4 | Ridgeline, the theme, the controls |
| 5 | the rest of the sounds |
| 6 | deploy |

### Not an AudioWorklet, and that turned out to be right

The plan said worklet. What it needed was an offline render: `granular` takes a
whole buffer and returns a whole buffer, so the cloud is made in one call and
then played and looped. A quarter of a second of work for fifty seconds of
sound, once — against a worklet's obligation to keep up 128 samples at a time,
for ever.

A worklet becomes worth having when a control has to move *while* it plays.
Until then this is simpler, and it is what makes the page start playing on its
own.

## What it weighs

An empty component — the page, the routing and the Spin runtime — is **211 KB**.
With the engine and one sound compiled into it, **315 KB**. The budget:

| | raw |
|---|---|
| the component, with the engine, the Room and one sound inside it | 428 KB |
| — of which the granular engine | 54 KB |
| Room + Ridgeline | 269 KB |
| interface, before trimming | 848 KB |
| twenty sounds, Opus 96k | ~1,480 KB |

Under 2 MB, sounds and all.

## The other repository

[**rjvaleo/__Audio-Edit---Tag**](https://github.com/rjvaleo/__Audio-Edit---Tag) —
the desktop build, and it **does not change** for this. Ten crates, ~53,700
lines of Rust, 1,033 Rust tests and 223 browser tests.

This repository was seeded by copying rather than by forking history: nothing
here shares a commit with it, and the audio in its history should not follow it
anywhere — which is also why it is not a submodule. Pulling the desktop tree in
that way costs a **407 MB fetch and a 1,028 MB checkout** to obtain 1.2 MB of
source, and none of the gigabyte is anything this build can use.

So the engine is **vendored**. `engine/vendor/` holds `audio-core`, `fx`, `edit`
and the four wire-format files, copied byte for byte from a named commit of that
repository. That is what makes "the same engine, not a reimplementation"
literally true, and it is why a bare `git clone` of this repository builds on a
machine that has never seen the desktop tree.

**This copy is allowed to drift, and probably will.** That is a decision, not an
oversight: this repository is a proof that the engine runs at the edge, not a
second distribution of it. The desktop build carries on doing what it does and
owes this nothing; nothing here has to be kept level with it.

If you ever do want the current desktop code, that is one command:

    tools/sync-core.sh            # re-copy, and rewrite the provenance note
    tools/sync-core.sh --check    # or just ask whether anything has moved

`engine/vendor/SOURCE.md` records which commit this copy came from. Both find
the desktop tree at `$AUDIOLAB_CORE` or beside this one at
`../__Audio-Edit---Tag/core`, and both are entirely optional.
