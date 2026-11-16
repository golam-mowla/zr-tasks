use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use rand::{distributions::Alphanumeric, Rng};
use reqwest::Method;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
mod obsidian;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const SCOPE: &str = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks";
const TASKS: &str = "https://tasks.googleapis.com/tasks/v1";
const TOKEN: &str = "https://oauth2.googleapis.com/token";

struct DbState(Mutex<Connection>);

fn get_credentials(app: &AppHandle) -> (String, String) {
    // 1. Check process env vars
    let env_id = std::env::var("GOOGLE_CLIENT_ID").ok();
    let env_sec = std::env::var("GOOGLE_CLIENT_SECRET").ok();
    if let (Some(id), Some(sec)) = (env_id, env_sec) {
        if !id.trim().is_empty() && !sec.trim().is_empty() {
            return (id.trim().to_string(), sec.trim().to_string());
        }
    }

    // 2. Check compile-time option_env
    if let (Some(id), Some(sec)) = (
        option_env!("GOOGLE_CLIENT_ID"),
        option_env!("GOOGLE_CLIENT_SECRET"),
    ) {
        if !id.trim().is_empty() && !sec.trim().is_empty() {
            return (id.trim().to_string(), sec.trim().to_string());
        }
    }

    // 3. Check SQLite database kv table
    if let Some(state) = app.try_state::<DbState>() {
        if let Ok(conn) = state.0.lock() {
            let id: Option<String> = conn
                .query_row(
                    "SELECT val FROM kv WHERE key = 'google_client_id'",
                    [],
                    |r| r.get(0),
                )
                .ok();
            let sec: Option<String> = conn
                .query_row(
                    "SELECT val FROM kv WHERE key = 'google_client_secret'",
                    [],
                    |r| r.get(0),
                )
                .ok();
            if let (Some(i), Some(s)) = (id, sec) {
                if !i.trim().is_empty() && !s.trim().is_empty() {
                    return (i.trim().to_string(), s.trim().to_string());
                }
            }
        }
    }

    // 4. Check AppData .env
    if let Ok(app_dir) = app.path().app_data_dir() {
        let env_path = app_dir.join(".env");
        if let Ok(iter) = dotenvy::from_path_iter(&env_path) {
            let mut id = String::new();
            let mut sec = String::new();
            for item in iter.flatten() {
                match item.0.as_str() {
                    "GOOGLE_CLIENT_ID" => id = item.1,
                    "GOOGLE_CLIENT_SECRET" => sec = item.1,
                    _ => {}
                }
            }
            if !id.trim().is_empty() && !sec.trim().is_empty() {
                return (id.trim().to_string(), sec.trim().to_string());
            }
        }
    }

    // 5. Check exe dir .env
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let env_path = exe_dir.join(".env");
            if let Ok(iter) = dotenvy::from_path_iter(&env_path) {
                let mut id = String::new();
                let mut sec = String::new();
                for item in iter.flatten() {
                    match item.0.as_str() {
                        "GOOGLE_CLIENT_ID" => id = item.1,
                        "GOOGLE_CLIENT_SECRET" => sec = item.1,
                        _ => {}
                    }
                }
                if !id.trim().is_empty() && !sec.trim().is_empty() {
                    return (id.trim().to_string(), sec.trim().to_string());
                }
            }
        }
    }

    // 6. Check workspace .env
    if let Ok(iter) = dotenvy::from_path_iter(".env") {
        let mut id = String::new();
        let mut sec = String::new();
        for item in iter.flatten() {
            match item.0.as_str() {
                "GOOGLE_CLIENT_ID" => id = item.1,
                "GOOGLE_CLIENT_SECRET" => sec = item.1,
                _ => {}
            }
        }
        if !id.trim().is_empty() && !sec.trim().is_empty() {
            return (id.trim().to_string(), sec.trim().to_string());
        }
    }

    (String::new(), String::new())
}

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

fn net<E: ToString>(e: E) -> String {
    format!("NETWORK: {}", e.to_string())
}

fn rnd(n: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(n)
        .map(char::from)
        .collect()
}

fn store() -> Result<keyring::Entry, String> {
    keyring::Entry::new("zr-tasks", "google-refresh-token").map_err(err)
}

fn get_db_path(app: &AppHandle) -> std::path::PathBuf {
    let mut dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap());
    let _ = std::fs::create_dir_all(&dir);
    dir.push("zr_tasks.db");
    dir
}

fn init_db(app: &AppHandle) -> Result<Connection, String> {
    let path = get_db_path(app);
    let conn = Connection::open(path).map_err(err)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            val TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(err)?;
    Ok(conn)
}

#[tauri::command]
fn get_google_credentials(app: AppHandle) -> Result<Value, String> {
    let (id, sec) = get_credentials(&app);
    Ok(json!({ "client_id": id, "client_secret": sec }))
}

#[tauri::command]
fn set_google_credentials(
    app: AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    let id = client_id.trim().to_string();
    let sec = client_secret.trim().to_string();

    // 1. Save to SQLite
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO kv (key, val, updated_at) VALUES ('google_client_id', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET val = ?1, updated_at = ?2",
        params![id, now],
    )
    .map_err(err)?;
    conn.execute(
        "INSERT INTO kv (key, val, updated_at) VALUES ('google_client_secret', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET val = ?1, updated_at = ?2",
        params![sec, now],
    )
    .map_err(err)?;

    // 2. Set environment variables
    std::env::set_var("GOOGLE_CLIENT_ID", &id);
    std::env::set_var("GOOGLE_CLIENT_SECRET", &sec);

    // 3. Save to AppData .env
    if let Ok(app_dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&app_dir);
        let env_path = app_dir.join(".env");
        let content = format!("GOOGLE_CLIENT_ID={}\nGOOGLE_CLIENT_SECRET={}\n", id, sec);
        let _ = std::fs::write(env_path, content);
    }

    // 4. Save to workspace .env
    let content = format!("GOOGLE_CLIENT_ID={}\nGOOGLE_CLIENT_SECRET={}\n", id, sec);
    let _ = std::fs::write(".env", content);

    Ok(())
}

#[tauri::command]
fn save_cache(app: AppHandle, key: String, val: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO kv (key, val, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET val = ?2, updated_at = ?3",
        params![key, val, now],
    )
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn load_cache(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT val FROM kv WHERE key = ?1")
        .map_err(err)?;
    let mut rows = stmt.query(params![key]).map_err(err)?;
    if let Some(row) = rows.next().map_err(err)? {
        let val: String = row.get(0).map_err(err)?;
        Ok(Some(val))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn login(app: AppHandle) -> Result<(), String> {
    let (id, sec) = get_credentials(&app);
    if id.is_empty() || sec.is_empty() {
        return Err("MISSING_CREDENTIALS: Enter Google Client ID and Secret in Settings".into());
    }
    let verifier = rnd(64);
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    let state = rnd(16);
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(err)?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(err)?.port());
    let url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", id.clone()),
            ("redirect_uri", redirect.clone()),
            ("response_type", "code".to_string()),
            ("scope", SCOPE.to_string()),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256".to_string()),
            ("access_type", "offline".to_string()),
            ("prompt", "consent".to_string()),
            ("state", state.clone()),
        ],
    )
    .map_err(err)?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(err)?;
    let (mut sock, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| "Login timed out".to_string())?
        .map_err(err)?;
    let mut buf = vec![0u8; 4096];
    let n = sock.read(&mut buf).await.map_err(err)?;
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let path = req.split_whitespace().nth(1).unwrap_or("/");
    let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).map_err(err)?;
    let q: std::collections::HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    let _ = sock
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<h3>ZR tasks is connected. You can close this tab.</h3>",
        )
        .await;
    if q.get("state") != Some(&state) {
        return Err("Login state mismatch".into());
    }
    let code = q.get("code").ok_or("Google returned no code")?;
    let r: Value = reqwest::Client::new()
        .post(TOKEN)
        .form(&[
            ("code", code.as_str()),
            ("client_id", id.as_str()),
            ("client_secret", sec.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(net)?
        .json()
        .await
        .map_err(err)?;
    let rt = r["refresh_token"]
        .as_str()
        .ok_or_else(|| r["error_description"].as_str().unwrap_or("Google returned no refresh token"))?;
    store()?.set_password(rt).map_err(err)
}

#[tauri::command]
fn logout() -> Result<(), String> {
    store()?.delete_credential().map_err(err)
}

async fn access(app: &AppHandle) -> Result<String, String> {
    let rt = store()?.get_password().map_err(|_| "NOT_CONNECTED".to_string())?;
    let (id, sec) = get_credentials(app);
    if id.is_empty() || sec.is_empty() {
        return Err("MISSING_CREDENTIALS".to_string());
    }
    let r: Value = reqwest::Client::new()
        .post(TOKEN)
        .form(&[
            ("client_id", id.as_str()),
            ("client_secret", sec.as_str()),
            ("refresh_token", rt.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(net)?
        .json()
        .await
        .map_err(err)?;
    if let Some(err_code) = r.get("error").and_then(|v| v.as_str()) {
        if err_code == "invalid_grant" {
            return Err("RECONNECT_REQUIRED".to_string());
        }
        return Err(format!("AUTH_ERROR: {}", err_code));
    }
    r["access_token"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "NOT_CONNECTED".to_string())
}

async fn api(
    app: &AppHandle,
    method: Method,
    url: &str,
    q: &[(&str, &str)],
    body: Option<Value>,
) -> Result<Value, String> {
    let token = access(app).await?;
    let mut rb = reqwest::Client::new()
        .request(method, url)
        .bearer_auth(token)
        .query(q);
    if let Some(b) = body {
        rb = rb.json(&b);
    }
    let res = rb.send().await.map_err(net)?;
    if !res.status().is_success() {
        return Err(format!("Google API error {}", res.status()));
    }
    let txt = res.text().await.map_err(err)?;
    if txt.is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_str(&txt).map_err(err)
    }
}

async fn lists(app: &AppHandle) -> Result<Vec<Value>, String> {
    let l = api(app, Method::GET, &format!("{TASKS}/users/@me/lists"), &[], None).await?;
    Ok(l["items"].as_array().cloned().unwrap_or_default())
}

#[tauri::command]
async fn fetch_day(app: AppHandle, min: String, max: String) -> Result<Value, String> {
    let ev = api(
        &app,
        Method::GET,
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        &[
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("timeMin", min.as_str()),
            ("timeMax", max.as_str()),
        ],
        None,
    )
    .await?;
    let mut tasks = vec![];
    for l in lists(&app).await? {
        let id = l["id"].as_str().unwrap_or_default();
        let title = l["title"].as_str().unwrap_or("My Tasks");
        let t = api(
            &app,
            Method::GET,
            &format!("{TASKS}/lists/{id}/tasks"),
            &[("showCompleted", "true"), ("maxResults", "100")],
            None,
        )
        .await?;
        for mut x in t["items"].as_array().cloned().unwrap_or_default() {
            x["list"] = json!(id);
            x["listTitle"] = json!(title);
            tasks.push(x);
        }
    }
    Ok(json!({ "events": ev["items"], "tasks": tasks }))
}

#[tauri::command]
async fn set_task(app: AppHandle, list: String, id: String, done: bool) -> Result<(), String> {
    let body = if done {
        json!({"status": "completed"})
    } else {
        json!({"status": "needsAction", "completed": null})
    };
    api(&app, Method::PATCH, &format!("{TASKS}/lists/{list}/tasks/{id}"), &[], Some(body))
        .await
        .map(|_| ())
}

#[tauri::command]
async fn add_task(app: AppHandle, title: String, due: String, notes: Option<String>) -> Result<(), String> {
    let mut b = json!({"title": title, "due": due});
    if let Some(n) = notes {
        b["notes"] = json!(n);
    }
    api(&app, Method::POST, &format!("{TASKS}/lists/@default/tasks"), &[], Some(b))
        .await
        .map(|_| ())
}

#[tauri::command]
async fn delete_task(app: AppHandle, list: String, id: String) -> Result<(), String> {
    api(&app, Method::DELETE, &format!("{TASKS}/lists/{list}/tasks/{id}"), &[], None)
        .await
        .map(|_| ())
}

#[tauri::command]
async fn clear_done(app: AppHandle) -> Result<(), String> {
    for l in lists(&app).await? {
        let id = l["id"].as_str().unwrap_or_default();
        api(&app, Method::POST, &format!("{TASKS}/lists/{id}/clear"), &[], None).await?;
    }
    Ok(())
}

#[tauri::command]
fn is_startup() -> bool {
    std::env::args().any(|a| a == "--startup")
}

#[tauri::command]
fn show_main(app: AppHandle) {
    show(&app);
}

#[tauri::command]
async fn add_event(app: AppHandle, summary: String, start: String, end: String) -> Result<(), String> {
    api(
        &app,
        Method::POST,
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        &[],
        Some(json!({
            "summary": summary,
            "start": {"dateTime": start},
            "end": {"dateTime": end}
        })),
    )
    .await
    .map(|_| ())
}

#[tauri::command]
async fn delete_event(app: AppHandle, id: String) -> Result<(), String> {
    api(
        &app,
        Method::DELETE,
        &format!("https://www.googleapis.com/calendar/v3/calendars/primary/events/{id}"),
        &[],
        None,
    )
    .await
    .map(|_| ())
}

#[tauri::command]
async fn open_popup(app: AppHandle, query: String) -> Result<(), String> {
    for (label, w) in app.webview_windows() {
        if label.starts_with("popup") {
            let _ = w.destroy();
        }
    }
    let (w, h, center) = if query.contains("mode=add") {
        (440.0, 96.0, true)
    } else if query.contains("mode=remind") {
        (380.0, 240.0, false)
    } else {
        (380.0, 540.0, false)
    };
    let label = format!(
        "popup{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("popup.html?{query}").into()),
    )
    .title("ZR tasks")
    .inner_size(w, h)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(true)
    .build()
    .map_err(err)?;

    if let Ok(Some(m)) = win.primary_monitor() {
        let sf = m.scale_factor();
        let (sw, sh) = (m.size().width as f64 / sf, m.size().height as f64 / sf);
        let (x, y) = if center {
            ((sw - w) / 2.0, sh * 0.25)
        } else {
            (sw - w - 24.0, sh - h - 60.0)
        };
        let _ = win.set_position(tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)));
    }
    Ok(())
}

#[tauri::command]
fn update_tray(app: AppHandle, tooltip: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
    Ok(())
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let _ = dotenvy::dotenv();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _sc, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = open_popup(a, "mode=add".into()).await;
                        });
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--startup"]),
        ))
        .invoke_handler(tauri::generate_handler![
            obsidian::obsidian_scan,
            obsidian::obsidian_complete,
            obsidian::obsidian_daily,
            obsidian::fs_write,
            obsidian::fs_read,
            login,
            logout,
            fetch_day,
            set_task,
            add_task,
            delete_task,
            clear_done,
            add_event,
            delete_event,
            open_popup,
            is_startup,
            show_main,
            update_tray,
            save_cache,
            load_cache,
            get_google_credentials,
            set_google_credentials
        ])
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .setup(|app| {
            let conn = init_db(app.handle())?;
            app.manage(DbState(Mutex::new(conn)));

            if !std::env::args().any(|a| a == "--startup") {
                show(app.handle());
            }
            let _ = app.global_shortcut().register("ctrl+alt+z");
            if !cfg!(debug_assertions) {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            let today_item = MenuItem::with_id(app, "tray_today", "Today", true, None::<&str>)?;
            let add_item = MenuItem::with_id(app, "tray_add", "Quick add task", true, None::<&str>)?;
            let sync_item = MenuItem::with_id(app, "tray_sync", "Sync now", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let launch_item = MenuItem::with_id(app, "tray_launch", "Launch at login", true, None::<&str>)?;
            let theme_item = MenuItem::with_id(app, "tray_theme", "Theme: toggle", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "tray_settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &today_item,
                    &add_item,
                    &sync_item,
                    &sep,
                    &launch_item,
                    &theme_item,
                    &settings_item,
                    &quit_item,
                ],
            )?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ZR tasks")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "tray_today" => {
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = open_popup(a, "mode=today".into()).await;
                        });
                    }
                    "tray_add" => {
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = open_popup(a, "mode=add".into()).await;
                        });
                    }
                    "tray_sync" => {
                        let _ = app.emit("sync", ());
                    }
                    "tray_launch" => {
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_autostart::ManagerExt;
                            let enabled = a.autolaunch().is_enabled().unwrap_or(false);
                            if enabled {
                                let _ = a.autolaunch().disable();
                            } else {
                                let _ = a.autolaunch().enable();
                            }
                            let _ = a.emit("autolaunch_changed", !enabled);
                        });
                    }
                    "tray_theme" => {
                        let _ = app.emit("toggle-theme", ());
                    }
                    "tray_settings" => {
                        show(app);
                        let _ = app.emit("nav", "Settings");
                    }
                    "tray_quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        let a = tray.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = open_popup(a, "mode=today".into()).await;
                        });
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ZR tasks");
}
