'use strict';

// Reads the active Omarchy theme and watches for `omarchy-theme-set` swapping it.
//
// Omarchy keeps the active theme at ~/.config/omarchy/current/theme/. Its colors.toml
// is a flat list of `key = "#rrggbb"` lines (accent, foreground, background,
// selection_*, color0..color15). A `light.mode` file marks a light theme. Older themes
// only ship alacritty.toml, so that is read as a fallback.
//
// Without Omarchy, Webber falls back to its own palette and follows the OS light/dark.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { nativeTheme } = require('electron');

// WEBBER_OMARCHY_DIR overrides the Omarchy config root (default ~/.config/omarchy).
const OMARCHY_ROOT = process.env.WEBBER_OMARCHY_DIR || path.join(os.homedir(), '.config', 'omarchy');
const OMARCHY_CURRENT = path.join(OMARCHY_ROOT, 'current');
const THEME_DIR = path.join(OMARCHY_CURRENT, 'theme');

const DEFAULTS = {
  dark: { background: '#1b1b1f', foreground: '#e4e4e7', accent: '#8b9cf7' },
  light: { background: '#ecebe7', foreground: '#2a2a2e', accent: '#5465d6' },
};

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

const HEX = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i;
function hex(v) {
  const m = HEX.exec(String(v || '').trim().replace(/^0x/i, '#'));
  return m ? `#${m[1].toLowerCase()}` : null;
}

function parseColorsToml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*["']([^"']+)["']/.exec(line);
    if (m && hex(m[2])) out[m[1]] = hex(m[2]);
  }
  return out;
}

// Minimal alacritty.toml reader: [colors.primary] background/foreground, [colors.normal] blue.
function parseAlacritty(text) {
  let section = '';
  const out = {};
  for (const line of text.split('\n')) {
    const s = /^\s*\[([^\]]+)\]/.exec(line);
    if (s) { section = s[1].trim(); continue; }
    const kv = /^\s*([A-Za-z_]+)\s*=\s*["']([^"']+)["']/.exec(line);
    if (!kv || !hex(kv[2])) continue;
    if (section === 'colors.primary' && (kv[1] === 'background' || kv[1] === 'foreground')) out[kv[1]] = hex(kv[2]);
    if (section === 'colors.normal' && kv[1] === 'blue') out.accent = hex(kv[2]);
    if (section === 'colors.cursor' && kv[1] === 'cursor') out.cursor = hex(kv[2]);
  }
  return out;
}

function luminance(color) {
  const n = parseInt(color.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function loadOmarchy() {
  let colors = null;
  const toml = read(path.join(THEME_DIR, 'colors.toml'));
  if (toml) colors = parseColorsToml(toml);
  if (!colors || !colors.background) {
    const alacritty = read(path.join(THEME_DIR, 'alacritty.toml'));
    if (alacritty) colors = { ...parseAlacritty(alacritty), ...(colors || {}) };
  }
  if (!colors || !colors.background || !colors.foreground) return null;

  const name = (read(path.join(OMARCHY_CURRENT, 'theme.name')) || '').trim() || 'omarchy';
  const light = fs.existsSync(path.join(THEME_DIR, 'light.mode')) || luminance(colors.background) > 0.5;
  return {
    source: 'omarchy',
    name,
    mode: light ? 'light' : 'dark',
    background: colors.background,
    foreground: colors.foreground,
    accent: colors.accent || colors.color4 || colors.selection_background || colors.foreground,
  };
}

function current() {
  const omarchy = loadOmarchy();
  if (omarchy) return omarchy;
  const mode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return { source: 'default', name: 'default', mode, ...DEFAULTS[mode] };
}

// Calls `onChange(theme)` whenever the effective theme changes.
function watch(onChange) {
  let last = JSON.stringify(current());
  let timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const t = current();
      const key = JSON.stringify(t);
      if (key !== last) { last = key; onChange(t); }
    }, 250);
  };

  // omarchy-theme-set does `rm -rf current/theme && mv next-theme current/theme`,
  // so watch the parent folder; a slow poll of theme.name covers missed events
  // and Omarchy being installed while Webber is running.
  try { fs.watch(OMARCHY_CURRENT, check); } catch {}
  fs.watchFile(path.join(OMARCHY_CURRENT, 'theme.name'), { interval: 2000 }, check);
  fs.watchFile(path.join(THEME_DIR, 'colors.toml'), { interval: 2000 }, check);
  nativeTheme.on('updated', check);
}

module.exports = { current, watch, THEME_DIR };
