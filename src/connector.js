'use strict';

// "Claude connector": an MCP server inside Webber, so Claude can use the browser.
//
// It speaks MCP over Streamable HTTP on 127.0.0.1 only, and every request must carry
// the access key (Authorization: Bearer <key>). Requests that come from a web page
// (they have an Origin header) are refused, so websites can't drive the browser.
// It is off until the user turns it on from the sidebar.

const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod');

const ISOLATED_WORLD = 4242; // our scripts run here, out of reach of the page's own JS
const MAX_TEXT = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

// ---------------------------------------------------------------- page helpers
function inPage(wc, code) {
  return wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }], true);
}

async function waitForLoad(wc, timeout = 15000) {
  if (!wc.isLoading()) return;
  await Promise.race([
    new Promise((r) => wc.once('did-stop-loading', r)),
    sleep(timeout),
  ]);
}

// After a click or key press: give the page a moment, then wait out any navigation it started.
async function settle(wc) {
  await sleep(350);
  await waitForLoad(wc, 10000);
}

// Numbers every visible interactive element (kept in the isolated world) and
// returns the page's title, URL, element list and readable text.
const SNAPSHOT = (maxText, withText) => `(() => {
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=""], [contenteditable=true],' +
    '[role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=textbox], [role=searchbox]';
  const vh = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const label = (el) => {
    const id = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    return clean(el.getAttribute('aria-label') || (id && id.innerText) || el.innerText || el.placeholder ||
      el.title || el.alt || (el.querySelector('img[alt]') || {}).alt || el.name || el.value || '').slice(0, 80);
  };
  const role = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio', 'submit', 'button', 'range', 'file', 'color', 'date'].includes(type)) return type === 'submit' ? 'button' : type;
      return type === 'search' ? 'searchbox' : 'textbox';
    }
    if (t === 'textarea' || el.isContentEditable) return 'textbox';
    if (t === 'select') return 'combobox';
    return t;
  };
  const all = [...document.querySelectorAll(SEL)].filter(visible);
  // things on screen first, then the rest of the page
  all.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const ia = ra.bottom > 0 && ra.top < vh, ib = rb.bottom > 0 && rb.top < vh;
    return ia === ib ? 0 : ia ? -1 : 1;
  });
  const els = all.slice(0, 250);
  window.__webberRefs = els;
  const lines = els.map((el, i) => {
    const r = role(el);
    let line = '[' + (i + 1) + '] ' + r + ' "' + label(el).replace(/"/g, "'") + '"';
    if (r === 'link') { try { line += ' -> ' + new URL(el.href).pathname; } catch {} }
    if ((r === 'textbox' || r === 'searchbox' || r === 'combobox') && el.type !== 'password' && el.value) line += ' value="' + clean(el.value).slice(0, 60) + '"';
    if ((r === 'checkbox' || r === 'radio' || r === 'switch') && ('checked' in el)) line += el.checked ? ' (checked)' : ' (unchecked)';
    if (el.disabled) line += ' (disabled)';
    const rect = el.getBoundingClientRect();
    if (!(rect.bottom > 0 && rect.top < vh)) line += ' (offscreen)';
    return line;
  });
  let body = '';
  if (${withText}) {
    body = (document.body ? document.body.innerText : '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    if (body.length > ${maxText}) body = body.slice(0, ${maxText}) + '\\n… (truncated)';
  }
  return {
    title: document.title,
    url: location.href,
    scroll: Math.round(scrollY) + ' of ' + Math.max(0, document.documentElement.scrollHeight - vh) + 'px',
    elements: lines,
    text: body,
  };
})()`;

async function refCenter(wc, ref) {
  const r = await inPage(wc, `(() => {
    const el = (window.__webberRefs || [])[${Number(ref) - 1}];
    if (!el || !el.isConnected) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!r) throw new Error(`Element [${ref}] isn't on the page anymore. Call read_page again to get fresh refs.`);
  return r;
}

async function clickAt(wc, x, y) {
  const zoom = wc.getZoomFactor();
  const p = { x: Math.round(x * zoom), y: Math.round(y * zoom) };
  wc.sendInputEvent({ type: 'mouseMove', ...p });
  wc.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
}

const KEY_NAMES = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace',
  delete: 'Delete', space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};

function pressKey(wc, combo) {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  const keyPart = parts.pop() || '';
  const modifiers = parts.map((m) => ({ ctrl: 'control', cmd: 'meta', command: 'meta', option: 'alt' }[m.toLowerCase()] || m.toLowerCase()));
  const keyCode = KEY_NAMES[keyPart.toLowerCase()] || keyPart;
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode.length === 1 && !modifiers.some((m) => m === 'control' || m === 'meta')) {
    wc.sendInputEvent({ type: 'char', keyCode, modifiers });
  } else if (keyCode === 'Enter') {
    wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function formatSnapshot(s, tabId) {
  const out = [`Tab ${tabId}: ${s.title || '(untitled)'}`, `URL: ${s.url}`, `Scrolled ${s.scroll}`, ''];
  out.push(s.elements.length ? 'Interactive elements (use the number as "ref"):' : 'No interactive elements.');
  out.push(...s.elements);
  if (s.text) out.push('', 'Page text:', s.text);
  return out.join('\n');
}

// ---------------------------------------------------------------- tools
function buildServer(browser) {
  const server = new McpServer(
    { name: 'webber', version: '0.1.0' },
    {
      instructions:
        'Controls the Webber browser on the user\'s computer, using their real tabs and signed-in sessions. ' +
        'Typical flow: list_tabs or open_tab, then read_page to see the page and its numbered elements, ' +
        'then click / type using those numbers. Refs change after the page changes, so read_page again. ' +
        'Ask the user before submitting payments, sending messages, or deleting things on their behalf.',
    },
  );

  const tabArg = z.number().int().optional().describe('Tab id from list_tabs. Defaults to the tab the user is looking at.');
  const resolve = (tabId, { front = false } = {}) => {
    const tab = browser.getTab(tabId);
    if (!tab) throw new Error(tabId == null ? 'There is no open tab.' : `No tab with id ${tabId}. Call list_tabs.`);
    // Real input events only reach the tab on screen, and the user should see what Claude does.
    if (front) browser.activate(tab.id);
    browser.markAgent(tab);
    return tab;
  };
  const tool = (name, description, inputSchema, handler, annotations = {}) => {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try { return await handler(args || {}); } catch (err) { return fail(err.message || String(err)); }
    });
  };

  tool('list_tabs', 'List the open tabs: id, title, URL, and which one is active or pinned.', {}, async () => {
    const tabs = browser.listTabs();
    if (!tabs.length) return text('No tabs are open.');
    return text(tabs.map((t) => `${t.id}${t.active ? ' (active)' : ''}${t.pinned ? ' (pinned)' : ''}  ${t.title}\n    ${t.url || 'new tab'}`).join('\n'));
  }, { readOnlyHint: true });

  tool('open_tab', 'Open a URL (or a search) in a new tab and wait for it to load.', {
    url: z.string().describe('A URL, or words to search for.'),
    background: z.boolean().optional().describe('Open without switching to it. Default false.'),
  }, async ({ url, background }) => {
    const tab = browser.openTab(url, !!background);
    browser.markAgent(tab);
    await sleep(100);
    await waitForLoad(tab.view.webContents);
    return text(`Opened tab ${tab.id}: ${tab.view.webContents.getTitle()}\n${tab.view.webContents.getURL()}`);
  });

  tool('navigate', 'Load a URL (or a search) in a tab and wait for it to load.', {
    url: z.string(), tab_id: tabArg,
  }, async ({ url, tab_id }) => {
    const tab = resolve(tab_id);
    const wc = tab.view.webContents;
    await wc.loadURL(browser.toUrl(url)).catch(() => {});
    await waitForLoad(wc);
    return text(`Tab ${tab.id}: ${wc.getTitle()}\n${wc.getURL()}`);
  });

  tool('switch_tab', 'Bring a tab to the front.', { tab_id: z.number().int() }, async ({ tab_id }) => {
    const tab = resolve(tab_id);
    browser.activate(tab.id);
    return text(`Switched to tab ${tab.id}.`);
  });

  tool('close_tab', 'Close a tab.', { tab_id: z.number().int() }, async ({ tab_id }) => {
    const tab = resolve(tab_id);
    browser.closeTab(tab.id);
    return text(`Closed tab ${tab_id}.`);
  }, { destructiveHint: true });

  tool('history', 'Go back, go forward, or reload a tab.', {
    action: z.enum(['back', 'forward', 'reload']), tab_id: tabArg,
  }, async ({ action, tab_id }) => {
    const tab = resolve(tab_id);
    const wc = tab.view.webContents;
    if (action === 'back') wc.navigationHistory.goBack();
    else if (action === 'forward') wc.navigationHistory.goForward();
    else wc.reload();
    await settle(wc);
    return text(`Tab ${tab.id}: ${wc.getTitle()}\n${wc.getURL()}`);
  });

  tool('read_page',
    'Read a tab: its title, URL, a numbered list of the buttons, links and fields on it, and its visible text. ' +
    'Use the numbers with click and type.', {
      tab_id: tabArg,
      include_text: z.boolean().optional().describe('Include the page text. Default true.'),
      max_chars: z.number().int().optional().describe(`Cap on page text length. Default ${MAX_TEXT}.`),
    }, async ({ tab_id, include_text, max_chars }) => {
      const tab = resolve(tab_id);
      const wc = tab.view.webContents;
      await waitForLoad(wc, 8000);
      const snap = await inPage(wc, SNAPSHOT(Math.max(500, Math.min(max_chars || MAX_TEXT, 200000)), include_text !== false));
      return text(formatSnapshot(snap, tab.id));
    }, { readOnlyHint: true });

  tool('click', 'Click an element by its number from read_page.', {
    ref: z.number().int(), tab_id: tabArg,
  }, async ({ ref, tab_id }) => {
    const tab = resolve(tab_id, { front: true });
    const wc = tab.view.webContents;
    const p = await refCenter(wc, ref);
    await clickAt(wc, p.x, p.y);
    await settle(wc);
    return text(`Clicked [${ref}]. Tab ${tab.id} is now at ${wc.getURL()}. Call read_page to see the result.`);
  });

  tool('type', 'Type text into a field (by its number from read_page). Replaces what is there unless append is true.', {
    ref: z.number().int(),
    text: z.string(),
    submit: z.boolean().optional().describe('Press Enter afterwards.'),
    append: z.boolean().optional(),
    tab_id: tabArg,
  }, async ({ ref, text: value, submit, append, tab_id }) => {
    const tab = resolve(tab_id, { front: true });
    const wc = tab.view.webContents;
    const p = await refCenter(wc, ref);
    await clickAt(wc, p.x, p.y);
    await sleep(60);
    if (!append) {
      await inPage(wc, `(() => {
        const el = (window.__webberRefs || [])[${Number(ref) - 1}];
        if (!el) return;
        el.focus();
        if ('select' in el && typeof el.select === 'function') el.select();
        else document.execCommand('selectAll');
      })()`);
    }
    await wc.insertText(value);
    if (submit) { pressKey(wc, 'Enter'); await settle(wc); }
    return text(`Typed into [${ref}]${submit ? ' and pressed Enter' : ''}.`);
  });

  tool('select_option', 'Choose an option in a dropdown (<select>) by its visible text or value.', {
    ref: z.number().int(), option: z.string(), tab_id: tabArg,
  }, async ({ ref, option, tab_id }) => {
    const tab = resolve(tab_id);
    const ok = await inPage(tab.view.webContents, `(() => {
      const el = (window.__webberRefs || [])[${Number(ref) - 1}];
      if (!el || el.tagName !== 'SELECT') return 'not a dropdown';
      const want = ${JSON.stringify(option)}.toLowerCase();
      const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
        || [...el.options].find((o) => o.text.toLowerCase().includes(want));
      if (!opt) return 'no option matching';
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok:' + opt.text.trim();
    })()`);
    if (!String(ok).startsWith('ok:')) return fail(`Couldn't select: ${ok}.`);
    return text(`Selected "${String(ok).slice(3)}" in [${ref}].`);
  });

  tool('press_key', 'Press a key or shortcut in a tab, e.g. "Enter", "Escape", "PageDown", "ctrl+a".', {
    key: z.string(), tab_id: tabArg,
  }, async ({ key, tab_id }) => {
    const tab = resolve(tab_id, { front: true });
    const wc = tab.view.webContents;
    wc.focus();
    pressKey(wc, key);
    await settle(wc);
    return text(`Pressed ${key}.`);
  });

  tool('scroll', 'Scroll a tab up or down by about a screen, to the top/bottom, or to an element.', {
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
    ref: z.number().int().optional().describe('Scroll this element into view instead.'),
    tab_id: tabArg,
  }, async ({ direction = 'down', ref, tab_id }) => {
    const tab = resolve(tab_id);
    const wc = tab.view.webContents;
    if (ref) await refCenter(wc, ref);
    else {
      await inPage(wc, {
        up: 'scrollBy(0, -innerHeight * 0.85)', down: 'scrollBy(0, innerHeight * 0.85)',
        top: 'scrollTo(0, 0)', bottom: 'scrollTo(0, document.documentElement.scrollHeight)',
      }[direction]);
    }
    await sleep(250);
    return text('Scrolled. Call read_page to see what is on screen now.');
  });

  tool('screenshot', 'Take a screenshot of a tab (brings it to the front first).', { tab_id: tabArg }, async ({ tab_id }) => {
    const tab = resolve(tab_id, { front: true });
    await sleep(250);
    let img = await tab.view.webContents.capturePage();
    const { width } = img.getSize();
    if (width > 1280) img = img.resize({ width: 1280, quality: 'good' });
    return { content: [{ type: 'image', data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' }] };
  }, { readOnlyHint: true });

  tool('wait_for', 'Wait until some text appears on a page (up to 20 seconds).', {
    text: z.string(), tab_id: tabArg, timeout_seconds: z.number().optional(),
  }, async ({ text: needle, tab_id, timeout_seconds }) => {
    const tab = resolve(tab_id);
    const wc = tab.view.webContents;
    const end = Date.now() + Math.min(timeout_seconds || 10, 20) * 1000;
    while (Date.now() < end) {
      const found = await inPage(wc, `(document.body && document.body.innerText || '').toLowerCase().includes(${JSON.stringify(needle.toLowerCase())})`).catch(() => false);
      if (found) return text(`Found "${needle}".`);
      await sleep(400);
    }
    return fail(`"${needle}" didn't appear.`);
  }, { readOnlyHint: true });

  tool('run_javascript', 'Run JavaScript in the page and return the result (JSON). Use for things the other tools can\'t do.', {
    code: z.string().describe('An expression, or statements ending in a return inside an async function body.'),
    tab_id: tabArg,
  }, async ({ code, tab_id }) => {
    const tab = resolve(tab_id);
    const wrapped = `(async () => { ${/\breturn\b/.test(code) ? code : `return (${code});`} })().then((v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } })`;
    const result = await tab.view.webContents.executeJavaScript(wrapped, true);
    return text(result === undefined ? 'undefined' : String(result).slice(0, MAX_TEXT));
  });

  tool('search_history', 'Search the pages the user has visited in Webber.', {
    query: z.string(), limit: z.number().int().optional(),
  }, async ({ query, limit }) => {
    const rows = browser.searchHistory(query, Math.min(limit || 15, 50));
    if (!rows.length) return text('Nothing in history matches.');
    return text(rows.map((h) => `${h.title || h.url}\n    ${h.url}  (visited ${h.visits}×, last ${new Date(h.last).toLocaleString()})`).join('\n'));
  }, { readOnlyHint: true });

  return server;
}

// ---------------------------------------------------------------- HTTP
function createConnector(browser) {
  let httpServer = null;
  let config = null;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }

    // Browsers always send Origin on cross-site requests; Claude's clients don't.
    if (req.headers.origin) { res.writeHead(403).end('Requests from web pages are not allowed.'); return; }
    if (req.headers.authorization !== `Bearer ${config.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Missing or wrong access key. Copy the setup command from Webber again.' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 5e6) { res.writeHead(413).end(); return; }
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('Bad JSON'); return; }

    // Stateless: a fresh server per request keeps things simple and robust.
    const server = buildServer(browser);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
    browser.onActivity();
  }

  return {
    start(cfg) {
      config = cfg;
      if (httpServer) return Promise.resolve();
      return new Promise((resolve, reject) => {
        httpServer = http.createServer((req, res) => {
          handle(req, res).catch((err) => {
            console.error('[webber] connector error:', err);
            if (!res.headersSent) res.writeHead(500).end();
          });
        });
        httpServer.once('error', (err) => { httpServer = null; reject(err); });
        httpServer.listen(cfg.port, '127.0.0.1', () => resolve());
      });
    },
    stop() {
      if (!httpServer) return;
      httpServer.close();
      httpServer.closeAllConnections?.();
      httpServer = null;
    },
    get running() { return !!httpServer; },
    update(cfg) { config = cfg; },
  };
}

module.exports = { createConnector };
