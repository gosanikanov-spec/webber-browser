'use strict';

const {
  app, BaseWindow, WebContentsView, ipcMain, nativeTheme, session,
  Menu, clipboard, protocol, net, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const IS_MAC = process.platform === 'darwin';
const CHROME_HEIGHT = 84; // tab strip (40) + toolbar (44)
const NEW_TAB_URL = 'webber://newtab';
const SEARCH_URL = 'https://duckduckgo.com/?q=';
const PAGES_DIR = path.join(__dirname, 'pages');
const STATE_FILE = () => path.join(app.getPath('userData'), 'session.json');

protocol.registerSchemesAsPrivileged([
  { scheme: 'webber', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------------------------------------------------------------- adblock
let blocker = null;
let blockingEnabled = true;

async function setupBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
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
function toUrl(input) {
  const text = input.trim();
  if (!text) return null;
  if (/^(https?|file|webber|about|chrome|data):/i.test(text)) return text;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text)) {
    return 'http://' + text;
  }
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

const ERROR_TEMPLATE = fs.readFileSync(path.join(PAGES_DIR, 'error.html'), 'utf8');
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
    .replaceAll('{{host}}', esc(displayHost(url)))
    .replaceAll('{{message}}', esc(ERROR_MESSAGES[desc] || 'This page couldn’t be loaded.'))
    .replaceAll('{{code}}', esc(desc));
  return `document.open();document.write(${JSON.stringify(html)});document.close();`;
}

function displayHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || url; } catch { return url; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return null; }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const w = windows[0];
    if (!w) return;
    const tabs = w.tabs.map((t) => t.view.webContents.getURL() || t.pendingUrl).filter(Boolean);
    const active = w.tabs.findIndex((t) => t.id === w.activeId);
    try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ tabs, active })); } catch {}
  }, 400);
}

// ---------------------------------------------------------------- window
const windows = [];
let nextTabId = 1;

class BrowserShell {
  constructor({ urls = [NEW_TAB_URL], active = 0 } = {}) {
    this.tabs = [];
    this.activeId = null;
    this.closed = [];
    this.findOpen = false;
    this.syncPending = false;

    this.win = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 480,
      minHeight: 320,
      show: false,
      backgroundColor: themeColors().bg,
      titleBarStyle: 'hidden',
      ...(IS_MAC
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarOverlay: overlayFor(themeColors()) }),
    });

    this.ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.ui.setBackgroundColor(themeColors().bg);
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'), {
      query: { platform: process.platform },
    });
    this.ui.webContents.on('before-input-event', (e, input) => this.handleKey(e, input));
    this.ui.webContents.once('did-finish-load', () => {
      this.sync();
      this.win.show();
      const t = this.activeTab();
      if (t && t.isNewTab) this.focusAddress();
    });

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => this.ui.webContents.send('window-focus', true));
    this.win.on('blur', () => this.ui.webContents.send('window-focus', false));
    this.win.on('closed', () => {
      windows.splice(windows.indexOf(this), 1);
    });

    (urls.length ? urls : [NEW_TAB_URL]).forEach((u) => this.newTab(u, { background: true }));
    this.activate(this.tabs[Math.min(Math.max(active, 0), this.tabs.length - 1)].id);
    this.layout();
    windows.push(this);
  }

  // ----- tabs
  newTab(url = NEW_TAB_URL, { background = false, afterActive = false } = {}) {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    view.setBackgroundColor('#ffffff');
    const tab = {
      id: nextTabId++, view, title: '', favicon: null, loading: false,
      blocked: 0, pendingUrl: url, get isNewTab() {
        return (view.webContents.getURL() || this.pendingUrl).startsWith(NEW_TAB_URL);
      },
    };
    this.wire(tab);

    const idx = afterActive ? this.tabs.findIndex((t) => t.id === this.activeId) + 1 : this.tabs.length;
    this.tabs.splice(idx || this.tabs.length, 0, tab);
    view.webContents.loadURL(url).catch(() => {});
    if (!background) this.activate(tab.id);
    this.scheduleSync();
    return tab;
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const update = () => this.scheduleSync();
    wc.on('page-title-updated', (_e, title) => { tab.title = title; update(); });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; update(); });
    wc.on('did-start-loading', () => { tab.loading = true; update(); });
    wc.on('did-stop-loading', () => { tab.loading = false; update(); saveState(); });
    wc.on('did-start-navigation', (_e, url, inPage, isMain) => {
      if (isMain && !inPage) { tab.blocked = 0; tab.favicon = null; }
      update();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      // -3 is ERR_ABORTED (user stopped / navigated away): not worth a page.
      if (!isMain || code === -3) return;
      wc.once('did-stop-loading', () => {
        if (wc.isDestroyed() || wc.getURL() !== url) return;
        wc.executeJavaScript(errorPageScript(url, desc)).catch(() => {});
      });
    });
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
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
    this.layout();
    if (this.findOpen) this.closeFind();
    if (tab.isNewTab) this.focusAddress();
    else tab.view.webContents.focus();
    this.scheduleSync();
    saveState();
  }

  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    const url = tab.view.webContents.getURL();
    if (url && !tab.isNewTab) this.closed.push(url);
    if (this.tabs.length === 0) {
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
    saveState();
  }

  reopenClosed() {
    const url = this.closed.pop();
    if (url) this.newTab(url, { afterActive: true });
  }

  moveTab(id, toIndex) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.scheduleSync();
    saveState();
  }

  cycle(dir) {
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  // ----- layout
  layout() {
    const { width, height } = this.win.getContentBounds();
    const top = this.htmlFullscreen ? 0 : CHROME_HEIGHT;
    this.ui.setBounds({ x: 0, y: 0, width, height: this.htmlFullscreen ? 0 : height });
    const tab = this.activeTab();
    if (tab) tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
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
        canBack: wc.navigationHistory.canGoBack(),
        canForward: wc.navigationHistory.canGoForward(),
        zoom: wc.getZoomFactor(),
        blocked: t.blocked,
      };
    });
    this.ui.webContents.send('state', {
      tabs, activeId: this.activeId,
      blocking: blocker ? blockingEnabled : null,
    });
    const active = this.activeTab();
    if (active) this.win.setTitle(active.isNewTab ? 'Webber' : `${active.title || 'Webber'}`);
  }

  focusAddress() {
    this.ui.webContents.focus();
    this.ui.webContents.send('focus-address');
  }

  // ----- find
  openFind() {
    this.findOpen = true;
    this.ui.webContents.focus();
    this.ui.webContents.send('find-open');
  }

  closeFind() {
    this.findOpen = false;
    const t = this.activeTab();
    if (t) t.view.webContents.stopFindInPage('clearSelection');
    this.ui.webContents.send('find-close');
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

    if (mod && !input.shift && key === 't') return run(() => this.newTab());
    if (mod && input.shift && key === 't') return run(() => this.reopenClosed());
    if (mod && key === 'n') return run(() => new BrowserShell());
    if (mod && key === 'w') return run(() => this.closeTab(this.activeId));
    if ((mod && key === 'l') || (input.alt && key === 'd' && !IS_MAC) || key === 'f6') return run(() => this.focusAddress());
    if ((mod && key === 'r') || key === 'f5') return run(() => t && (input.shift ? t.view.webContents.reloadIgnoringCache() : t.view.webContents.reload()));
    if (mod && key === 'f') return run(() => this.openFind());
    if (key === 'escape' && this.findOpen) return run(() => this.closeFind());
    if (input.control && key === 'tab') return run(() => this.cycle(input.shift ? -1 : 1));
    if (mod && input.alt && (key === 'arrowright' || key === 'arrowleft')) return run(() => this.cycle(key === 'arrowright' ? 1 : -1));
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

  // ----- context menu
  contextMenu(tab, p) {
    const wc = tab.view.webContents;
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.newTab(p.linkURL, { background: true, afterActive: true }) },
        { label: 'Open Link in New Window', click: () => new BrowserShell({ urls: [p.linkURL] }) },
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
}

// ---------------------------------------------------------------- theme
function themeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { bg: '#1c1c1e', fg: '#e8e8ea' }
    : { bg: '#f4f4f5', fg: '#3a3a3c' };
}

function overlayFor(c) {
  return { color: '#00000000', symbolColor: c.fg, height: 40 };
}

nativeTheme.on('updated', () => {
  const c = themeColors();
  for (const w of windows) {
    w.win.setBackgroundColor(c.bg);
    if (!IS_MAC) w.win.setTitleBarOverlay(overlayFor(c));
  }
});

// ---------------------------------------------------------------- IPC
function shellFor(event) {
  return windows.find((w) => w.ui.webContents === event.sender);
}

ipcMain.on('cmd', (event, cmd, arg) => {
  const w = shellFor(event);
  if (!w) return;
  const t = w.activeTab();
  const wc = t && t.view.webContents;
  switch (cmd) {
    case 'new-tab': w.newTab(); break;
    case 'close-tab': w.closeTab(arg); break;
    case 'activate': w.activate(arg); break;
    case 'move-tab': w.moveTab(arg.id, arg.index); break;
    case 'navigate': {
      const url = toUrl(arg);
      if (url && wc) { wc.loadURL(url).catch(() => {}); wc.focus(); }
      break;
    }
    case 'back': wc && wc.navigationHistory.goBack(); break;
    case 'forward': wc && wc.navigationHistory.goForward(); break;
    case 'reload': wc && wc.reload(); break;
    case 'stop': wc && wc.stop(); break;
    case 'zoom-reset': w.zoom(0); break;
    case 'toggle-blocking': setBlocking(!blockingEnabled); break;
    case 'find': if (wc && arg.text) wc.findInPage(arg.text, { forward: arg.forward !== false, findNext: !!arg.next }); else if (wc) wc.stopFindInPage('clearSelection'); break;
    case 'find-close': w.closeFind(); if (wc) wc.focus(); break;
    case 'focus-page': if (wc) wc.focus(); break;
    case 'tab-menu': {
      const tab = w.tabs.find((x) => x.id === arg);
      if (!tab) break;
      Menu.buildFromTemplate([
        { label: 'New Tab', click: () => w.newTab() },
        { type: 'separator' },
        { label: 'Reload', click: () => tab.view.webContents.reload() },
        { label: 'Duplicate', click: () => w.newTab(tab.view.webContents.getURL(), { afterActive: true }) },
        { label: tab.view.webContents.isAudioMuted() ? 'Unmute Site' : 'Mute Site', click: () => { tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted()); } },
        { type: 'separator' },
        { label: 'Close Tab', click: () => w.closeTab(tab.id) },
        { label: 'Close Other Tabs', enabled: w.tabs.length > 1, click: () => w.tabs.filter((x) => x.id !== tab.id).forEach((x) => w.closeTab(x.id)) },
        { label: 'Reopen Closed Tab', enabled: w.closed.length > 0, click: () => w.reopenClosed() },
      ]).popup({ window: w.win });
      break;
    }
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
    protocol.handle('webber', (req) => {
      const { host } = new URL(req.url);
      const file = path.join(PAGES_DIR, `${host.replace(/[^a-z0-9-]/gi, '')}.html`);
      return net.fetch(pathToFileURL(file).toString());
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

    const argUrl = process.argv.slice(1).find((a) => /^https?:/.test(a));
    const saved = loadState();
    const urls = saved && Array.isArray(saved.tabs) && saved.tabs.length ? saved.tabs : [NEW_TAB_URL];
    if (argUrl) urls.push(argUrl);
    new BrowserShell({ urls, active: argUrl ? urls.length - 1 : (saved ? saved.active : 0) });

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
