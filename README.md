<div align="center">
  <br/>
  <h1>🤖 AGENT OS</h1>
  <p><em>The Operating System for Autonomous Intelligence</em></p>
  
  <img src="https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/React-18-20232A?style=flat-square&logo=react&logoColor=61DAFB" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
  <br/><br/>
</div>

**AGENT OS** is a unified command centre for all your AI agents — real-time group chat, image generation, voice butler, memory galaxy, pipelines, kanban, and more. One HQ to manage every autonomous agent across every platform.

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🗣️ | **War Room** | Real-time group chat where the operator rallies colour-coded AI agents with @mentions |
| 🎙️ | **Apollo Voice** | KITT-inspired voice butler — real-time listening, OpenAI TTS, circular equalizer orb |
| 🎨 | **Image Studio** | Fal.ai FLUX generation cockpit with model picker, style presets, and session gallery |
| 🌌 | **Memory Galaxy** | 3D interactive star visualisation of every agent memory and conversation |
| 📋 | **Kanban** | Drag-and-drop task boards for agent workflow management |
| 🔗 | **Pipelines** | Multi-step automated agent pipelines |
| 🔌 | **Integrations** | Connect Hermes, ChatGPT, Claude, DeepSeek, Fal.ai, bridges |
| 📊 | **Mission Control** | Real-time agent metrics, telemetry, and health monitoring |
| 🖼️ | **Gallery** | Permanent workspace asset library for generated images and documents |

## 🚀 Quick Start

```bash
git clone https://github.com/findgriff/agent-os.git
cd agent-os
python3 -m server.app        # starts API on :8100
npm install && npm run dev   # starts SPA on :5173
```

## 🏗 Architecture

```
agent-os/
├── server/          # Python API (auth, agents, vault, studio, apollo, pipelines...)
│   ├── app.py       # Main server — all routes
│   ├── studio.py    # Fal.ai / ComfyUI image generation
│   ├── apollo.py    # Voice command processing
│   ├── vault.py     # Memory vault + Obsidian sync
│   └── ...
├── pages/           # React SPA pages
│   ├── WarRoom.tsx  # Group chat with agent @mentions
│   ├── Voice.tsx    # Apollo voice butler
│   ├── ImageStudio.tsx  # Image generation cockpit
│   └── ...
├── components/      # Shared UI components
└── lib/             # API client + state store
```

## 🛠 Stack

- **Backend:** Python 3.11+, SQLite, Web Audio API
- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite
- **AI:** DeepSeek V4 Flash, OpenAI TTS, Fal.ai FLUX
- **Infra:** Caddy, systemd, single-VPS deploy

## 📄 License

MIT © Craig Griff (Ares Sentinel Limited)
