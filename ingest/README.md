# Drop sounds here

Any format — wav, aiff, mp3, flac, m4a, ogg. They are converted to Opus 96k,
moved into `sounds/`, and written into `sounds/manifest.json`, which is what the
interface reads as its file list.

    node tools/ingest.mjs

Everything in `sounds/` is compiled into the component, so each one adds its own
size to the deployable. At Opus 96k that is roughly 12 KB a second.

This folder is a staging area. Nothing in it is served or embedded.
