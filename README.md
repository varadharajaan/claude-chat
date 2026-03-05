<p align="center">
  <img src="https://img.shields.io/badge/Python-3.7+-3776AB?logo=python&logoColor=white" alt="Python 3.7+">
  <img src="https://img.shields.io/badge/Zero_Dependencies-success?logo=checkmarx&logoColor=white" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/LiteLLM_Proxy-localhost:5000-orange?logo=lightning&logoColor=white" alt="LiteLLM Proxy">
</p>

<h1 align="center">💬 Claude Chat</h1>

<p align="center">
  <strong>A beautiful, local web chat UI for Claude, GPT, Gemini and more — zero dependencies, pure vibes.</strong>
</p>

<p align="center">
  Connects to your local <a href="https://docs.litellm.ai/docs/">LiteLLM proxy</a> and gives you a claude.ai-like experience<br>
  with streaming responses, conversation history, image paste, model switching, and a built-in log viewer.<br>
  All from a single <code>python server.py</code>.
</p>

---

## 🏛️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          YOUR BROWSER                               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  index.html + app.js + styles.css                            │   │
│  │                                                              │   │
│  │  ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐    │   │
│  │  │ Chat Window │ │  Model   │ │  Theme   │ │  Log Panel │    │   │
│  │  │  (streaming)│ │ Selector │ │  Toggle  │ │  (tail)    │    │   │
│  │  └──────┬──────┘ └────┬─────┘ └──────────┘ └─────┬──────┘    │   │
│  └─────────┼─────────────┼───────────────────────────┼──────────┘   │
│            │             │                           │              │
└────────────┼─────────────┼───────────────────────────┼──────────────┘
             │             │                           │
         SSE stream    /v1/models              /api/logs
         /v1/chat/     (fetch list)            /api/conversations
         completions                           /api/backups
             │             │                           │
             ▼             ▼                           ▼
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│     LiteLLM Proxy :5000          │  │     Chat Server :8090            │
│                                  │  │                                  │
│  OpenAI-compatible gateway       │  │  Python stdlib HTTP server       │
│  ┌────────────────────────────┐  │  │  ┌────────────────────────────┐  │
│  │  /v1/models                │  │  │  │  Static file serving       │  │
│  │  /v1/chat/completions      │  │  │  │  (index.html, app.js..)    │  │
│  │  (streaming SSE)           │  │  │  ├────────────────────────────┤  │
│  └────────────┬───────────────┘  │  │  │  REST API                  │  │
│               │                  │  │  │  ├─ /api/conversations     │  │
│  ┌────────────▼───────────────┐  │  │  │  ├─ /api/logs              │  │
│  │  Model Router              │  │  │  │  └─ /api/backups           │  │
│  │  ┌───────┐ ┌───────────┐   │  │  │  └────────────┬───────────────┘  │
│  │  │Claude │ │GPT / Codex│   │  │  │               │                  │
│  │  │Opus   │ │5.x series │   │  │  │  ┌────────────▼───────────────┐  │
│  │  │Sonnet │ ├───────────┤   │  │  │  │  Data Layer (filesystem)   │  │
│  │  │Haiku  │ │  Gemini   │   │  │  │  │  ┌──────────────────────┐  │  │
│  │  └───────┘ │  2.5/3 Pro│   │  │  │  │  │ conversations/*.json │  │  │
│  │            └───────────┘   │  │  │  │  │ backups/snapshot_*   │  │  │
│  └────────────────────────────┘  │  │  │  │ chat-server.log      │  │  │
│               │                  │  │  │  └──────────────────────┘  │  │
└───────────────┼──────────────────┘  │  └────────────────────────────┘  │
                │                     └──────────────────────────────────┘
              ▼
┌────────────────────────────────┐
│   Cloud API Backends           │
│   (upstream model providers)   │
│                                │
│   Anthropic API (Claude)       │
│   OpenAI API (GPT)             │
│   Google API (Gemini)          │
└────────────────────────────────┘
```

**Data flow:** Browser → Chat Server `:8090` (static files + API) → LiteLLM Proxy `:5000` (model routing) → Cloud APIs

---

## ✨ Features at a Glance

| | Feature | Details |
|---|---|---|
| 🧠 | **Multi-model chat** | Claude Opus, Sonnet, Haiku · GPT-5.x Codex · Gemini · all via one dropdown |
| ⚡ | **Streaming responses** | Real-time SSE streaming with stop/cancel mid-generation |
| 🖼️ | **Image support** | Ctrl+V paste or drag & drop images into chat |
| 🌙 | **Dark / Light theme** | Gorgeous dark mode (default) + light mode with one click |
| 💾 | **Server-side history** | Conversations saved as JSON files — survives browser clears |
| 🔄 | **Rolling backups** | Auto-snapshot every 15 min, keeps 4 slots (1 hour of history) |
| 📋 | **Built-in log viewer** | Tail LiteLLM proxy & chat server logs from the UI |
| ⚠️ | **Fallback detection** | Notifies you when the backend silently routes to a different model |
| 🏥 | **Proxy health check** | Green/red dot indicator + toast for proxy status |
| 📝 | **Markdown rendering** | Headers, code blocks with copy button, tables, lists, blockquotes |
| 🛠️ | **Dev controller** | `devctl.py` — start/stop/restart/status/logs for both servers |
| 📦 | **Zero dependencies** | Pure HTML + CSS + JS frontend, Python stdlib backend. That's it. |

---

## 🚀 Quick Start

```bash
# 1. Start the chat server
python server.py

# 2. Open http://localhost:8090 in your browser
```

Make sure your LiteLLM proxy is running on `localhost:5000` (or change the proxy URL in the sidebar).

### Using the Dev Controller

```bash
# Start both servers (chat + proxy)
python devctl.py start

# Start just the chat server (silent, no terminal popup)
python devctl.py start chat

# Check what's running
python devctl.py status

# Restart everything
python devctl.py restart

# Tail logs (interleaved, colored)
python devctl.py logs

# Tail with grep
python devctl.py logs proxy -g error

# Stop everything
python devctl.py stop
```

---

## 📁 Project Structure

```
claude-chat/
├── index.html          Main chat UI
├── app.js              Chat client (streaming, models, conversations, themes)
├── styles.css          Dark/light themes, responsive layout, animations
├── server.py           Python HTTP server (API + static files)
├── devctl.py           Dev controller (start/stop/restart/status/logs)
├── logs.html           Dedicated full-screen log viewer
└── data/
    ├── chat-server.log         Server logs (auto-rotates at 5 MB)
    ├── conversations/          One JSON file per conversation
    │   ├── conv_17726...json
    │   └── ...
    └── backups/                Rolling snapshots
        ├── snapshot_1.json     Latest
        ├── snapshot_2.json     15 min ago
        ├── snapshot_3.json     30 min ago
        └── snapshot_4.json     45 min ago
```

---

## 🧠 Supported Models

Models are auto-discovered from your LiteLLM proxy. The dropdown groups them nicely:

| Group | Models |
|-------|--------|
| **Claude Opus** | Opus 4.6 (default), Opus 4.6 (1M context), Opus 4.5 |
| **Claude Sonnet** | Sonnet 4.6, Sonnet 4.6 (1M context), Sonnet 4.5, Sonnet 4 |
| **Claude Haiku** | Haiku 4.5 |
| **GPT Codex** | GPT-5.3-Codex, GPT-5.2-Codex, GPT-5.1-Codex, GPT-5.1-Codex-Mini |
| **GPT** | GPT-5.2, GPT-5.1, GPT-5 mini, GPT-4.1 |
| **Gemini** | Gemini 2.5 Pro, Gemini 3 Pro (Preview) |

- **1M context models** are listed first in each group
- **Dead models** that return errors are auto-hidden for 1 hour
- **New models** added to the proxy appear automatically on refresh

---

## ⚠️ Fallback Detection

When the backend silently routes your request to a different model than you selected (e.g., you pick `Sonnet 4` but the backend uses `Claude Sonnet 4.5`), a small amber warning appears next to the model dropdown:

> ⚠ Fallback: **Sonnet 4** → **Claude Sonnet 4.5**

It stays visible until you dismiss it or switch models.

---

## 🔌 API Endpoints

The chat server exposes these endpoints on `localhost:8090`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/conversations` | List all conversation summaries |
| `GET` | `/api/conversations/:id` | Get full conversation with messages |
| `POST` | `/api/conversations` | Save/update a conversation |
| `DELETE` | `/api/conversations/:id` | Delete a conversation |
| `POST` | `/api/conversations/import` | Bulk import from localStorage |
| `GET` | `/api/logs?source=proxy\|chat` | Tail log files with filtering |
| `GET` | `/api/logs/clear?source=proxy\|chat` | Clear a log file |
| `GET` | `/api/backups` | List available backup snapshots |
| `POST` | `/api/backups/snapshot` | Manually trigger a backup |
| `POST` | `/api/backups/restore` | Restore from a backup slot `{"slot": 1}` |

---

## 🎨 Theme

Two handcrafted themes with 30+ CSS variables each:

- **Dark** (default) — warm grays, amber accents, easy on the eyes
- **Light** — clean whites, sharp contrast, professional feel

Toggle with the sun/moon button in the sidebar footer. Your choice is remembered.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift + Enter` | New line |
| `Ctrl + V` | Paste image from clipboard |

---

## 🏗️ Tech Stack

**Frontend** — Pure HTML + Vanilla JS + CSS. No React, no build step, no npm.

**Backend** — Python 3.7+ standard library only. No Flask, no pip install.

**External** — Connects to any OpenAI-compatible API (LiteLLM proxy, OpenAI direct, etc.)

```
Dependencies: 0
Frameworks: 0
Build steps: 0
npm packages: 0
pip packages: 0
Config files: 0
```

---

## 📝 devctl.py Commands

```
python devctl.py start   [chat|proxy|all]     Start services (silent, no popup)
python devctl.py stop    [chat|proxy|all]     Stop services
python devctl.py restart [chat|proxy|all]     Restart services
python devctl.py status                       Show running status + health
python devctl.py logs    [chat|proxy|all]     Tail logs (colored, interleaved)
python devctl.py logs    [target] -g TERM     Tail with grep filter
python devctl.py logs    [target] --level L   Filter by level (error/warn/info)
python devctl.py clean                        Rotate & cleanup old log files
python devctl.py help                         Show usage
```

**Aliases:** `proxy` = `llm`, `chat` = `server`, default = `all`

---

## 🔧 Configuration

| Setting | Default | Where |
|---------|---------|-------|
| Chat server port | `8090` | `server.py` line 27 |
| Proxy URL | `http://localhost:5000` | Sidebar input (saved in browser) |
| Backup interval | 15 minutes | `server.py` line 35 |
| Backup slots | 4 | `server.py` line 36 |
| Log rotation size | 5 MB | `server.py` line 40 |
| Log retention | 7 days | `devctl.py` line 158 |

---

<p align="center">
  <sub>Built with nothing but Python and a browser. No frameworks were harmed in the making of this project.</sub>
</p>
