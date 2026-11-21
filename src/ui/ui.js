'use strict';

const $ = (id) => document.getElementById(id);
const api = window.webber;

const platform = new URLSearchParams(location.search).get('platform') || '';
document.body.classList.add(platform);

const els = {
  tabs: $('tabs'), newTab: $('new-tab'),
  back: $('back'), forward: $('forward'), reload: $('reload'),
  omnibox: $('omnibox'), address: $('address'), zoom: $('zoom'),
  shield: $('shield'), blocked: $('blocked-count'),
  find: $('find'), findInput: $('find-input'), findCount: $('find-count'),
};

let state = { tabs: [], activeId: null, blocking: null };
let editing = false;      // user is typing in the address bar
let lastLoading = false;

const active = () => state.tabs.find((t) => t.id === state.activeId);

// ------------------------------------------------------------ rendering
function displayUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '');
  } catch {}
  return url;
}

function renderTabs() {
  const existing = new Map([...els.tabs.children].map((el) => [Number(el.dataset.id), el]));

  state.tabs.forEach((t, i) => {
    let el = existing.get(t.id);
    if (!el) el = createTab(t.id);
    existing.delete(t.id);
    if (els.tabs.children[i] !== el) els.tabs.insertBefore(el, els.tabs.children[i] || null);

    el.classList.toggle('active', t.id === state.activeId);
    el.title = t.title;
    el.setAttribute('aria-selected', t.id === state.activeId);
    el.querySelector('.title').textContent = t.title;

    const fav = el.querySelector('.fav');
    const favKey = t.loading ? 'loading' : (t.favicon || 'none');
    if (fav.dataset.key !== favKey) {
      fav.dataset.key = favKey;
      fav.replaceChildren();
      if (t.loading) {
        fav.append(Object.assign(document.createElement('div'), { className: 'spinner' }));
      } else if (t.favicon) {
        const img = new Image();
        img.src = t.favicon;
        img.onerror = () => img.replaceWith(Object.assign(document.createElement('div'), { className: 'dot' }));
        fav.append(img);
      } else {
        fav.append(Object.assign(document.createElement('div'), { className: 'dot' }));
      }
    }
  });
  existing.forEach((el) => el.remove());
  fitTabs();
}

// Collapse tabs to icons only when there is no room for titles.
function fitTabs() {
  const strip = $('tabstrip');
  const cs = getComputedStyle(strip);
  const room = strip.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - els.newTab.offsetWidth - 24;
  const narrow = room / Math.max(state.tabs.length, 1) < 76;
  for (const el of els.tabs.children) el.classList.toggle('narrow', narrow);
}

function createTab(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = id;
  el.setAttribute('role', 'tab');
  el.draggable = true;
  el.innerHTML = `
    <span class="fav"></span>
    <span class="title"></span>
    <button class="close" aria-label="Close tab" tabindex="-1">
      <svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
    </button>`;

  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close')) api.cmd('activate', id);
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) api.cmd('close-tab', id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.cmd('tab-menu', id); });
  el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); api.cmd('close-tab', id); });

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/webber-tab', String(id));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = Number(e.dataTransfer.getData('text/webber-tab'));
    if (!dragged || dragged === id) return;
    const rect = el.getBoundingClientRect();
    let index = state.tabs.findIndex((t) => t.id === id);
    const from = state.tabs.findIndex((t) => t.id === dragged);
    if (e.clientX > rect.left + rect.width / 2) index += 1;
    if (from < index) index -= 1;
    api.cmd('move-tab', { id: dragged, index });
  });
  return el;
}

function renderToolbar() {
  const t = active();
  if (!t) return;
  els.back.disabled = !t.canBack;
  els.forward.disabled = !t.canForward;
  els.reload.classList.toggle('loading', t.loading);
  els.reload.title = t.loading ? 'Stop' : 'Reload';

  if (!editing) {
    els.address.value = document.activeElement === els.address ? t.url : displayUrl(t.url);
  }
  els.omnibox.classList.toggle('https', t.url.startsWith('https://'));
  els.omnibox.classList.toggle('has-url', !!t.url);

  // progress line
  if (t.loading && !lastLoading) {
    els.omnibox.classList.remove('done');
    void els.omnibox.offsetWidth;
    els.omnibox.classList.add('loading');
  } else if (!t.loading && lastLoading) {
    els.omnibox.classList.remove('loading');
    els.omnibox.classList.add('done');
  }
  lastLoading = t.loading;

  const zoom = Math.round(t.zoom * 100);
  els.zoom.hidden = zoom === 100;
  els.zoom.textContent = `${zoom}%`;

  els.shield.hidden = state.blocking === null;
  els.shield.classList.toggle('on', !!state.blocking);
  els.shield.title = state.blocking
    ? `Blocking ads & trackers${t.blocked ? ` — ${t.blocked} blocked on this page` : ''}. Click to turn off.`
    : 'Content blocking is off. Click to turn on.';
  els.blocked.textContent = state.blocking && t.blocked ? (t.blocked > 99 ? '99+' : t.blocked) : '';
}

let prevActive = null;
api.on('state', (s) => {
  state = s;
  if (prevActive !== s.activeId) { editing = false; lastLoading = false; els.omnibox.classList.remove('loading', 'done'); }
  prevActive = s.activeId;
  renderTabs();
  renderToolbar();
});

window.addEventListener('resize', fitTabs);
api.on('window-focus', (f) => document.body.classList.toggle('blurred', !f));

// ------------------------------------------------------------ controls
els.newTab.addEventListener('click', () => api.cmd('new-tab'));
els.back.addEventListener('click', () => api.cmd('back'));
els.forward.addEventListener('click', () => api.cmd('forward'));
els.reload.addEventListener('click', () => api.cmd(active()?.loading ? 'stop' : 'reload'));
els.zoom.addEventListener('click', () => api.cmd('zoom-reset'));
els.shield.addEventListener('click', () => api.cmd('toggle-blocking'));
$('tabstrip').addEventListener('dblclick', (e) => {
  if (e.target.id === 'tabstrip' || e.target.classList.contains('drag-fill')) api.cmd('new-tab');
});

// ------------------------------------------------------------ address bar
els.address.addEventListener('focus', () => {
  const t = active();
  els.address.value = t ? t.url : '';
  requestAnimationFrame(() => els.address.select());
});
els.address.addEventListener('blur', () => { editing = false; renderToolbar(); });
els.address.addEventListener('input', () => { editing = true; });
els.address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    editing = false;
    const t = active();
    els.address.value = t ? t.url : '';
    if (t && t.url) api.cmd('focus-page');
    else els.address.select();
  }
});
els.omnibox.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = els.address.value.trim();
  if (!v) return;
  editing = false;
  els.address.blur();
  api.cmd('navigate', v);
});

api.on('focus-address', () => {
  els.address.focus();
  els.address.select();
});

// ------------------------------------------------------------ find
function sendFind(opts = {}) {
  api.cmd('find', { text: els.findInput.value, ...opts });
}
els.findInput.addEventListener('input', () => {
  if (!els.findInput.value) { els.findCount.textContent = ''; els.find.classList.remove('miss'); }
  sendFind();
});
els.find.addEventListener('submit', (e) => { e.preventDefault(); });
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
  if (!r.finalUpdate && r.matches === undefined) return;
  els.findCount.textContent = els.findInput.value ? `${r.activeMatchOrdinal || 0}/${r.matches}` : '';
  els.find.classList.toggle('miss', !!els.findInput.value && r.matches === 0);
});
