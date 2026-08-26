# The port

**This is a port, not a rebuild.** The interface exists, it has been worked on
for a year, and every control in it was argued over once already. Nothing here
is re-decided; things are either carried across or deleted.

The distinction is not pedantry. A rebuild diverges from the desktop build the
day it is written and never converges again, and then there are two granular
interfaces to maintain and one of them is worse.

## What was copied

Whole, unedited, into `ui/port/`:

| | |
|---|---|
| `index.html` | 57 KB |
| `app.js` | 628 KB · **15,143 lines** |
| `app.css` | 163 KB |
| `vis-gl.js` | 108 KB — already in place and running |
| `ridge.js` + `ridge-data.js` | 161 KB |
| `room-paint.js`, `room-text.js` | 54 KB |
| `theme-derive.js`, `theme-palettes.js` | 31 KB |

## The seam, and why this is tractable

**The whole interface talks to the server through one function.**

    76  calls through api() / postJSON()
     1  raw fetch() — and it is the one inside api()

Fifteen thousand lines, and a single door. So the port is not "rewrite the
interface against a new backend". It is **reimplement `api()`** against the
WebAssembly engine and in-memory state, and let everything upstream of it carry
on believing there is a server.

That is worth stating plainly because it is the entire reason this is a week
rather than a rewrite. Whoever drew that line drew it in the right place.

## The forty-three routes

### Travels — needs a local answer

The engine is already here; these are the routes that stand between it and the
interface.

| route | becomes |
|---|---|
| `/api/edit` | the edit list, held in the page |
| `/api/grains`, `/api/grains/cap` | `fx::grain::plan` through the wasm engine |
| `/api/peaks` | computed from the decoded buffer |
| `/api/audio/buffer` | the decoded buffer itself |
| `/api/engine/state` | what Web Audio reports |
| `/api/engine/transport` | play and stop on a `BufferSource` |
| `/api/engine/master` | the meter window that already feeds the Room |
| `/api/measure` | `audio_core` through the wasm engine |
| `/api/state` | a constant: one sound, no library |

### Does not travel — the caller goes with it

| | routes |
|---|---|
| the library | `/api/library`, `/api/folders`, `/api/files`, `/api/browse`, `/api/scan`, `/api/scan/stop`, `/api/thumbs`, `/api/stats`, `/api/similar`, `/api/order` |
| tagging | `/api/labels`, `/api/usertags`, `/api/annot` |
| writing files | `/api/export`, `/api/export/stop`, `/api/record`, `/api/capture` (`/api/save` was listed here and has no caller in `app.js`) |
| video | `/api/video/stop` |
| the rest | `/api/markers`, `/api/automation`, `/api/automation/record`, `/api/scales`, `/api/presets` and its four, `/api/rack`, `/api/rack/param`, `/api/fx`, `/api/engine/shed`, `/api/engine/load/reset` |

Deleting a route means deleting what calls it, which is where most of the
15,143 lines go.

## Order of work

1. **`api()` against the engine**, answering the routes that travel and throwing
   a recognisable error for the rest. The app then runs, loudly, and every
   error is a thing to delete.
2. **Delete by following the errors.** The panel that asks for `/api/folders`
   goes; so does the rail item that opens it.
3. **The visuals**: twenty-five down to two, through `vis-registry.js`.
4. **The stretchers**: five down to one.

Step 1 first because it turns "what does this file still need" from a reading
exercise into a running program that says so.
