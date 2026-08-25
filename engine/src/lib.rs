//! The granular engine, for the browser.
//!
//! A thin C ABI over `fx::grain::granular` and nothing else. No wasm-bindgen:
//! the whole surface is four functions and a flat buffer of `f32`, and a
//! generated binding layer would be more code than the thing it wraps.
//!
//! **Interleaved `f32`, the same as everywhere else in this program.** Web
//! Audio hands out planar channels, so the page interleaves on the way in and
//! de-interleaves on the way out. That is three lines of JavaScript and it
//! keeps the engine's own convention untouched.
//!
//! Single-threaded by construction — which costs nothing here, because WASI and
//! the browser would both refuse threads anyway.

use std::cell::RefCell;

thread_local! {
    /// Where the last render is kept so the page can copy it out. One buffer,
    /// overwritten each time: a render replaces the one before it, and holding
    /// two of a thirty-second cloud is megabytes for no reason.
    static OUT: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

/// Room for the page to write source samples into.
///
/// Leaked on purpose. The page owns this buffer for the life of the sound it
/// loaded, and there is exactly one of those.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut f32 {
    let mut v = vec![0.0f32; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Render a cloud. Returns how many `f32` came out; `out_ptr` says where.
///
/// **Two calls rather than one**, because a `usize` is all a C ABI can return
/// and the buffer has to outlive the call. The page asks for the length, then
/// for the pointer, then copies — and copies *immediately*, since the next
/// render replaces it.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn render(
    input: *const f32,
    in_len: usize,
    channels: usize,
    sample_rate: u32,
    ratio: f32,
    semitones: f32,
    window_ms: f32,
    density_hz: f32,
    overlap: f32,
    position_jitter_ms: f32,
    pitch_jitter_semis: f32,
    layers: u32,
    pan_spread: f32,
    seed: u32,
) -> usize {
    if input.is_null() || in_len == 0 {
        return 0;
    }
    let src = unsafe { std::slice::from_raw_parts(input, in_len) };

    let g = fx::Grain {
        density_hz,
        overlap,
        position_jitter_ms,
        pitch_jitter_semis,
        layers: layers.max(1),
        pan_spread,
        seed,
        ..Default::default()
    };

    let out = fx::grain::granular(
        src,
        channels.max(1),
        sample_rate.max(1),
        ratio,
        semitones,
        window_ms,
        &g,
    );
    let n = out.len();
    OUT.with(|o| *o.borrow_mut() = out);
    n
}

/// Where the last render sits. Only valid until the next `render`.
#[no_mangle]
pub extern "C" fn out_ptr() -> *const f32 {
    OUT.with(|o| o.borrow().as_ptr())
}

/// How long the cloud will be, without rendering it. Lets the page size things
/// before committing to the work.
#[no_mangle]
pub extern "C" fn out_frames(in_frames: usize, sample_rate: u32, ratio: f32, window_ms: f32) -> usize {
    let g = fx::Grain::default();
    fx::grain::plan(in_frames, sample_rate.max(1), ratio, window_ms, &g).out_frames
}
