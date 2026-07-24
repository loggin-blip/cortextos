'use strict';

const state = {
  surfaces: { skills: [], crons: [], bootstrap: [] },
  selected: null, // { type, id }
  tgMessages: [],
  tgSeenIds: new Set(),
  sse: null
};

// ---------- utils ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ago(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ---------- sidebar ----------

async function loadSurfaces() {
  const data = await fetchJSON('/api/surfaces');
  state.surfaces = data;
  renderSidebar();
}

function renderSidebar() {
  renderGroup('skills', state.surfaces.skills, s => ({
    id: s.id, type: 'skill',
    label: s.name || s.id,
    meta: ago(s.mtime)
  }));
  renderGroup('crons', state.surfaces.crons, c => ({
    id: c.id, type: 'cron',
    label: c.name,
    meta: c.schedule
  }));
  renderGroup('bootstrap', state.surfaces.bootstrap, b => ({
    id: b.id, type: 'bootstrap',
    label: b.name,
    meta: `${b.lineCount} lines`
  }));
  document.getElementById('count-skills').textContent = state.surfaces.skills.length;
  document.getElementById('count-crons').textContent = state.surfaces.crons.length;
  document.getElementById('count-bootstrap').textContent = state.surfaces.bootstrap.length;
  applyFilter(document.getElementById('search').value);
}

function renderGroup(key, items, mapFn) {
  const ul = document.getElementById('list-' + key);
  ul.innerHTML = '';
  for (const item of items) {
    const view = mapFn(item);
    const li = h('li', {
      data: { type: view.type, id: view.id }
    },
      h('span', { class: 'row-name' }, view.label),
      h('span', { class: 'row-meta' }, view.meta || '')
    );
    li.addEventListener('click', () => selectSurface(view.type, view.id));
    ul.appendChild(li);
  }
  if (state.selected) markSelected(state.selected.type, state.selected.id);
}

function markSelected(type, id) {
  document.querySelectorAll('#sidebar li').forEach(el => {
    el.classList.toggle('active', el.dataset.type === type && el.dataset.id === id);
  });
}

function applyFilter(q) {
  const needle = (q || '').trim().toLowerCase();
  document.querySelectorAll('#sidebar li').forEach(el => {
    if (!needle) { el.classList.remove('hidden'); return; }
    const text = el.textContent.toLowerCase();
    el.classList.toggle('hidden', !text.includes(needle));
  });
}

// ---------- detail pane ----------

async function selectSurface(type, id) {
  state.selected = { type, id };
  markSelected(type, id);
  const pane = document.getElementById('pane');
  pane.innerHTML = '<div class="empty">loading...</div>';
  try {
    if (type === 'tg') {
      renderTgStream();
      return;
    }
    const data = await fetchJSON(`/api/surface?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
    if (type === 'skill') renderSkill(data);
    else if (type === 'cron') renderCron(data);
    else if (type === 'bootstrap') renderBootstrap(data);
  } catch (err) {
    pane.innerHTML = `<div class="empty"><h2>Failed to load</h2><pre class="plain">${esc(err.message)}</pre></div>`;
  }
}

function renderSkill(d) {
  const pane = document.getElementById('pane');
  pane.innerHTML = '';
  pane.appendChild(h('div', { class: 'detail-head' },
    h('div', {},
      h('div', {}, h('span', { class: 'badge skill' }, 'skill'), document.createTextNode(d.name)),
      h('h1', {}, d.name),
      h('div', { class: 'path' }, d.path)
    ),
    h('div', { class: 'subtle' }, `${fmtBytes(d.size)} · updated ${ago(d.mtime)}`)
  ));

  if (d.description) {
    pane.appendChild(h('div', { class: 'section' },
      h('h3', {}, 'description'),
      h('p', {}, d.description)
    ));
  }

  if (d.triggers && d.triggers.length) {
    const chips = h('div', { class: 'triggers' }, ...d.triggers.map(t => h('span', { class: 'chip' }, t)));
    pane.appendChild(h('div', { class: 'section' }, h('h3', {}, 'triggers'), chips));
  }

  const body = h('div', { class: 'md' });
  body.innerHTML = d.bodyHtml || '';
  pane.appendChild(h('div', { class: 'section' }, h('h3', {}, 'SKILL.md'), body));

  if (d.files && d.files.length) {
    const list = h('ul', { class: 'file-list' },
      ...d.files.map(f => h('li', {}, h('span', {}, f.path), h('span', {}, fmtBytes(f.size))))
    );
    pane.appendChild(h('div', { class: 'section' }, h('h3', {}, `files (${d.files.length})`), list));
  }

  const activitySection = h('div', { class: 'section' },
    h('h3', {}, `recent activity — stdout matches for "${d.name}"`)
  );
  if (d.recent && d.recent.length) {
    const list = h('div', { class: 'log-list' },
      ...d.recent.map(line => h('div', { class: 'log-line' }, line))
    );
    activitySection.appendChild(list);
  } else {
    activitySection.appendChild(h('div', { class: 'subtle' }, 'no matches in recent stdout log'));
  }
  pane.appendChild(activitySection);
}

function renderCron(d) {
  const pane = document.getElementById('pane');
  pane.innerHTML = '';
  pane.appendChild(h('div', { class: 'detail-head' },
    h('div', {},
      h('div', {}, h('span', { class: 'badge cron' }, 'cron'), document.createTextNode(d.name)),
      h('h1', {}, d.name),
      h('div', { class: 'path' }, d.path)
    )
  ));

  const kv = h('dl', { class: 'kv' },
    h('dt', {}, 'schedule'), h('dd', {}, d.schedule),
    h('dt', {}, 'kind'), h('dd', {}, d.scheduleKind)
  );
  pane.appendChild(h('div', { class: 'section' }, h('h3', {}, 'config'), kv));

  pane.appendChild(h('div', { class: 'section' },
    h('h3', {}, 'prompt'),
    h('pre', { class: 'plain' }, d.prompt || '(empty)')
  ));

  const activitySection = h('div', { class: 'section' },
    h('h3', {}, `recent activity — stdout matches for "${d.name}"`)
  );
  if (d.recent && d.recent.length) {
    const list = h('div', { class: 'log-list' },
      ...d.recent.map(line => h('div', { class: 'log-line' }, line))
    );
    activitySection.appendChild(list);
  } else {
    activitySection.appendChild(h('div', { class: 'subtle' }, 'no matches in recent stdout log'));
  }
  pane.appendChild(activitySection);
}

function renderBootstrap(d) {
  const pane = document.getElementById('pane');
  pane.innerHTML = '';
  pane.appendChild(h('div', { class: 'detail-head' },
    h('div', {},
      h('div', {}, h('span', { class: 'badge bootstrap' }, 'bootstrap'), document.createTextNode(d.name)),
      h('h1', {}, d.name),
      h('div', { class: 'path' }, d.path)
    ),
    h('div', { class: 'subtle' }, `${fmtBytes(d.size)} · ${d.lineCount} lines · ${ago(d.mtime)}`)
  ));

  const body = h('div', { class: 'md' });
  body.innerHTML = d.bodyHtml || '';
  pane.appendChild(h('div', { class: 'section' }, h('h3', {}, 'contents'), body));
}

// ---------- TG stream view ----------

async function renderTgStream() {
  const pane = document.getElementById('pane');
  pane.innerHTML = '';
  pane.appendChild(h('div', { class: 'detail-head' },
    h('div', {},
      h('div', {}, h('span', { class: 'badge log' }, 'stream'), document.createTextNode('TG stream')),
      h('h1', {}, 'Telegram stream'),
      h('div', { class: 'path' }, '~/.cortextos/default/logs/massivlust-team/')
    )
  ));

  const restartsBox = h('div', { class: 'section' }, h('h3', {}, 'recent restarts'));
  const restartsInner = h('div', { class: 'log-list' });
  restartsBox.appendChild(restartsInner);
  pane.appendChild(restartsBox);

  const tableSection = h('div', { class: 'section' });
  tableSection.appendChild(h('h3', {}, 'last 50 messages (live)'));
  const table = h('table', { class: 'grid', id: 'tg-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'dir'),
      h('th', {}, 'time'),
      h('th', {}, 'chat'),
      h('th', {}, 'who'),
      h('th', {}, 'text')
    )),
    h('tbody', { id: 'tg-tbody' })
  );
  tableSection.appendChild(table);
  pane.appendChild(tableSection);

  await refreshTg({ restartsInner, initial: true });
}

async function refreshTg({ restartsInner, initial = false } = {}) {
  if (state.selected?.type !== 'tg') return;
  const data = await fetchJSON('/api/tg?limit=50');
  const tbody = document.getElementById('tg-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const newIds = new Set();
  for (const m of data.messages) {
    const key = `${m.direction}:${m.message_id ?? ''}:${m.ts ?? ''}`;
    newIds.add(key);
    const isNew = !initial && !state.tgSeenIds.has(key);
    const tr = h('tr', { class: `tg-row ${m.direction}${isNew ? ' new' : ''}` },
      h('td', {}, m.direction === 'in' ? '↙︎ in' : '↗︎ out'),
      h('td', {}, fmtTime(m.ts)),
      h('td', {}, String(m.chat_id ?? '')),
      h('td', {}, m.from_name || ''),
      h('td', {}, m.text || '')
    );
    tbody.appendChild(tr);
  }
  state.tgSeenIds = newIds;
  // Auto-scroll pane to bottom of table
  if (!initial) {
    const main = document.getElementById('main');
    main.scrollTop = main.scrollHeight;
  }
  if (restartsInner || document.querySelector('#pane .log-list')) {
    const target = restartsInner || document.querySelector('#pane .log-list');
    if (target && data.restarts) {
      target.innerHTML = '';
      for (const line of data.restarts.slice().reverse()) {
        target.appendChild(h('div', { class: 'log-line' }, line));
      }
    }
  }
}

// ---------- SSE ----------

function connectSSE() {
  if (state.sse) { try { state.sse.close(); } catch { /* ignore */ } }
  const es = new EventSource('/api/events');
  state.sse = es;
  es.onopen = () => setConn(true);
  es.onerror = () => {
    setConn(false);
    // browser auto-reconnects
  };
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleEvent(msg);
  };
}

function setConn(alive) {
  const el = document.getElementById('conn');
  el.classList.toggle('live', alive);
  el.classList.toggle('dead', !alive);
  el.querySelector('.conn-text').textContent = alive ? 'live' : 'offline';
}

let refreshTimer = null;
function scheduleSidebarRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadSurfaces().catch(() => {}), 400);
}

function handleEvent(msg) {
  if (msg.type !== 'file-changed') return;
  const kind = msg.kind;
  if (kind === 'tg' || kind === 'restart') {
    if (state.selected?.type === 'tg') refreshTg({});
    return;
  }
  scheduleSidebarRefresh();
  // Refresh currently-viewed surface if the changed file is relevant.
  if (!state.selected) return;
  const sel = state.selected;
  if (sel.type === 'skill' && msg.path && msg.path.includes('/skills/' + sel.id + '/')) {
    selectSurface('skill', sel.id);
    flashRow('skill', sel.id);
  } else if (sel.type === 'cron' && kind === 'cron') {
    selectSurface('cron', sel.id);
    flashRow('cron', sel.id);
  } else if (sel.type === 'bootstrap' && msg.path && msg.path.endsWith('/' + sel.id)) {
    selectSurface('bootstrap', sel.id);
    flashRow('bootstrap', sel.id);
  }
}

function flashRow(type, id) {
  const li = document.querySelector(`#sidebar li[data-type="${type}"][data-id="${id}"]`);
  if (!li) return;
  const name = li.querySelector('.row-name');
  name.classList.add('flash');
  setTimeout(() => name.classList.remove('flash'), 1500);
}

// ---------- init ----------

document.getElementById('search').addEventListener('input', (e) => applyFilter(e.target.value));

loadSurfaces().catch(err => {
  document.getElementById('pane').innerHTML = `<div class="empty"><h2>Backend not reachable</h2><pre class="plain">${esc(err.message)}</pre></div>`;
});
connectSSE();

// Poll TG lightly as a safety net in case a log rotate hides an event.
setInterval(() => {
  if (state.selected?.type === 'tg') refreshTg({});
}, 5000);
