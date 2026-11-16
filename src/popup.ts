import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'today';

let th: string | null = null;
try { th = localStorage.getItem('zr-theme'); } catch {}
document.documentElement.dataset.theme = th || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const el = (t: string, c = '', x = '') => {
  const e = document.createElement(t);
  if (c) e.className = c;
  if (x) e.textContent = x;
  return e;
};

const btn = (label: string, fn: () => void, p = false) => {
  const b = el('button', 'btn' + (p ? ' p' : ''), label);
  b.onclick = fn;
  return b;
};

const close = () => {
  try { getCurrentWindow().close(); } catch {}
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') close();
});

// Closes on click-away
window.addEventListener('blur', () => {
  // Give a small grace period for focus transitions within the popup
  setTimeout(() => {
    if (!document.hasFocus()) close();
  }, 180);
});

const app = document.getElementById('app')!;
const card = el('div', 'card');
app.replaceChildren(card);

async function init() {
  if (mode === 'today') {
    let d: any = null;
    try {
      const param = q.get('d');
      if (param) d = JSON.parse(param);
    } catch {}

    if (!d) {
      try {
        const cached = await invoke<string | null>('load_cache', { key: 'today_summary' });
        if (cached) d = JSON.parse(cached);
      } catch {}
    }

    if (!d) {
      d = { n: 0, c: 0, o: 0, ev: [], tk: [] };
    }

    const h = new Date().getHours();
    const greetingText = h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';

    // Header
    const brandRow = el('div', 'brand-row');
    const brand = el('div', 'brand');
    const icon = el('img', 'mark') as HTMLImageElement;
    icon.src = '/icon.png';
    icon.alt = 'ZR';
    brand.append(icon, document.createTextNode('ZR tasks'));
    const syncBadge = el('span', 'm', '● Synced');
    syncBadge.style.color = 'var(--green)';
    brandRow.append(brand, syncBadge);

    const greeting = el('div', 'greeting', greetingText);
    const countRow = el('div', 'm');
    countRow.textContent = `${d.n || 0} events · ${d.c || 0} tasks`;
    if (d.o > 0) {
      const odSpan = el('span', 'od', ` · ${d.o} overdue`);
      countRow.append(odSpan);
    }

    card.append(brandRow, greeting, countRow);

    const listWrap = el('div', 'list-wrap');

    if (d.ev && d.ev.length > 0) {
      listWrap.append(el('div', 'sec', 'EVENTS'));
      d.ev.forEach((r: [string, string], idx: number) => {
        const row = el('div', 'row');
        const bar = el('span', 'bar');
        if (idx % 2 === 1) bar.style.background = 'var(--purple)';
        row.append(bar, el('span', 'sp', r[0]), el('span', 'tm', r[1]));
        listWrap.append(row);
      });
    }

    if (d.tk && d.tk.length > 0) {
      listWrap.append(el('div', 'sec', 'TASKS'));
      d.tk.forEach((r: [string, string]) => {
        const row = el('div', 'row');
        const chk = el('span', 'chk');
        const isOd = r[1] === 'Overdue';
        if (isOd) chk.style.borderColor = 'var(--amber)';
        row.append(chk, el('span', 'sp', r[0]), el('span', 'tm' + (isOd ? ' od' : ''), r[1]));
        listWrap.append(row);
      });
    }

    if ((!d.ev || d.ev.length === 0) && (!d.tk || d.tk.length === 0)) {
      const emptyNote = el('div', 'm', 'Nothing scheduled for today. Make space for what matters.');
      emptyNote.style.padding = '24px 0';
      listWrap.append(emptyNote);
    }

    card.append(listWrap);

    const act = el('div', 'act');
    act.append(
      btn('Open ZR tasks', async () => {
        await invoke('show_main');
        close();
      }, true),
      btn('Snooze 1 hour', async () => {
        await emit('snooze', { key: 'today', mins: 60 });
        close();
      }),
      btn('Dismiss', close)
    );
    card.append(act);

  } else if (mode === 'remind') {
    const mins = +(q.get('mins') || 0);
    const title = q.get('title') || 'Reminder';
    const time = q.get('time') || '';
    const key = q.get('key') || '';
    const src = q.get('src') || 'Google Calendar';

    const brandRow = el('div', 'brand-row');
    const brand = el('div', 'brand');
    const icon = el('img', 'mark') as HTMLImageElement;
    icon.src = '/icon.png';
    brand.append(icon, document.createTextNode('ZR tasks'));
    brandRow.append(brand);

    const heading = el('div', 'greeting', title);
    heading.style.fontSize = '16px';
    const sub = el('div', 'm', mins > 0 ? `Starts in ${mins} min · ${time} · ${src}` : `${time} · ${src}`);

    card.append(brandRow, heading, sub, el('div', 'sec', 'SNOOZE'));

    const act = el('div', 'act');
    [5, 10, 30, 60].forEach(m => {
      act.append(
        btn(m === 60 ? '1 hour' : `${m} min`, async () => {
          await emit('snooze', { key, title, time, mins: m });
          close();
        })
      );
    });
    act.append(btn('Dismiss', close, true));
    card.append(act);

  } else {
    // Quick add mode
    const wrap = el('div', 'qa-box');
    const input = el('input', 'qa') as HTMLInputElement;
    input.placeholder = 'call client tomorrow 5pm   or   event: meeting 4pm';
    wrap.append(input);
    card.append(wrap);
    setTimeout(() => input.focus(), 50);

    input.onkeydown = async e => {
      if (e.key === 'Enter' && input.value.trim()) {
        await emit('quickadd', input.value.trim());
        close();
      }
    };
  }
}

init();
