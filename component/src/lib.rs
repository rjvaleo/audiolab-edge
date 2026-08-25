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
        // Everything here is immutable for the life of a deployment: the build
        // is the content, so a new build is a new URL's worth of bytes.
        .header("cache-control", "public, max-age=3600")
        .body(body.to_vec())
        .build())
}
