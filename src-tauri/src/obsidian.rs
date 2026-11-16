use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}};

fn err<E: ToString>(e: E) -> String { e.to_string() }

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 12 { return; }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if name.starts_with('.') || name == "node_modules" { continue; }
            walk(&p, out, depth + 1);
        } else if p.extension().map(|x| x == "md").unwrap_or(false) {
            out.push(p);
        }
    }
}

fn open_task(line: &str) -> Option<String> {
    let t = line.trim_start();
    for p in ["- [ ] ", "* [ ] ", "+ [ ] "] {
        if let Some(r) = t.strip_prefix(p) { return Some(r.to_string()); }
    }
    None
}

fn due_of(body: &str) -> Option<String> {
    let i = body.find('📅')?;
    let rest = body[i + '📅'.len_utf8()..].trim_start();
    let d: String = rest.chars().take(10).collect();
    let b = d.as_bytes();
    if d.len() == 10 && b[4] == b'-' && b[7] == b'-' && d.chars().filter(|c| c.is_ascii_digit()).count() == 8 { Some(d) } else { None }
}

#[tauri::command]
pub fn obsidian_scan(vault: String) -> Result<Value, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() { return Err("Vault folder not found".into()); }
    let mut files = vec![];
    walk(&root, &mut files, 0);
    let mut out = vec![];
    for f in files {
        let Ok(txt) = fs::read_to_string(&f) else { continue };
        for (i, line) in txt.lines().enumerate() {
            let Some(body) = open_task(line) else { continue };
            if body.contains('🔁') { continue; }
            let Some(due) = due_of(&body) else { continue };
            let title = body.split(|c| "📅⏳🛫🔁⏫🔼🔽➕✅".contains(c)).next().unwrap_or("").trim().to_string();
            out.push(json!({
                "path": f.to_string_lossy(), "line": i, "text": line.trim(), "title": title, "due": due,
                "note": f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
            }));
        }
        if out.len() > 2000 { break; }
    }
    Ok(Value::Array(out))
}

#[tauri::command]
pub fn obsidian_complete(vault: String, path: String, line: usize, text: String, today: String) -> Result<(), String> {
    let root = fs::canonicalize(&vault).map_err(err)?;
    let file = fs::canonicalize(&path).map_err(err)?;
    if !file.starts_with(&root) { return Err("File is outside the vault".into()); }
    let content = fs::read_to_string(&file).map_err(err)?;
    let mut lines: Vec<String> = content.split('\n').map(String::from).collect();
    let idx = if lines.get(line).map(|l| l.trim() == text).unwrap_or(false) { Some(line) } else { lines.iter().position(|l| l.trim() == text) };
    let i = idx.ok_or("The task changed in the note. Scan again and retry.")?;
    let cr = lines[i].ends_with('\r');
    let mut nl = lines[i].trim_end_matches('\r').replacen("[ ]", "[x]", 1);
    if !nl.contains('✅') { nl.push_str(&format!(" ✅ {today}")); }
    if cr { nl.push('\r'); }
    lines[i] = nl;
    let tmp = file.with_extension("md.zrtmp");
    fs::write(&tmp, lines.join("\n")).map_err(err)?;
    fs::rename(&tmp, &file).map_err(err)
}

#[tauri::command]
pub fn obsidian_daily(vault: String, folder: String, date: String, content: String) -> Result<(), String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() { return Err("Vault folder not found".into()); }
    if folder.contains("..") || !date.chars().all(|c| c.is_ascii_digit() || c == '-') { return Err("Invalid folder or date".into()); }
    let f = folder.trim_matches(|c| c == '/' || c == '\\');
    let dir = if f.is_empty() { root } else { root.join(f) };
    fs::create_dir_all(&dir).map_err(err)?;
    let file = dir.join(format!("{date}.md"));
    const A: &str = "<!-- zr-tasks:start -->";
    const B: &str = "<!-- zr-tasks:end -->";
    let block = format!("{A}\n{content}\n{B}");
    let new = match fs::read_to_string(&file) {
        Ok(old) => match (old.find(A), old.find(B)) {
            (Some(a), Some(b)) if b > a => format!("{}{}{}", &old[..a], block, &old[b + B.len()..]),
            _ => format!("{}\n\n{}\n", old.trim_end(), block),
        },
        Err(_) => format!("{block}\n"),
    };
    fs::write(&file, new).map_err(err)
}

#[tauri::command]
pub fn fs_write(path: String, content: String) -> Result<(), String> { fs::write(path, content).map_err(err) }

#[tauri::command]
pub fn fs_read(path: String) -> Result<String, String> { fs::read_to_string(path).map_err(err) }
