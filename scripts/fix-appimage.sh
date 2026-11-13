#!/usr/bin/env bash
set -euo pipefail

directory="${1:?Usage: fix-appimage.sh APPIMAGE_DIRECTORY}"
shopt -s nullglob
images=("$directory"/*.AppImage)
[[ ${#images[@]} == 1 ]] || { echo "Expected exactly one AppImage" >&2; exit 1; }
image="$(realpath "${images[0]}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$image" "$work/original.AppImage"
chmod +x "$work/original.AppImage"
pushd "$work" >/dev/null
./original.AppImage --appimage-extract >/dev/null
# Use the host Wayland libraries instead of Ubuntu 22.04's older bundled copies.
rm -f squashfs-root/usr/lib/libwayland-{client,egl,cursor,server}.so*
test -x squashfs-root/usr/bin/tarex-ui
curl --fail --show-error --location --retry 3 \
  https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage \
  -o appimagetool.AppImage
chmod +x appimagetool.AppImage
ARCH=x86_64 ./appimagetool.AppImage --appimage-extract-and-run squashfs-root fixed.AppImage
test -s fixed.AppImage
cp fixed.AppImage "$image"
popd >/dev/null
