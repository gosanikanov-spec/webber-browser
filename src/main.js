'use strict';

const {
  app, BaseWindow, WebContentsView, ipcMain, nativeTheme, session,
  Menu, clipboard, protocol, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const theme = require('./theme');
const { createConnector } = require('./connector');

const IS_MAC = process.platform === 'darwin';
// Tiling window managers (Omarchy runs Hyprland) don't want in-app window buttons.
const IS_TILING = !!process.env.HYPRLAND_INSTANCE_SIGNATURE
  || /hyprland|sway|i3|niri|river|bspwm/i.test(process.env.XDG_CURRENT_DESKTOP || '');

const SIDEBAR_WIDTH = 252;
const GAP = 8;          // frame around the page card
const RADIUS = 10;      // page card corner radius
const FIND_HEIGHT = 44;

const NEW_TAB_URL = 'webber://newtab';
const SEARCH_URL = 'https://duckduckgo.com/?q=';
const PAGES_DIR = path.join(__dirname, 'pages');
const userFile = (name) => path.join(app.getPath('userData'), name);

protocol.registerSchemesAsPrivileged([
  { scheme: 'webber', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------------------------------------------------------------- theme
let activeTheme = null;

function applyTheme(t) {
  activeTheme = t;
  // Let web pages' prefers-color-scheme follow the Omarchy theme too.
  nativeTheme.themeSource = t.source === 'omarchy' ? t.mode : 'system';
  for (const w of windows) {
    w.win.setBackgroundColor(frameColor(t));
    w.sendTheme();
    for (const tab of w.tabs) if (tab.isNewTab) tab.view.webContents.reload();
  }
}

// The frame is the Omarchy background; light themes get it nudged darker so the page card stands out.
function frameColor(t) {
  if (t.mode === 'dark') return t.background;
  const n = parseInt(t.background.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) * 0.94).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function themeStyle() {
  const t = activeTheme;
  return `<style>:root{--bg:${t.background};--fg:${t.foreground};--accent:${t.accent};color-scheme:${t.mode}}</style>`;
}

// ---------------------------------------------------------------- adblock
let blocker = null;
let blockingEnabled = true;

async function setupBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: userFile('adblock-engine.bin'),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    blocker.enableBlockingInSession(session.defaultSession);
    blocker.on('request-blocked', (req) => {
      for (const w of windows) {
        const tab = w.tabs.find((t) => t.view.webContents.id === req.tabId);
        if (tab) { tab.blocked += 1; w.scheduleSync(); }
      }
    });
  } catch (err) {
    console.warn('[webber] content blocking unavailable:', err.message);
    blocker = null;
  }
}

function setBlocking(on) {
  if (!blocker) return;
  blockingEnabled = on;
  if (on) blocker.enableBlockingInSession(session.defaultSession);
  else blocker.disableBlockingInSession(session.defaultSession);
  for (const w of windows) w.scheduleSync();
}

// ---------------------------------------------------------------- helpers
function looksLikeUrl(text) {
  return /^(https?|file|webber|about|chrome|data):/i.test(text)
    || /^localhost(:\d+)?(\/.*)?$/i.test(text)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text)
    || (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text));
}

function toUrl(input) {
  const text = input.trim();
  if (!text) return null;
  if (/^(https?|file|webber|about|chrome|data):/i.test(text)) return text;
  if (/^localhost|^\d{1,3}(\.\d{1,3}){3}/i.test(text) && looksLikeUrl(text)) return 'http://' + text;
  if (looksLikeUrl(text)) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

function displayHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || url; } catch { return url; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function debounce(fn, ms) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

// ---------------------------------------------------------------- history
let history = [];   // [{ url, title, visits, last }]

function recordVisit(url, title) {
  if (!/^https?:/.test(url)) return;
  let entry = history.find((h) => h.url === url);
  if (!entry) { entry = { url, title: '', visits: 0, last: 0 }; history.push(entry); }
  entry.visits += 1;
  entry.last = Date.now();
  if (title) entry.title = title;
  if (history.length > 3000) {
    history.sort((a, b) => b.last - a.last);
    history.length = 2500;
  }
  saveHistory();
}

function updateHistoryTitle(url, title) {
  const entry = history.find((h) => h.url === url);
  if (entry && title) { entry.title = title; saveHistory(); }
}

const saveHistory = debounce(() => {
  try { fs.writeFileSync(userFile('history.json'), JSON.stringify(history)); } catch {}
}, 1000);

function suggest(w, query) {
  const q = query.trim().toLowerCase();
  const items = [];
  const tabMatch = (t) => !t.isNewTab && (t.title.toLowerCase().includes(q) || t.view.webContents.getURL().toLowerCase().includes(q));

  if (!q) {
    for (const t of w.tabs.filter((t) => !t.isNewTab && t.id !== w.activeId).slice(-6).reverse()) {
      items.push({ type: 'tab', tabId: t.id, title: t.title || displayHost(t.view.webContents.getURL()), url: t.view.webContents.getURL(), favicon: t.favicon });
    }
    return items;
  }

  const primary = looksLikeUrl(query.trim())
    ? { type: 'url', title: query.trim(), url: toUrl(query) }
    : { type: 'search', title: query.trim(), url: toUrl(query) };
  items.push(primary);

  for (const t of w.tabs.filter((t) => t.id !== w.activeId && tabMatch(t)).slice(0, 3)) {
    items.push({ type: 'tab', tabId: t.id, title: t.title, url: t.view.webContents.getURL(), favicon: t.favicon });
  }

  const now = Date.now();
  const scored = [];
  for (const h of history) {
    const url = h.url.toLowerCase();
    const bare = url.replace(/^https?:\/\/(www\.)?/, '');
    const title = (h.title || '').toLowerCase();
    let score = 0;
    if (bare.startsWith(q)) score += 10;
    else if (url.includes(q)) score += 4;
    if (title.includes(q)) score += 3;
    if (!score) continue;
    const ageDays = (now - h.last) / 864e5;
    score += Math.log2(h.visits + 1) * 2 - Math.min(ageDays / 7, 4);
    scored.push([score, h]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const seen = new Set(items.map((i) => i.url));
  for (const [, h] of scored) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    items.push({ type: 'history', title: h.title || displayHost(h.url), url: h.url });
    if (items.length >= 8) break;
  }
  return items;
}

// ---------------------------------------------------------------- session
function saveSession() {
  const w = windows[0];
  if (!w) return;
  const tabs = w.tabs
    .map((t) => ({ url: t.view.webContents.getURL() || t.pendingUrl, pinned: t.pinned }))
    .filter((t) => t.url);
  const active = w.tabs.findIndex((t) => t.id === w.activeId);
  try {
    fs.writeFileSync(userFile('session.json'), JSON.stringify({ tabs, active, compact: w.compact }));
  } catch {}
}
const scheduleSaveSession = debounce(saveSession, 400);

// ---------------------------------------------------------------- Claude connector
const CONNECTOR_PORT = Number(process.env.WEBBER_MCP_PORT) || 47823;
const AGENT_GLOW_MS = 4000;
let connectorConfig = null;
let connectorError = null;
let lastAgentActivity = 0;

function loadConnectorConfig() {
  const saved = readJson(userFile('connector.json'), {});
  connectorConfig = {
    enabled: !!saved.enabled,
    token: typeof saved.token === 'string' && saved.token.length >= 32 ? saved.token : crypto.randomBytes(24).toString('hex'),
    port: CONNECTOR_PORT,
  };
  saveConnectorConfig();
}

function saveConnectorConfig() {
  try {
    fs.writeFileSync(userFile('connector.json'), JSON.stringify(connectorConfig, null, 2), { mode: 0o600 });
  } catch {}
}

function allTabs() { return windows.flatMap((w) => w.tabs.map((t) => ({ w, t }))); }
function shellOfTab(tab) { return windows.find((w) => w.tabs.includes(tab)); }
function frontShell() { return windows.find((w) => w.win.isFocused()) || windows[0]; }

// What the connector is allowed to do with the browser.
const browserApi = {
  listTabs: () => allTabs().map(({ w, t }) => ({
    id: t.id,
    title: t.isNewTab ? 'New Tab' : (t.title || displayHost(t.view.webContents.getURL())),
    url: t.isNewTab ? '' : t.view.webContents.getURL(),
    active: w.activeId === t.id,
    pinned: t.pinned,
  })),
  getTab: (id) => {
    if (id == null) { const w = frontShell(); return w && w.activeTab(); }
    const hit = allTabs().find(({ t }) => t.id === id);
    return hit && hit.t;
  },
  openTab: (url, background) => {
    const w = frontShell() || new BrowserShell({ tabs: [] });
    const tab = w.newTab(toUrl(url) || NEW_TAB_URL, { background, afterActive: true });
    if (!background) w.closeOverlay();
    return tab;
  },
  activate: (id) => {
    const hit = allTabs().find(({ t }) => t.id === id);
    if (hit && hit.w.activeId !== id) { hit.w.closeOverlay(); hit.w.activate(id); }
  },
  closeTab: (id) => {
    const hit = allTabs().find(({ t }) => t.id === id);
    if (hit) hit.w.closeTab(id);
  },
  markAgent: (tab) => {
    tab.agentAt = Date.now();
    lastAgentActivity = tab.agentAt;
    const w = shellOfTab(tab);
    if (w) {
      w.scheduleSync();
      clearTimeout(tab.agentTimer);
      tab.agentTimer = setTimeout(() => w.scheduleSync(), AGENT_GLOW_MS + 50);
    }
  },
  onActivity: () => {
    lastAgentActivity = Date.now();
    for (const w of windows) w.scheduleSync();
    clearTimeout(browserApi.idleTimer);
    browserApi.idleTimer = setTimeout(() => windows.forEach((w) => w.scheduleSync()), AGENT_GLOW_MS + 50);
  },
  toUrl,
  searchHistory: (query, limit) => {
    const q = query.toLowerCase();
    return history
      .filter((h) => h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q))
      .sort((a, b) => b.last - a.last)
      .slice(0, limit);
  },
};

const connector = createConnector(browserApi);

async function applyConnector() {
  connectorError = null;
  if (connectorConfig.enabled) {
    try { await connector.start(connectorConfig); connector.update(connectorConfig); }
    catch (err) {
      connectorError = err.code === 'EADDRINUSE' ? `Port ${connectorConfig.port} is already in use.` : err.message;
      console.warn('[webber] connector failed to start:', connectorError);
    }
  } else {
    connector.stop();
  }
  for (const w of windows) w.scheduleSync();
}

// The packaged app's folder can move (an AppImage mounts somewhere new on every
// launch), so keep a copy of the Claude Desktop bridge at a stable path.
function bridgePath() {
  const stable = userFile('webber-mcp.js');
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'bin', 'webber-mcp.js'), stable);
    fs.chmodSync(stable, 0o755);
    return stable;
  } catch {
    return path.join(__dirname, '..', 'bin', 'webber-mcp.js');
  }
}

function claudeCodeCommand() {
  return `claude mcp add --transport http webber http://127.0.0.1:${connectorConfig.port}/mcp --header "Authorization: Bearer ${connectorConfig.token}"`;
}

function claudeDesktopConfig() {
  return JSON.stringify({ mcpServers: { webber: { command: 'node', args: [bridgePath()] } } }, null, 2);
}

function connectorMenu(w) {
  const on = connectorConfig.enabled;
  const status = connectorError
    ? `Couldn’t start: ${connectorError}`
    : on ? `On — listening on 127.0.0.1:${connectorConfig.port}` : 'Off';
  Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: 'Let Claude Use Webber', type: 'checkbox', checked: on,
      click: () => { connectorConfig.enabled = !on; saveConnectorConfig(); applyConnector(); },
    },
    { type: 'separator' },
    { label: 'Copy Setup Command for Claude Code', click: () => clipboard.writeText(claudeCodeCommand()) },
    { label: 'Copy Config for Claude Desktop', click: () => clipboard.writeText(claudeDesktopConfig()) },
    { type: 'separator' },
    {
      label: 'Reset Access Key',
      click: () => {
        connectorConfig.token = crypto.randomBytes(24).toString('hex');
        saveConnectorConfig();
        connector.update(connectorConfig);
      },
    },
  ]).popup({ window: w.win });
}

// ---------------------------------------------------------------- window
const windows = [];
let nextTabId = 1;

class BrowserShell {
  constructor({ tabs = [{ url: NEW_TAB_URL }], active = 0, compact = false } = {}) {
    this.tabs = [];
    this.activeId = null;
    this.closed = [];
    this.findOpen = false;
    this.compact = compact;
    this.overlay = null;          // null | 'omnibox' | 'peek'
    this.htmlFullscreen = false;
    this.syncPending = false;

    this.win = new BaseWindow({
      width: 1360,
      height: 860,
      minWidth: 560,
      minHeight: 360,
      show: false,
      icon: path.join(__dirname, 'icon.png'),
      backgroundColor: frameColor(activeTheme),
      ...(IS_MAC
        ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 18 } }
        : { frame: false }),
    });

    // The UI layer fills the whole window: the sidebar, the frame around the page,
    // and (when raised above the page) the floating address bar.
    this.ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'), {
      query: {
        platform: process.platform,
        controls: IS_MAC || IS_TILING ? '0' : '1',
      },
    });
    this.ui.webContents.on('before-input-event', (e, input) => this.handleKey(e, input));
    this.ui.webContents.once('did-finish-load', () => {
      this.sendTheme();
      this.sync();
      this.win.show();
      const t = this.activeTab();
      if (t && t.isNewTab) this.openOmnibox(false);
    });

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => this.ui.webContents.send('window-focus', true));
    this.win.on('blur', () => this.ui.webContents.send('window-focus', false));
    this.win.on('enter-full-screen', () => this.scheduleSync());
    this.win.on('leave-full-screen', () => this.scheduleSync());
    this.win.on('closed', () => windows.splice(windows.indexOf(this), 1));

    const list = tabs.length ? tabs : [{ url: NEW_TAB_URL }];
    list.forEach((t) => this.newTab(t.url, { background: true, pinned: !!t.pinned }));
    this.activate(this.tabs[Math.min(Math.max(active, 0), this.tabs.length - 1)].id);
    if (IS_MAC && compact) this.win.setWindowButtonVisibility(false);
    this.layout();
    windows.push(this);
  }

  sendTheme() {
    if (this.ui.webContents.isDestroyed()) return;
    this.ui.webContents.send('theme', { ...activeTheme, frame: frameColor(activeTheme) });
  }

  // ----- tabs
  newTab(url = NEW_TAB_URL, { background = false, afterActive = false, pinned = false } = {}) {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    view.setBorderRadius(RADIUS);
    const tab = {
      id: nextTabId++, view, title: '', favicon: null, loading: false, audible: false,
      blocked: 0, pinned, pendingUrl: url,
      get isNewTab() { return (view.webContents.getURL() || this.pendingUrl).startsWith(NEW_TAB_URL); },
    };
    this.wire(tab);

    let idx = this.tabs.length;
    if (pinned) idx = this.tabs.filter((t) => t.pinned).length;
    else if (afterActive) {
      const a = this.tabs.findIndex((t) => t.id === this.activeId);
      if (a >= 0) idx = Math.max(a + 1, this.tabs.filter((t) => t.pinned).length);
    }
    this.tabs.splice(idx, 0, tab);
    view.webContents.loadURL(url).catch(() => {});
    if (!background) this.activate(tab.id);
    this.scheduleSync();
    return tab;
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const update = () => this.scheduleSync();
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      updateHistoryTitle(wc.getURL(), title);
      update();
    });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; update(); });
    wc.on('did-start-loading', () => { tab.loading = true; update(); });
    wc.on('did-stop-loading', () => { tab.loading = false; update(); scheduleSaveSession(); });
    wc.on('did-start-navigation', (_e, _url, inPage, isMain) => {
      if (isMain && !inPage) { tab.blocked = 0; tab.favicon = null; }
      update();
    });
    wc.on('did-navigate', (_e, url, code) => {
      if (code < 400) recordVisit(url, '');
      update();
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) recordVisit(url, wc.getTitle()); update(); });
    wc.on('audio-state-changed', (e) => { tab.audible = e.audible; update(); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      // -3 is ERR_ABORTED (user stopped / navigated away): not worth a page.
      if (!isMain || code === -3) return;
      wc.once('did-stop-loading', () => {
        if (wc.isDestroyed() || wc.getURL() !== url) return;
        wc.executeJavaScript(errorPageScript(url, desc)).catch(() => {});
      });
    });
    wc.on('found-in-page', (_e, r) => {
      if (tab.id === this.activeId) this.ui.webContents.send('find-result', r);
    });
    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; this.layout(); });
    wc.on('leave-html-full-screen', () => { this.htmlFullscreen = false; this.layout(); });
    wc.on('before-input-event', (e, input) => this.handleKey(e, input));
    wc.on('context-menu', (_e, params) => this.contextMenu(tab, params));
    wc.setWindowOpenHandler(({ url, disposition }) => {
      this.newTab(url, { background: disposition === 'background-tab', afterActive: true });
      return { action: 'deny' };
    });
  }

  activeTab() { return this.tabs.find((t) => t.id === this.activeId); }

  activate(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const prev = this.activeTab();
    if (prev && prev !== tab) this.win.contentView.removeChildView(prev.view);
    this.activeId = id;
    this.win.contentView.addChildView(tab.view);
    if (this.overlay) this.win.contentView.addChildView(this.ui); // keep the overlay on top
    this.layout();
    if (this.findOpen) this.closeFind();
    if (!this.overlay) {
      if (tab.isNewTab) this.openOmnibox(false);
      else tab.view.webContents.focus();
    }
    this.scheduleSync();
    scheduleSaveSession();
  }

  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    const url = tab.view.webContents.getURL();
    if (url && !tab.isNewTab) this.closed.push(url);
    if (this.tabs.length === 0) {
      saveSessionEmpty();
      this.win.close();
      tab.view.webContents.close();
      return;
    }
    if (id === this.activeId) {
      this.win.contentView.removeChildView(tab.view);
      this.activeId = null;
      this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    }
    tab.view.webContents.close();
    this.scheduleSync();
    scheduleSaveSession();
  }

  reopenClosed() {
    const url = this.closed.pop();
    if (url) this.newTab(url, { afterActive: true });
  }

  setPinned(id, pinned) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.pinned === pinned) return;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    tab.pinned = pinned;
    this.tabs.splice(this.tabs.filter((t) => t.pinned).length, 0, tab);
    this.scheduleSync();
    scheduleSaveSession();
  }

  moveTab(id, toIndex, pinned) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    if (typeof pinned === 'boolean') tab.pinned = pinned;
    const pinnedCount = this.tabs.filter((t) => t.pinned).length;
    const lo = tab.pinned ? 0 : pinnedCount;
    const hi = tab.pinned ? pinnedCount : this.tabs.length;
    this.tabs.splice(Math.max(lo, Math.min(toIndex, hi)), 0, tab);
    this.scheduleSync();
    scheduleSaveSession();
  }

  cycle(dir) {
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  // ----- layout
  layout() {
    const { width, height } = this.win.getContentBounds();
    this.ui.setBounds({ x: 0, y: 0, width, height });
    const tab = this.activeTab();
    if (!tab) return;
    if (this.htmlFullscreen) {
      tab.view.setBorderRadius(0);
      tab.view.setBounds({ x: 0, y: 0, width, height });
      return;
    }
    tab.view.setBorderRadius(RADIUS);
    const left = this.compact ? GAP : SIDEBAR_WIDTH;
    const bottom = GAP + (this.findOpen ? FIND_HEIGHT : 0);
    tab.view.setBounds({
      x: left, y: GAP,
      width: Math.max(0, width - left - GAP),
      height: Math.max(0, height - GAP - bottom),
    });
  }

  toggleCompact() {
    this.compact = !this.compact;
    if (IS_MAC) this.win.setWindowButtonVisibility(!this.compact);
    if (this.overlay === 'peek') this.closeOverlay();
    this.layout();
    this.scheduleSync();
    scheduleSaveSession();
  }

  // ----- overlays: the UI layer is raised above the page
  setOverlay(kind) {
    this.overlay = kind;
    if (kind) {
      this.win.contentView.addChildView(this.ui);
      this.ui.webContents.focus();
      if (IS_MAC && kind === 'peek') this.win.setWindowButtonVisibility(true);
    } else {
      const t = this.activeTab();
      if (t) this.win.contentView.addChildView(t.view);
      if (IS_MAC && this.compact) this.win.setWindowButtonVisibility(false);
    }
    this.scheduleSync();
  }

  openOmnibox(newTab) {
    const t = this.activeTab();
    this.setOverlay('omnibox');
    this.ui.webContents.send('omnibox-open', {
      newTab,
      url: !newTab && t && !t.isNewTab ? t.view.webContents.getURL() : '',
    });
  }

  closeOverlay() {
    if (!this.overlay) return;
    this.setOverlay(null);
    const t = this.activeTab();
    if (t && !t.isNewTab) t.view.webContents.focus();
  }

  // ----- state to UI
  scheduleSync() {
    if (this.syncPending) return;
    this.syncPending = true;
    setImmediate(() => { this.syncPending = false; this.sync(); });
  }

  sync() {
    if (this.ui.webContents.isDestroyed()) return;
    const tabs = this.tabs.map((t) => {
      const wc = t.view.webContents;
      const url = wc.getURL() || t.pendingUrl;
      return {
        id: t.id,
        title: t.isNewTab ? 'New Tab' : (t.title || displayHost(url)),
        url: t.isNewTab ? '' : url,
        favicon: t.favicon,
        loading: t.loading,
        audible: t.audible,
        muted: wc.isAudioMuted(),
        pinned: t.pinned,
        canBack: wc.navigationHistory.canGoBack(),
        canForward: wc.navigationHistory.canGoForward(),
        zoom: wc.getZoomFactor(),
        blocked: t.blocked,
        agent: !!t.agentAt && Date.now() - t.agentAt < AGENT_GLOW_MS,
      };
    });
    this.ui.webContents.send('state', {
      tabs,
      activeId: this.activeId,
      blocking: blocker ? blockingEnabled : null,
      connector: {
        enabled: connectorConfig.enabled,
        running: connector.running,
        error: connectorError,
        active: Date.now() - lastAgentActivity < AGENT_GLOW_MS,
      },
      layout: {
        compact: this.compact,
        overlay: this.overlay,
        findOpen: this.findOpen,
        htmlFullscreen: this.htmlFullscreen,
        fullscreen: this.win.isFullScreen(),
        sidebarWidth: SIDEBAR_WIDTH,
        gap: GAP,
        radius: RADIUS,
        findHeight: FIND_HEIGHT,
      },
    });
    const active = this.activeTab();
    if (active) this.win.setTitle(active.isNewTab ? 'Webber' : (active.title || 'Webber'));
  }

  // ----- find
  openFind() {
    this.findOpen = true;
    this.layout();
    this.ui.webContents.focus();
    this.ui.webContents.send('find-open');
    this.scheduleSync();
  }

  closeFind() {
    if (!this.findOpen) return;
    this.findOpen = false;
    const t = this.activeTab();
    if (t) t.view.webContents.stopFindInPage('clearSelection');
    this.layout();
    this.ui.webContents.send('find-close');
    this.scheduleSync();
  }

  // ----- zoom
  zoom(delta) {
    const t = this.activeTab();
    if (!t) return;
    const wc = t.view.webContents;
    wc.setZoomLevel(delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta)));
    this.scheduleSync();
  }

  // ----- keyboard
  handleKey(event, input) {
    if (input.type !== 'keyDown') return;
    const mod = IS_MAC ? input.meta : input.control;
    const key = input.key.toLowerCase();
    const run = (fn) => { event.preventDefault(); fn(); };
    const t = this.activeTab();

    if (mod && !input.shift && key === 't') return run(() => this.openOmnibox(true));
    if (mod && input.shift && key === 't') return run(() => this.reopenClosed());
    if (mod && key === 'n') return run(() => new BrowserShell());
    if (mod && key === 'w') return run(() => this.closeTab(this.activeId));
    if ((mod && key === 'l') || (input.alt && key === 'd' && !IS_MAC) || key === 'f6') return run(() => this.openOmnibox(false));
    if (mod && key === 'b') return run(() => this.toggleCompact());
    if ((mod && key === 'r') || key === 'f5') return run(() => t && (input.shift ? t.view.webContents.reloadIgnoringCache() : t.view.webContents.reload()));
    if (mod && key === 'f') return run(() => this.openFind());
    if (key === 'escape' && this.findOpen && !this.overlay) return run(() => this.closeFind());
    if (input.control && key === 'tab') return run(() => this.cycle(input.shift ? -1 : 1));
    if (mod && input.alt && (key === 'arrowdown' || key === 'arrowup')) return run(() => this.cycle(key === 'arrowdown' ? 1 : -1));
    if (mod && /^[1-9]$/.test(key)) {
      return run(() => {
        const n = Number(key);
        const target = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
        if (target) this.activate(target.id);
      });
    }
    if ((input.alt && !IS_MAC && key === 'arrowleft') || (mod && key === '[')) return run(() => t && t.view.webContents.navigationHistory.goBack());
    if ((input.alt && !IS_MAC && key === 'arrowright') || (mod && key === ']')) return run(() => t && t.view.webContents.navigationHistory.goForward());
    if (mod && (key === '=' || key === '+')) return run(() => this.zoom(0.5));
    if (mod && key === '-') return run(() => this.zoom(-0.5));
    if (mod && key === '0') return run(() => this.zoom(0));
    if (key === 'f11' || (IS_MAC && input.meta && input.control && key === 'f')) return run(() => this.win.setFullScreen(!this.win.isFullScreen()));
    if (key === 'f12' || (mod && input.shift && key === 'i')) return run(() => t && t.view.webContents.toggleDevTools());
    if (mod && key === 'q' && IS_MAC) return run(() => app.quit());
  }

  // ----- context menus
  contextMenu(tab, p) {
    const wc = tab.view.webContents;
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.newTab(p.linkURL, { background: true, afterActive: true }) },
        { label: 'Open Link in New Window', click: () => new BrowserShell({ tabs: [{ url: p.linkURL }] }) },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.hasImageContents && p.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.newTab(p.srcURL, { afterActive: true }) },
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    } else if (p.selectionText) {
      const q = p.selectionText.trim().slice(0, 80);
      items.push({ role: 'copy' },
        { label: `Search for “${q.length > 30 ? q.slice(0, 30) + '…' : q}”`, click: () => this.newTab(SEARCH_URL + encodeURIComponent(q), { afterActive: true }) },
        { type: 'separator' });
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText && !p.hasImageContents) {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
      );
    }
    items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  tabMenu(id) {
    const tab = this.tabs.find((x) => x.id === id);
    if (!tab) return;
    const wc = tab.view.webContents;
    Menu.buildFromTemplate([
      { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => this.setPinned(tab.id, !tab.pinned) },
      { label: 'Duplicate Tab', click: () => this.newTab(wc.getURL(), { afterActive: true }) },
      { label: 'Copy Link', enabled: !tab.isNewTab, click: () => clipboard.writeText(wc.getURL()) },
      { label: wc.isAudioMuted() ? 'Unmute Tab' : 'Mute Tab', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); this.scheduleSync(); } },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Close Tab', click: () => this.closeTab(tab.id) },
      { label: 'Close Other Tabs', enabled: this.tabs.length > 1, click: () => this.tabs.filter((x) => x.id !== tab.id && !x.pinned).forEach((x) => this.closeTab(x.id)) },
      { label: 'Reopen Closed Tab', enabled: this.closed.length > 0, click: () => this.reopenClosed() },
    ]).popup({ window: this.win });
  }
}

function saveSessionEmpty() {
  try { fs.writeFileSync(userFile('session.json'), JSON.stringify({ tabs: [], active: 0, compact: windows[0]?.compact })); } catch {}
}

// ---------------------------------------------------------------- error page
let ERROR_TEMPLATE = '';
const ERROR_MESSAGES = {
  ERR_NAME_NOT_RESOLVED: 'The address couldn’t be found.',
  ERR_INTERNET_DISCONNECTED: 'You appear to be offline.',
  ERR_CONNECTION_REFUSED: 'The site refused to connect.',
  ERR_CONNECTION_TIMED_OUT: 'The site took too long to respond.',
  ERR_CERT_AUTHORITY_INVALID: 'This site’s security certificate isn’t trusted.',
};

function errorPageScript(url, desc) {
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = ERROR_TEMPLATE
    .replace('<!--theme-->', themeStyle())
    .replaceAll('{{host}}', esc(displayHost(url)))
    .replaceAll('{{message}}', esc(ERROR_MESSAGES[desc] || 'This page couldn’t be loaded.'))
    .replaceAll('{{code}}', esc(desc));
  return `document.open();document.write(${JSON.stringify(html)});document.close();`;
}

// ---------------------------------------------------------------- IPC
function shellFor(event) {
  return windows.find((w) => w.ui.webContents === event.sender);
}

ipcMain.handle('suggest', (event, query) => {
  const w = shellFor(event);
  return w ? suggest(w, String(query || '')) : [];
});

ipcMain.on('cmd', (event, cmd, arg) => {
  const w = shellFor(event);
  if (!w) return;
  const t = w.activeTab();
  const wc = t && t.view.webContents;
  switch (cmd) {
    case 'new-tab': w.openOmnibox(true); break;
    case 'close-tab': w.closeTab(arg); break;
    case 'activate': w.activate(arg); break;
    case 'move-tab': w.moveTab(arg.id, arg.index, arg.pinned); break;
    case 'navigate': {
      const url = toUrl(arg.text);
      w.closeOverlay();
      if (!url) break;
      if (arg.newTab || !t) w.newTab(url);
      else { wc.loadURL(url).catch(() => {}); wc.focus(); }
      break;
    }
    case 'switch-tab': w.closeOverlay(); w.activate(arg); break;
    case 'omnibox': w.openOmnibox(!!arg); break;
    case 'peek': if (w.compact && !w.overlay) w.setOverlay('peek'); break;
    case 'overlay-close': w.closeOverlay(); break;
    case 'toggle-compact': w.toggleCompact(); break;
    case 'back': wc && wc.navigationHistory.goBack(); break;
    case 'forward': wc && wc.navigationHistory.goForward(); break;
    case 'reload': wc && wc.reload(); break;
    case 'stop': wc && wc.stop(); break;
    case 'zoom-reset': w.zoom(0); break;
    case 'toggle-mute': {
      const tab = w.tabs.find((x) => x.id === arg);
      if (tab) { tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted()); w.scheduleSync(); }
      break;
    }
    case 'toggle-blocking': setBlocking(!blockingEnabled); break;
    case 'find':
      if (wc && arg.text) wc.findInPage(arg.text, { forward: arg.forward !== false, findNext: !!arg.next });
      else if (wc) wc.stopFindInPage('clearSelection');
      break;
    case 'find-close': w.closeFind(); if (wc) wc.focus(); break;
    case 'tab-menu': w.tabMenu(arg); break;
    case 'connector-menu': connectorMenu(w); break;
    case 'win-min': w.win.minimize(); break;
    case 'win-max': w.win.isMaximized() ? w.win.unmaximize() : w.win.maximize(); break;
    case 'win-close': w.win.close(); break;
  }
});

// ---------------------------------------------------------------- app
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const w = windows[0];
    const url = argv.slice(1).find((a) => /^https?:/.test(a));
    if (w) {
      if (url) w.newTab(url);
      if (w.win.isMinimized()) w.win.restore();
      w.win.focus();
    }
  });

  app.whenReady().then(async () => {
    activeTheme = theme.current();
    nativeTheme.themeSource = activeTheme.source === 'omarchy' ? activeTheme.mode : 'system';
    theme.watch(applyTheme);

    ERROR_TEMPLATE = fs.readFileSync(path.join(PAGES_DIR, 'error.html'), 'utf8');
    history = readJson(userFile('history.json'), []);
    loadConnectorConfig();

    protocol.handle('webber', (req) => {
      const { host } = new URL(req.url);
      const file = path.join(PAGES_DIR, `${host.replace(/[^a-z0-9-]/gi, '')}.html`);
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch { return new Response('Not found', { status: 404 }); }
      return new Response(html.replace('<!--theme-->', themeStyle()), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    if (IS_MAC) {
      // Standard edit menu so ⌘C/⌘V work; browser shortcuts are handled per-view.
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }

    await setupBlocker();
    await applyConnector();

    const argUrl = process.argv.slice(1).find((a) => /^https?:/.test(a));
    const saved = readJson(userFile('session.json'), null);
    let tabs = saved && Array.isArray(saved.tabs) ? saved.tabs : [];
    tabs = tabs.map((t) => (typeof t === 'string' ? { url: t } : t)).filter((t) => t && t.url);
    if (argUrl) tabs.push({ url: argUrl });
    if (!tabs.length) tabs = [{ url: NEW_TAB_URL }];
    new BrowserShell({
      tabs,
      active: argUrl ? tabs.length - 1 : (saved ? saved.active : 0),
      compact: !!(saved && saved.compact),
    });

    app.on('activate', () => { if (windows.length === 0) new BrowserShell(); });
  });

  app.on('web-contents-created', (_e, wc) => {
    // External protocols (mailto:, etc.) go to the OS.
    wc.on('will-navigate', (e, url) => {
      if (!/^(https?|file|webber|about|data|blob|chrome|devtools):/i.test(url)) {
        e.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });
  });

  app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
}
