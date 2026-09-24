#!/usr/bin/env sh
# Regenerate the embedded font subsets from @fontsource (needs fonttools: pyftsubset).
# Basic Latin, Latin-1 punctuation, and the few symbols the panel draws.
set -eu
cd "$(dirname "$0")"
UNICODES='U+0020-007E,U+00A0-00BF,U+00D7,U+2013-2014,U+2018-201D,U+2022,U+2026,U+203A,U+2190-2193,U+2212,U+22EE'
src=$(node -p "require('path').dirname(require('path').dirname(require.resolve('@fontsource/inter/package.json')))")
for spec in inter/files/inter-latin-400-normal inter/files/inter-latin-500-normal \
  jetbrains-mono/files/jetbrains-mono-latin-400-normal jetbrains-mono/files/jetbrains-mono-latin-500-normal; do
  pyftsubset "$src/$spec.woff2" --unicodes="$UNICODES" --flavor=woff2 --layout-features='kern,liga,calt,tnum' \
    --no-hinting --desubroutinize --output-file="$(basename "$spec" | sed 's/-latin//; s/-normal//').woff2"
done
