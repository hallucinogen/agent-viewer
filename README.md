# Agent Viewer

A kanban board for managing multiple Claude Code agents running in tmux sessions. Spawn, monitor, and interact with agents from a single web UI.

<img width="1466" height="725" alt="Screenshot 2026-02-09 at 14 54 21" src="https://github.com/user-attachments/assets/cd31b988-f649-4e92-9844-7a1ece9aa634" />

Manage your agents from your mobile phone with Tailscale

![IMG_7782](https://github.com/user-attachments/assets/c7298d61-dd37-4d0f-8b0a-d9d1f0231782)


## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [tmux](https://github.com/tmux/tmux)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` command available in your PATH)

### Install prerequisites (macOS)

```bash
brew install node tmux
npm install -g @anthropic-ai/claude-code
```

## Setup

```bash
git clone <repo-url> && cd agent-viewer
npm install
```

## Usage

```bash
npm start
```

Open http://localhost:4200 in your browser.

### Configuration

| Variable | Default     | Description              |
|----------|-------------|--------------------------|
| `PORT`   | `4200`      | Server port              |
| `HOST`   | `localhost`  | Bind address (`0.0.0.0` for network access) |

Example:

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

## Remote Access via Tailscale

You can access Agent Viewer from your phone (or any device) by using [Tailscale](https://tailscale.com/).

### 1. Install Tailscale on your Mac

```bash
brew install tailscale
```

Or download from [tailscale.com/download](https://tailscale.com/download).

### 2. Install Tailscale on your phone

Download the Tailscale app from the [App Store](https://apps.apple.com/app/tailscale/id1470499037) or [Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn). Sign in with the same account.

### 3. Start the server

```bash
npm start
```

The server binds to `0.0.0.0` by default, so it's already accessible on all network interfaces including Tailscale.

### 4. Open on your phone

Find your Mac's Tailscale IP (shown in the Tailscale app or via `tailscale ip`), then visit:

```
http://<tailscale-ip>:4200
```

If you have [MagicDNS](https://tailscale.com/kb/1081/magicdns) enabled, you can use your machine name instead:

```
http://<machine-name>:4200
```

## Features

- **Spawn agents** — Click `[+ SPAWN]` or press `N`, enter a project path and prompt. Each agent launches in its own tmux session running `claude`.
- **Kanban columns** — Agents are sorted into Running, Idle, and Completed columns based on their state.
- **Auto-discovery** — Existing tmux sessions running Claude are automatically detected and added to the board.
- **Live output** — Click `VIEW OUTPUT` to see the full terminal output with ANSI color rendering.
- **Send messages** — Type in the prompt field on any card and press `Ctrl+Enter` to send follow-up messages to an agent.
- **File uploads** — Drag and drop files onto a card or click `FILE` to send files to an agent.
- **Re-spawn** — Completed agents can be re-spawned with a new prompt from the same project directory.
- **Attach** — Click `ATTACH` to copy the `tmux attach` command for direct terminal access.
- **Claude desktop app sessions (macOS)** — Sessions from the Claude desktop app's Code tab show as read-only cards with an `APP` or `SCHEDULED` badge. Click `VIEW TRANSCRIPT` to read the conversation, or `OPEN IN APP` to jump to the session. Only the newest run of each scheduled task is shown.

### Desktop app sessions

Agent Viewer reads session metadata from `~/Library/Application Support/Claude/claude-code-sessions/` and transcripts from `~/.claude/projects/`. It never writes to these folders. You cannot send messages to or stop desktop sessions from the board.

| Variable | Default | Description |
|----------|---------|-------------|
| `DESKTOP_MAX_AGE_HOURS` | `48` | Hide desktop sessions with no activity for this long |
| `DESKTOP_COMPLETED_AFTER_HOURS` | `12` | Move an idle desktop session to Completed after this long |
| `DESKTOP_SESSIONS_DIR` | see above | Override the desktop session metadata folder |
