#!/usr/bin/env bash
#
# Refresh engine/vendor/ from a checkout of the desktop tree — or just say
# whether it has drifted.
#
#   tools/sync-core.sh            copy the desktop's source in, rewrite SOURCE.md
#   tools/sync-core.sh --check    diff only; exit 1 if anything differs
#
# ── why this file exists ─────────────────────────────────────────────────────
#
# The engine crates used to be consumed by absolute path straight out of
# ~/Documents/__Audio-Edit---Tag, which meant this repository built on exactly
# one machine in the world. They are copied in now, so a bare `git clone` builds.
#
# The engine and the file formats are meant to stay level with the desktop —
# a preset written by one build opens in the other, and that is the contract.
# The *feature* set is free to differ and this build lags behind, which is
# normal. So this script is how the format half catches up: run it after
# changing anything in core/crates/{audio-core,fx,edit} or the four wire files.
# --check answers whether that is needed without moving anything.
#
# ── where the desktop tree is looked for ─────────────────────────────────────
#
#   $AUDIOLAB_CORE           if set — the path to .../__Audio-Edit---Tag/core
#   ../__Audio-Edit---Tag/core   otherwise, a sibling checkout
#
# Neither present is not an error worth failing a build over: it just means this
# machine has no desktop tree to compare against, which is the normal case for
# anybody who is not the author. The script says so and exits 0 in --check mode.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/engine/vendor"

CRATES=(audio-core fx edit)
WIRE=(json rack persist docs)
# The real-time engine: two files out of `engine`, not the crate.
#
# `render.rs` is the granular block renderer and `stretcher.rs` drives all five
# engines a block at a time. Between them they need `fx` and each other and
# nothing else — no cpal, no device, no transport. The rest of that crate does
# not travel and does not need to: taken this way they become modules of
# `audiolab-engine`, the same arrangement and the same reason as `wire/`.
RT=(render stretcher)

MODE="sync"
[[ "${1:-}" == "--check" ]] && MODE="check"

# ── locate the desktop tree ──────────────────────────────────────────────────
CORE="${AUDIOLAB_CORE:-$HERE/../__Audio-Edit---Tag/core}"
if [[ ! -d "$CORE/crates/fx" ]]; then
  echo "No desktop tree found."
  echo "  looked in: $CORE"
  echo "  set AUDIOLAB_CORE to the 'core' directory of a __Audio-Edit---Tag checkout."
  if [[ "$MODE" == "check" ]]; then
    echo "Nothing to compare against — not a failure. The vendored copy stands as it is."
    exit 0
  fi
  exit 1
fi
CORE="$(cd "$CORE" && pwd)"
REPO="$(cd "$CORE/.." && pwd)"

# ── check ────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "check" ]]; then
  drift=0
  for c in "${CRATES[@]}"; do
    if ! diff -r -q "$CORE/crates/$c" "$VENDOR/$c" >/dev/null 2>&1; then
      echo "DRIFT  $c"
      diff -r -q "$CORE/crates/$c" "$VENDOR/$c" 2>&1 | sed 's/^/       /'
      drift=1
    fi
  done
  for f in "${WIRE[@]}"; do
    if ! cmp -s "$CORE/crates/server/src/$f.rs" "$VENDOR/wire/$f.rs"; then
      echo "DRIFT  wire/$f.rs"
      drift=1
    fi
  done
  for f in "${RT[@]}"; do
    if ! cmp -s "$CORE/crates/engine/src/$f.rs" "$VENDOR/rt/$f.rs"; then
      echo "DRIFT  rt/$f.rs"
      drift=1
    fi
  done
  if [[ $drift -eq 0 ]]; then
    echo "engine/vendor/ matches $REPO — no drift."
    exit 0
  fi
  echo
  echo "Run tools/sync-core.sh to bring the copy up to date."
  exit 1
fi

# ── sync ─────────────────────────────────────────────────────────────────────
rm -rf "$VENDOR"
mkdir -p "$VENDOR/wire" "$VENDOR/rt"
for c in "${CRATES[@]}"; do cp -R "$CORE/crates/$c" "$VENDOR/$c"; done
for f in "${WIRE[@]}"; do cp "$CORE/crates/server/src/$f.rs" "$VENDOR/wire/$f.rs"; done
for f in "${RT[@]}"; do cp "$CORE/crates/engine/src/$f.rs" "$VENDOR/rt/$f.rs"; done

# Provenance. A vendored copy with no record of where it came from is the thing
# that turns into folklore in six months.
COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
SHORT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
WHEN="$(git -C "$REPO" log -1 --format=%cI HEAD 2>/dev/null || echo unknown)"
SUBJ="$(git -C "$REPO" log -1 --format=%s HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$REPO" status --porcelain \
           core/crates/audio-core core/crates/fx core/crates/edit \
           core/crates/server/src/{json,rack,persist,docs}.rs \
           core/crates/engine/src/{render,stretcher}.rs 2>/dev/null | wc -l | tr -d ' ')"

{
  echo "# Where this came from"
  echo
  echo "Everything under \`engine/vendor/\` was copied, byte for byte, out of the"
  echo "desktop build at the commit below. Do not edit it here — a sync overwrites"
  echo "without asking. Change it in the desktop tree and re-run \`tools/sync-core.sh\`."
  echo
  echo "These files are the contract between the two builds: a preset, a session or a"
  echo "rack spec written by either has to open in the other. The *feature* set is free"
  echo "to differ. This is not."
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| repository | https://github.com/rjvaleo/__Audio-Edit---Tag |"
  echo "| commit | \`$COMMIT\` |"
  echo "| | $SUBJ |"
  echo "| dated | $WHEN |"
  if [[ "$DIRTY" != "0" ]]; then
    echo "| **uncommitted** | **$DIRTY file(s) in the vendored paths were modified and unpushed when this was taken — this copy does not correspond to any public commit** |"
  fi
  echo
  echo "## What is here"
  echo
  echo "| path | from | files | lines |"
  echo "|---|---|---|---|"
  for c in "${CRATES[@]}"; do
    n=$(find "$VENDOR/$c" -name '*.rs' | wc -l | tr -d ' ')
    l=$(find "$VENDOR/$c" -name '*.rs' -exec cat {} + | wc -l | tr -d ' ')
    echo "| \`$c/\` | \`core/crates/$c/\` | $n | $l |"
  done
  for f in "${WIRE[@]}"; do
    l=$(wc -l < "$VENDOR/wire/$f.rs" | tr -d ' ')
    echo "| \`wire/$f.rs\` | \`core/crates/server/src/$f.rs\` | 1 | $l |"
  done
  for f in "${RT[@]}"; do
    l=$(wc -l < "$VENDOR/rt/$f.rs" | tr -d ' ')
    echo "| \`rt/$f.rs\` | \`core/crates/engine/src/$f.rs\` | 1 | $l |"
  done
  echo
  echo "The three crates are ordinary path dependencies. The four \`wire/\` files are"
  echo "\`#[path]\`-included as modules of \`audiolab-engine\` itself, because they live"
  echo "inside the \`server\` crate and depending on that crate costs 14.07 MB —"
  echo "\`server\` pulls \`yamnet\`, and \`yamnet\` pulls \`tract-onnx\`. See \`engine/src/lib.rs\`."
  echo
  echo "The two \`rt/\` files are included the same way, for a different reason: they"
  echo "are the real-time engine, and the crate they live in owns the sound card. They"
  echo "need \`fx\` and each other and nothing else, so they travel and the device"
  echo "does not. \`stretcher.rs\` runs all five engines a block at a time;"
  echo "\`render.rs\` is the granular one it calls."
  echo
  echo "## Checking"
  echo
  echo '```bash'
  echo "tools/sync-core.sh --check"
  echo '```'
  echo
  echo "Diffs every file above against a desktop checkout and fails if one has moved."
  echo "Finds the tree at \`\$AUDIOLAB_CORE\`, or at \`../__Audio-Edit---Tag/core\`. On a"
  echo "machine with no desktop tree it says so and passes — there is nothing to"
  echo "compare against, which is the normal case for anyone but the author."
  echo
  echo "*This file is generated by \`tools/sync-core.sh\`. Do not edit it by hand.*"
} > "$VENDOR/SOURCE.md"

echo "engine/vendor/ synced from $REPO @ $SHORT"
[[ "$DIRTY" != "0" ]] && echo "WARNING: $DIRTY modified file(s) in the source — this copy matches no public commit."
find "$VENDOR" -name '*.rs' | wc -l | xargs echo "  rust files:"
du -sh "$VENDOR" | awk '{print "  size:       " $1}'
