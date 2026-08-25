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
    /// The effect rack. One, beside the one document.
    ///
    /// **`default_chain`, not `empty`.** That is what `racks.get` falls back to
    /// for a file nobody has touched: an EQ and a compressor, both switched on,
    /// because a module that arrives bypassed reads as broken — you move a
    /// control and nothing happens. Both start genuinely inert, so the document
    /// still renders what it did before the rack existed. Starting empty was my
    /// choice and it silently changed what a file begins as.
    static RACK: RefCell<rack::RackSpec> = RefCell::new(rack::RackSpec::default_chain());
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


/// The band limits the room's floor is laid out for, from `routes.rs`.
const MASTER_LO_HZ: f32 = 20.0;
const MASTER_HI_HZ: f32 = 20_000.0;
const LISSAJOUS_POINTS: usize = 1024;

fn round4(v: f32) -> f64 {
    ((v * 10_000.0).round() / 10_000.0) as f64
}

fn channel_json(c: &audio_core::meter::Channel) -> Value {
    Value::obj()
        .set("vu", c.vu as f64)
        .set("vuDb", c.vu_db as f64)
        .set("vuUnits", c.vu_units as f64)
        .set("peak", c.peak as f64)
        .set("peakDb", c.peak_db as f64)
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
///
/// **Of the document, not of the source.** The desktop route takes its length
/// from `list.frames()` and renders the edit list — so with a stretch active
/// the waveform is as long as the thing that plays. Here the rendered cloud
/// *is* that, so peaks are read from it when there is one and from the source
/// when there is not.
///
/// That matters more than it sounds. `state.view.frames` comes from this
/// response and the timeline is laid out on it; peaks of a six-second source
/// under a fifty-second document put the playhead in a different place from the
/// picture under it.
///
/// Three series a channel, as the desktop sends: the extremes for the outline
/// and RMS for the body. A waveform drawn from extremes alone is a silhouette
/// with no weight in it.
#[no_mangle]
pub extern "C" fn peaks_json(cols: usize, from: f64, to: f64) -> usize {
    let channels = DOC.with(|d| d.borrow().as_ref().map(|l| l.channels as usize).unwrap_or(2)).max(1);
    let rate = DOC.with(|d| d.borrow().as_ref().map(|l| l.sample_rate).unwrap_or(48_000));

    // Copied out rather than borrowed across the measuring closure. Both live
    // in a `RefCell`, and `say` at the end of it would want the same borrow.
    let buf: Vec<f32> = {
        let rendered = OUT.with(|o| o.borrow().len());
        if rendered > 0 {
            OUT.with(|o| o.borrow().clone())
        } else {
            SRC.with(|s| s.borrow().clone())
        }
    };

    let measure = |buf: &[f32]| -> Value {
        let frames = buf.len() / channels;
        let a = (from.max(0.0) as usize).min(frames);
        let b = if to > from { (to as usize).min(frames) } else { frames };
        let b = b.max(a + 1).min(frames.max(1));
        let n = cols.clamp(1, 20_000);

        let mut chans = Vec::with_capacity(channels);
        for c in 0..channels {
            let (mut max, mut min, mut rms) =
                (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
            for i in 0..n {
                let s0 = a + (b - a) * i / n;
                let s1 = (a + (b - a) * (i + 1) / n).max(s0 + 1).min(frames);
                let (mut hi, mut lo, mut sum) = (0.0f32, 0.0f32, 0.0f64);
                for f in s0..s1 {
                    let v = buf[f * channels + c];
                    if v > hi { hi = v }
                    if v < lo { lo = v }
                    sum += (v as f64) * (v as f64);
                }
                let count = (s1 - s0).max(1);
                max.push(Value::Num(round4(hi)));
                min.push(Value::Num(round4(lo)));
                rms.push(Value::Num(round4((sum / count as f64).sqrt() as f32)));
            }
            chans.push(
                Value::obj()
                    .set("max", Value::Arr(max))
                    .set("min", Value::Arr(min))
                    .set("rms", Value::Arr(rms)),
            );
        }

        Value::obj()
            .set("channels", Value::Arr(chans))
            .set("columns", n as f64)
            .set("frames", frames as f64)
            .set("from", a as f64)
            .set("to", b as f64)
            .set("sampleRate", rate as f64)
    };
    say(&measure(&buf))
}

/// What the master bus is doing right now, in the shape `/api/engine/master`
/// answers.
///
/// **The numbers are `audio_core::meter`'s**, the same functions the desktop
/// route calls: `master` for the ballistics, `spectrum` for the log-spaced
/// bands, `lissajous` for the figure. So the VU is EBU R68 with 0 VU at −18
/// dBFS here exactly as it is there, rather than something plausible written
/// against a browser's `AnalyserNode`.
///
/// The assembly around them is written out, because it lives inside
/// `api_engine_master` in `routes.rs` — a function that takes an `App` and a
/// `Request`, neither of which exists here. Field names, rounding and the
/// interleaved figure all follow that function line for line.
///
/// The page passes the window of sound *behind the playhead*, which is what the
/// desktop's transport keeps in its scope ring for exactly this purpose.
#[no_mangle]
pub extern "C" fn meter_json(
    input: *const f32,
    len: usize,
    channels: usize,
    rate: u32,
    fft: usize,
    bands: usize,
) -> usize {
    if input.is_null() || len == 0 {
        return say(&Value::obj().set("live", false));
    }
    let src = unsafe { std::slice::from_raw_parts(input, len) };
    let ch = channels.max(1);
    let frames = src.len() / ch;

    // Split, because every meter function takes two channels. A mono source is
    // the same signal twice, which is what it sounds like.
    let mut l = Vec::with_capacity(frames);
    let mut r = Vec::with_capacity(frames);
    for f in 0..frames {
        l.push(src[f * ch]);
        r.push(src[f * ch + if ch > 1 { 1 } else { 0 }]);
    }

    let fft = fft.clamp(256, 16_384).next_power_of_two();
    let nbands = bands.clamp(24, 2048);

    let m = audio_core::meter::master(&l, &r, rate, fx::CEILING_KNEE);
    let spectrum =
        audio_core::meter::spectrum(&l, &r, rate, fft, nbands, MASTER_LO_HZ, MASTER_HI_HZ);
    let pts = audio_core::meter::lissajous(&l, &r, LISSAJOUS_POINTS);

    // Flat, and interleaved. A thousand `[l, r]` arrays is twice the JSON of a
    // thousand pairs of numbers and says exactly the same thing.
    let mut xy = Vec::with_capacity(pts.len() * 2);
    for (a, b) in &pts {
        xy.push(Value::Num(round4(*a)));
        xy.push(Value::Num(round4(*b)));
    }

    say(&Value::obj()
        .set("live", true)
        .set("rate", rate as f64)
        .set("frames", m.frames as f64)
        .set("left", channel_json(&m.left))
        .set("right", channel_json(&m.right))
        .set("correlation", m.correlation as f64)
        .set("overKnee", m.over_knee as f64)
        .set("vuRef", audio_core::meter::VU_REF_DBFS as f64)
        .set("fft", fft as f64)
        .set("bins", (rate as f64) / fft as f64)
        .set("knee", fx::CEILING_KNEE as f64)
        .set("lo", MASTER_LO_HZ as f64)
        .set("hi", MASTER_HI_HZ as f64)
        .set(
            "spectrum",
            Value::Arr(spectrum.into_iter().map(round4).map(Value::Num).collect()),
        )
        .set("lissajous", Value::Arr(xy)))
}

/// The grain schedule, in the shape `/api/grains` answers.
///
/// **From the same enumeration the renderer uses.** That is the property the
/// desktop route exists to preserve — the picture cannot show grains the audio
/// does not contain, because both come out of `fx::grain::grains_sampled`.
///
/// Each grain is eight numbers, in the desktop's order and to the desktop's
/// rounding: where it lands, where it reads from, how long, how far it is
/// pitched, how loud, how bright, where it sits across the field, and its own
/// index. The index is the grain's rather than the array's, because every
/// jitter it carries is a pure function of that number and thinning the list
/// would otherwise change what a grain *is*.
/// `f64` rather than `u64` for the window, deliberately.
///
/// A `u64` across the wasm boundary arrives in JavaScript as a **BigInt**, and
/// passing it an ordinary number throws `Cannot convert 0 to a BigInt` from
/// inside `api()` — which reads as the interface being broken rather than as a
/// type mismatch two layers down. Frame positions come from the page as
/// numbers; they should be taken as numbers.
#[no_mangle]
pub extern "C" fn grains_json(from: f64, to: f64, cap: usize) -> usize {
    let (from, to) = (from.max(0.0) as u64, to.max(0.0) as u64);
    let Some((ch, rate, st, frames)) = DOC.with(|d| {
        d.borrow()
            .as_ref()
            .map(|l| (l.channels as usize, l.sample_rate, l.stretch, l.base_frames()))
    }) else {
        return error("no document open");
    };

    let window = if to > from { Some((from, to)) } else { None };
    let (sent, total) = fx::grain::grains_sampled(
        frames as usize,
        rate,
        st.ratio,
        st.semitones,
        st.window_ms,
        &st.grain,
        cap.max(1),
        window,
    );

    // **What each grain actually sounds like, not just where it sits.** The
    // visualiser is driven by the audio, so loudness and brightness come from
    // the source window the grain reads rather than from the parameters that
    // scheduled it. Every eighth frame is plenty for a display value and keeps
    // a dense stream from turning into a full second of arithmetic.
    let measure = |start: f32, len: usize| -> (f32, f32) {
        SRC.with(|src| {
            let buf = src.borrow();
            let total = buf.len() / ch.max(1);
            let a = (start as usize).min(total.saturating_sub(1));
            let b = (a + len).min(total);
            if b <= a + 1 {
                return (0.0, 0.0);
            }
            let (mut sum, mut n, mut crossings, mut prev) = (0f64, 0u32, 0u32, 0f32);
            for f in (a..b).step_by(8) {
                let v = buf[f * ch];
                sum += (v as f64) * (v as f64);
                if prev <= 0.0 && v > 0.0 {
                    crossings += 1;
                }
                prev = v;
                n += 1;
            }
            let rms = if n > 0 { (sum / n as f64).sqrt() as f32 } else { 0.0 };
            // Zero-crossing rate as a cheap brightness proxy: no FFT per grain.
            let bright = if n > 1 { crossings as f32 / n as f32 } else { 0.0 };
            (rms, bright.min(1.0))
        })
    };

    /// Equal power either side of centre, from the same function that places
    /// the grain in the audio. The cloud needs a left-and-right that is real
    /// rather than decorative, and this is the only one a grain has.
    fn pan_of(g: &fx::Grain, index: u64) -> f32 {
        let (l, r) = fx::grain::pan_gains(g, index, 2);
        let sum = l + r;
        if sum <= 1e-6 {
            0.0
        } else {
            ((r - l) / sum).clamp(-1.0, 1.0)
        }
    }

    let r2 = |v: f32, places: i32| -> f64 {
        let m = 10f64.powi(places);
        (v as f64 * m).round() / m
    };

    let arr: Vec<Value> = sent
        .iter()
        .map(|e| {
            let (rms, bright) = measure(e.src_frame, e.size as usize);
            Value::Arr(vec![
                Value::Num(e.out_frame as f64),
                Value::Num(r2(e.src_frame, 2)),
                Value::Num(e.size as f64),
                Value::Num(r2(e.pitch_semis, 3)),
                Value::Num(r2(rms, 4)),
                Value::Num(r2(bright, 4)),
                Value::Num(r2(pan_of(&st.grain, e.index), 3)),
                Value::Num(e.index as f64),
            ])
        })
        .collect();

    let stride = if sent.is_empty() { 1 } else { (total / sent.len()).max(1) };
    say(&Value::obj()
        .set("grains", Value::Arr(arr))
        .set("total", total as f64)
        .set("stride", stride as f64)
        .set("sampleRate", rate as f64)
        .set("outFrames", (frames as f64 * st.ratio as f64).round())
        .set("srcFrames", frames as f64))
}

// ── samples as a source ──
//
// **The adapter the whole rest of the port hangs off.**
//
// `Reader::spectrogram` and `edit::render` both take a
// `Reader<S: RandomAccessSource>`, and that trait is byte-oriented: it is a
// file, not a buffer of samples. There is no file in a browser.
//
// There does not need to be one. `Reader::new(src, info)` takes any source plus
// a description of what is in it, and `Container::Raw` with `Codec::PcmF32` is
// exactly "these bytes are the samples". So the decoded audio is handed over as
// headerless PCM and every reader-shaped thing in the program works on it
// unchanged — no WAV to assemble, no container to parse, and no second copy of
// the audio in a different format.
struct Samples {
    bytes: Vec<u8>,
}

impl Samples {
    fn of(src: &[f32]) -> Self {
        let mut bytes = Vec::with_capacity(src.len() * 4);
        for v in src {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        Samples { bytes }
    }
}

impl audio_core::RandomAccessSource for Samples {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        let at = (offset as usize).min(self.bytes.len());
        let n = buf.len().min(self.bytes.len() - at);
        buf[..n].copy_from_slice(&self.bytes[at..at + n]);
        Ok(n)
    }
    fn len(&self) -> std::io::Result<u64> {
        Ok(self.bytes.len() as u64)
    }
}

fn reader_over(src: &[f32], channels: usize, rate: u32) -> audio_core::Reader<Samples> {
    let s = Samples::of(src);
    let info = audio_core::AudioInfo {
        container: audio_core::Container::Raw,
        codec: audio_core::Codec::PcmF32,
        endian: audio_core::Endian::Little,
        sample_rate: rate,
        channels: channels.max(1) as u16,
        bits: 32,
        data_offset: 0,
        data_len: (src.len() * 4) as u64,
    };
    audio_core::Reader::new(s, info)
}

/// A spectrogram, in the shape `/api/spectrogram` answers.
///
/// **`Reader::spectrogram` itself**, over the sound in memory — the same
/// transform, the same Hann window, the same 90 dB floor and the same mapping
/// of magnitude into a byte. Only the base64 is written out, because the
/// desktop's encoder is a private function in `routes.rs`.
#[no_mangle]
pub extern "C" fn spectrogram_json(cols: usize, fft: usize, from: f64, to: f64) -> usize {
    let (ch, rate) = match DOC.with(|d| {
        d.borrow().as_ref().map(|l| (l.channels as usize, l.sample_rate))
    }) {
        Some(t) => t,
        None => return error("no document open"),
    };
    let buf: Vec<f32> = SRC.with(|s| s.borrow().clone());
    if buf.is_empty() {
        return error("no sound open");
    }
    let frames = (buf.len() / ch.max(1)) as u64;
    let start = (from.max(0.0) as u64).min(frames);
    let count = if to > from { (to as u64).min(frames) - start } else { frames - start };

    let mut r = reader_over(&buf, ch, rate);
    let Ok(sg) = r.spectrogram(start, count, cols.clamp(1, 2048), fft.clamp(64, 8192)) else {
        return error("the spectrogram failed");
    };

    say(&Value::obj()
        .set("columns", sg.columns as f64)
        .set("bins", sg.bins as f64)
        .set("maxHz", sg.max_hz as f64)
        .set("floorDb", sg.floor_db as f64)
        .set("from", start as f64)
        .set("to", (start + count) as f64)
        .set("data", base64(&sg.data).as_str()))
}

/// The desktop's encoder is private to `routes.rs`, so this is the one thing
/// here written out rather than called. Same alphabet, same padding.
fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// The catalogue of shapers, in the shape `/api/fx` answers.
///
/// The content is `fx::shape::ShapeKind::ALL` and each kind's own `specs()`, so
/// what is offered is whatever the crate has. The loop is written out because
/// `api_fx_catalogue` returns a `Response`, which is a server type.
#[no_mangle]
pub extern "C" fn fx_catalogue_json() -> usize {
    let kinds: Vec<Value> = fx::shape::ShapeKind::ALL
        .into_iter()
        .map(|k| {
            let params: Vec<Value> = k
                .specs()
                .iter()
                .map(|s| {
                    Value::obj()
                        .set("key", s.key)
                        .set("label", s.label)
                        .set("min", s.min as f64)
                        .set("max", s.max as f64)
                        .set("default", s.default as f64)
                        .set("log", s.log)
                        .set("unit", s.unit)
                })
                .collect();
            Value::obj()
                .set("kind", k.as_str())
                .set("label", k.label())
                .set("params", Value::Arr(params))
        })
        .collect();
    say(&Value::obj().set("shapers", Value::Arr(kinds)))
}

/// The effect rack, in the shape `/api/rack` answers.
///
/// `RackSpec::to_json` and `RackSpec::eq_curve` are the desktop's own — `rack.rs`
/// is one of the files compiled in — so this is the route almost exactly as it
/// is written there.
#[no_mangle]
pub extern "C" fn rack_json(sr: u32) -> usize {
    RACK.with(|r| {
        let spec = r.borrow();
        let curve: Vec<Value> = spec
            .eq_curve(if sr == 0 { 48_000 } else { sr }, 96)
            .into_iter()
            .map(|(f, db)| Value::Arr(vec![Value::Num(f as f64), Value::Num(db as f64)]))
            .collect();
        say(&spec.to_json().set("curve", Value::Arr(curve)))
    })
}

/// Set the rack from what the interface posted, and answer with it.
#[no_mangle]
pub extern "C" fn rack_set(ptr: *const u8, len: usize, sr: u32) -> usize {
    if ptr.is_null() || len == 0 {
        return error("no rack given");
    }
    let body = unsafe { std::slice::from_raw_parts(ptr, len) };
    let Ok(text) = std::str::from_utf8(body) else {
        return error("rack was not text");
    };
    let Some(v) = json::parse(text) else {
        return error("invalid JSON");
    };
    RACK.with(|r| *r.borrow_mut() = rack::RackSpec::from_json(&v));
    rack_json(sr)
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
    let mut out = SRC.with(|s| {
        let src = s.borrow();
        fx::grain::granular(&src, ch, rate, st.ratio, st.semitones, st.window_ms, &st.grain)
    });

    // ── through the rack ──
    //
    // **The same two calls `edit::render_fx` makes.** `RackSpec::build` turns
    // the stored spec into a live `Rack`, `reset` clears the delay lines and
    // filter state so a render does not begin mid-tail, and `process` runs the
    // buffer through it. The EQ, the compressor, the shapers and the maximiser
    // are all in there.
    //
    // Without this the rack was stored, serialised, drawn and answered for —
    // and never applied to a single sample. Every control in the FX tab moved a
    // number that reached nothing.
    //
    // Built per render rather than kept. The desktop keeps one because it is
    // feeding a real-time callback and cannot afford to allocate on the audio
    // thread; here a render is a discrete event that already costs a quarter of
    // a second, and a rack rebuilt from the spec cannot drift from it.
    RACK.with(|r| {
        let rack = r.borrow().build(rate, ch);
        let mut rack = rack;
        if !rack.is_empty() {
            rack.reset();
            rack.process(&mut out, ch, rate);
        }
    });

    let n = out.len();
    OUT.with(|o| *o.borrow_mut() = out);
    n
}

/// Move one control on one slot, and answer the way `/api/rack/param` does.
///
/// **Not a rebuild.** The desktop is emphatic: posting the whole spec on every
/// movement builds every effect in the chain again from nothing — delay lines
/// cleared, filters restarted, reverb tails cut off — and that is why the
/// effects stopped feeling connected to the sound. So a moving control changes
/// one number in the spec and nothing else.
///
/// `master` is not in `slot_ids`; it has no id because it cannot be added,
/// removed or reordered. Its live index is the number of spec slots, which is
/// where `build` puts the maximiser.
#[no_mangle]
pub extern "C" fn rack_param(ptr: *const u8, len: usize) -> usize {
    if ptr.is_null() || len == 0 {
        return error("no parameter given");
    }
    let body = unsafe { std::slice::from_raw_parts(ptr, len) };
    let Ok(text) = std::str::from_utf8(body) else {
        return error("parameter was not text");
    };
    let Some(v) = json::parse(text) else {
        return error("invalid JSON");
    };
    let Some(id) = v.get("id").and_then(Value::as_str) else {
        return error("no slot given");
    };
    let Some(key) = v.get("key").and_then(Value::as_str) else {
        return error("no key given");
    };
    let value = match v.get("value") {
        Some(Value::Num(n)) if n.is_finite() => *n as f32,
        _ => return error("no value given"),
    };

    let applied = RACK.with(|r| {
        let mut spec = r.borrow_mut();
        if id == "master" {
            // Only `amount` is live on the master, for the reason the desktop
            // gives: the ceiling is the one guarantee the maximiser makes, and
            // putting it on a curve would defeat it.
            if key != "amount" {
                return None;
            }
            let a = value.clamp(0.0, 1.0);
            spec.master.amount = a;
            return Some(a);
        }
        let slot = spec.slot_ids.iter().position(|x| x == id)?;
        if spec.set_param(slot, key, value) { Some(value) } else { None }
    });

    match applied {
        Some(a) => say(&Value::obj()
            .set("id", id)
            .set("key", key)
            .set("value", a as f64)),
        None => error("that control is not live"),
    }
}

/// Where the last render sits. Only valid until the next one.
#[no_mangle]
pub extern "C" fn out_ptr() -> *const f32 {
    OUT.with(|o| o.borrow().as_ptr())
}
