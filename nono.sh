#!/usr/bin/env bash
# nono.sh — run `claude` inside the nono sandbox with the always-further/claude
# profile plus read+write access to the Rust toolchain dirs.
#
# The `claude` profile already bundles a `rust_runtime` group, but it only grants
# *read* access to ~/.cargo and ~/.rustup. cargo needs to write the registry
# cache, git checkouts, and the package-cache lock, so we add write allows for
# exactly those paths. The project working directory is already read+write under
# the profile, so `target/` builds work without extra grants.
#
# We deliberately do NOT grant write to all of ~/.cargo. nono unions grants
# (most-permissive wins), so a broad `--allow ~/.cargo` could not be narrowed
# back down with a `--read ~/.cargo/bin`. By granting only the specific subpaths
# cargo writes, ~/.cargo/bin (which holds the nono binary itself) and ~/.rustup
# stay read-only, so the sandboxed agent can't replace its own sandbox.
# Note: this intentionally blocks `cargo install` (it writes ~/.cargo/bin).
set -euo pipefail

exec nono run \
  --profile claude \
  --allow "$HOME/.cargo/registry" \
  --allow "$HOME/.cargo/git" \
  --allow-file "$HOME/.cargo/.package-cache" \
  -- claude --permission-mode auto "$@"
