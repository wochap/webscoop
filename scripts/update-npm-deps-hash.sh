#!/usr/bin/env bash
# Recompute fetchNpmDeps hash in flake.nix after package-lock.json changes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
flake="$root/flake.nix"
fake="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
pattern='(hash = ")sha256-[A-Za-z0-9+/=]+(";)'

old="$(grep -oE "$pattern" "$flake" | head -n1 | sed -E 's/.*(sha256-[^"]+).*/\1/')"
if [[ -z "$old" ]]; then
  echo "error: no npmDeps hash found in $flake" >&2
  exit 1
fi

sed -E -i "0,/$pattern/s||\1$fake\2|" "$flake"

set +e
log="$(nix build "$root#default.npmDeps" --no-link 2>&1)"
status=$?
set -e

new="$(grep -oE 'got: +sha256-[A-Za-z0-9+/=]+' <<<"$log" | awk '{print $2}' | head -n1)"

if [[ -z "$new" ]]; then
  sed -E -i "0,/$pattern/s||\1$old\2|" "$flake"
  if [[ $status -eq 0 ]]; then
    echo "error: build succeeded with fake hash; nothing to do" >&2
  else
    echo "$log" >&2
    echo "error: could not extract new hash; restored $old" >&2
  fi
  exit 1
fi

sed -E -i "0,/$pattern/s||\1$new\2|" "$flake"

if [[ "$new" == "$old" ]]; then
  echo "npmDeps hash unchanged: $new"
else
  echo "npmDeps hash updated: $old -> $new"
fi
