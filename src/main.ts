import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import './extras';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const root = document.documentElement;

type Ev = {
  id: string;
  summary?: string;
  description?: string;
  start: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

type Tk = {
  id: string;
  list: string;
  listTitle?: string;
  title: string;
  status: string;
  due?: string;
  notes?: string;
};

let events: Ev[] = [];
let tasks: Tk[] = [];
let connected = false;
let first = true;
let reconnectRequired = false;
let currentView = 'Home';
let homeFilter: 'today' | 'tomorrow' | 'week' = 'today';
let taskCategory: 'all' | 'overdue' | 'today' | 'upcoming' | 'completed' = 'all';
let searchQuery = '';

const pad = (n: number) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => {
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  return `${y}-${m}-${day}`;
};

const X = (): { evLen: number; syncMin: number; h24: boolean } => { try { return { evLen: 60, syncMin: 2, h24: false, ...JSON.parse(localStorage.getItem('zr-x') || '{}') }; } catch { return { evLen: 60, syncMin: 2, h24: false }; } };
const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: X().h24 ? false : undefined });
const load = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v !== null ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

const taskTime = (t: Tk) => /⏰\s?(\d{1,2}):(\d{2})/.exec(t.notes || '');

let S = {
  lead: 10,
  dnd: false,
  quiet: false,
  from: '22:00',
  to: '07:00',
  popup: true,
  theme: 'system',
  evening: true,
  eveningTime: '21:00',
  ...load<any>('zr-settings', {}),
};

let Q: { cmd: string; args: any }[] = load('zr-queue', []);
const fired = new Set<string>(load<string[]>('zr-fired', []));
const snoozed: Record<string, { until: number; title: string; time: string; src: string }> = load('zr-snoozed', {});
let eveningFiredDate: string = load('zr-evening-date', '');

function toast(m: string) {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout((window as any).tt);
  (window as any).tt = setTimeout(() => t.classList.remove('show'), 2400);
}

// Theme handling
function applyTheme(t: string) {
  const effective = t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
  root.dataset.theme = effective;
  $('#themeBtn').textContent = effective === 'dark' ? '☀' : '☾';
}

applyTheme(S.theme);

$('#themeBtn').onclick = () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  S.theme = next;
  save('zr-settings', S);
  applyTheme(next);
  if ($('#sThemeSelect')) ($('#sThemeSelect') as HTMLSelectElement).value = next;
};

function setConn(on: boolean, label?: string) {
  connected = on;
  const pill = $('#syncPill');
  pill.classList.remove('offline', 'warning');
  if (reconnectRequired) {
    pill.classList.add('warning');
    $('#syncText').textContent = 'Reconnect Google';
    $('#reconnectBanner').hidden = false;
  } else if (!on) {
    pill.classList.add('offline');
    $('#syncText').textContent = label || 'Connect Google';
    $('#reconnectBanner').hidden = true;
  } else {
    $('#syncText').textContent = label || 'Synced';
    $('#reconnectBanner').hidden = true;
  }
  document.querySelectorAll('.acc').forEach(e => {
    (e as HTMLElement).textContent = on ? 'Connected' : 'Not connected';
  });
}

function el(tag: string, cls = '', text = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

async function run(cmd: string, args: any) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    const s = String(e);
    if (s.startsWith('NETWORK:')) {
      Q.push({ cmd, args });
      save('zr-queue', Q);
      toast('Offline: saved locally, will sync later');
      return;
    }
    throw e;
  }
}

async function flush() {
  while (Q.length) {
    try {
      await invoke(Q[0].cmd, Q[0].args);
    } catch (e) {
      if (String(e).startsWith('NETWORK:')) return;
    }
    Q.shift();
    save('zr-queue', Q);
  }
}

// Date helpers
function addDays(d: Date, n: number) {
  const res = new Date(d);
  res.setDate(res.getDate() + n);
  return res;
}

function parseTaskDue(dueStr?: string): string {
  if (!dueStr) return '';
  return dueStr.slice(0, 10);
}

function parseEventDate(ev: Ev): string {
  if (ev.start.date) return ev.start.date;
  if (ev.start.dateTime) return ev.start.dateTime.slice(0, 10);
  return '';
}

function formatEventTime(ev: Ev): string {
  if (ev.start.date) return 'All day';
  if (ev.start.dateTime) {
    const s = clock(new Date(ev.start.dateTime));
    const e = ev.end?.dateTime ? clock(new Date(ev.end.dateTime)) : '';
    return e ? `${s} – ${e}` : s;
  }
  return 'All day';
}

// Render active view
function render() {
  const day = todayStr();
  const tomorrow = todayStr(addDays(new Date(), 1));
  const weekEnd = todayStr(addDays(new Date(), 7));

  // Update dynamic tray tooltip
  const todayTasksLeft = tasks.filter(t => t.due && parseTaskDue(t.due) <= day && t.status !== 'completed');
  const todayEvents = events.filter(e => parseEventDate(e) === day);
  const trayTooltip = `ZR tasks: ${todayEvents.length} events · ${todayTasksLeft.length} tasks left`;
  invoke('update_tray', { tooltip: trayTooltip }).catch(() => {});

  // Update stats
  let activeTasks = tasks;
  let activeEvents = events;
  if (homeFilter === 'today') {
    activeTasks = tasks.filter(t => t.due && parseTaskDue(t.due) === day);
    activeEvents = events.filter(e => parseEventDate(e) === day);
  } else if (homeFilter === 'tomorrow') {
    activeTasks = tasks.filter(t => t.due && parseTaskDue(t.due) === tomorrow);
    activeEvents = events.filter(e => parseEventDate(e) === tomorrow);
  } else {
    activeTasks = tasks.filter(t => t.due && parseTaskDue(t.due) >= day && parseTaskDue(t.due) <= weekEnd);
    activeEvents = events.filter(e => {
      const d = parseEventDate(e);
      return d >= day && d <= weekEnd;
    });
  }

  const overdue = tasks.filter(t => t.status !== 'completed' && t.due && parseTaskDue(t.due) < day);
  const doneTasks = activeTasks.filter(t => t.status === 'completed');

  $('#taskCount').textContent = pad(activeTasks.length);
  const overdueCountEl = $('#overdueCount');
  if (overdueCountEl) overdueCountEl.textContent = pad(overdue.length);
  $('#eventCount').textContent = pad(activeEvents.length);
  $('#doneCount').textContent = pad(doneTasks.length);

  const overdueBadgeEl = $('#overdueBadge');
  if (overdueBadgeEl) overdueBadgeEl.textContent = `${overdue.length} items`;
  const taskStatNoteEl = $('#taskStatNote');
  if (taskStatNoteEl) {
    taskStatNoteEl.textContent = activeTasks.length > 0 
      ? `${doneTasks.length} of ${activeTasks.length} done`
      : 'On your list for this view';
  }
  const overdueStatNoteEl = $('#overdueStatNote');
  if (overdueStatNoteEl) {
    overdueStatNoteEl.textContent = overdue.length > 0 ? `${overdue.length} items need attention` : 'All caught up!';
  }
  const nextEventEl = $('#nextEventSnippet');
  if (nextEventEl) {
    if (activeEvents.length > 0) {
      const first = activeEvents[0];
      nextEventEl.textContent = `${first.summary || 'Event'} (${formatEventTime(first)})`;
    } else {
      nextEventEl.textContent = 'Scheduled for this period';
    }
  }

  // 1. HOME VIEW: OVERDUE & FILTERED TASKS
  const overdueSec = $('#overdueSection');
  const overdueList = $('#overdueTaskList');
  if (overdue.length > 0) {
    overdueSec.hidden = false;
    overdueList.replaceChildren();
    overdue.forEach(t => overdueList.append(renderTaskRow(t, true)));
  } else {
    overdueSec.hidden = true;
  }

  const tl = $('#taskList');
  tl.replaceChildren();
  let homeFiltered = activeTasks;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    homeFiltered = homeFiltered.filter(t => t.title.toLowerCase().includes(q));
  }
  if (homeFiltered.length === 0) {
    const empty = el('div', 'task-meta', 'No tasks for this view.');
    empty.style.padding = '12px 0';
    tl.append(empty);
  } else {
    homeFiltered.forEach(t => tl.append(renderTaskRow(t, false)));
  }

  // HOME VIEW: EVENTS LIST
  const evl = $('#eventList');
  evl.replaceChildren();
  let homeEvents = activeEvents;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    homeEvents = homeEvents.filter(e => (e.summary || '').toLowerCase().includes(q));
  }
  if (homeEvents.length === 0) {
    const empty = el('div', 'event-time', 'No events scheduled for this period.');
    empty.style.padding = '10px 0';
    evl.append(empty);
  } else {
    homeEvents.slice(0, 8).forEach((e, idx) => {
      const row = el('div', 'event');
      const bar = el('div', 'event-line');
      if (idx % 2 === 1) bar.style.background = 'var(--purple)';
      const copy = el('div', 'event-copy');
      copy.append(
        el('div', 'event-name', e.summary || '(No title)'),
        el('div', 'event-time', formatEventTime(e))
      );
      const del = el('button', 'del-btn', '✕');
      del.title = 'Delete event';
      del.onclick = async () => {
        try {
          await run('delete_event', { id: e.id });
          events = events.filter(x => x.id !== e.id);
          render();
          toast('Event deleted');
        } catch {
          toast('Could not delete event');
        }
      };
      row.append(bar, copy, del);
      evl.append(row);
    });
  }

  // 2. CALENDAR VIEW (7-day agenda)
  renderCalendarView();

  // 3. TASKS VIEW (All lists, categories)
  renderTasksView();

  // 4. REMINDERS VIEW
  renderRemindersView();
}

function renderTaskRow(t: Tk, isOverdueList = false) {
  const done = t.status === 'completed';
  const tm = taskTime(t);
  const row = el('label', 'task' + (done ? ' done' : ''));
  const c = el('input', 'check') as HTMLInputElement;
  c.type = 'checkbox';
  c.checked = done;
  c.onchange = async () => {
    try {
      await run('set_task', { list: t.list, id: t.id, done: c.checked });
      t.status = c.checked ? 'completed' : 'needsAction';
      render();
    } catch {
      toast('Could not update task');
      c.checked = !c.checked;
    }
  };

  const copy = el('span', 'task-copy');
  const nameDiv = el('div', 'task-name', t.title);
  const metaDiv = el('div', 'task-meta');

  if (isOverdueList) {
    metaDiv.append(el('span', 'badge amber', 'Overdue'));
  } else if (t.due && parseTaskDue(t.due) < todayStr()) {
    metaDiv.append(el('span', 'badge amber', 'Overdue'));
  }

  if (t.listTitle) {
    metaDiv.append(el('span', '', t.listTitle));
  }

  copy.append(nameDiv, metaDiv);

  let timeText = '';
  if (tm) {
    timeText = `${pad(+tm[1])}:${tm[2]}`;
  } else if (t.due) {
    timeText = parseTaskDue(t.due) === todayStr() ? 'Today' : parseTaskDue(t.due);
  }

  const timeSpan = el('span', 'task-time' + (isOverdueList ? ' od' : ''), timeText);

  const del = el('button', 'del-btn', '✕');
  del.title = 'Delete task';
  del.onclick = async e => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await run('delete_task', { list: t.list, id: t.id });
      tasks = tasks.filter(x => x.id !== t.id);
      render();
      toast('Task deleted');
    } catch {
      toast('Could not delete task');
    }
  };

  row.append(c, copy, timeSpan, del);
  return row;
}

// CALENDAR VIEW RENDERER
function renderCalendarView() {
  const container = $('#calendarAgenda');
  container.replaceChildren();

  const days: { dateStr: string; label: string; events: Ev[] }[] = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const cur = addDays(base, i);
    const dStr = todayStr(cur);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : cur.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    days.push({
      dateStr: dStr,
      label,
      events: events.filter(e => parseEventDate(e) === dStr),
    });
  }

  days.forEach(d => {
    const dayWrap = el('div', 'cal-day');
    const head = el('div', 'cal-day-head');
    head.append(el('span', '', d.label), el('span', '', `${d.events.length} events`));
    dayWrap.append(head);

    if (d.events.length === 0) {
      const empty = el('div', 'panel-sub', 'No events scheduled');
      empty.style.padding = '8px 0 14px';
      dayWrap.append(empty);
    } else {
      d.events.forEach((e, idx) => {
        const row = el('div', 'event');
        const bar = el('div', 'event-line');
        if (idx % 3 === 1) bar.style.background = 'var(--purple)';
        if (idx % 3 === 2) bar.style.background = 'var(--green)';
        const copy = el('div', 'event-copy');
        copy.append(
          el('div', 'event-name', e.summary || '(No title)'),
          el('div', 'event-time', formatEventTime(e))
        );
        const del = el('button', 'del-btn', '✕');
        del.title = 'Delete event';
        del.onclick = async () => {
          try {
            await run('delete_event', { id: e.id });
            events = events.filter(x => x.id !== e.id);
            render();
            toast('Event deleted');
          } catch {
            toast('Could not delete event');
          }
        };
        row.append(bar, copy, del);
        dayWrap.append(row);
      });
    }
    container.append(dayWrap);
  });
}

// TASKS VIEW RENDERER
function renderTasksView() {
  const container = $('#allTasksList');
  container.replaceChildren();

  const day = todayStr();
  let filtered = tasks;

  if (taskCategory === 'overdue') {
    filtered = filtered.filter(t => t.status !== 'completed' && t.due && parseTaskDue(t.due) < day);
  } else if (taskCategory === 'today') {
    filtered = filtered.filter(t => t.due && parseTaskDue(t.due) === day);
  } else if (taskCategory === 'upcoming') {
    filtered = filtered.filter(t => t.due && parseTaskDue(t.due) > day);
  } else if (taskCategory === 'completed') {
    filtered = filtered.filter(t => t.status === 'completed');
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(t => t.title.toLowerCase().includes(q));
  }

  if (filtered.length === 0) {
    const empty = el('div', 'panel-sub', 'No tasks found in this section.');
    empty.style.padding = '20px 0';
    container.append(empty);
    return;
  }

  filtered.forEach(t => container.append(renderTaskRow(t, false)));
}

// REMINDERS VIEW RENDERER
function renderRemindersView() {
  $('#reminderLeadDisplay').textContent = `${S.lead} min before`;
  $('#reminderDndDisplay').textContent = S.dnd ? 'Active (All muted)' : 'Disabled';
  $('#reminderEveningDisplay').textContent = S.evening ? `${S.eveningTime || '21:00'} (Enabled)` : 'Disabled';

  // Snoozed list
  const snoozedWrap = $('#snoozedList');
  snoozedWrap.replaceChildren();
  const entries = Object.entries(snoozed);
  if (entries.length === 0) {
    snoozedWrap.append(el('div', 'panel-sub', 'No reminders currently snoozed.'));
  } else {
    entries.forEach(([k, v]) => {
      const row = el('div', 'srow');
      const timeStr = clock(new Date(v.until));
      row.append(
        el('span', '', `${v.title} (snoozed until ${timeStr})`),
        el('button', 'text-btn', 'Cancel snooze')
      );
      (row.querySelector('button') as HTMLElement).onclick = () => {
        delete snoozed[k];
        save('zr-snoozed', snoozed);
        renderRemindersView();
        toast('Snooze cleared');
      };
      snoozedWrap.append(row);
    });
  }

  // Upcoming alarms today
  const upcomingWrap = $('#upcomingRemindersList');
  upcomingWrap.replaceChildren();
  const day = todayStr();
  const items = [
    ...events.filter(e => e.start.dateTime && parseEventDate(e) === day).map(e => ({
      title: e.summary || 'Event',
      time: clock(new Date(e.start.dateTime!)),
      at: new Date(e.start.dateTime!).getTime(),
    })),
    ...tasks.filter(t => t.status !== 'completed' && parseTaskDue(t.due) === day && taskTime(t)).map(t => {
      const m = taskTime(t)!;
      const d = new Date();
      d.setHours(+m[1], +m[2], 0, 0);
      return {
        title: t.title,
        time: `${pad(+m[1])}:${m[2]}`,
        at: d.getTime(),
      };
    }),
  ];

  if (items.length === 0) {
    upcomingWrap.append(el('div', 'panel-sub', 'No scheduled event reminders or timed tasks for today.'));
  } else {
    items.sort((a, b) => a.at - b.at).forEach(i => {
      const row = el('div', 'srow');
      row.append(
        el('span', '', `${i.title} at ${i.time}`),
        el('span', 'badge blue', `Alerts ${S.lead}m before`)
      );
      upcomingWrap.append(row);
    });
  }
}

// SYNC ENGINE
async function sync() {
  try {
    await flush();

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = addDays(start, 8); // Window: today to +7 days

    const d: any = await invoke('fetch_day', {
      min: start.toISOString(),
      max: end.toISOString(),
    });

    events = d.events ?? [];
    tasks = d.tasks ?? [];
    reconnectRequired = false;
    setConn(true);

    // Save fetched data to SQLite cache
    await invoke('save_cache', { key: 'events', val: JSON.stringify(events) }).catch(() => {});
    await invoke('save_cache', { key: 'tasks', val: JSON.stringify(tasks) }).catch(() => {});

    // Save summary for instant popup startup
    const day = todayStr();
    const todayTasks = tasks.filter(t => t.due && parseTaskDue(t.due) <= day && t.status !== 'completed');
    const odCount = todayTasks.filter(t => parseTaskDue(t.due) < day).length;
    const todayEvs = events.filter(e => parseEventDate(e) === day);

    const summary = {
      n: todayEvs.length,
      c: todayTasks.length,
      o: odCount,
      ev: todayEvs.slice(0, 6).map(e => [e.summary || '(No title)', formatEventTime(e)]),
      tk: todayTasks.slice(0, 6).map(t => {
        const tm = taskTime(t);
        const lbl = parseTaskDue(t.due) < day ? 'Overdue' : tm ? `${pad(+tm[1])}:${tm[2]}` : 'Today';
        return [t.title, lbl];
      }),
    };
    await invoke('save_cache', { key: 'today_summary', val: JSON.stringify(summary) }).catch(() => {});

    render();

    if (first) {
      first = false;
      if (S.popup) {
        invoke<boolean>('is_startup')
          .then(isStart => {
            if (isStart) openTodayPopup();
          })
          .catch(() => {});
      }
    }
  } catch (e) {
    const m = String(e);
    if (m.includes('RECONNECT_REQUIRED') || m.includes('invalid_grant')) {
      reconnectRequired = true;
      setConn(false, 'Reconnect Google');
    } else if (m.includes('NOT_CONNECTED')) {
      setConn(false, 'Connect Google');
    } else if (m.startsWith('NETWORK:')) {
      setConn(connected, 'Offline');
    } else {
      toast('Sync failed: ' + m);
    }
  }
}

// NATURAL LANGUAGE PARSER FOR QUICK ADD
function parse(text: string) {
  let s = text.trim();
  let isEvent = false;
  const m0 = /^event\s*:?\s+/i.exec(s);
  if (m0) {
    isEvent = true;
    s = s.slice(m0[0].length);
  }

  const d = new Date();
  let hh = -1;
  let mm = 0;

  if (/\btomorrow\b/i.test(s)) {
    d.setDate(d.getDate() + 1);
    s = s.replace(/\btomorrow\b/i, '');
  } else {
    s = s.replace(/\btoday\b/i, '');
  }

  const t =
    /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(s) ||
    /\bat\s+(\d{1,2}):(\d{2})()/i.exec(s);

  if (t) {
    hh = +t[1];
    mm = +(t[2] || 0);
    const ap = (t[3] || '').toLowerCase();
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    s = s.replace(t[0], '');
  }

  return { title: s.replace(/\s+/g, ' ').trim(), date: d, hh, mm, isEvent };
}

async function addFrom(text: string) {
  const p = parse(text);
  if (!p.title) return;
  try {
    if (p.isEvent) {
      const st = new Date(p.date);
      st.setHours(p.hh < 0 ? 9 : p.hh, p.mm, 0, 0);
      const et = new Date(st.getTime() + X().evLen * 60000);
      await run('add_event', {
        summary: p.title,
        start: st.toISOString(),
        end: et.toISOString(),
      });
      toast('Event added to Google Calendar');
    } else {
      await run('add_task', {
        title: p.title,
        due: `${todayStr(p.date)}T00:00:00.000Z`,
        notes: p.hh < 0 ? null : `⏰ ${pad(p.hh)}:${pad(p.mm)}`,
      });
      toast('Task added to Google Tasks');
    }
    sync();
  } catch (e) {
    toast(String(e).includes('NOT_CONNECTED') ? 'Connect Google first' : 'Could not add');
  }
}

// REMINDER SCHEDULER & QUIET HOURS
const quiet = () => {
  if (S.dnd) return true;
  if (!S.quiet) return false;
  const n = new Date();
  const v = n.getHours() * 60 + n.getMinutes();
  const [a, b] = [S.from, S.to].map((x: string) => +x.slice(0, 2) * 60 + +x.slice(3));
  return a < b ? v >= a && v < b : v >= a || v < b;
};

async function remind(key: string, title: string, time: string, mins: number, src = 'Google Calendar') {
  const q = new URLSearchParams({ mode: 'remind', key, title, time, mins: String(mins), src });
  try {
    await invoke('open_popup', { query: q.toString() });
  } catch {
    sendNotification({ title: `${title} (${time})`, body: mins > 0 ? `Starts in ${mins} min` : time });
  }
}

// Scheduled check runs every 30 seconds
setInterval(() => {
  const now = Date.now();
  const day = todayStr();

  // Evening review check (default 9 PM)
  if (S.evening && !quiet()) {
    const curTime = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
    const target = S.eveningTime || '21:00';
    if (curTime === target && eveningFiredDate !== day) {
      eveningFiredDate = day;
      save('zr-evening-date', day);
      const remaining = tasks.filter(t => t.due && parseTaskDue(t.due) <= day && t.status !== 'completed').length;
      sendNotification({
        title: 'ZR tasks · Evening Review',
        body: remaining > 0 ? `You have ${remaining} tasks remaining today.` : 'All tasks completed today! Great job.',
      });
    }
  }

  if (quiet()) return;

  const items = [
    ...events.filter(e => e.start.dateTime).map(e => ({
      key: e.id + e.start.dateTime,
      title: e.summary || 'Event',
      at: new Date(e.start.dateTime!).getTime(),
      src: 'Google Calendar',
    })),
    ...tasks.filter(t => t.status !== 'completed' && parseTaskDue(t.due) === day && taskTime(t)).map(t => {
      const m = taskTime(t)!;
      const d = new Date();
      d.setHours(+m[1], +m[2], 0, 0);
      return {
        key: 'task' + t.id + day,
        title: t.title,
        at: d.getTime(),
        src: 'Google Tasks',
      };
    }),
  ];

  items.forEach(i => {
    const mins = (i.at - now) / 60000;
    // Lead time trigger (e.g. 10m before) OR start time trigger
    if (mins >= -1 && mins <= S.lead && !fired.has(i.key)) {
      fired.add(i.key);
      save('zr-fired', [...fired].slice(-300));
      remind(i.key, i.title, clock(new Date(i.at)), Math.max(0, Math.ceil(mins)), i.src);
    }
  });

  // Snoozed alarms
  for (const [k, v] of Object.entries(snoozed)) {
    if (now >= v.until) {
      delete snoozed[k];
      save('zr-snoozed', snoozed);
      remind(k, v.title, v.time, 0, v.src);
      renderRemindersView();
    }
  }
}, 30000);

async function openTodayPopup() {
  const day = todayStr();
  const list = tasks.filter(t => t.due && parseTaskDue(t.due) <= day && t.status !== 'completed');
  const d = {
    n: events.filter(e => parseEventDate(e) === day).length,
    c: list.length,
    o: list.filter(t => parseTaskDue(t.due) < day).length,
    ev: events.filter(e => parseEventDate(e) === day).slice(0, 6).map(e => [e.summary || '(No title)', formatEventTime(e)]),
    tk: list.slice(0, 6).map(t => {
      const tm = taskTime(t);
      const lbl = parseTaskDue(t.due) < day ? 'Overdue' : tm ? `${pad(+tm[1])}:${tm[2]}` : 'Today';
      return [t.title, lbl];
    }),
  };
  try {
    await invoke('open_popup', {
      query: new URLSearchParams({ mode: 'today', d: JSON.stringify(d) }).toString(),
    });
  } catch {}
}

// Navigation View switcher
function showView(v: string) {
  currentView = v;
  document.querySelectorAll<HTMLElement>('.nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === v);
  });
  $('#currentSection').textContent = v;

  const views = ['Home', 'Calendar', 'Tasks', 'Reminders', 'Settings'];
  views.forEach(name => {
    const el = $(`#${name.toLowerCase()}View`);
    if (el) el.hidden = name !== v;
  });

  render();
}

document.querySelectorAll<HTMLElement>('.nav button').forEach(b => {
  b.addEventListener('click', () => {
    const v = b.dataset.view || 'Home';
    showView(v);
  });
});

// View Calendar button in Home panel
$('#viewCalendarBtn').onclick = () => showView('Calendar');

// Home filter buttons: Today / Tomorrow / 7 Days
document.querySelectorAll<HTMLButtonElement>('#homeFilterPills .filter-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#homeFilterPills .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    homeFilter = btn.dataset.filter as any;
    $('#homeTasksTitle').textContent = homeFilter === 'today' ? "Today's tasks" : homeFilter === 'tomorrow' ? "Tomorrow's tasks" : "7-Day tasks";
    render();
  };
});

// Tasks page category filter pills
document.querySelectorAll<HTMLButtonElement>('#taskCategoryPills .filter-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#taskCategoryPills .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    taskCategory = btn.dataset.tfilter as any;
    renderTasksView();
  };
});

// Search handling
$('#searchBtn').onclick = () => {
  const wrap = $('#searchWrap');
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) {
    $('#globalSearchInput').focus();
  } else {
    searchQuery = '';
    $('#globalSearchInput').value = '';
    render();
  }
};
$('#searchCloseBtn').onclick = () => {
  $('#searchWrap').hidden = true;
  searchQuery = '';
  $('#globalSearchInput').value = '';
  render();
};
$('#globalSearchInput').oninput = e => {
  searchQuery = (e.target as HTMLInputElement).value.trim();
  render();
};

// Forms & Quick Add
$('#addTaskForm').addEventListener('submit', e => {
  e.preventDefault();
  const i = $('#newTask') as HTMLInputElement;
  const v = i.value;
  i.value = '';
  addFrom(v);
});

$('#tasksPageAddForm').addEventListener('submit', e => {
  e.preventDefault();
  const i = $('#tasksPageInput') as HTMLInputElement;
  const v = i.value;
  i.value = '';
  addFrom(v);
});

// Add Calendar Event form
$('#openAddEventBtn').onclick = () => {
  const card = $('#addEventCard');
  card.hidden = false;
  ($('#evDate') as HTMLInputElement).value = todayStr();
};
$('#cancelEventBtn').onclick = () => {
  $('#addEventCard').hidden = true;
};
$('#createEventForm').addEventListener('submit', async e => {
  e.preventDefault();
  const summary = ($('#evSummary') as HTMLInputElement).value.trim();
  const date = ($('#evDate') as HTMLInputElement).value;
  const startT = ($('#evStart') as HTMLInputElement).value;
  const endT = ($('#evEnd') as HTMLInputElement).value;
  if (!summary || !date || !startT || !endT) return;

  const startIso = new Date(`${date}T${startT}:00`).toISOString();
  const endIso = new Date(`${date}T${endT}:00`).toISOString();

  try {
    await run('add_event', { summary, start: startIso, end: endIso });
    toast('Event created');
    $('#addEventCard').hidden = true;
    ($('#evSummary') as HTMLInputElement).value = '';
    sync();
  } catch (err) {
    toast('Could not create event: ' + err);
  }
});

$('#clearDone').onclick = async () => {
  try {
    await invoke('clear_done');
    toast('Completed tasks cleared');
    sync();
  } catch {
    toast('Could not clear tasks');
  }
};

// Notification test button
$('#notifyBtn').onclick = async () => {
  try {
    await sendNotification({ title: 'ZR tasks', body: 'Desktop notifications are active.' });
    toast('Test notification sent');
  } catch {
    toast('Could not send notification');
  }
};
$('#testNotificationBtn').onclick = () => $('#notifyBtn').click();

// Settings bindings
const g = (id: string) => $('#' + id) as HTMLInputElement;
const sLead = $('#sLeadSelect') as HTMLSelectElement;
const sTheme = $('#sThemeSelect') as HTMLSelectElement;

sLead.value = String(S.lead);
sTheme.value = S.theme;
g('sDnd').checked = S.dnd;
g('sQuiet').checked = S.quiet;
g('sFrom').value = S.from;
g('sTo').value = S.to;
g('sPopup').checked = S.popup;
g('sEvening').checked = S.evening;
g('sEveningTime').value = S.eveningTime || '21:00';

isEnabled().then(v => (g('sAuto').checked = v)).catch(() => {});

const updateSettings = () => {
  S = {
    lead: +sLead.value || 10,
    theme: sTheme.value,
    dnd: g('sDnd').checked,
    quiet: g('sQuiet').checked,
    from: g('sFrom').value,
    to: g('sTo').value,
    popup: g('sPopup').checked,
    evening: g('sEvening').checked,
    eveningTime: g('sEveningTime').value,
  };
  save('zr-settings', S);
  applyTheme(S.theme);
  renderRemindersView();
};

[sLead, sTheme, g('sDnd'), g('sQuiet'), g('sFrom'), g('sTo'), g('sPopup'), g('sEvening'), g('sEveningTime')].forEach(elem => {
  elem.onchange = updateSettings;
});

g('sAuto').onchange = () => {
  (g('sAuto').checked ? enable() : disable()).catch(() => toast('Launch at login works in the installed app'));
};

// Google Cloud Credentials handling
async function loadGoogleCredentials() {
  try {
    const creds = await invoke<{ client_id: string; client_secret: string }>('get_google_credentials');
    if (creds && $('#googleClientId')) {
      ($('#googleClientId') as HTMLInputElement).value = creds.client_id || '';
      ($('#googleClientSecret') as HTMLInputElement).value = creds.client_secret || '';
    }
  } catch {}
}

$('#saveCredentialsBtn').onclick = async () => {
  const cid = ($('#googleClientId') as HTMLInputElement).value.trim();
  const csec = ($('#googleClientSecret') as HTMLInputElement).value.trim();
  if (!cid || !csec) {
    toast('Please enter both Client ID and Client Secret');
    return;
  }
  try {
    await invoke('set_google_credentials', { clientId: cid, clientSecret: csec });
    toast('Credentials saved. Click "Connect Google" to sign in.');
  } catch (err) {
    toast('Failed to save credentials: ' + err);
  }
};

$('#toggleSecretBtn').onclick = () => {
  const input = $('#googleClientSecret') as HTMLInputElement;
  const btn = $('#toggleSecretBtn');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
};

$('#connectGoogleFromSettingsBtn').onclick = () => $('#syncPill').click();

$('#signOut').onclick = async () => {
  try {
    await invoke('logout');
  } catch {}
  tasks = [];
  events = [];
  setConn(false);
  render();
  toast('Signed out');
};

$('#sSyncNowBtn').onclick = () => sync();

$('#syncPill').onclick = async () => {
  if (connected && !reconnectRequired) return sync();
  try {
    const creds = await invoke<{ client_id: string; client_secret: string }>('get_google_credentials');
    if (!creds.client_id || !creds.client_secret) {
      toast('Please set Google Client ID & Secret in Settings');
      showView('Settings');
      setTimeout(() => $('#googleClientId')?.focus(), 200);
      return;
    }
    toast('Opening Google login in your browser…');
    await invoke('login');
    reconnectRequired = false;
    await sync();
    toast('Connected to Google');
  } catch (e) {
    const m = String(e);
    if (m.includes('MISSING_CREDENTIALS')) {
      toast('Please enter your Google Client ID and Secret in Settings');
      showView('Settings');
      setTimeout(() => $('#googleClientId')?.focus(), 200);
    } else {
      toast(m);
    }
  }
};

$('#reconnectBtn').onclick = () => $('#syncPill').click();

// Overdue accordion toggle
let overdueDrawerOpen = true;
const overdueToggleBtn = $('#overdueToggleBtn');
const overdueScrollWrap = $('#overdueScrollWrap');
const overdueArrow = $('#overdueArrow');
if (overdueToggleBtn && overdueScrollWrap && overdueArrow) {
  overdueToggleBtn.onclick = () => {
    overdueDrawerOpen = !overdueDrawerOpen;
    if (overdueDrawerOpen) {
      overdueScrollWrap.classList.remove('collapsed');
      overdueArrow.classList.remove('collapsed');
    } else {
      overdueScrollWrap.classList.add('collapsed');
      overdueArrow.classList.add('collapsed');
    }
  };
}

const statCardOverdue = $('#statCardOverdue');
if (statCardOverdue && overdueScrollWrap && overdueArrow) {
  statCardOverdue.onclick = () => {
    overdueDrawerOpen = true;
    overdueScrollWrap.classList.remove('collapsed');
    overdueArrow.classList.remove('collapsed');
    $('#overdueSection')?.scrollIntoView({ behavior: 'smooth' });
  };
}

// Reschedule all overdue tasks to today
const rescheduleBtn = $('#rescheduleOverdueBtn');
if (rescheduleBtn) {
  rescheduleBtn.onclick = async (e) => {
    e.stopPropagation();
    const day = todayStr();
    const overdueList = tasks.filter(t => t.status !== 'completed' && t.due && parseTaskDue(t.due) < day);
    if (overdueList.length === 0) return;
    toast(`Rescheduling ${overdueList.length} overdue tasks to today...`);
    const dueIso = `${day}T00:00:00.000Z`;
    for (const t of overdueList) {
      t.due = dueIso;
      run('reschedule_task', { list: t.list, id: t.id, due: dueIso }).catch(() => {});
    }
    render();
    toast(`Rescheduled ${overdueList.length} tasks to today!`);
  };
}

// Event listeners
listen<any>('snooze', e => {
  const { key, title, time, mins, src } = e.payload;
  if (key === 'today') {
    setTimeout(openTodayPopup, mins * 60000);
  } else {
    snoozed[key] = { until: Date.now() + mins * 60000, title, time, src: src || 'Google Calendar' };
    save('zr-snoozed', snoozed);
    renderRemindersView();
  }
  toast(`Snoozed for ${mins} min`);
});

listen<string>('quickadd', e => addFrom(e.payload));
listen('sync', () => sync());
listen('toggle-theme', () => $('#themeBtn').click());
listen<string>('nav', e => showView(e.payload));
listen<boolean>('autolaunch_changed', e => {
  g('sAuto').checked = e.payload;
});

// Setup headers
const now = new Date();
const hour = now.getHours();
$('#todayDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
$('#greeting').textContent = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';

// Request notification permission if needed
(async () => {
  try {
    if (!(await isPermissionGranted())) {
      await requestPermission();
    }
  } catch {}
})();

// Restore from cache first (instant startup UI)
(async () => {
  try {
    loadGoogleCredentials();
    const cachedEvents = await invoke<string | null>('load_cache', { key: 'events' });
    if (cachedEvents) events = JSON.parse(cachedEvents);
    const cachedTasks = await invoke<string | null>('load_cache', { key: 'tasks' });
    if (cachedTasks) tasks = JSON.parse(cachedTasks);
    if (events.length > 0 || tasks.length > 0) {
      render();
    }
  } catch {}

  // Then perform online sync
  sync();
})();

// Cadence: poll every 2 min while active window
setInterval(sync, X().syncMin * 60000);
