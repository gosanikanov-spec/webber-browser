#!/usr/bin/env bash
# Installs a downloaded Webber AppImage for the current user and adds it to the app
# launcher (Omarchy's launcher reads the same .desktop files).
#
#   bash install-linux.sh [path/to/Webber-x.y.z-x86_64.AppImage] [--default]
#
# --default also makes Webber your default web browser.
set -euo pipefail

appimage="${1:-}"
if [[ -z "$appimage" || "$appimage" == --* ]]; then
  appimage=$(ls -t "$PWD"/Webber-*.AppImage "$HOME"/Downloads/Webber-*.AppImage 2>/dev/null | head -n1 || true)
fi
if [[ -z "$appimage" || ! -f "$appimage" ]]; then
  echo "Couldn't find a Webber AppImage. Pass its path: bash install-linux.sh ~/Downloads/Webber-0.1.0-x86_64.AppImage" >&2
  exit 1
fi

bin_dir="$HOME/.local/bin"
app_dir="$HOME/.local/share/applications"
icon_dir="$HOME/.local/share/icons/hicolor/512x512/apps"
mkdir -p "$bin_dir" "$app_dir" "$icon_dir"

install -m 755 "$appimage" "$bin_dir/webber"
echo "Installed $bin_dir/webber"

# Pull the icon out of the AppImage. (The top-level webber.png is only a symlink,
# so extract the real file.) A missing icon must never stop the install.
icon_path='usr/share/icons/hicolor/512x512/apps/webber.png'
tmp=$(mktemp -d)
( cd "$tmp" && "$bin_dir/webber" --appimage-extract "$icon_path" >/dev/null 2>&1 ) || true
if [[ -f "$tmp/squashfs-root/$icon_path" ]]; then
  cp "$tmp/squashfs-root/$icon_path" "$icon_dir/webber.png" || true
else
  echo "(Couldn't extract the icon; Webber will use a generic one.)"
fi
rm -rf "$tmp"

cat > "$app_dir/webber.desktop" <<DESKTOP
[Desktop Entry]
Name=Webber
GenericName=Web Browser
Comment=A clean browser that uses your Omarchy theme
Exec=$bin_dir/webber %U
Icon=webber
Terminal=false
Type=Application
Categories=Network;WebBrowser;
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;application/xhtml+xml;
StartupWMClass=Webber
Keywords=browser;web;internet;
DESKTOP
update-desktop-database "$app_dir" >/dev/null 2>&1 || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
# Omarchy's launcher (Walker) keeps a list of apps in memory; restart it so Webber shows up now.
if command -v omarchy-restart-walker >/dev/null 2>&1; then
  omarchy-restart-walker >/dev/null 2>&1 || true
fi
echo "Added Webber to your app launcher"

if [[ " $* " == *" --default "* ]]; then
  xdg-settings set default-web-browser webber.desktop
  echo "Webber is now your default browser"
fi

if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
  echo
  echo "Note: AppImages need FUSE 2. If Webber doesn't start, run:  sudo pacman -S fuse2"
fi
