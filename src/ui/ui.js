'use strict';

const $ = (id) => document.getElementById(id);
const api = window.webber;
const params = new URLSearchParams(location.search);
document.body.classList.add(params.get('platform') || '');
if (params.get('controls') === '1') document.body.classList.add('controls');

const els = {
  back: $('back'), forward: $('forward'), reload: $('reload'),
  urlbar: $('urlbar'), urltext: $('urltext'), zoom: $('zoom'),
  essentials: $('essentials'), tabs: $('tabs'), newTab: $('new-tab'),
  shield: $('shield'), blocked: $('blocked-count'), themeName: $('theme-name'),
  find: $('find'), findInput: $('find-input'), findCount: $('find-count'),
  omnibox: $('omnibox'), omniInput: $('omni-input'), omniList: $('omni-list'),
};

let state = { tabs: [], activeId: null, blocking: null, layout: {} };
const active = () => state.tabs.find((t) => t.id === state.activeId);

const ICONS = {
  close: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  audio: '<svg viewBox="0 0 16 16"><path d="M3 6.2h2.2L8.4 3.5v9L5.2 9.8H3z"/><path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.3 4a5.6 5.6 0 0 1 0 8"/></svg>',
  muted: '<svg viewBox="0 0 16 16"><path d="M3 6.2h2.2L8.4 3.5v9L5.2 9.8H3z"/><path d="m10.5 6 3.5 4M14 6l-3.5 4"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/></svg>',
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>',
  tab: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="2"/><path d="M2.5 6.5h11"/></svg>',
};

function displayUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '');
  } catch {}
  return url;
}

function favicon(el, t) {
  const key = t.loading ? 'loading' : (t.favicon || 'none');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren();
  const dot = () => Object.assign(document.createElement('div'), { className: 'dot' });
  if (t.loading) {
    el.append(Object.assign(document.createElement('div'), { className: 'spinner' }));
  } else if (t.favicon) {
    const img = new Image();
    img.src = t.favicon;
    img.onerror = () => img.replaceWith(dot());
    el.append(img);
  } else {
    el.append(dot());
  }
}

// ------------------------------------------------------------ theme
api.on('theme', (t) => {
  const root = document.documentElement.style;
  root.setProperty('--frame', t.frame);
  root.setProperty('--fg', t.foreground);
  root.setProperty('--accent', t.accent);
  document.body.classList.toggle('light', t.mode === 'light');
  els.themeName.textContent = t.source === 'omarchy' ? t.name.replace(/-/g, ' ') : '';
  els.themeName.title = t.source === 'omarchy' ? 'Colors from your Omarchy theme' : '';
});

// ------------------------------------------------------------ tabs
function syncList(container, tabs, make, update) {
  const existing = new Map([...container.children].map((el) => [Number(el.dataset.id), el]));
  tabs.forEach((t, i) => {
    let el = existing.get(t.id);
    if (!el) el = make(t.id);
    existing.delete(t.id);
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    update(el, t);
  });
  existing.forEach((el) => el.remove());
}

function makeEssential(id) {
  const el = document.createElement('button');
  el.className = 'essential';
  el.dataset.id = id;
  el.innerHTML = '<span class="fav"></span>';
  bindTabEvents(el, id, true);
  return el;
}

function makeTab(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = id;
  el.setAttribute('role', 'tab');
  el.innerHTML = `
    <span class="fav"></span>
    <span class="title"></span>
    <button class="audio" hidden tabindex="-1"></button>
    <button class="close" aria-label="Close tab" tabindex="-1">${ICONS.close}</button>`;
  bindTabEvents(el, id, false);
  el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); api.cmd('close-tab', id); });
  el.querySelector('.audio').addEventListener('click', (e) => { e.stopPropagation(); api.cmd('toggle-mute', id); });
  return el;
}

let dragId = null;
function bindTabEvents(el, id, pinned) {
  el.draggable = true;
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close, .audio')) api.cmd('activate', id);
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) api.cmd('close-tab', id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.cmd('tab-menu', id); });
  el.addEventListener('dragstart', (e) => {
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    el.classList.add('dragging');
    els.essentials.classList.add('drop-target');
  });
  el.addEventListener('dragend', () => {
    dragId = null;
    el.classList.remove('dragging');
    els.essentials.classList.remove('drop-target');
    clearDropMarks();
  });
  el.addEventListener('dragover', (e) => {
    if (dragId == null || dragId === id) return;
    e.preventDefault();
    e.stopPropagation();
    if (!pinned) {
      clearDropMarks();
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
    }
  });
  el.addEventListener('drop', (e) => {
    if (dragId == null || dragId === id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const after = pinned ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    dropAt(id, after, pinned);
  });
}

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

function dropAt(targetId, after, pinned) {
  const others = state.tabs.filter((t) => t.id !== dragId);
  let index = others.findIndex((t) => t.id === targetId) + (after ? 1 : 0);
  api.cmd('move-tab', { id: dragId, index, pinned });
  clearDropMarks();
}

// Dropping on empty essentials area pins; dropping on the empty tab area unpins.
els.essentials.addEventListener('dragover', (e) => { if (dragId != null) e.preventDefault(); });
els.essentials.addEventListener('drop', (e) => {
  if (dragId == null) return;
  e.preventDefault();
  api.cmd('move-tab', { id: dragId, index: state.tabs.filter((t) => t.pinned && t.id !== dragId).length, pinned: true });
});
els.tabs.addEventListener('dragover', (e) => { if (dragId != null) e.preventDefault(); });
els.tabs.addEventListener('drop', (e) => {
  if (dragId == null) return;
  e.preventDefault();
  api.cmd('move-tab', { id: dragId, index: state.tabs.length, pinned: false });
});

function renderTabs() {
  const pinned = state.tabs.filter((t) => t.pinned);
  const regular = state.tabs.filter((t) => !t.pinned);

  syncList(els.essentials, pinned, makeEssential, (el, t) => {
    el.classList.toggle('active', t.id === state.activeId);
    el.classList.toggle('busy', t.audible || t.loading);
    el.title = t.title;
    favicon(el.querySelector('.fav'), t);
  });

  syncList(els.tabs, regular, makeTab, (el, t) => {
    el.classList.toggle('active', t.id === state.activeId);
    el.title = t.title;
    el.setAttribute('aria-selected', t.id === state.activeId);
    el.querySelector('.title').textContent = t.title;
    favicon(el.querySelector('.fav'), t);
    const audio = el.querySelector('.audio');
    audio.hidden = !(t.audible || t.muted);
    const icon = t.muted ? 'muted' : 'audio';
    if (audio.dataset.icon !== icon) { audio.dataset.icon = icon; audio.innerHTML = ICONS[icon]; }
    audio.title = t.muted ? 'Unmute tab' : 'Mute tab';
  });

  $('tab-count').textContent = regular.length || '';

  const a = els.tabs.querySelector('.tab.active');
  if (a) a.scrollIntoView({ block: 'nearest' });
}

function renderChrome() {
  const t = active();
  const L = state.layout;
  const body = document.body.classList;
  body.toggle('compact', !!L.compact);
  body.toggle('overlay', !!L.overlay);
  body.toggle('peek', L.overlay === 'peek');
  if (L.overlay !== 'omnibox') body.remove('omni');
  body.toggle('html-fs', !!L.htmlFullscreen);

  const root = document.documentElement.style;
  if (L.sidebarWidth) {
    root.setProperty('--sidebar-w', `${L.sidebarWidth}px`);
    root.setProperty('--gap', `${L.gap}px`);
    root.setProperty('--radius', `${L.radius}px`);
    root.setProperty('--card-left', `${L.compact ? L.gap : L.sidebarWidth}px`);
    root.setProperty('--find-h', L.findOpen ? `${L.findHeight}px` : '0px');
  }

  if (!t) return;
  els.back.disabled = !t.canBack;
  els.forward.disabled = !t.canForward;
  els.reload.classList.toggle('loading', t.loading);
  els.reload.title = t.loading ? 'Stop' : 'Reload';

  els.urltext.textContent = t.url ? displayUrl(t.url) : 'Search or enter address';
  els.urlbar.classList.toggle('empty', !t.url);
  els.urlbar.classList.toggle('https', t.url.startsWith('https://'));
  const zoom = Math.round(t.zoom * 100);
  els.zoom.hidden = zoom === 100;
  els.zoom.textContent = `${zoom}%`;

  els.shield.hidden = state.blocking === null;
  els.shield.classList.toggle('on', !!state.blocking);
  els.shield.title = state.blocking
    ? `Blocking ads & trackers${t.blocked ? ` — ${t.blocked} on this page` : ''}. Click to turn off.`
    : 'Content blocking is off. Click to turn on.';
  els.blocked.textContent = state.blocking && t.blocked ? (t.blocked > 99 ? '99+' : t.blocked) : '';
}

api.on('state', (s) => {
  state = s;
  renderTabs();
  renderChrome();
});

api.on('window-focus', (f) => document.body.classList.toggle('blurred', !f));

// ------------------------------------------------------------ controls
els.newTab.addEventListener('click', () => api.cmd('new-tab'));
els.back.addEventListener('click', () => api.cmd('back'));
els.forward.addEventListener('click', () => api.cmd('forward'));
els.reload.addEventListener('click', () => api.cmd(active()?.loading ? 'stop' : 'reload'));
els.urlbar.addEventListener('click', (e) => {
  if (e.target === els.zoom) return api.cmd('zoom-reset');
  api.cmd('omnibox', false);
});
els.shield.addEventListener('click', () => api.cmd('toggle-blocking'));
$('toggle-sidebar').addEventListener('click', () => api.cmd('toggle-compact'));
$('win-min').addEventListener('click', () => api.cmd('win-min'));
$('win-max').addEventListener('click', () => api.cmd('win-max'));
$('win-close').addEventListener('click', () => api.cmd('win-close'));
$('topbar').addEventListener('dblclick', (e) => { if (e.target.closest('button') == null) api.cmd('win-max'); });

// compact mode: reveal the sidebar from the left edge
let peekTimer = null;
$('edge').addEventListener('mouseenter', () => {
  peekTimer = setTimeout(() => api.cmd('peek'), 60);
});
$('edge').addEventListener('mouseleave', () => clearTimeout(peekTimer));
$('sidebar').addEventListener('mouseleave', () => {
  if (document.body.classList.contains('peek')) api.cmd('overlay-close');
});
document.addEventListener('mousedown', (e) => {
  if (document.body.classList.contains('peek') && !e.target.closest('#sidebar')) api.cmd('overlay-close');
});

// ------------------------------------------------------------ floating address bar
const omni = { newTab: false, items: [], index: -1, seq: 0 };

api.on('omnibox-open', ({ newTab, url }) => {
  omni.newTab = newTab;
  document.body.classList.add('overlay', 'omni');
  els.omniInput.value = url || '';
  els.omniInput.placeholder = newTab ? 'Open a new tab — search or enter address' : 'Search or enter address';
  els.omniInput.focus();
  els.omniInput.select();
  refreshSuggestions(url ? null : '');
});

function closeOmnibox() {
  document.body.classList.remove('omni');
  api.cmd('overlay-close');
}

async function refreshSuggestions(query) {
  const seq = ++omni.seq;
  const items = query == null ? [] : await api.suggest(query);
  if (seq !== omni.seq) return;
  omni.items = items;
  omni.index = query ? 0 : -1;
  renderSuggestions();
}

function renderSuggestions() {
  els.omniList.replaceChildren(...omni.items.map((item, i) => {
    const row = document.createElement('div');
    row.className = 'omni-item' + (i === omni.index ? ' selected' : '');
    row.setAttribute('role', 'option');

    const ic = document.createElement('span');
    ic.className = 'ic';
    if (item.type === 'tab' && item.favicon) {
      const img = new Image();
      img.src = item.favicon;
      img.onerror = () => { ic.innerHTML = ICONS.tab; };
      ic.append(img);
    } else {
      ic.innerHTML = { search: ICONS.search, url: ICONS.globe, history: ICONS.clock, tab: ICONS.tab }[item.type];
    }

    const t = Object.assign(document.createElement('span'), { className: 't', textContent: item.title });
    const u = Object.assign(document.createElement('span'), { className: 'u' });
    const hint = Object.assign(document.createElement('span'), { className: 'hint' });
    if (item.type === 'search') { u.textContent = '— Search with DuckDuckGo'; hint.textContent = 'Enter'; hint.classList.add('only-selected'); }
    else if (item.type === 'url') { u.textContent = ''; hint.textContent = 'Open'; hint.classList.add('only-selected'); }
    else if (item.type === 'tab') { u.textContent = displayUrl(item.url); hint.textContent = 'Switch to tab'; }
    else u.textContent = displayUrl(item.url);

    row.append(ic, t, u);
    if (hint.textContent) row.append(hint);
    row.addEventListener('mousemove', () => {
      if (omni.index !== i) { omni.index = i; renderSuggestions(); }
    });
    row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(item); });
    return row;
  }));
}

function choose(item) {
  document.body.classList.remove('omni');
  if (item.type === 'tab') api.cmd('switch-tab', item.tabId);
  else api.cmd('navigate', { text: item.url, newTab: omni.newTab });
}

els.omniInput.addEventListener('input', () => refreshSuggestions(els.omniInput.value));
els.omniInput.addEventListener('keydown', (e) => {
  const n = omni.items.length;
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); omni.index = (omni.index + 1) % n; renderSuggestions(); }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); omni.index = (omni.index - 1 + n) % n; renderSuggestions(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeOmnibox(); }
});
$('omni-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const item = omni.items[omni.index];
  if (item) return choose(item);
  const text = els.omniInput.value.trim();
  if (!text) return;
  document.body.classList.remove('omni');
  api.cmd('navigate', { text, newTab: omni.newTab });
});
els.omnibox.addEventListener('mousedown', (e) => { if (e.target === els.omnibox) closeOmnibox(); });

// ------------------------------------------------------------ find
function sendFind(opts = {}) {
  api.cmd('find', { text: els.findInput.value, ...opts });
}
els.findInput.addEventListener('input', () => {
  if (!els.findInput.value) { els.findCount.textContent = ''; els.find.classList.remove('miss'); }
  sendFind();
});
els.find.addEventListener('submit', (e) => e.preventDefault());
els.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendFind({ next: true, forward: !e.shiftKey }); }
  if (e.key === 'Escape') api.cmd('find-close');
});
$('find-next').addEventListener('click', () => sendFind({ next: true }));
$('find-prev').addEventListener('click', () => sendFind({ next: true, forward: false }));
$('find-close').addEventListener('click', () => api.cmd('find-close'));

api.on('find-open', () => {
  els.find.hidden = false;
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) sendFind();
});
api.on('find-close', () => {
  els.find.hidden = true;
  els.findCount.textContent = '';
  els.find.classList.remove('miss');
});
api.on('find-result', (r) => {
  els.findCount.textContent = els.findInput.value ? `${r.activeMatchOrdinal || 0}/${r.matches}` : '';
  els.find.classList.toggle('miss', !!els.findInput.value && r.matches === 0);
});
