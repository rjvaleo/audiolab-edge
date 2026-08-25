//! The whole server.
//!
//! It serves files and does nothing else — no engine, no session, no document.
//! The sound plays in the browser, so there is nothing here to keep between one
//! request and the next.
//!
//! **Everything is compiled in.** `include_str!` and `include_bytes!`, the same
//! way the desktop binary has always embedded its interface, and the way Akamai
//! asked for it: no static-file serving in front, no WASI filesystem to mount.

use spin_sdk::http::{IntoResponse, Request, Response};
use spin_sdk::http_component;

// ── the interface ──
//
// `ui/port/` is the desktop build's interface, copied across whole and not
// edited: `app.js` is byte-for-byte the same file. What replaced the server is
// `local-server.js`, which swaps the global `fetch`. See `docs/PORT.md`.
//
// Listed one by one rather than walked, because a component cannot walk a
// directory it does not have — and because being able to read what ships is
// worth more here than being able to add a file without thinking.
macro_rules! ui {
    ($name:literal) => {
        include_str!(concat!("../../ui/port/", $name))
    };
}

const INDEX: &str = ui!("index.html");
const APP_JS: &str = ui!("app.js");
const APP_CSS: &str = ui!("app.css");
/// The rail: its own file, and nothing else depends on it.
const RAIL_JS: &str = ui!("rail.js");
const RAIL_CSS: &str = ui!("rail.css");
/// Opens a sound on arrival. Edge build only.
const FIRST_SOUND: &str = ui!("first-sound.js");
const THEME_PALETTES: &str = ui!("theme-palettes.js");
const THEME_DERIVE: &str = ui!("theme-derive.js");
const GRAIN_SHAPES: &str = ui!("grain-shapes.js");
const ROOM_PAINT: &str = ui!("room-paint.js");
const RIDGE_DATA: &str = ui!("ridge-data.js");
const VIS_REGISTRY: &str = ui!("vis-registry.js");
const ROOM3D: &str = ui!("room3d.js");
const STAGE: &str = ui!("stage.js");
const RIDGE: &str = ui!("ridge.js");
const ROOM_TEXT: &str = ui!("room-text.js");
const MP4: &str = ui!("mp4.js");
const VIS_GL: &str = ui!("vis-gl.js");
const VIDEO_EXPORT: &str = ui!("video-export.js");

/// The server, in the page.
const LOCAL_SERVER: &str = include_str!("../../ui/local-server.js");
/// The granular engine, built for the browser rather than for WASI. Two
/// different wasm targets in one deployment, which is the whole architecture in
/// one line: this one is *served*, not run.
const ENGINE_WASM: &[u8] =
    include_bytes!("../../engine/target/wasm32-unknown-unknown/release/audiolab_engine.wasm");

/// What ships, and what it is.
const MANIFEST: &str = include_str!("../../sounds/manifest.json");
const TV_SNIPS: &[u8] = include_bytes!("../../sounds/tv-snips.opus");

/// What a path is served as. Kept explicit rather than guessed from an
/// extension table — this build has few enough kinds of file to name them.
fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "opus" => "audio/ogg",
        "webm" => "audio/webm",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

#[http_component]
fn handle(req: Request) -> anyhow::Result<impl IntoResponse> {
    let path = req.path();

    // One page for now. As the visuals and the engine arrive they are added
    // here as further `include_*` arms, which is the whole of the routing this
    // build will ever need.
    let (body, kind) = match path {
        "/" | "/index.html" => (INDEX.as_bytes(), mime("html")),
        "/app.js" => (APP_JS.as_bytes(), mime("js")),
        "/app.css" => (APP_CSS.as_bytes(), mime("css")),
        "/rail.js" => (RAIL_JS.as_bytes(), mime("js")),
        "/rail.css" => (RAIL_CSS.as_bytes(), mime("css")),
        "/first-sound.js" => (FIRST_SOUND.as_bytes(), mime("js")),
        "/theme-palettes.js" => (THEME_PALETTES.as_bytes(), mime("js")),
        "/theme-derive.js" => (THEME_DERIVE.as_bytes(), mime("js")),
        "/grain-shapes.js" => (GRAIN_SHAPES.as_bytes(), mime("js")),
        "/room-paint.js" => (ROOM_PAINT.as_bytes(), mime("js")),
        "/ridge-data.js" => (RIDGE_DATA.as_bytes(), mime("js")),
        "/vis-registry.js" => (VIS_REGISTRY.as_bytes(), mime("js")),
        "/room3d.js" => (ROOM3D.as_bytes(), mime("js")),
        "/stage.js" => (STAGE.as_bytes(), mime("js")),
        "/ridge.js" => (RIDGE.as_bytes(), mime("js")),
        "/room-text.js" => (ROOM_TEXT.as_bytes(), mime("js")),
        "/mp4.js" => (MP4.as_bytes(), mime("js")),
        "/vis-gl.js" => (VIS_GL.as_bytes(), mime("js")),
        "/video-export.js" => (VIDEO_EXPORT.as_bytes(), mime("js")),

        "/local-server.js" => (LOCAL_SERVER.as_bytes(), mime("js")),
        "/engine.wasm" => (ENGINE_WASM, mime("wasm")),

        "/sounds/manifest.json" => (MANIFEST.as_bytes(), mime("json")),
        "/sounds/tv-snips.opus" => (TV_SNIPS, mime("opus")),

        _ => {
            return Ok(Response::builder()
                .status(404)
                .header("content-type", "text/plain; charset=utf-8")
                .body("no such file in this build")
                .build())
        }
    };

    Ok(Response::builder()
        .status(200)
        .header("content-type", kind)
        // **`no-cache`, until the URLs carry a hash.**
        //
        // Everything here really is immutable for the life of a deployment —
        // but the paths are not: `/engine.wasm` means one thing today and
        // another after the next build, at the same URL. A long `max-age` on
        // that is a browser holding last week's engine with no way to be told.
        //
        // Found the moment it was written: an hour's `max-age` on `/` served
        // the previous page straight back after a rebuild.
        //
        // `no-cache` is not "do not store" — it is "revalidate first", so a
        // 304 still costs nothing but the round trip. When the assets are
        // content-hashed, they become `immutable` and only the page stays here.
        .header("cache-control", "no-cache")
        .body(body.to_vec())
        .build())
}
