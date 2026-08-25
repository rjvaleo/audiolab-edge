//! The server's answers, without the server.
//!
//! **This calls the desktop build's own code.** `docs::edit_json` is the
//! function `/api/edit` already used to serialise a document, and
//! `persist::stretch_from_json` is the one it already used to read the stretch
//! panel back. Depending on the `server` crate — which compiles for
//! `wasm32-unknown-unknown` with nothing but a `getrandom` backend to set —
//! means those answers cannot drift from the desktop's, because they *are* the
//! desktop's.
//!
//! What is genuinely new here is plumbing: one document held in memory instead
//! of a library on disk, and a C ABI instead of HTTP. See `docs/PORT.md`.
//!
//! **The ABI is two calls.** A function does its work, stores the answer, and
//! returns its length; the page then asks where it is and copies it out. A C
//! ABI can return one integer, and the buffer has to outlive the call.

use std::cell::RefCell;

// ── the desktop build's own wire format ──
//
// **Its source files, compiled in — not a copy, and not a dependency.**
//
// `docs::edit_json` is the function `/api/edit` already used to serialise a
// document; `persist::stretch_from_json` is the one that already read the
// stretch panel back. Using them is what makes this a port rather than a
// rebuild: those answers cannot drift from the desktop's, because they *are*
// the desktop's. Edit them over there and this build changes too.
//
// **Depending on the `server` crate was the obvious way to get them, and it is
// the wrong one.** Measured: it took this module from 54 KB to **14.07 MB**,
// because `server` pulls `yamnet`, which pulls `tract-onnx` — a neural network
// runtime, there for search-by-sound and for tagging. Neither travels to the
// edge, and `wasm-opt -Oz` only reached 11 MB because none of it was dead.
//
// `#[path]` takes the five files the wire format needs and nothing else. They
// reach for `edit`, `fx`, `json` and std; not one of them mentions yamnet,
// search, catalog or indexer — checked, not assumed.
#[path = "/Users/rjvaleo/Documents/__Audio-Edit---Tag/core/crates/server/src/json.rs"]
mod json;
#[path = "/Users/rjvaleo/Documents/__Audio-Edit---Tag/core/crates/server/src/rack.rs"]
mod rack;
/// **Automation does not travel, and this is the shape of its absence.**
///
/// `docs.rs` touches exactly two things here: whether there are any lanes, and
/// how to write them out if there are. The real `automation.rs` is 1,467 lines
/// of which the last 700 are a runner that reaches for `crate::state::App` and
/// `crate::live` — the server's own state and its audio device, neither of
/// which exists in a browser.
///
/// So it is not compiled in. What stands in its place says *there is no
/// automation here*, truthfully: no lanes, ever. `docs::edit_json` reads that
/// and writes no `automation` key at all, which is byte-for-byte what the
/// desktop writes for a document that has none — the branch it takes for every
/// unautomated file.
///
/// This is the only place in the port where a desktop module is answered rather
/// than used, and it is answered with the truth about this build.
mod automation {
    use crate::json::Value;

    #[derive(Default)]
    pub struct Automation {
        pub lanes: Vec<()>,
    }

    impl Automation {
        pub fn to_json(&self) -> Value {
            Value::obj()
        }
    }
}
#[path = "/Users/rjvaleo/Documents/__Audio-Edit---Tag/core/crates/server/src/persist.rs"]
mod persist;
#[path = "/Users/rjvaleo/Documents/__Audio-Edit---Tag/core/crates/server/src/docs.rs"]
mod docs;

use json::Value;

thread_local! {
    /// The sound the document is made of, interleaved, as it came from
    /// `decodeAudioData`.
    static SRC: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    /// The document. One, because there is one sound open at a time — which is
    /// as true on the desktop as it is here.
    static DOC: RefCell<Option<edit::EditList>> = const { RefCell::new(None) };
    /// Where the last answer is kept until the page copies it.
    static TEXT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// And the last render, likewise.
    static OUT: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

/// Room for the page to write source samples into. Leaked on purpose: the page
/// owns it for the life of the sound, and there is one of those.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut f32 {
    let mut v = vec![0.0f32; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

fn say(v: &Value) -> usize {
    let s = v.to_string().into_bytes();
    let n = s.len();
    TEXT.with(|t| *t.borrow_mut() = s);
    n
}

fn error(msg: &str) -> usize {
    say(&Value::obj().set("error", msg))
}

/// Where the last answer sits. Valid until the next call that produces one.
#[no_mangle]
pub extern "C" fn text_ptr() -> *const u8 {
    TEXT.with(|t| t.borrow().as_ptr())
}

/// Open a sound as a document. Answers what `GET /api/edit` answers.
#[no_mangle]
pub extern "C" fn doc_open(input: *const f32, len: usize, channels: usize, rate: u32) -> usize {
    if input.is_null() || len == 0 {
        return error("no sound given");
    }
    let src = unsafe { std::slice::from_raw_parts(input, len) }.to_vec();
    let ch = channels.max(1);
    let frames = (src.len() / ch) as u64;
    SRC.with(|s| *s.borrow_mut() = src);
    let list = edit::EditList::identity(frames, ch as u16, rate.max(1));
    DOC.with(|d| *d.borrow_mut() = Some(list));
    doc_json()
}

/// The document, as `/api/edit` returns it.
///
/// Undo and redo are false rather than absent: there is no undo stack here yet,
/// and the interface reads the flags to decide whether the menu items are live.
#[no_mangle]
pub extern "C" fn doc_json() -> usize {
    DOC.with(|d| match d.borrow().as_ref() {
        Some(l) => say(&docs::edit_json(l, false, false)),
        None => error("no document open"),
    })
}

/// Apply one operation, and answer with the document.
///
/// The op names are the desktop's, and so is the JSON: this is handed exactly
/// what the interface already posts to `/api/edit`.
#[no_mangle]
pub extern "C" fn doc_apply(ptr: *const u8, len: usize) -> usize {
    if ptr.is_null() || len == 0 {
        return error("no operation given");
    }
    let body = unsafe { std::slice::from_raw_parts(ptr, len) };
    let Ok(text) = std::str::from_utf8(body) else {
        return error("operation was not text");
    };
    let Some(v) = json::parse(text) else {
        return error("invalid JSON");
    };
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");

    let done = DOC.with(|d| {
        let mut d = d.borrow_mut();
        let Some(list) = d.as_mut() else { return false };
        match op {
            // **The whole panel, every time.** The desktop posts every control
            // on the stretch tray with each change, and `stretch_from_json` is
            // the function that already read it.
            "stretch" => {
                list.stretch = persist::stretch_from_json(&v);
                true
            }
            _ => false,
        }
    });

    if !done {
        return error(&format!("not ported: op {op}"));
    }
    doc_json()
}

/// Peaks for the waveform, in the shape `/api/peaks` returns.
#[no_mangle]
pub extern "C" fn peaks_json(buckets: usize) -> usize {
    let n = buckets.clamp(1, 100_000);
    let channels = DOC.with(|d| d.borrow().as_ref().map(|l| l.channels as usize).unwrap_or(1));
    let out = SRC.with(|s| {
        let src = s.borrow();
        let frames = src.len() / channels.max(1);
        let mut chans = Vec::with_capacity(channels);
        for c in 0..channels {
            let mut max = Vec::with_capacity(n);
            let mut min = Vec::with_capacity(n);
            for b in 0..n {
                let a = b * frames / n;
                let z = (((b + 1) * frames) / n).max(a + 1).min(frames);
                let (mut hi, mut lo) = (0.0f32, 0.0f32);
                for f in a..z {
                    let v = src[f * channels + c];
                    if v > hi { hi = v }
                    if v < lo { lo = v }
                }
                max.push(Value::Num(hi as f64));
                min.push(Value::Num(lo as f64));
            }
            chans.push(Value::obj().set("max", Value::Arr(max)).set("min", Value::Arr(min)));
        }
        Value::obj().set("channels", Value::Arr(chans))
    });
    say(&out)
}

/// Render the document's cloud. Returns how many `f32` came out; `out_ptr` says
/// where.
#[no_mangle]
pub extern "C" fn render() -> usize {
    let (ch, rate, st) = match DOC.with(|d| {
        d.borrow().as_ref().map(|l| (l.channels as usize, l.sample_rate, l.stretch))
    }) {
        Some(t) => t,
        None => return 0,
    };
    let out = SRC.with(|s| {
        let src = s.borrow();
        fx::grain::granular(&src, ch, rate, st.ratio, st.semitones, st.window_ms, &st.grain)
    });
    let n = out.len();
    OUT.with(|o| *o.borrow_mut() = out);
    n
}

/// Where the last render sits. Only valid until the next one.
#[no_mangle]
pub extern "C" fn out_ptr() -> *const f32 {
    OUT.with(|o| o.borrow().as_ptr())
}
