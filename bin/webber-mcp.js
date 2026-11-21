#!/usr/bin/env node
'use strict';

// Bridge for MCP clients that launch connectors as a local program (Claude Desktop):
// relays JSON-RPC messages between stdin/stdout and the connector inside the running
// Webber app. It reads the port and access key from Webber's connector.json, so the
// config needs no secrets. Needs Node 18+ and nothing else.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

function configPath() {
  if (process.env.WEBBER_CONFIG) return process.env.WEBBER_CONFIG;
  const home = os.homedir();
  const appData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(appData, 'Webber', 'connector.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return null; }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

function replyError(msg, message) {
  if (msg && msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
}

async function relay(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const cfg = readConfig();
  if (!cfg || !cfg.token) return replyError(msg, `Webber's connector settings weren't found at ${configPath()}. Open Webber once first.`);
  if (!cfg.enabled) return replyError(msg, 'Webber is not letting Claude use it. In Webber, click the Claude button at the bottom of the sidebar and turn on "Let Claude Use Webber".');

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${cfg.token}`,
      },
      body: line,
    });
  } catch {
    return replyError(msg, 'Webber isn’t running. Open Webber and try again.');
  }

  const body = await res.text();
  if (!body.trim()) return;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const l of body.split('\n')) if (l.startsWith('data:')) process.stdout.write(l.slice(5).trim() + '\n');
    return;
  }
  try { send(JSON.parse(body)); } catch { replyError(msg, `Webber answered with HTTP ${res.status}: ${body.slice(0, 200)}`); }
}

const rl = readline.createInterface({ input: process.stdin });
const pending = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  const p = relay(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exit(0); });
