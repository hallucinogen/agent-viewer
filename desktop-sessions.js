// Read-only view of Claude desktop app (Code tab) sessions.
// The desktop app keeps one metadata JSON per session and the CLI keeps the
// transcript as JSONL. This module never writes to either.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = process.env.DESKTOP_SESSIONS_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_AGE_MS = (Number(process.env.DESKTOP_MAX_AGE_HOURS) || 48) * 3600 * 1000;
const COMPLETED_AFTER_MS = (Number(process.env.DESKTOP_COMPLETED_AFTER_HOURS) || 12) * 3600 * 1000;
// A turn with no transcript write for this long is treated as stopped.
const STALE_TURN_MS = 30 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const NAME_PREFIX = 'desktop-';

const HIDDEN_FILE = path.join(__dirname, '.desktop-hidden.json');
let hidden = {};
try { hidden = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf-8')); } catch {}

const transcriptPathCache = new Map();
const tailCache = new Map(); // path -> { mtimeMs, size, entries }

function isDesktopName(name) {
  return typeof name === 'string' && name.startsWith(NAME_PREFIX);
}

function toName(sessionId) {
  return NAME_PREFIX + sessionId.replace(/^local_/, '');
}

function listMetaFiles() {
  const out = [];
  let accounts = [];
  try { accounts = fs.readdirSync(SESSIONS_DIR); } catch { return out; }
  for (const a of accounts) {
    let orgs = [];
    try { orgs = fs.readdirSync(path.join(SESSIONS_DIR, a)); } catch { continue; }
    for (const o of orgs) {
      const dir = path.join(SESSIONS_DIR, a, o);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (f.startsWith('local_') && f.endsWith('.json')) out.push(path.join(dir, f));
      }
    }
  }
  return out;
}

function readMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function findTranscript(meta) {
  const ids = [meta.lastAssistantCliSessionId, meta.cliSessionId].filter(Boolean);
  for (const id of ids) {
    const cached = transcriptPathCache.get(id);
    if (cached && fs.existsSync(cached)) return cached;
    for (const cwd of [meta.cwd, meta.originCwd].filter(Boolean)) {
      const p = path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      if (fs.existsSync(p)) { transcriptPathCache.set(id, p); return p; }
    }
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS_DIR); } catch {}
    for (const d of dirs) {
      const p = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
      if (fs.existsSync(p)) { transcriptPathCache.set(id, p); return p; }
    }
  }
  return null;
}

function readTail(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const cached = tailCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const start = Math.max(0, st.size - TAIL_BYTES);
  const buf = Buffer.alloc(st.size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf-8').split('\n');
  if (start > 0) lines.shift(); // first line is probably cut
  const entries = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain && e.message) entries.push(e);
    } catch {}
  }
  const result = { mtimeMs: st.mtimeMs, size: st.size, entries };
  tailCache.set(file, result);
  return result;
}

function detectState(meta, tail, now) {
  const last = tail && tail.entries[tail.entries.length - 1];
  const lastWrite = tail ? tail.mtimeMs : Number(meta.lastActivityAt) || 0;
  let state = 'idle';
  if (last) {
    const ended = last.type === 'assistant' &&
      ['end_turn', 'stop_sequence', 'max_tokens'].includes(last.message.stop_reason);
    if (!ended && now - lastWrite < STALE_TURN_MS) state = 'running';
  }
  if (meta.interruptedAwaitingPerson) state = 'idle';
  if (state === 'idle' && (meta.scheduledTaskId || now - lastWrite > COMPLETED_AFTER_MS)) {
    state = 'completed';
  }
  return { state, lastWrite };
}

// ─── Transcript rendering ───────────────────────────────────────────────

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', cyan: '\x1b[36m', amber: '\x1b[33m' };

function oneLine(s, max = 160) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function toolSummary(block) {
  const i = block.input || {};
  const name = String(block.name || 'tool').replace(/^mcp__.+?__/, '');
  const arg = i.description || i.command || i.file_path || i.path || i.pattern ||
    i.url || i.query || i.prompt || i.title || '';
  return `${name}(${oneLine(arg, 100)})`;
}

function renderEntries(entries) {
  const out = [];
  for (const e of entries) {
    const c = e.message.content;
    if (e.type === 'user') {
      if (typeof c === 'string') {
        if (!c.startsWith('<')) out.push(`${C.cyan}> ${oneLine(c, 400)}${C.reset}`);
        continue;
      }
      for (const b of c || []) {
        if (b.type === 'text' && !String(b.text).startsWith('<')) {
          out.push(`${C.cyan}> ${oneLine(b.text, 400)}${C.reset}`);
        } else if (b.type === 'tool_result' && b.is_error) {
          out.push(`${C.amber}  ⎿ error${C.reset}`);
        }
      }
    } else {
      for (const b of c || []) {
        if (b.type === 'text' && b.text.trim()) out.push(b.text.trim());
        else if (b.type === 'tool_use') out.push(`${C.green}● ${toolSummary(b)}${C.reset}`);
      }
    }
  }
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────

function listDesktopAgents() {
  const now = Date.now();
  const byId = new Map();
  for (const f of listMetaFiles()) {
    const m = readMeta(f);
    if (!m || !m.sessionId || m.isArchived) continue;
    if (now - (Number(m.lastActivityAt) || 0) > MAX_AGE_MS) continue;
    const prev = byId.get(m.sessionId);
    if (!prev || Number(m.lastActivityAt) > Number(prev.lastActivityAt)) byId.set(m.sessionId, m);
  }

  const titles = new Map([...byId.values()].map(m => [m.sessionId, m.title]));
  const agents = [];
  for (const m of byId.values()) {
    const transcript = findTranscript(m);
    const tail = transcript ? readTail(transcript) : null;
    const { state, lastWrite } = detectState(m, tail, now);
    const name = toName(m.sessionId);
    if (hidden[name] && hidden[name] >= lastWrite) continue;
    const lines = tail ? renderEntries(tail.entries.slice(-12)) : [];
    agents.push({
      name,
      label: m.title || m.sessionId,
      projectPath: m.cwd || '',
      prompt: '',
      model: m.model || null,
      state,
      promptType: null,
      createdAt: Number(m.createdAt) || 0,
      idleSince: state === 'idle' ? lastWrite : null,
      completedAt: state === 'completed' ? lastWrite : null,
      lastActivity: lines.slice(-3).map(l => l.split('\n').slice(-2).join('\n')).join('\n'),
      discovered: false,
      source: m.scheduledTaskId ? 'scheduled' : 'desktop',
      scheduledTaskId: m.scheduledTaskId || null,
      spawnedFromTitle: m.spawnedFrom ? (titles.get(m.spawnedFrom.sessionId || m.spawnedFrom) || null) : null,
      appLink: `claude://claude.ai/epitaxy/${m.sessionId}`,
      lastWrite,
    });
  }

  // Keep only the newest run of each scheduled task.
  const newestRun = new Map();
  for (const a of agents) {
    if (!a.scheduledTaskId) continue;
    const cur = newestRun.get(a.scheduledTaskId);
    if (!cur || a.lastWrite > cur.lastWrite) newestRun.set(a.scheduledTaskId, a);
  }
  return agents.filter(a => !a.scheduledTaskId || newestRun.get(a.scheduledTaskId) === a);
}

function getDesktopOutput(name) {
  for (const f of listMetaFiles()) {
    const m = readMeta(f);
    if (!m || toName(m.sessionId || '') !== name) continue;
    const transcript = findTranscript(m);
    const tail = transcript ? readTail(transcript) : null;
    const raw = tail ? renderEntries(tail.entries).slice(-300).join('\n\n') : '(no transcript found)';
    return { raw, output: raw.replace(/\x1b\[[0-9;]*m/g, '') };
  }
  return null;
}

function hideDesktopAgent(name, lastWrite) {
  hidden[name] = lastWrite || Date.now();
  try { fs.writeFileSync(HIDDEN_FILE, JSON.stringify(hidden)); } catch {}
}

module.exports = { isDesktopName, listDesktopAgents, getDesktopOutput, hideDesktopAgent };
