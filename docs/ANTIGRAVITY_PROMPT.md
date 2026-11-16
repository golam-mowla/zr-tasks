# Master prompt for Antigravity — paste this whole file as your first message

**Starter code already exists** in `src/` and `src-tauri/` (Google login, today view, task tick/add/clear, 10-min reminders, tray). Read it first, fix anything that fails to compile, it also has a first pass of the startup popup, reminder snooze, timed tasks, quick add (Ctrl+Alt+Z), offline queue, settings and event creation. Compile it, test each feature, fix bugs, then build the Calendar, Tasks and Reminders pages. Keep the code lean.

You are a senior desktop-app engineer. Build **ZR tasks** completely, phase by phase, from this spec.
Open `/design` first and match it faithfully. Port the CSS variables from the HTML files as they are (light and dark).
Do not invent Google API fields: check the official docs when unsure. Commit after every phase.

## What it is
A fast, lightweight Windows desktop app that syncs Google Calendar and Google Tasks, shows a "today" popup at startup, and sends reminders.
Target machine: 8GB RAM, entry-level laptop. Keep it light.

## Stack (fixed)
- Tauri v2 (Rust) + Vite + vanilla TypeScript. No React or other heavy framework.
- Official Tauri plugins: autostart, notification, global-shortcut, single-instance, store, window-state, opener. Check current docs for the exact v2 setup.
- Local cache: SQLite (tauri-plugin-sql or rusqlite).
- Google login: OAuth 2.0 for desktop apps, PKCE, loopback redirect on 127.0.0.1 with a random free port. Tokens go in the OS credential store (`keyring` crate), never in plain files or logs.
- Client ID and secret come from `.env` (see `.env.example`). Never commit `.env`.

## Windows
1. Main window = `design/zr_tasks_dashboard.html` wired to real data. Closing it hides to tray and frees the webview (destroy and recreate on demand).
2. Startup popup = the "Startup popup" card in `design/zr_tasks_system_ui.html`. Frameless, always on top, bottom-right, created on demand, closes on Esc or click away.
3. Tray menu = the "Tray menu" card (Today, Quick add task, Sync now, Launch at login, Theme, Settings, Quit). Left click opens the popup.
4. Notification = the "Reminder notification" card. Use native OS notifications first. If native action buttons (Snooze 5 min, Dismiss) are not supported, show the small custom always-on-top toast window from the design.
5. Theme: system, light or dark. Saved in the store plugin. Toggle button is already in the dashboard top bar.

## Phase 1 — read and show
- Google login and reconnect flow; sign out.
- Fetch events for today to +7 days (`singleEvents=true`, `orderBy=startTime`). Handle all-day events (`start.date`).
- Fetch tasks from all task lists: due today, overdue, and recently completed.
- Wire the dashboard: counts, task list, events, Connected accounts, sync pill.
- Startup popup at login, tray, autostart, single instance.

## Phase 2 — reminders
- Local scheduler built from the cache. Default lead time 10 min before an event, plus at start time. Configurable (5, 10, 15, 30).
- The Tasks API stores the date only. For timed tasks, save the time as a line `⏰ HH:MM` at the top of the task notes and read it back. Show it as the task time.
- Snooze (5 min, 10 min, 30 min, 1 hour), quiet hours, Do Not Disturb toggle.
- Remember what already fired so nothing repeats. After sleep or restart, fire missed reminders once.
- Evening review notification (default 9 PM, can be turned off).

## Phase 3 — write back
- Add, complete, uncomplete and delete tasks. "Clear completed" button works.
- Quick add with global hotkey `Ctrl+Alt+Z`, small input window, simple parsing: "call client tomorrow 5pm".
- Create a Calendar event from the app.
- Optimistic UI plus an offline queue that retries when the connection returns.

## Phase 4 — polish
- Overdue section and amber badge, Today / Tomorrow / Week switch, search.
- Tray tooltip shows "3 events · 4 tasks left".
- Settings view: theme, launch at login, startup popup on/off, sync interval, reminder lead time, quiet hours, sound, sign out.

## Sync rules
- Poll every 2 min while a window is open, every 5 min in the background. No polling while offline.
- Each poll re-fetches the window (today to +7 days) — simple and cheap. Do not use Calendar `syncToken` together with `timeMin` or `timeMax` (not allowed together).
- Tasks: fetch with `updatedMin` where possible; the API has no incremental sync token.
- On `invalid_grant`, show a "Reconnect Google" banner. Do not crash.
- Scopes: `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/tasks`.

## Performance and privacy
- Create windows on demand, destroy when closed. No animation loops. No telemetry. All data stays on this PC.

## Repo layout
```
src/            vanilla TS front end (dashboard, popup, quick-add, toast)
src-tauri/      Rust: auth, google api, scheduler, tray, plugins
design/         reference HTML (do not ship)
docs/           this file
.github/workflows/build.yml
```

## Done when
- Fresh install: login works, popup shows at next Windows login, tray works.
- A reminder fires on time, snooze works, and nothing fires twice.
- Light and dark theme both match the design.
- `npm run tauri build` makes a Windows installer.
- README explains setup. Report anything you could not verify.
