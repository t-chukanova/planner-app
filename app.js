// ================= IndexedDB =================
const DB_NAME = 'planner-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('todos')) db.createObjectStore('todos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(store, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function remove(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ================= Date utils =================
const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_NOM = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const WEEKDAYS_SHORT = ['пн','вт','ср','чт','пт','сб','вс'];

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function sameDay(a, b) { return dateKey(a) === dateKey(b); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function addMonths(d, n) { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; }
function startOfWeekMonday(d) {
  const r = new Date(d);
  const dow = (r.getDay() + 6) % 7; // 0 = Monday
  r.setDate(r.getDate() - dow);
  return r;
}
function dateAtMinutes(key, minutes) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setMinutes(minutes);
  return dt.getTime();
}
function minutesLabel(mins) {
  const h = Math.floor((mins % 1440 + 1440) % 1440 / 60);
  const m = mins % 60;
  return pad(h) + ':' + pad(Math.abs(m));
}

// ================= State =================
let currentView = 'day';
let anchorDate = new Date(); anchorDate.setHours(0,0,0,0);
let allBlocks = [];
let allTodos = [];
let editingId = null;
let editingType = 'block';

const COLORS = ['#E8A33D','#6FCF97','#5B9BD5','#C77DFF','#E0654F','#4DD0E1','#F2C94C','#9AA7B8'];
let selectedColor = COLORS[0];

// ================= Service worker & notifications =================
let swRegistration = null;
async function registerSW() {
  if ('serviceWorker' in navigator) {
    swRegistration = await navigator.serviceWorker.register('sw.js');
    try {
      if ('periodicSync' in swRegistration) {
        await swRegistration.periodicSync.register('check-blocks', { minInterval: 15 * 60 * 1000 });
      }
    } catch (e) {}
  }
}

function updatePermStatus() {
  const banner = document.getElementById('permBanner');
  if (!('Notification' in window)) { banner.hidden = true; return; }
  banner.hidden = Notification.permission === 'granted' || Notification.permission === 'denied';
}
async function requestPermission() {
  if (!('Notification' in window)) return;
  await Notification.requestPermission();
  updatePermStatus();
  scheduleAll();
}

const timers = new Map();
function fireNotification(block) {
  const body = 'Запланировано на ' + minutesLabel(block.start);
  if (swRegistration) {
    swRegistration.showNotification(block.title, { body, icon: 'icons/icon-192.png', tag: 'block-' + block.id, renotify: true });
  } else if (Notification.permission === 'granted') {
    new Notification(block.title, { body, icon: 'icons/icon-192.png' });
  }
}
async function scheduleAll() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  timers.forEach(t => clearTimeout(t));
  timers.clear();
  const now = Date.now();
  const HORIZON = 6 * 60 * 60 * 1000;
  for (const b of allBlocks) {
    if (b.notify === false) continue;
    const due = dateAtMinutes(b.date, b.start);
    const delay = due - now;
    if (delay <= 0 && !b.notified) {
      fireNotification(b);
      b.notified = true;
      await put('blocks', b);
    } else if (delay > 0 && delay <= HORIZON) {
      const id = setTimeout(async () => { fireNotification(b); b.notified = true; await put('blocks', b); }, delay);
      timers.set(b.id, id);
    }
  }
}

// ================= Data load =================
async function reloadData() {
  allBlocks = await getAll('blocks');
  allTodos = await getAll('todos');
}

// ================= View switching / nav =================
function setView(v) {
  currentView = v;
  document.querySelectorAll('.view-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.view === v));
  render();
}
function shiftAnchor(dir) {
  if (currentView === 'day') anchorDate = addDays(anchorDate, dir);
  else if (currentView === '3day') anchorDate = addDays(anchorDate, dir * 3);
  else if (currentView === 'week') anchorDate = addDays(anchorDate, dir * 7);
  else if (currentView === 'month') anchorDate = addMonths(anchorDate, dir);
  else if (currentView === 'quarter') anchorDate = addMonths(anchorDate, dir * 3);
  else if (currentView === 'year') anchorDate = new Date(anchorDate.getFullYear() + dir, anchorDate.getMonth(), 1);
  render();
}
function goToday() {
  anchorDate = new Date(); anchorDate.setHours(0,0,0,0);
  render();
}

function updateDateLabel(days) {
  const label = document.getElementById('dateLabel');
  if (currentView === 'day') {
    label.textContent = anchorDate.getDate() + ' ' + MONTHS_GEN[anchorDate.getMonth()];
  } else if (currentView === '3day' || currentView === 'week') {
    const first = days[0], last = days[days.length - 1];
    if (first.getMonth() === last.getMonth()) {
      label.textContent = first.getDate() + '–' + last.getDate() + ' ' + MONTHS_GEN[first.getMonth()];
    } else {
      label.textContent = first.getDate() + ' ' + MONTHS_GEN[first.getMonth()] + ' – ' + last.getDate() + ' ' + MONTHS_GEN[last.getMonth()];
    }
  } else if (currentView === 'month') {
    label.textContent = MONTHS_NOM[anchorDate.getMonth()] + ' ' + anchorDate.getFullYear();
  } else if (currentView === 'quarter') {
    const m2 = addMonths(anchorDate, 2);
    label.textContent = MONTHS_NOM[anchorDate.getMonth()].slice(0,3) + ' – ' + MONTHS_NOM[m2.getMonth()].slice(0,3) + ' ' + m2.getFullYear();
  } else if (currentView === 'year') {
    label.textContent = String(anchorDate.getFullYear());
  }
}

// ================= Render dispatch =================
function render() {
  const root = document.getElementById('viewRoot');
  root.innerHTML = '';
  if (currentView === 'day') renderGrid(root, [new Date(anchorDate)]);
  else if (currentView === '3day') renderGrid(root, [0,1,2].map(i => addDays(anchorDate, i)));
  else if (currentView === 'week') { const start = startOfWeekMonday(anchorDate); renderGrid(root, [0,1,2,3,4,5,6].map(i => addDays(start, i))); }
  else if (currentView === 'month') renderMonth(root);
  else if (currentView === 'quarter') renderMultiMonth(root, 3);
  else if (currentView === 'year') renderMultiMonth(root, 12);
}

// ================= Grid view (day/3day/week) =================
function renderGrid(root, days) {
  updateDateLabel(days);

  const todoStrip = document.createElement('div');
  todoStrip.className = 'todo-strip';
  const todoGutter = document.createElement('div'); todoGutter.className = 'time-gutter'; todoStrip.appendChild(todoGutter);
  days.forEach(day => {
    const key = dateKey(day);
    const col = document.createElement('div'); col.className = 'todo-col';
    allTodos.filter(t => t.date === key).forEach(t => {
      const chip = document.createElement('label');
      chip.className = 'todo-chip' + (t.done ? ' done' : '');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
      cb.onchange = async () => { t.done = cb.checked; await put('todos', t); render(); };
      const span = document.createElement('span'); span.textContent = t.title;
      span.onclick = (e) => { e.preventDefault(); openSheet('todo', t); };
      chip.appendChild(cb); chip.appendChild(span);
      col.appendChild(chip);
    });
    todoStrip.appendChild(col);
  });
  root.appendChild(todoStrip);
  todoStrip.style.overflow = 'hidden';

  const today = new Date();
  const scroll = document.createElement('div'); scroll.className = 'grid-scroll';
  const inner = document.createElement('div'); inner.className = 'grid-inner';

  const gutter = document.createElement('div'); gutter.className = 'time-gutter';
  const gutterSpacer = document.createElement('div'); gutterSpacer.className = 'gutter-spacer'; gutter.appendChild(gutterSpacer);
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('div'); lbl.className = 'hour-label'; lbl.textContent = pad(h) + ':00';
    gutter.appendChild(lbl);
  }
  inner.appendChild(gutter);

  const colsWrap = document.createElement('div'); colsWrap.className = 'day-columns';

  days.forEach(day => {
    const key = dateKey(day);
    const isToday = sameDay(day, today);
    const col = document.createElement('div'); col.className = 'day-col' + (isToday ? ' today' : '');
    col.dataset.date = key;

    const header = document.createElement('div'); header.className = 'day-col-header' + (isToday ? ' today' : '');
    header.innerHTML = '<span>' + WEEKDAYS_SHORT[(day.getDay()+6)%7] + '</span> <span class="num">' + day.getDate() + '</span>';
    col.appendChild(header);

    const content = document.createElement('div'); content.className = 'day-col-content';
    content.style.height = (24 * 52) + 'px';
    allBlocks.filter(b => b.date === key).forEach(b => content.appendChild(renderBlockEl(b)));
    attachLongPress(content, key);
    col.appendChild(content);

    colsWrap.appendChild(col);
  });

  inner.appendChild(colsWrap);
  scroll.appendChild(inner);
  root.appendChild(scroll);

  // keep the top todo strip's columns aligned with the grid when scrolling sideways
  scroll.addEventListener('scroll', () => { todoStrip.scrollLeft = scroll.scrollLeft; });

  // scroll to 7am by default
  requestAnimationFrame(() => { scroll.scrollTop = 7 * 52; });
}

function renderBlockEl(b) {
  const el = document.createElement('div');
  el.className = 'block';
  el.style.top = (b.start / 60 * 52) + 'px';
  el.style.height = Math.max(20, (b.end - b.start) / 60 * 52) + 'px';
  el.style.background = b.color + 'cc';
  el.style.borderLeftColor = b.color;
  el.innerHTML = '<div class="block-title"></div><div class="block-time"></div>';
  el.querySelector('.block-title').textContent = b.title;
  el.querySelector('.block-time').textContent = minutesLabel(b.start) + '–' + minutesLabel(b.end);

  const topHandle = document.createElement('div'); topHandle.className = 'block-handle top';
  const botHandle = document.createElement('div'); botHandle.className = 'block-handle bottom';
  el.appendChild(topHandle); el.appendChild(botHandle);

  attachBlockDrag(el, b, topHandle, botHandle);
  return el;
}

// ---- long press to create a block ----
function attachLongPress(col, dateKeyStr) {
  let timer = null, startY = 0, startX = 0, longPressed = false;

  col.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.block')) return;
    startY = e.clientY; startX = e.clientX; longPressed = false;
    const rect = col.getBoundingClientRect();
    timer = setTimeout(() => {
      longPressed = true;
      const y = startY - rect.top;
      let minutes = Math.round((y / 52 * 60) / 15) * 15;
      minutes = Math.max(0, Math.min(1425, minutes));
      openSheet('block', null, dateKeyStr, minutes);
    }, 450);
  });
  col.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientY - startY) > 10 || Math.abs(e.clientX - startX) > 10) {
      clearTimeout(timer);
    }
  });
  col.addEventListener('pointerup', () => clearTimeout(timer));
  col.addEventListener('pointercancel', () => clearTimeout(timer));
}

// ---- drag to move / resize a block ----
function attachBlockDrag(el, block, topHandle, botHandle) {
  let mode = null; // 'move' | 'resize-top' | 'resize-bottom'
  let startY = 0, origStart = 0, origEnd = 0, moved = false;

  function begin(e, m) {
    mode = m; moved = false;
    startY = e.clientY;
    origStart = block.start; origEnd = block.end;
    el.setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  el.addEventListener('pointerdown', (e) => { if (e.target === topHandle || e.target === botHandle) return; begin(e, 'move'); });
  topHandle.addEventListener('pointerdown', (e) => begin(e, 'resize-top'));
  botHandle.addEventListener('pointerdown', (e) => begin(e, 'resize-bottom'));

  el.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const deltaMin = Math.round((e.clientY - startY) / 52 * 60 / 15) * 15;
    if (deltaMin === 0) return;
    moved = true;
    if (mode === 'move') {
      let ns = origStart + deltaMin, ne = origEnd + deltaMin;
      const dur = origEnd - origStart;
      ns = Math.max(0, Math.min(1440 - dur, ns)); ne = ns + dur;
      block.start = ns; block.end = ne;
    } else if (mode === 'resize-top') {
      let ns = Math.max(0, Math.min(origEnd - 15, origStart + deltaMin));
      block.start = ns;
    } else if (mode === 'resize-bottom') {
      let ne = Math.min(1440, Math.max(origStart + 15, origEnd + deltaMin));
      block.end = ne;
    }
    el.style.top = (block.start / 60 * 52) + 'px';
    el.style.height = Math.max(20, (block.end - block.start) / 60 * 52) + 'px';
    el.querySelector('.block-time').textContent = minutesLabel(block.start) + '–' + minutesLabel(block.end);
  });

  el.addEventListener('pointerup', async (e) => {
    if (!mode) return;
    const wasMoved = moved;
    mode = null;
    if (wasMoved) {
      await put('blocks', block);
      await reloadData();
      scheduleAll();
    } else {
      openSheet('block', block);
    }
  });
}

// ================= Month view =================
function renderMonth(root) {
  updateDateLabel();
  const wrap = document.createElement('div'); wrap.className = 'month-view';

  const wd = document.createElement('div'); wd.className = 'month-weekdays';
  WEEKDAYS_SHORT.forEach(w => { const s = document.createElement('div'); s.textContent = w; wd.appendChild(s); });
  wrap.appendChild(wd);

  const grid = document.createElement('div'); grid.className = 'month-grid';
  const firstOfMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const gridStart = startOfWeekMonday(firstOfMonth);
  const today = new Date();

  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const key = dateKey(day);
    const cell = document.createElement('div');
    cell.className = 'month-cell' + (day.getMonth() !== anchorDate.getMonth() ? ' other' : '') + (sameDay(day, today) ? ' today' : '');
    const num = document.createElement('div'); num.className = 'daynum'; num.textContent = day.getDate();
    cell.appendChild(num);

    const dayBlocks = allBlocks.filter(b => b.date === key);
    const dayTodos = allTodos.filter(t => t.date === key);
    if (dayBlocks.length || dayTodos.length) {
      const dots = document.createElement('div'); dots.className = 'month-dots';
      const colors = [...new Set(dayBlocks.map(b => b.color))].slice(0, 4);
      colors.forEach(c => { const d = document.createElement('div'); d.className = 'month-dot'; d.style.background = c; dots.appendChild(d); });
      if (dayTodos.length) { const d = document.createElement('div'); d.className = 'month-dot'; d.style.background = 'var(--text-dim)'; dots.appendChild(d); }
      cell.appendChild(dots);
    }
    cell.onclick = () => { anchorDate = day; setView('day'); };
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  root.appendChild(wrap);
}

// ================= Quarter / Year view =================
function buildMiniMonth(year, monthIndex, itemDates) {
  const wrap = document.createElement('div');
  const title = document.createElement('div'); title.className = 'mini-month-title'; title.textContent = MONTHS_NOM[monthIndex] + ' ' + year;
  wrap.appendChild(title);

  const wd = document.createElement('div'); wd.className = 'mini-weekdays';
  WEEKDAYS_SHORT.forEach(w => { const s = document.createElement('div'); s.textContent = w[0].toUpperCase(); wd.appendChild(s); });
  wrap.appendChild(wd);

  const grid = document.createElement('div'); grid.className = 'mini-grid';
  const firstOfMonth = new Date(year, monthIndex, 1);
  const gridStart = startOfWeekMonday(firstOfMonth);
  const today = new Date();

  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    if (day.getMonth() !== monthIndex && i >= 35) continue;
    const key = dateKey(day);
    const cell = document.createElement('div');
    cell.className = 'mini-cell' + (day.getMonth() !== monthIndex ? ' other' : '') + (sameDay(day, today) ? ' today' : (itemDates.has(key) ? ' hasitems' : ''));
    cell.textContent = day.getDate();
    cell.onclick = () => { anchorDate = day; setView('day'); };
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderMultiMonth(root, count) {
  updateDateLabel();
  const wrap = document.createElement('div'); wrap.className = 'multi-month';
  const itemDates = new Set([...allBlocks.map(b => b.date), ...allTodos.map(t => t.date)]);

  if (count === 12) {
    const grid = document.createElement('div'); grid.className = 'year-grid';
    for (let m = 0; m < 12; m++) grid.appendChild(buildMiniMonth(anchorDate.getFullYear(), m, itemDates));
    wrap.appendChild(grid);
  } else {
    for (let i = 0; i < count; i++) {
      const d = addMonths(anchorDate, i);
      wrap.appendChild(buildMiniMonth(d.getFullYear(), d.getMonth(), itemDates));
    }
  }
  root.appendChild(wrap);
}

// ================= Sheet (add/edit) =================
const sheet = document.getElementById('sheet');

function buildColorRow() {
  const row = document.getElementById('colorRow');
  row.innerHTML = '';
  COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch' + (c === selectedColor ? ' selected' : '');
    sw.style.background = c;
    sw.onclick = () => { selectedColor = c; buildColorRow(); };
    row.appendChild(sw);
  });
  const customLabel = document.createElement('label');
  customLabel.className = 'swatch swatch-custom';
  customLabel.textContent = '+';
  const input = document.createElement('input');
  input.type = 'color'; input.id = 'customColorInput';
  input.style.position = 'absolute'; input.style.opacity = '0';
  input.oninput = () => { selectedColor = input.value; buildColorRow(); };
  customLabel.appendChild(input);
  row.appendChild(customLabel);
}

function setType(type) {
  editingType = type;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.getElementById('blockTimeFields').style.display = type === 'block' ? 'block' : 'none';
}

function openSheet(type, item, presetDate, presetStartMin) {
  setType(type);
  document.getElementById('typeToggle').style.display = item ? 'none' : 'flex';
  document.getElementById('deleteBtn').hidden = !item;
  editingId = item ? item.id : null;

  const today = presetDate || dateKey(anchorDate);
  document.getElementById('itemDate').value = item ? item.date : today;

  if (type === 'block') {
    selectedColor = item ? item.color : COLORS[0];
    buildColorRow();
    document.getElementById('itemTitle').value = item ? item.title : '';
    const startMin = item ? item.start : (presetStartMin != null ? presetStartMin : 540);
    const endMin = item ? item.end : startMin + 60;
    document.getElementById('itemStart').value = minutesLabel(startMin);
    document.getElementById('itemEnd').value = minutesLabel(endMin);
  } else {
    document.getElementById('itemTitle').value = item ? item.title : '';
  }
  sheet.hidden = false;
  document.getElementById('itemTitle').focus();
}
function closeSheet() { sheet.hidden = true; editingId = null; }

document.querySelectorAll('.type-btn').forEach(b => b.onclick = () => setType(b.dataset.type));
document.getElementById('addBtn').onclick = () => openSheet('block', null);
document.getElementById('cancelBtn').onclick = closeSheet;
document.getElementById('permBtn').onclick = requestPermission;

document.getElementById('deleteBtn').onclick = async () => {
  if (!editingId) return;
  await remove(editingType === 'block' ? 'blocks' : 'todos', editingId);
  await reloadData();
  closeSheet();
  render();
  scheduleAll();
};

document.getElementById('saveBtn').onclick = async () => {
  const title = document.getElementById('itemTitle').value.trim();
  const date = document.getElementById('itemDate').value;
  if (!title || !date) return;

  if (editingType === 'block') {
    const [sh, sm] = document.getElementById('itemStart').value.split(':').map(Number);
    const [eh, em] = document.getElementById('itemEnd').value.split(':').map(Number);
    let start = sh * 60 + sm, end = eh * 60 + em;
    if (end <= start) end = start + 30;
    const block = {
      id: editingId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      title, date, start, end, color: selectedColor,
      notify: true, notified: false
    };
    await put('blocks', block);
  } else {
    const todo = {
      id: editingId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      title, date, done: editingId ? (allTodos.find(t => t.id === editingId) || {}).done : false
    };
    await put('todos', todo);
  }
  await reloadData();
  closeSheet();
  render();
  scheduleAll();
};

// ================= Nav wiring =================
document.getElementById('prevBtn').onclick = () => shiftAnchor(-1);
document.getElementById('nextBtn').onclick = () => shiftAnchor(1);
document.getElementById('dateLabel').onclick = goToday;
document.querySelectorAll('.view-tab').forEach(btn => btn.onclick = () => setView(btn.dataset.view));

// ================= Init =================
(async function init() {
  document.querySelector('.view-tab[data-view="day"]').classList.add('active');
  updatePermStatus();
  await registerSW();
  await reloadData();
  render();
  await scheduleAll();

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await reloadData();
      render();
      scheduleAll();
    }
  });
})();
