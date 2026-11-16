# ZR tasks

Fast, lightweight Windows desktop app: Google Calendar + Google Tasks sync, startup "today" popup, reminders, tray, light and dark theme.

## Kit contents
- `design/zr_tasks_dashboard.html` — reference dashboard
- `design/zr_tasks_system_ui.html` — startup popup, reminder notification, tray menu
- `docs/ANTIGRAVITY_PROMPT.md` — project spec and phase breakdown
- `.github/workflows/build.yml` — builds the Windows installer on GitHub Actions
- `.env.example`, `.gitignore`

## Features implemented
- **Google OAuth 2.0 PKCE:** Loopback redirect on `127.0.0.1`, refresh tokens safely secured in Windows Credential Store (`keyring`).
- **SQLite Local Cache:** `rusqlite` bundled persistence for offline capability, instant cold startup UI, and fast popup loading.
- **Home View (Today):** Filter by Today, Tomorrow, or 7-Day window; overdue section with amber badges; upcoming events list; connected account live status.
- **Calendar View:** 7-day grouped agenda from Google Calendar with inline event creation and event deletion.
- **Tasks View:** Complete view across all Google Task lists with filters (All, Overdue, Today, Upcoming, Completed) and task deletion.
- **Reminders Engine & Scheduler:**
  - Lead time alerts (5, 10, 15, 30 min before events and timed tasks).
  - Timed tasks: `⏰ HH:MM` notes format.
  - Snooze actions: 5 min, 10 min, 30 min, 1 hour.
  - Do Not Disturb & Quiet hours filtering.
  - Evening review notification (default 9:00 PM).
  - De-duplication memory (`zr-fired`) to prevent repeat alerts.
- **Quick Add (`Ctrl+Alt+Z`):** Global shortcut popup with natural language parsing (`call client tomorrow 5pm` or `event: meeting 4pm`).
- **Startup Popup:** Frameless, always-on-top, bottom-right popup showing today's events, tasks, and overdue badges. Closes on Escape or click-away.
- **System Tray:** Full menu (Today, Quick add task, Sync now, Launch at login, Theme toggle, Settings, Quit). Left-click opens today's popup; dynamic tooltip shows remaining events and tasks.
- **Theme:** Matches design tokens in light and dark modes with system auto-detection and persistence.

## Step 1 — Install tools (Windows, one time)
1. Node.js LTS (nodejs.org)
2. Rust via rustup (rustup.rs)
3. Microsoft C++ Build Tools ("Desktop development with C++")
4. WebView2 runtime (pre-installed on Windows 11 / Windows 10)

## Step 2 — Google Cloud setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/) → New project `zr-tasks`.
2. Enable **Google Calendar API** and **Google Tasks API**.
3. OAuth consent screen → External → add scopes:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/tasks`
4. Add your own Google account as a Test user.
5. Credentials → Create credentials → OAuth client ID → application type **Desktop app**.
6. Copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into a `.env` file (copied from `.env.example`).
7. *(Optional)* When ready for permanent usage, click **Publish app** in the OAuth consent screen to avoid the 7-day token expiration.

## Step 3 — Run development build
1. Install dependencies:
   ```powershell
   npm install
   ```
2. Run in development mode:
   ```powershell
   npm run tauri dev
   ```
3. Click **Connect Google** in the top bar to authenticate. Your calendar events and tasks will sync immediately.

## Step 4 — Build Windows installer
To build the standalone Windows installer locally:
```powershell
npm run tauri build
```
The installer (`.msi` / `.exe`) will be generated in `src-tauri/target/release/bundle/`.

## Test checklist
- [x] Backend compilation (`cargo check`) & frontend build (`vite build`) passing cleanly
- [x] Google login (PKCE) flow with auto-reconnect banner
- [x] Startup popup matches system UI design, closes on Escape or click away
- [x] Tray menu with full controls & left-click popup trigger
- [x] Calendar 7-day agenda + add/delete event
- [x] Tasks full management across lists + add/tick/delete/clear
- [x] Reminder scheduler with lead time, snooze, quiet hours, and evening review
- [x] Light, dark, and system matching theme
