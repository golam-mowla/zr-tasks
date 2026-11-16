import { invoke } from '@tauri-apps/api/core';
import { open as openDlg, save as saveDlg } from '@tauri-apps/plugin-dialog';
import { getVersion } from '@tauri-apps/api/app';

const $ = (s: string) => document.querySelector(s) as HTMLElement | null;
const D = { evLen: 60, syncMin: 2, h24: false, obVault: '', obImport: true, obMark: true, obDaily: false, obFolder: 'Daily' };
let X = { ...D };
try { X = { ...D, ...JSON.parse(localStorage.getItem('zr-x') || '{}') }; } catch {}
const saveX = () => { try { localStorage.setItem('zr-x', JSON.stringify(X)); } catch {} };
const today = () => new Date().toLocaleDateString('en-CA');
function toast(m: string) { const t = $('#toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
}
const head = (t: string) => el('div', 'sec-h', t);
function row(label: string, ...ctl: HTMLElement[]) {
  const r = el('div', 'srow'), c = el('span');
  c.style.cssText = 'display:flex;gap:8px;align-items:center'; c.append(...ctl); r.append(el('span', '', label), c); return r;
}
function select(opts: [string, string][], val: string, on: (v: string) => void) {
  const s = el('select'); opts.forEach(([v, t]) => { const o = el('option', '', t); o.value = v; s.append(o); }); s.value = val; s.onchange = () => on(s.value); return s;
}
function check(val: boolean, on: (v: boolean) => void) { const c = el('input'); c.type = 'checkbox'; c.checked = val; c.onchange = () => on(c.checked); return c; }
function button(t: string, fn: () => void) { const b = el('button', 'btn', t); b.type = 'button'; b.onclick = fn; return b; }

let ob: any[] = [];
const vaultLabel = el('span', 'ob-meta'), status = el('span', 'ob-meta'), verEl = el('span', 'ob-meta', '0.2.0');
const showVault = () => (vaultLabel.textContent = X.obVault || 'Not set');
const panel = el('article', 'panel'), list = el('div');
panel.hidden = true;
panel.append(el('div', 'panel-title', 'Obsidian tasks'), el('div', 'panel-sub', 'Open tasks due today or overdue, from your vault'), list);

function renderOb() {
  const d = today();
  const due = ob.filter(t => t.due <= d).sort((a, b) => a.due.localeCompare(b.due));
  panel.hidden = !(X.obVault && X.obImport);
  list.replaceChildren();
  if (!due.length) list.append(el('div', 'ob-meta', 'Nothing due in your notes.'));
  due.slice(0, 30).forEach(t => {
    const item = el('label', 'task'), c = el('input', 'check');
    c.type = 'checkbox'; c.disabled = !X.obMark; c.title = X.obMark ? '' : 'Turn on “Mark done in note” in Settings';
    c.onchange = async () => {
      try {
        await invoke('obsidian_complete', { vault: X.obVault, path: t.path, line: t.line, text: t.text, today: d });
        ob = ob.filter(x => x !== t); renderOb(); toast('Marked done in note');
      } catch (e) { c.checked = false; toast(String(e)); }
    };
    const copy = el('span', 'task-copy');
    copy.append(el('div', 'task-name', t.title), el('div', 'task-meta', `${t.note} · ${t.due < d ? 'Overdue' : 'Today'}`));
    item.append(c, copy); list.append(item);
  });
  status.textContent = `${ob.length} open tasks with a due date`;
}
async function scan(manual = false) {
  if (!X.obVault || !X.obImport) { renderOb(); return; }
  try { ob = await invoke<any[]>('obsidian_scan', { vault: X.obVault }); renderOb(); if (manual) toast('Vault scanned'); }
  catch (e) { status.textContent = String(e); if (manual) toast(String(e)); }
}

let lastDaily = '';
async function writeDaily() {
  if (!X.obVault || !X.obDaily) return;
  try {
    const a = new Date(); a.setHours(0, 0, 0, 0); const b = new Date(a); b.setDate(b.getDate() + 1);
    const d: any = await invoke('fetch_day', { min: a.toISOString(), max: b.toISOString() });
    const day = today();
    const tm = (s: string) => new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: X.h24 ? false : undefined });
    const ev = (d.events ?? []).map((e: any) => `- ${e.start?.dateTime ? tm(e.start.dateTime) : 'All day'} ${e.summary || '(No title)'}`);
    const tk = (d.tasks ?? []).filter((t: any) => t.due && t.due.slice(0, 10) <= day).map((t: any) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.title}`);
    const content = ['## ZR tasks', '', '### Events', ...(ev.length ? ev : ['- None']), '', '### Tasks', ...(tk.length ? tk : ['- None'])].join('\n');
    if (content === lastDaily) return;
    lastDaily = content;
    await invoke('obsidian_daily', { vault: X.obVault, folder: X.obFolder, date: day, content });
  } catch { lastDaily = ''; }
}

async function exportBackup() {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith('zr-')) data[k] = localStorage.getItem(k) || ''; }
  const p = await saveDlg({ defaultPath: 'zr-tasks-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!p) return;
  try { await invoke('fs_write', { path: p, content: JSON.stringify(data, null, 2) }); toast('Backup saved'); } catch (e) { toast(String(e)); }
}
async function importBackup() {
  const p = await openDlg({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (typeof p !== 'string') return;
  try {
    const data = JSON.parse(await invoke<string>('fs_read', { path: p }));
    Object.entries(data).forEach(([k, v]) => { if (k.startsWith('zr-') && typeof v === 'string') localStorage.setItem(k, v); });
    toast('Backup restored'); setTimeout(() => location.reload(), 800);
  } catch { toast('That file isn’t a ZR tasks backup'); }
}
async function clearCache() {
  await invoke('save_cache', { key: 'events', val: '[]' }).catch(() => {});
  await invoke('save_cache', { key: 'tasks', val: '[]' }).catch(() => {});
  toast('Cache cleared'); setTimeout(() => location.reload(), 600);
}

function buildSettings() {
  const anchor = $('#sSyncNowBtn')?.parentElement; if (!anchor) return;
  const folder = el('input'); folder.type = 'text'; folder.value = X.obFolder; folder.style.width = '110px';
  folder.onchange = () => { X.obFolder = folder.value.trim(); saveX(); lastDaily = ''; };
  const box = el('div');
  box.append(
    head('Calendar and tasks'),
    row('Default event length', select([['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '1.5 hours']], String(X.evLen), v => { X.evLen = +v; saveX(); })),
    row('Time format', select([['12', '12 hour'], ['24', '24 hour']], X.h24 ? '24' : '12', v => { X.h24 = v === '24'; saveX(); toast('Applies after the next refresh'); })),
    row('Sync interval', select([['1', '1 min'], ['2', '2 min'], ['5', '5 min'], ['10', '10 min']], String(X.syncMin), v => { X.syncMin = +v; saveX(); toast('Applies after restart'); })),
    head('Obsidian'),
    row('Vault folder', vaultLabel, button('Browse', async () => {
      const p = await openDlg({ directory: true, multiple: false });
      if (typeof p === 'string') { X.obVault = p; saveX(); showVault(); scan(true); }
    })),
    row('Show tasks from notes', check(X.obImport, v => { X.obImport = v; saveX(); scan(); })),
    row('Mark done in note when ticked', check(X.obMark, v => { X.obMark = v; saveX(); renderOb(); })),
    row('Write today’s agenda to daily note', check(X.obDaily, v => { X.obDaily = v; saveX(); lastDaily = ''; writeDaily(); })),
    row('Daily note folder', folder),
    row('Status', status, button('Scan now', () => scan(true))),
    head('Data'),
    row('Backup', button('Export', exportBackup), button('Import', importBackup)),
    row('Local cache', button('Clear', clearCache)),
    head('About & Publisher'),
    row('App Name', el('span', '', 'ZR tasks — Personal Workspace')),
    row('Publisher', el('span', '', 'Golam Mowla')),
    row('Version', verEl),
    (() => {
      const card = el('div', 'form-card');
      card.style.cssText = 'background:var(--surface-2);border:1px solid var(--line-strong);border-radius:10px;padding:16px;margin:12px 0;line-height:1.5;';
      card.innerHTML = `
        <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px;color:var(--ink);margin-bottom:6px;">
          <span>🎯</span> <span>ZR tasks — এর কাজ কি? (About & Features)</span>
        </div>
        <div style="font-size:12px;color:var(--ink);margin-bottom:12px;line-height:1.5;">
          <strong>ZR tasks</strong> হলো একটি ফোকাসড পার্সোনাল প্রোডাক্টিভিটি অ্যাপ, যা তৈরি ও প্রকাশ করেছেন <strong>Golam Mowla</strong>। এর মূল উদ্দেশ্য হলো একাধিক অ্যাপ না ঘেঁটে আপনার Google Calendar এবং Google Tasks-এর সব কাজ এক স্ক্রিনে সাজিয়ে দেওয়া, জমে থাকা ওভারডিউ ব্যাকলগ দূর করা এবং কোনো অপ্রয়োজনীয় ডিস্ট্র্যাকশন ছাড়াই প্রতিদিনের লক্ষ্য অর্জনে সাহায্য করা।
        </div>
        <div style="display:grid;gap:8px;font-size:11px;color:var(--muted);">
          <div>⚡ <strong>Google Calendar & Tasks সিঙ্ক:</strong> ক্যালেন্ডার ইভেন্ট ও টাস্ক লিস্টের দ্বিমুখী লাইভ অটো-সিঙ্ক।</div>
          <div>🎯 <strong>Today Focus Dashboard:</strong> আজকের সবথেকে গুরুত্বপূর্ণ কাজ ও সময়সূচি সহজে ট্র্যাকিং।</div>
          <div>⚠️ <strong>স্মার্ট ওভারডিউ ড্রয়ার:</strong> পুরনো জমে থাকা ওভারডিউ কাজগুলো এক ক্লিকে আজকের তারিখে রিশিডিউল সুবিধা।</div>
          <div>📝 <strong>Obsidian Vault কানেকশন:</strong> লোকাল মার্কডাউন নোটস থেকে টাস্ক ইমপোর্ট ও অটো ডেইলি নোট তৈরি।</div>
          <div>🔔 <strong>স্মার্ট অ্যালার্ম ও ট্রে পপআপ:</strong> নির্ধারিত সময়ের আগে অ্যালার্ম, উইন্ডোজ স্টার্টআপ রান ও কুইক হটকি (Ctrl+Alt+Z)।</div>
        </div>
      `;
      return card;
    })(),
  );
  anchor.before(box);
}

buildSettings(); showVault();
$('#homeView .content-grid')?.after(panel);
getVersion().then(v => (verEl.textContent = v)).catch(() => {});
scan(); setTimeout(writeDaily, 8000);
setInterval(() => { scan(); writeDaily(); }, 600000);
