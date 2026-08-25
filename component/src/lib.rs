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

const INDEX: &str = include_str!("../../ui/index.html");
const ENGINE_JS: &str = include_str!("../../ui/engine.js");
const APP_JS: &str = include_str!("../../ui/app.js");
const ROOM_JS: &str = include_str!("../../ui/room.js");
/// The Room, copied from the desktop build and not edited. It reaches for
/// nothing outside itself, which is the only reason that was possible.
const VIS_GL_JS: &str = include_str!("../../ui/vis-gl.js");
/// The granular engine, built for the browser rather than for WASI. Two
/// different wasm targets in one deployment, which is the whole architecture in
/// one line: this one is *served*, not run.
const ENGINE_WASM: &[u8] =
    include_bytes!("../../engine/target/wasm32-unknown-unknown/release/audiolab_engine.wasm");
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
        "/engine.js" => (ENGINE_JS.as_bytes(), mime("js")),
        "/app.js" => (APP_JS.as_bytes(), mime("js")),
        "/room.js" => (ROOM_JS.as_bytes(), mime("js")),
        "/vis-gl.js" => (VIS_GL_JS.as_bytes(), mime("js")),
        "/engine.wasm" => (ENGINE_WASM, mime("wasm")),
        "/tv-snips.opus" => (TV_SNIPS, mime("opus")),
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
