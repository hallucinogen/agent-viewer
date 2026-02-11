const express = require('express');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 4200;
const REGISTRY_FILE = path.join(__dirname, '.agent-registry.json');
const POLL_INTERVAL = 3000;
const SPAWN_PREFIX = 'agent-';

// ─── Agent Registry ──────────────────────────────────────────────────────────

let registry = {};
const nonClaudeCache = new Map(); // sessionName -> timestamp (skip re-checking)

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load registry:', e.message);
    registry = {};
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (e) {
    console.error('Failed to save registry:', e.message);
  }
}

// ─── Label Generation (LLM-powered) ─────────────────────────────────────────

console.log('[LABEL] Using claude CLI for smart label generation');

function fallbackLabel(text) {
  if (!text) return 'task-' + Date.now().toString(36);
  const stop = new Set(['the','a','an','in','on','at','to','for','of','with','and','or','but','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','can','that','this','it','its','i','me','my','we','our','you','your','they','them','their','he','him','his','she','her','from','by','as','all','so','if','then','than','too','very','just','about','up','out','into','over','please','make']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w && !stop.has(w));
  return words.slice(0, 4).join('-') || 'task-' + Date.now().toString(36);
}

function callClaude(systemPrompt, userText) {
  return new Promise((resolve, reject) => {
    const prompt = `${systemPrompt}\n\n${userText}`;
    const escaped = prompt.replace(/'/g, "'\\''");
    exec(
      `echo '${escaped}' | claude --print --model haiku 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 },
      (err, stdout) => {
        if (err) {
          console.log(`[LABEL-CLI] Failed: ${err.message.substring(0, 100)}`);
          return reject(err);
        }
        const result = stdout.trim();
        console.log(`[LABEL-CLI] Response: "${result}"`);
        resolve(result);
      }
    );
  });
}

async function generateSmartLabel(text) {
  try {
    const raw = await callClaude(
      'Generate a short label (2-4 lowercase words, hyphenated, no quotes) summarizing this coding task. Reply with ONLY the label.',
      text.substring(0, 300)
    );
    // Sanitize: lowercase, hyphenated, no special chars
    const label = raw.toLowerCase().replace(/[^a-z0-9-\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (label && label.length > 2 && label.length < 60) return label;
  } catch (e) {
    console.log(`[LABEL] LLM fallback: ${e.message}`);
  }
  return fallbackLabel(text);
}

// Update a discovered agent's label from pane output (async, non-blocking)
async function refreshDiscoveredLabel(sessionName) {
  const reg = registry[sessionName];
  if (!reg || !reg.discovered || reg.labelRefreshed) return;

  const rawOutput = capturePaneOutput(sessionName, 30);
  const output = stripAnsi(rawOutput).trim();
  console.log(`[LABEL] Refreshing label for ${sessionName}, output length: ${output.length}`);
  if (!output || output.length < 20) {
    console.log(`[LABEL] Not enough output yet for ${sessionName}`);
    return;
  }

  reg.labelRefreshed = true;
  try {
    const label = await callClaude(
      'This is terminal output from a Claude Code AI agent working on a coding task. Generate a short label (2-4 lowercase words, hyphenated, no quotes) summarizing what this agent is doing. Reply with ONLY the label.',
      output.substring(0, 500)
    );
    console.log(`[LABEL] Haiku returned for ${sessionName}: "${label}"`);
    const clean = label.toLowerCase().replace(/[^a-z0-9-\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (clean && clean.length > 2 && clean.length < 60) {
      reg.label = clean;
      saveRegistry();
      console.log(`[LABEL] Discovered agent ${sessionName} labeled: ${clean}`);
    } else {
      console.log(`[LABEL] Rejected cleaned label: "${clean}"`);
    }
  } catch (e) {
    console.log(`[LABEL] Failed for ${sessionName}: ${e.message}`);
    reg.labelRefreshed = false; // Allow retry
  }
}

// ─── ANSI Stripping ──────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1B(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\([A-Z0-9])/g, '')
            .replace(/\x1B\[[\?]?[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1B[^[\]()][^\x1B]*/g, '')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// ─── Process Tree (for Claude detection) ─────────────────────────────────────

function buildProcessTree() {
  try {
    const psOutput = execSync('ps -ax -o pid= -o ppid= -o command=', {
      encoding: 'utf-8', timeout: 5000
    });
    const children = {};
    const commands = {};

    for (const line of psOutput.trim().split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (match) {
        const [, pid, ppid, cmd] = match;
        commands[pid] = cmd.trim();
        if (!children[ppid]) children[ppid] = [];
        children[ppid].push(pid);
      }
    }
    return { children, commands };
  } catch {
    return { children: {}, commands: {} };
  }
}

function hasClaudeDescendant(pid, tree) {
  const queue = [String(pid)];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const cmd = tree.commands[current] || '';
    // Match "claude" as a command (not "agent-viewer" or other incidental matches)
    if (/(?:^|\/)claude\s/.test(cmd) || /(?:^|\/)claude$/.test(cmd)) {
      return true;
    }

    const kids = tree.children[current] || [];
    queue.push(...kids);
  }
  return false;
}

// ─── Tmux Integration ────────────────────────────────────────────────────────

function listTmuxSessions() {
  try {
    const output = execSync(
      "tmux list-sessions -F '#{session_name}|#{session_activity}|#{session_created}' 2>/dev/null",
      { encoding: 'utf-8', timeout: 5000 }
    );
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [name, activity, created] = line.split('|');
      return { name, activity: parseInt(activity) * 1000, created: parseInt(created) * 1000 };
    });
  } catch {
    return [];
  }
}

function capturePaneOutput(sessionName, lines = 200) {
  try {
    const output = execSync(
      `tmux capture-pane -e -t ${sessionName} -p -S -${lines} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return output;
  } catch {
    return '';
  }
}

function getSessionPid(sessionName) {
  try {
    const output = execSync(
      `tmux list-panes -t ${sessionName} -F '#{pane_pid}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return parseInt(output.trim());
  } catch {
    return null;
  }
}

function getPaneCurrentPath(sessionName) {
  try {
    return execSync(
      `tmux display-message -t ${sessionName} -p '#{pane_current_path}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
  } catch {
    return '';
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll tmux pane until Claude Code is ready for input (showing prompt).
 * Returns true if ready, false if timed out.
 */
async function waitForClaudeReady(sessionName, timeoutMs = 30000) {
  const pollInterval = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));

    const rawOutput = capturePaneOutput(sessionName, 30);
    const output = stripAnsi(rawOutput);
    const lines = output.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) continue;

    const recentText = lines.slice(-8).map(l => l.trim()).join('\n');

    // Detect interactive prompts that block Claude startup and dismiss them.
    // IMPORTANT: Only auto-dismiss known STARTUP prompts, not user-facing
    // selection/multi-select prompts that happen during task execution.
    // Startup prompts have specific option text we can match on.
    const isTrustPrompt = /No, exit/i.test(recentText) && /Yes, I accept/i.test(recentText);
    const isSettingsError = /Exit and fix manually/i.test(recentText) && /Continue without/i.test(recentText);
    const isInfoPrompt = /Enter to confirm/i.test(recentText)
      && !isTrustPrompt && !isSettingsError
      // Don't auto-dismiss user selection prompts
      && !/space to select/i.test(recentText)
      && !/to navigate/i.test(recentText);

    if (isTrustPrompt || isSettingsError) {
      console.log(`[SPAWN] Startup prompt detected for ${sessionName}, selecting option 2...`);
      try {
        execSync(`tmux send-keys -t ${sessionName} Down`, { encoding: 'utf-8', timeout: 3000 });
        await new Promise(r => setTimeout(r, 200));
        execSync(`tmux send-keys -t ${sessionName} Enter`, { encoding: 'utf-8', timeout: 3000 });
      } catch (e) {
        console.log(`[SPAWN] Failed to dismiss prompt for ${sessionName}: ${e.message}`);
      }
      continue;
    }

    if (isInfoPrompt) {
      // Info-only prompts (e.g. Chrome extension notice): just press Enter
      console.log(`[SPAWN] Info prompt detected for ${sessionName}, pressing Enter...`);
      try {
        execSync(`tmux send-keys -t ${sessionName} Enter`, { encoding: 'utf-8', timeout: 3000 });
      } catch (e) {
        console.log(`[SPAWN] Failed to dismiss info prompt for ${sessionName}: ${e.message}`);
      }
      continue;
    }

    // If Claude is actively running a task, it's past startup prompts
    if (/esc to interrupt/i.test(recentText)) return true;

    // Check if Claude is showing its input prompt (ready for input)
    const lastLine = lines[lines.length - 1].trim();
    if (/^>\s*$/.test(lastLine) || /^❯\s*$/.test(lastLine) || /^❯\s+\S/.test(lastLine)) {
      return true;
    }

    // Also ready if showing common idle signals
    if (/what.*would.*like/i.test(recentText) || /can i help/i.test(recentText)) {
      return true;
    }
  }

  console.log(`[SPAWN] waitForClaudeReady timed out for ${sessionName} after ${timeoutMs}ms`);
  return false;
}

async function spawnAgent(projectPath, prompt) {
  // Expand ~ to home directory
  if (projectPath.startsWith('~')) {
    projectPath = path.join(os.homedir(), projectPath.slice(1));
  }
  // Resolve to absolute path
  projectPath = path.resolve(projectPath);

  // Use fallback label immediately for fast spawn, then upgrade via LLM async
  const quickLabel = fallbackLabel(prompt);
  const safeName = SPAWN_PREFIX + quickLabel.replace(/[^a-zA-Z0-9_-]/g, '-');

  // Deduplicate if name exists
  let finalName = safeName;
  const allSessions = listTmuxSessions();
  if (allSessions.find(s => s.name === finalName) || registry[finalName]) {
    finalName = safeName + '-' + Date.now().toString(36).slice(-4);
  }

  // Verify project path exists
  if (!fs.existsSync(projectPath)) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const claudeCmd = 'claude --chrome --dangerously-skip-permissions';
  const tmuxCmd = `tmux new-session -d -s ${finalName} -c "${projectPath}" '${claudeCmd}'`;

  console.log(`[SPAWN] quickLabel=${quickLabel} name=${finalName}`);
  console.log(`[SPAWN] projectPath=${projectPath}`);
  console.log(`[SPAWN] cmd: ${tmuxCmd}`);

  execSync(tmuxCmd, { encoding: 'utf-8', timeout: 10000 });

  // Verify the session started and is in the right directory
  setTimeout(() => {
    const actualPath = getPaneCurrentPath(finalName);
    console.log(`[SPAWN] session ${finalName} actual cwd: ${actualPath}`);
    if (actualPath && actualPath !== projectPath) {
      console.log(`[SPAWN] WARNING: cwd mismatch! expected=${projectPath} actual=${actualPath}`);
    }
  }, 1000);

  registry[finalName] = {
    label: quickLabel,
    projectPath,
    prompt,
    createdAt: Date.now(),
    state: 'running',
    initialPromptSent: false,
  };
  saveRegistry();

  // Async: upgrade label via LLM in background (UI updates via SSE)
  generateSmartLabel(prompt).then(smartLabel => {
    if (smartLabel !== quickLabel && registry[finalName]) {
      console.log(`[SPAWN] label upgraded: "${quickLabel}" → "${smartLabel}"`);
      registry[finalName].label = smartLabel;
      saveRegistry();
    }
  }).catch(e => {
    console.log(`[SPAWN] async label upgrade failed, keeping fallback: ${e.message}`);
  });

  if (prompt) {
    // Wait for Claude to be ready (past trust prompt) before sending
    waitForClaudeReady(finalName).then(ready => {
      if (!ready) {
        console.log(`[SPAWN] Claude not ready for ${finalName}, sending prompt anyway`);
      }
      console.log(`[SPAWN] sending initial prompt to ${finalName}: ${prompt.substring(0, 80)}...`);
      const sent = sendToAgent(finalName, prompt);
      console.log(`[SPAWN] send result: ${sent}`);
      if (registry[finalName]) {
        registry[finalName].initialPromptSent = true;
        saveRegistry();
      }
    });
  }

  return finalName;
}

function sendToAgent(sessionName, message) {
  try {
    const escaped = message.replace(/'/g, "'\\''");
    const keysCmd = `tmux send-keys -t ${sessionName} -l '${escaped}'`;
    console.log(`[SEND] to ${sessionName}: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
    console.log(`[SEND] keys cmd: ${keysCmd.substring(0, 120)}...`);
    execSync(keysCmd, { encoding: 'utf-8', timeout: 5000 });
    execSync(
      `tmux send-keys -t ${sessionName} Enter`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    console.log(`[SEND] success`);
    return true;
  } catch (e) {
    console.error(`[SEND] FAILED to ${sessionName}:`, e.message);
    return false;
  }
}

function killAgent(sessionName) {
  try {
    execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000
    });
  } catch {
    // Session might already be dead
  }
  if (registry[sessionName]) {
    registry[sessionName].state = 'completed';
    registry[sessionName].completedAt = Date.now();
    saveRegistry();
  }
}

// ─── State Detection ─────────────────────────────────────────────────────────

function detectAgentState(sessionName, sessionsCache) {
  const reg = registry[sessionName];
  if (!reg) return 'unknown';

  const session = sessionsCache
    ? sessionsCache.find(s => s.name === sessionName)
    : listTmuxSessions().find(s => s.name === sessionName);

  if (!session) return 'completed';

  const pid = getSessionPid(sessionName);
  if (!isProcessAlive(pid)) return 'completed';

  // Grace period: if a message was recently sent, treat as running
  // (Claude may not have started producing output yet)
  if (reg.lastMessageSentAt && (Date.now() - reg.lastMessageSentAt) < 10000) {
    return 'running';
  }

  const rawOutput = capturePaneOutput(sessionName, 50);
  const output = stripAnsi(rawOutput);
  const lines = output.split('\n').filter(l => l.trim() !== '');

  if (lines.length === 0) return 'running';

  const recentText = lines.slice(-8).map(l => l.trim()).join('\n');

  // Check for interactive TUI prompts FIRST (before "esc to interrupt"),
  // because Claude's status bar may show "esc to interrupt" while an
  // interactive selection/permission prompt is also visible.
  const interactivePromptPatterns = [
    /enter to select/i,                    // Single-select TUI prompt
    /space to select/i,                    // Multi-select TUI prompt
    /to navigate.*esc to cancel/i,         // General TUI selection hint
    /Allow\s+(once|always)/i,              // Permission prompt options
    /yes.*no.*always allow/i,             // Permission choice UI
    /ctrl.g to edit/i,                     // Plan approval prompt
  ];

  if (interactivePromptPatterns.some(p => p.test(recentText))) {
    return 'idle';
  }

  // Claude Code's status bar shows "esc to interrupt" only when actively running
  if (/esc to interrupt/i.test(recentText)) {
    return 'running';
  }

  // Filter out persistent UI elements (status bar, separators, empty prompt)
  // to find the actual last content line
  const uiNoise = [
    /bypass permissions/i,
    /shift.?tab to cycle/i,
    /ctrl.?t to hide/i,
    /^[─━═]+$/,
    /^❯\s*$/,
  ];
  const contentLines = lines.filter(l => !uiNoise.some(p => p.test(l.trim())));

  if (contentLines.length === 0) return 'running';

  const lastLine = contentLines[contentLines.length - 1].trim();

  const idlePatterns = [
    /^>\s*$/,
    /^>\s+$/,
    /^\$\s*$/,
    /^❯\s*$/,
    /^❯\s+\S/,                            // Prompt with previous input visible
    /has completed/i,
    /what.*would.*like/i,
    /anything.*else/i,
    /can i help/i,
    /waiting for input/i,
  ];

  if (idlePatterns.some(p => p.test(lastLine))) {
    return 'idle';
  }

  // Check last several content lines for signs Claude is waiting for user input
  // (permission prompts, questions, plan approvals, etc.)
  const recentContent = contentLines.slice(-8).map(l => l.trim()).join('\n');

  const waitingForInputPatterns = [
    /do you want to proceed/i,             // Plan/action approval
    /shall I proceed/i,                    // Asking to proceed
    /should I proceed/i,                   // Asking to proceed
    /approve|deny|reject/i,               // Approval prompt
    /\(y\/n\)/i,                           // y/n prompt
    /enter a value|enter to confirm/i,     // Input prompt
    /select.*option/i,                     // Selection prompt
    /choose.*from/i,                       // Choice prompt
    /press enter to send/i,               // Message input prompt
  ];

  if (waitingForInputPatterns.some(p => p.test(recentContent))) {
    return 'idle';
  }

  return 'running';
}

/**
 * Detect the type of interactive prompt Claude is showing (if any).
 * Returns: 'select' | 'multiselect' | 'permission' | 'yesno' | 'plan' | null
 */
function detectPromptType(sessionName) {
  const rawOutput = capturePaneOutput(sessionName, 50);
  const output = stripAnsi(rawOutput);
  const lines = output.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return null;

  const recentText = lines.slice(-20).map(l => l.trim()).join('\n');

  // Multi-select: "Space to select · Enter to confirm"
  if (/space to select/i.test(recentText) && /enter to confirm/i.test(recentText)) {
    return 'multiselect';
  }

  // Permission prompt: "Allow once" / "Allow always" / "Deny"
  if (/allow\s+(once|always)/i.test(recentText) && /deny/i.test(recentText)) {
    return 'permission';
  }

  // Plan approval: check BEFORE generic select since plan prompts also show "enter to select"
  if (/ctrl.g to edit/i.test(recentText) ||
      (/manually approve/i.test(recentText) && /\d\.\s/.test(recentText)) ||
      (/execute.*plan/i.test(recentText) && /\d\.\s/.test(recentText))) {
    return 'plan';
  }

  // Single select: "Enter to select · ↑/↓ to navigate"
  if (/enter to select/i.test(recentText) && /to navigate/i.test(recentText)) {
    return 'select';
  }

  // Yes/No prompt
  if (/\(y\/n\)/i.test(recentText) || (/yes.*no/i.test(recentText) && /do you want|shall i|should i/i.test(recentText))) {
    return 'yesno';
  }

  // Generic numbered options fallback (AskUserQuestion, menus, etc.)
  // Match if there are multiple numbered lines like "1. ...\n2. ..." in recent output
  const numberedLines = recentText.split('\n').filter(l => /^\s*\d+[.)]\s/.test(l));
  if (numberedLines.length >= 2) {
    return 'select';
  }

  return null;
}

const NOISE_PATTERNS = [
  /bypass permissions/i,
  /shift.?tab to cycle/i,
  /ctrl.?t to hide/i,
  /press enter to send/i,
  /waiting for input/i,
  /^[>❯$]\s*$/,
  /^\s*$/,
];

function getLastActivity(sessionName) {
  const rawOutput = capturePaneOutput(sessionName, 30);
  const lines = rawOutput.split('\n');

  // Collect last 3 meaningful lines (raw, with ANSI)
  const meaningful = [];
  for (let i = lines.length - 1; i >= 0 && meaningful.length < 3; i--) {
    const clean = stripAnsi(lines[i]).trim();
    if (!clean) continue;
    if (NOISE_PATTERNS.some(p => p.test(clean))) continue;
    meaningful.unshift(lines[i]);
  }
  return meaningful.join('\n');
}

function buildAgentInfo(sessionName, sessionsCache) {
  const reg = registry[sessionName] || {};
  const state = detectAgentState(sessionName, sessionsCache);

  if (registry[sessionName]) {
    // If transitioning to completed, kill the tmux session so it doesn't linger
    if (state === 'completed' && registry[sessionName].state !== 'completed') {
      try {
        execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, {
          encoding: 'utf-8', timeout: 5000
        });
      } catch {
        // Session might already be dead
      }
      registry[sessionName].completedAt = registry[sessionName].completedAt || Date.now();
    }
    registry[sessionName].state = state;
    if (state === 'idle' && !registry[sessionName].idleSince) {
      registry[sessionName].idleSince = Date.now();
    } else if (state !== 'idle') {
      delete registry[sessionName].idleSince;
      delete registry[sessionName].lastMessageSentAt;
    }
  }

  // Detect interactive prompt type for non-completed agents
  const promptType = state !== 'completed' ? detectPromptType(sessionName) : null;

  return {
    name: sessionName,
    label: reg.label || sessionName,
    projectPath: reg.projectPath || '',
    prompt: reg.prompt || '',
    state,
    promptType,
    createdAt: reg.createdAt || 0,
    idleSince: reg.idleSince || null,
    completedAt: reg.completedAt || null,
    lastActivity: state !== 'completed' ? getLastActivity(sessionName) : '',
    discovered: reg.discovered || false,
  };
}

// ─── Discovery + Aggregation ─────────────────────────────────────────────────

function getAllAgents() {
  const sessions = listTmuxSessions();
  const processTree = buildProcessTree();

  // Discover Claude sessions not yet in registry
  for (const session of sessions) {
    if (registry[session.name]) continue;

    // Check non-Claude cache (re-check every 30s)
    const cached = nonClaudeCache.get(session.name);
    if (cached && Date.now() - cached < 30000) continue;

    const panePid = getSessionPid(session.name);
    if (!panePid) continue;

    if (hasClaudeDescendant(panePid, processTree)) {
      registry[session.name] = {
        label: session.name,
        projectPath: getPaneCurrentPath(session.name),
        prompt: '',
        createdAt: session.created,
        state: 'running',
        discovered: true,
      };
      // Async: generate a smart label from pane output
      refreshDiscoveredLabel(session.name);
    } else {
      nonClaudeCache.set(session.name, Date.now());
    }
  }

  // Mark dead registry entries as completed
  const liveNames = new Set(sessions.map(s => s.name));
  for (const name of Object.keys(registry)) {
    if (!liveNames.has(name) && registry[name].state !== 'completed') {
      registry[name].state = 'completed';
      registry[name].completedAt = registry[name].completedAt || Date.now();
    }
  }

  // Retry label refresh for discovered agents still using session name as label
  for (const name of Object.keys(registry)) {
    const r = registry[name];
    if (r.discovered && r.label === name && !r.labelRefreshed && r.state !== 'completed') {
      refreshDiscoveredLabel(name);
    }
  }

  // Build agent info for all known sessions
  const agents = [];
  for (const name of Object.keys(registry)) {
    agents.push(buildAgentInfo(name, sessions));
  }

  saveRegistry();
  return agents;
}

// ─── API Routes ──────────────────────────────────────────────────────────────

app.get('/api/recent-projects', (req, res) => {
  try {
    const seen = new Map(); // path -> most recent createdAt
    for (const agent of Object.values(registry)) {
      if (agent.projectPath) {
        const existing = seen.get(agent.projectPath) || 0;
        const ts = agent.createdAt || 0;
        if (ts > existing) seen.set(agent.projectPath, ts);
      }
    }
    const sorted = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p);
    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agents', (req, res) => {
  try {
    res.json(getAllAgents());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents', async (req, res) => {
  try {
    const { projectPath, prompt } = req.body;
    if (!projectPath || !prompt) {
      return res.status(400).json({ error: 'projectPath and prompt are required' });
    }
    const name = await spawnAgent(projectPath, prompt);
    res.json({ name, status: 'spawned' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/send', (req, res) => {
  try {
    const { name } = req.params;
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const reg = registry[name];

    // If agent is completed/dead, re-spawn it in the same project
    if (reg && reg.state === 'completed') {
      const projectPath = reg.projectPath || '.';
      const claudeCmd = 'claude --chrome --dangerously-skip-permissions';

      execSync(
        `tmux new-session -d -s ${name} -c "${projectPath}" '${claudeCmd}'`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      reg.state = 'running';
      reg.prompt = message;
      delete reg.idleSince;
      delete reg.completedAt;
      saveRegistry();

      // Wait for Claude to be ready (past trust prompt) before sending
      waitForClaudeReady(name).then(ready => {
        if (!ready) {
          console.log(`[RESPAWN] Claude not ready for ${name}, sending prompt anyway`);
        }
        sendToAgent(name, message);
      });

      return res.json({ status: 'respawned' });
    }

    // Otherwise send to live session
    const success = sendToAgent(name, message);
    if (success) {
      if (reg) {
        reg.state = 'running';
        reg.lastMessageSentAt = Date.now();
        delete reg.idleSince;
        saveRegistry();
      }
      res.json({ status: 'sent' });
    } else {
      res.status(500).json({ error: 'Failed to send message' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// File upload - save locally and send path to agent
const UPLOAD_DIR = path.join(os.tmpdir(), 'agent-viewer-uploads');

app.post('/api/agents/:name/upload', (req, res) => {
  try {
    const { name } = req.params;

    // Collect raw body chunks
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';

        // Parse multipart boundary
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          return res.status(400).json({ error: 'Invalid multipart form' });
        }
        const boundary = boundaryMatch[1];
        const bodyStr = buf.toString('latin1');

        // Extract filename from Content-Disposition
        const filenameMatch = bodyStr.match(/filename="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : 'upload-' + Date.now();

        // Extract file content between headers and boundary
        const headerEnd = bodyStr.indexOf('\r\n\r\n');
        const fileStart = headerEnd + 4;
        const fileEnd = bodyStr.lastIndexOf('\r\n--' + boundary);
        const fileBytes = buf.slice(
          Buffer.byteLength(bodyStr.substring(0, fileStart), 'latin1'),
          Buffer.byteLength(bodyStr.substring(0, fileEnd), 'latin1')
        );

        // Save file
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const savePath = path.join(UPLOAD_DIR, `${Date.now()}-${filename}`);
        fs.writeFileSync(savePath, fileBytes);

        // Send file path to agent
        const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(filename);
        const msg = isImage
          ? `Look at this image and tell me what you see: ${savePath}`
          : `Read this file: ${savePath}`;

        sendToAgent(name, msg);

        if (registry[name]) {
          registry[name].state = 'running';
          delete registry[name].idleSince;
          saveRegistry();
        }

        res.json({ status: 'uploaded', path: savePath });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/agents/:name', (req, res) => {
  try {
    killAgent(req.params.name);
    res.json({ status: 'killed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove a completed agent from the registry (cleanup)
app.delete('/api/agents/:name/cleanup', (req, res) => {
  try {
    const { name } = req.params;
    if (!registry[name]) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (registry[name].state !== 'completed') {
      return res.status(400).json({ error: 'Agent is not completed' });
    }
    delete registry[name];
    saveRegistry();
    res.json({ status: 'cleaned' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove all completed agents from the registry
app.delete('/api/cleanup/completed', (req, res) => {
  try {
    let count = 0;
    for (const name of Object.keys(registry)) {
      if (registry[name].state === 'completed') {
        delete registry[name];
        count++;
      }
    }
    saveRegistry();
    res.json({ status: 'cleaned', count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send raw tmux keys (for interactive prompts: Up, Down, Space, Enter, Escape)
app.post('/api/agents/:name/keys', (req, res) => {
  try {
    const { name } = req.params;
    const { keys } = req.body;
    if (!keys) {
      return res.status(400).json({ error: 'keys is required' });
    }

    // Whitelist allowed key names to prevent injection
    const allowed = ['Up', 'Down', 'Space', 'Enter', 'Escape', 'Tab'];
    if (!allowed.includes(keys)) {
      return res.status(400).json({ error: `Invalid key. Allowed: ${allowed.join(', ')}` });
    }

    execSync(`tmux send-keys -t ${name} ${keys}`, { encoding: 'utf-8', timeout: 5000 });

    if (registry[name]) {
      registry[name].lastMessageSentAt = Date.now();
      saveRegistry();
    }

    res.json({ status: 'sent', key: keys });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send plan feedback: auto-navigate to "Type here" option, select it, type message, submit
app.post('/api/agents/:name/plan-feedback', async (req, res) => {
  try {
    const { name } = req.params;
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Read pane to find numbered options and locate "Type here" option
    const rawOutput = capturePaneOutput(name, 50);
    const output = stripAnsi(rawOutput);
    const lines = output.split('\n').map(l => l.trim()).filter(l => l !== '');
    const recentLines = lines.slice(-20);

    const optionLines = recentLines.filter(l => /^\d+[.)]\s/.test(l));
    const typeHereIdx = optionLines.findIndex(l => /type here/i.test(l));

    if (typeHereIdx < 0) {
      return res.status(400).json({ error: 'Could not find "Type here" option in plan prompt' });
    }

    // Navigate to top first (send enough Ups to be safe)
    for (let i = 0; i < optionLines.length + 2; i++) {
      execSync(`tmux send-keys -t ${name} Up`, { encoding: 'utf-8', timeout: 3000 });
      await new Promise(r => setTimeout(r, 50));
    }

    // Navigate down to the "Type here" option
    for (let i = 0; i < typeHereIdx; i++) {
      execSync(`tmux send-keys -t ${name} Down`, { encoding: 'utf-8', timeout: 3000 });
      await new Promise(r => setTimeout(r, 50));
    }

    // Select the option
    execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf-8', timeout: 3000 });

    // Wait for the text input to appear
    await new Promise(r => setTimeout(r, 500));

    // Type the feedback
    const escaped = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t ${name} -l '${escaped}'`, { encoding: 'utf-8', timeout: 5000 });

    // Submit
    execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf-8', timeout: 3000 });

    if (registry[name]) {
      registry[name].lastMessageSentAt = Date.now();
      saveRegistry();
    }

    console.log(`[PLAN-FEEDBACK] Sent to ${name} (option ${typeHereIdx}): ${message.substring(0, 80)}`);
    res.json({ status: 'sent', optionIndex: typeHereIdx });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agents/:name/output', (req, res) => {
  try {
    const raw = capturePaneOutput(req.params.name, 200);
    const clean = stripAnsi(raw);
    res.json({ output: clean, raw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Directory Browser ───────────────────────────────────────────────────────

app.get('/api/browse', (req, res) => {
  try {
    const dir = req.query.dir || os.homedir();
    const resolved = path.resolve(dir);

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: 'Not a valid directory' });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    res.json({
      current: resolved,
      parent: path.dirname(resolved),
      dirs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SSE Endpoint ────────────────────────────────────────────────────────────

const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcastAgents() {
  if (sseClients.size === 0) return;
  try {
    const agents = getAllAgents();
    const data = JSON.stringify({ type: 'agents', agents });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  } catch (e) {
    console.error('SSE broadcast error:', e.message);
  }
}

// ─── Server Start ────────────────────────────────────────────────────────────

loadRegistry();

app.listen(PORT, HOST === 'localhost' ? '127.0.0.1' : HOST, () => {
  console.log(`\n  AGENT VIEWER`);
  console.log(`  ════════════════════════════════`);
  console.log(`  Local:   http://localhost:${PORT}`);

  if (HOST === '0.0.0.0') {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  Network: http://${addr.address}:${PORT}`);
        }
      }
    }
  }

  console.log(`  ════════════════════════════════\n`);
});

setInterval(broadcastAgents, POLL_INTERVAL);
