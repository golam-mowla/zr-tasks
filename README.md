# ZR tasks

> **Personal Workspace & Productivity Hub by [Golam Mowla](https://github.com/golam-mowla)**  
> Fast, lightweight Windows desktop app: Google Calendar + Google Tasks 2-way sync, Notion-style card dashboard, Obsidian vault integration, startup "Today" popup, system tray controls, and smart reminder alarms.

[![Release](https://img.shields.io/github/v/release/golam-mowla/zr-tasks?style=flat-square&color=6366F1)](https://github.com/golam-mowla/zr-tasks/releases/latest)
[![Author](https://img.shields.io/badge/Author-Golam%20Mowla-0EA5E9?style=flat-square)](https://github.com/golam-mowla)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

---

## 🚀 Key Features

1. **Google Calendar & Google Tasks 2-Way Sync**
   - OAuth 2.0 PKCE loopback redirect with Windows Credential Store (`keyring`) security.
   - Realtime 2-way synchronization between your Google account and local SQLite cache for instant offline access.
2. **Notion-Style UI & Card Dashboard**
   - Clean, modern Notion aesthetic with sticky viewport-pinned navigation.
   - High-contrast visual cards for *Overdue*, *Today Focus*, *Upcoming Events*, and *Obsidian Tasks*.
3. **Smart Overdue Drawer & 1-Click Reschedule**
   - Dedicated collapsible drawer for delayed tasks with quick actions (Reschedule to Today, Tomorrow, or Weekend).
4. **Obsidian Vault Markdown Integration**
   - Connect directly to your local Obsidian vault.
   - Reads `- [ ] Task 📅 YYYY-MM-DD` syntax and syncs completions seamlessly.
   - Writes today's agenda into `Daily/YYYY-MM-DD.md` without touching other notes.
5. **System Tray & Intelligent Reminder Alarms**
   - Global Quick Add (`Ctrl+Alt+Z`) popup with natural language parsing.
   - Configurable lead-time alerts (5, 10, 15, 30 min), customizable snooze, and evening review.
   - Frameless, bottom-right startup popup summarizing your day on login.

---

## 📥 Downloads (v0.2.2)

- **[ZR tasks v0.2.2 Setup (NSIS .exe)](https://github.com/golam-mowla/zr-tasks/releases/download/v0.2.2/ZR.tasks_0.2.2_x64-setup.exe)** — Recommended installer with automatic desktop and start menu shortcuts.
- **[ZR tasks v0.2.2 MSI (.msi)](https://github.com/golam-mowla/zr-tasks/releases/download/v0.2.2/ZR.tasks_0.2.2_x64_en-US.msi)** — Enterprise Windows Installer package.
- **[Portable Executable (zr-tasks.exe)](https://github.com/golam-mowla/zr-tasks/releases/download/v0.2.2/zr-tasks.exe)** — Standalone portable binary.

---

## 🛠️ Development & Building

### Prerequisites
1. Node.js LTS (v18+)
2. Rust & Cargo (via [rustup.rs](https://rustup.rs))
3. Microsoft C++ Build Tools ("Desktop development with C++")
4. WebView2 runtime (pre-installed on Windows 10/11)

### Setup & Run
```powershell
# 1. Clone repository
git clone https://github.com/golam-mowla/zr-tasks.git
cd zr-tasks

# 2. Install dependencies
npm install

# 3. Configure Google API keys
cp .env.example .env
# Edit .env with your GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET

# 4. Run in dev mode
npm run tauri dev

# 5. Build production installers
npm run tauri build
```

---

## 👤 Author & Publisher
- **Publisher**: **Golam Mowla**
- **GitHub**: [@golam-mowla](https://github.com/golam-mowla)
- **Email**: `golam589102@gmail.com`

Copyright © 2026 Golam Mowla. All rights reserved.
