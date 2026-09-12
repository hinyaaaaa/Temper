/* ============================================================
   app.js — Temper アプリケーション制御層
   ------------------------------------------------------------
   責務（憲法6条: 分離の原則）:
     - store.js（データ）、planner.js（今日の選定）、weather.js（空）を
       それぞれ「呼ぶだけ」で、ロジック自体はここに書かない。
     - 画面遷移・DOM描画・イベント配線のみを担当する。
   ============================================================ */
import * as Store from './store.js';
import * as Planner from './planner.js';
import * as Weather from './weather.js';

/* ------------------------------------------------------------
   状態
   ------------------------------------------------------------ */
let state = Store.loadState();
let currentPage = 'today';
let currentTodayPlan = null; // { entries, effectiveCapacity, totalLoad, reason }
let editingTaskId = null;
let detailTaskId = null;
let weatherState = null; // { condition, temperature, source } | null（取得失敗時）

const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

function persist() { Store.saveState(state); }

/* ------------------------------------------------------------
   今日のプラン再計算（planner.jsを呼ぶだけ、憲法6条）
   ------------------------------------------------------------ */
function recomputeTodayPlan() {
  currentTodayPlan = Planner.buildTodayPlan({
    tasks: state.tasks,
    todayStr: todayStr(),
    baseCapacity: state.settings.dailyCapacity,
    weekdayStats: Store.deriveWeekdayStats(state),
    weekdayPatternStats: Store.deriveWeekdayPatternStats(state),
    patternHistory: Store.derivePatternHistory(state),
  });
}

/* ------------------------------------------------------------
   ナビゲーション
   ------------------------------------------------------------ */
function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  render();
  document.getElementById('main-content').scrollTop = 0;
}

function render() {
  const root = document.getElementById('page-root');
  if (currentPage === 'today') root.innerHTML = renderTodayPage();
  else if (currentPage === 'tasks') root.innerHTML = renderTasksPage();
  else if (currentPage === 'settings') root.innerHTML = renderSettingsPage();
}

/* ------------------------------------------------------------
   今日画面（SPEC §6: 日付→天候→進捗→タスク→補助情報）
   ------------------------------------------------------------ */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

function weatherGlyphSvg(condition) {
  if (condition === 'rain') {
    return '<svg class="weather-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 16.5a4.5 4.5 0 01.5-8.98A6 6 0 0119 10.5a3.75 3.75 0 01-.5 7.48"/><line x1="9" y1="19" x2="9" y2="21.5"/><line x1="13" y1="19" x2="13" y2="21.5"/><line x1="17" y1="19" x2="17" y2="21.5"/></svg>';
  }
  if (condition === 'cloudy') {
    return '<svg class="weather-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 16.5a4.5 4.5 0 01.5-8.98A6 6 0 0119 10.5a3.75 3.75 0 01-.5 7.48H7z"/></svg>';
  }
  return '<svg class="weather-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="21.5"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="2.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="21.5" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/></svg>';
}

function renderTodayPage() {
  const today = todayStr();
  if (!currentTodayPlan) recomputeTodayPlan();
  const plan = currentTodayPlan;

  const pendingEntries = plan.entries.filter((e) => !isTaskDoneToday(e.id));
  const pct = plan.effectiveCapacity > 0 ? Math.min(1, plan.totalLoad > 0 ? doneLoadToday(plan) / plan.effectiveCapacity : 0) : 0;
  const circumference = 2 * Math.PI * 24;
  const offset = circumference * (1 - pct);

  const condition = weatherState ? weatherState.condition : 'clear';
  const weatherLabel = weatherState
    ? `${Weather.WEATHER_LABELS[condition] || '晴れ'}${weatherState.temperature != null ? '　' + weatherState.temperature + '℃' : ''}`
    : '天気を取得できませんでした';

  let taskListHtml;
  if (!plan.entries.length) {
    taskListHtml = `<div class="empty-state glass"><div class="glyph">✧</div><div class="msg">今日扱うタスクはありません</div></div>`;
  } else if (!pendingEntries.length) {
    taskListHtml = `<div class="empty-state glass"><div class="glyph">✧</div><div class="msg">今日の分はすべて終えました</div></div>`;
  } else {
    taskListHtml = pendingEntries.map((entry) => renderTaskCard(entry)).join('');
  }

  return `
    <div class="today-head">
      <div class="today-date">${formatDateLabel(today)}</div>
      <div class="today-weather-row">${weatherGlyphSvg(condition)}<span>${weatherLabel}</span></div>
    </div>
    <div class="load-ring-row">
      <svg class="load-ring-svg" viewBox="0 0 56 56">
        <circle class="load-ring-track" cx="28" cy="28" r="24"/>
        <circle class="load-ring-fill" cx="28" cy="28" r="24" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 28 28)"/>
      </svg>
      <div>
        <div class="load-text-main">今日の負荷　<span class="load-ring-label">${doneLoadToday(plan)}</span> / ${plan.effectiveCapacity}</div>
        <div class="load-text-sub">${pendingEntries.length}件のタスクが残っています</div>
      </div>
    </div>
    <div id="today-task-list">${taskListHtml}</div>
  `;
}

function doneLoadToday(plan) {
  return plan.entries.filter((e) => isTaskDoneToday(e.id)).reduce((sum, e) => sum + e.load, 0);
}

function isTaskDoneToday(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  return !!(t && t.done);
}

function renderTaskCard(entry) {
  const t = state.tasks.find((x) => x.id === entry.id);
  if (!t) return '';
  const chips = [];
  if (t.deadline) {
    const days = daysUntilFromToday(t.deadline);
    const near = days <= 1;
    chips.push(`<span class="task-meta-chip${near ? ' deadline-near' : ''}">${deadlineLabel(days)}</span>`);
  }
  chips.push(`<span class="load-dot-row">${loadDots(t.load)}</span>`);

  return `
    <div class="task-card glass" data-task-id="${t.id}" ontouchstart="Temper.onCardPressStart('${t.id}')" ontouchend="Temper.onCardPressEnd()" onmousedown="Temper.onCardPressStart('${t.id}')" onmouseup="Temper.onCardPressEnd()" onmouseleave="Temper.onCardPressEnd()">
      <button class="task-check" onclick="event.stopPropagation();Temper.completeTask('${t.id}')" aria-label="完了にする">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>
      </button>
      <div class="task-main">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta-row">${chips.join('')}</div>
      </div>
    </div>
  `;
}

function loadDots(load) {
  let html = '';
  const filled = Math.max(1, Math.round(load / 2));
  for (let i = 0; i < 5; i++) html += `<span class="load-dot${i < filled ? ' filled' : ''}"></span>`;
  return html;
}

function daysUntilFromToday(deadline) {
  const a = new Date(todayStr() + 'T00:00:00');
  const b = new Date(deadline + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function deadlineLabel(days) {
  if (days < 0) return `${Math.abs(days)}日超過`;
  if (days === 0) return '今日まで';
  if (days === 1) return '明日まで';
  return `あと${days}日`;
}

/* ------------------------------------------------------------
   長押し検出 → 詳細シート（SPEC §11、常時表示はしない）
   ------------------------------------------------------------ */
let pressTimer = null;
function onCardPressStart(taskId) {
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => openDetailSheet(taskId), 480);
}
function onCardPressEnd() {
  clearTimeout(pressTimer);
}

function openDetailSheet(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  detailTaskId = taskId;
  const entry = currentTodayPlan && currentTodayPlan.entries.find((e) => e.id === taskId);
  const reason = entry ? Planner.explainSelection(entry) : null;

  const body = document.getElementById('detail-sheet-body');
  body.innerHTML = `
    <div class="sheet-title">${esc(t.title)}</div>
    ${t.description ? `<div style="color:var(--ink-soft);font-size:13.5px;margin-bottom:10px">${esc(t.description)}</div>` : ''}
    <div class="sheet-row"><span class="sheet-row-label">期限</span><span>${t.deadline ? formatDateLabel(t.deadline) : 'なし'}</span></div>
    <div class="sheet-row"><span class="sheet-row-label">解禁日</span><span>${t.unlockDate ? formatDateLabel(t.unlockDate) : 'なし'}</span></div>
    <div class="sheet-row"><span class="sheet-row-label">負荷</span><span>${t.load} / 10</span></div>
    ${reason ? `<div class="sheet-reason">今日選ばれた理由：${esc(reason)}</div>` : ''}
    <div class="sheet-actions">
      <button class="btn btn-secondary" style="flex:1" onclick="Temper.closeDetailSheet();Temper.openEditTask('${t.id}')">編集する</button>
      <button class="btn btn-secondary" style="flex:1" onclick="Temper.closeDetailSheet()">閉じる</button>
    </div>
  `;
  document.getElementById('detail-sheet').classList.add('open');
}
function closeDetailSheet() {
  document.getElementById('detail-sheet').classList.remove('open');
  detailTaskId = null;
}

/* ------------------------------------------------------------
   タスク完了（SPEC §10: 静かに消える、演出をしない）
   ------------------------------------------------------------ */
function completeTask(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  const cardEl = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  if (cardEl) cardEl.classList.add('completing');

  const finish = () => {
    t.done = true;
    t.doneDate = todayStr();
    Store.recordCompletion(state, t, todayStr());
    persist();
    render();
  };
  if (cardEl) setTimeout(finish, 320);
  else finish();
}

/* ------------------------------------------------------------
   タスク一覧画面
   ------------------------------------------------------------ */
let taskFilter = 'active';
function renderTasksPage() {
  const all = state.tasks;
  const active = all.filter((t) => !t.done);
  const done = all.filter((t) => t.done);
  const list = taskFilter === 'active' ? active : done;

  const listHtml = list.length
    ? list.map((t) => renderTaskListItem(t)).join('')
    : `<div class="empty-state glass"><div class="glyph">✧</div><div class="msg">${taskFilter === 'active' ? 'タスクがありません' : '完了したタスクはまだありません'}</div></div>`;

  return `
    <div class="page-title">タスク</div>
    <div class="filter-row">
      <button class="filter-chip glass ${taskFilter === 'active' ? 'active' : ''}" onclick="Temper.setTaskFilter('active')">未完了 ${active.length ? `(${active.length})` : ''}</button>
      <button class="filter-chip glass ${taskFilter === 'done' ? 'active' : ''}" onclick="Temper.setTaskFilter('done')">完了済み</button>
    </div>
    <div>${listHtml}</div>
  `;
}

function setTaskFilter(f) { taskFilter = f; render(); }

function renderTaskListItem(t) {
  return `
    <div class="task-list-item glass ${t.done ? 'done' : ''}">
      <div class="task-main">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta-row">
          ${t.deadline ? `<span class="task-meta-chip">${deadlineLabel(daysUntilFromToday(t.deadline))}</span>` : ''}
          <span class="load-dot-row">${loadDots(t.load)}</span>
        </div>
      </div>
      <div class="task-list-actions">
        <button class="icon-btn" onclick="Temper.openEditTask('${t.id}')" aria-label="編集">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn" onclick="Temper.deleteTask('${t.id}')" aria-label="削除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
  `;
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter((t) => t.id !== taskId);
  persist();
  recomputeTodayPlan();
  render();
  showToast('削除しました');
}

/* ------------------------------------------------------------
   タスク追加/編集モーダル
   ------------------------------------------------------------ */
function openAddTask() {
  editingTaskId = null;
  document.getElementById('modal-task-title').textContent = 'タスクを追加';
  document.getElementById('input-title').value = '';
  document.getElementById('input-description').value = '';
  document.getElementById('input-deadline').value = '';
  document.getElementById('input-unlock').value = '';
  setLoadSlider(4);
  openModal('modal-task');
}

function openEditTask(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  editingTaskId = taskId;
  document.getElementById('modal-task-title').textContent = 'タスクを編集';
  document.getElementById('input-title').value = t.title || '';
  document.getElementById('input-description').value = t.description || '';
  document.getElementById('input-deadline').value = t.deadline || '';
  document.getElementById('input-unlock').value = t.unlockDate || '';
  setLoadSlider(t.load || 4);
  openModal('modal-task');
}

function setLoadSlider(v) {
  document.getElementById('input-load').value = v;
  document.getElementById('load-slider-val').textContent = v;
}
function onLoadSliderInput(v) {
  document.getElementById('load-slider-val').textContent = v;
}

function saveTaskFromModal() {
  const title = document.getElementById('input-title').value.trim();
  if (!title) { showToast('タイトルを入力してください'); return; }
  const description = document.getElementById('input-description').value.trim();
  const deadline = document.getElementById('input-deadline').value || null;
  const unlockDate = document.getElementById('input-unlock').value || null;
  const load = parseInt(document.getElementById('input-load').value, 10) || 4;

  if (editingTaskId) {
    const t = state.tasks.find((x) => x.id === editingTaskId);
    if (t) {
      t.title = title; t.description = description; t.deadline = deadline;
      t.unlockDate = unlockDate; t.load = load;
      t.pattern = Planner.estimatePattern(title, description, Store.derivePatternHistory(state));
    }
  } else {
    state.tasks.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title, description, deadline, unlockDate, load,
      done: false, doneDate: null,
      pattern: Planner.estimatePattern(title, description, Store.derivePatternHistory(state)),
      createdAt: Date.now(),
    });
  }
  persist();
  closeTaskModal();
  recomputeTodayPlan();
  render();
  showToast(editingTaskId ? '更新しました' : 'タスクを追加しました');
}

function closeTaskModal() { closeModal('modal-task'); editingTaskId = null; }
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

/* ------------------------------------------------------------
   設定画面
   ------------------------------------------------------------ */
function renderSettingsPage() {
  const cap = state.settings.dailyCapacity;
  return `
    <div class="page-title">設定</div>
    <div class="settings-section glass">
      <div class="settings-label">1日の負荷キャパシティ</div>
      <div class="load-slider-row">
        <input type="range" min="1" max="10" step="1" value="${cap}" oninput="Temper.onCapacityInput(this.value)">
        <span class="load-slider-val" id="capacity-val">${cap}</span>
      </div>
      <div class="settings-row-desc">通常の状態で無理なく扱える1日あたりの負荷の目安です。</div>
    </div>
    <div class="settings-section glass">
      <div class="settings-row">
        <div>
          <div>位置情報から天気を取得</div>
          <div class="settings-row-desc">オフにすると常に晴れとして表示されます</div>
        </div>
        <button class="toggle ${state.settings.weatherAutoLocation ? 'on' : ''}" onclick="Temper.toggleWeatherAuto()"></button>
      </div>
    </div>
    <div class="settings-section glass">
      <div class="settings-label">データ</div>
      <button class="btn btn-secondary btn-full" onclick="Temper.exportHistory()">学習履歴を書き出す</button>
    </div>
  `;
}

function onCapacityInput(v) {
  state.settings.dailyCapacity = parseInt(v, 10);
  document.getElementById('capacity-val').textContent = v;
  persist();
  recomputeTodayPlan();
}

function toggleWeatherAuto() {
  state.settings.weatherAutoLocation = !state.settings.weatherAutoLocation;
  persist();
  render();
  refreshWeather();
}

function exportHistory() {
  const json = Store.exportHistoryJson(state);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `temper_history_${todayStr()}.json`;
  a.click();
  showToast('書き出しました');
}

/* ------------------------------------------------------------
   トースト
   ------------------------------------------------------------ */
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ------------------------------------------------------------
   天候・空の更新（憲法11条: 失敗しても主機能は継続）
   ------------------------------------------------------------ */
async function refreshWeather() {
  try {
    const manual = state.settings.weatherAutoLocation ? null : (state.settings.manualWeatherCondition || 'clear');
    weatherState = await Weather.getWeather(manual);
  } catch (e) {
    weatherState = null; // 失敗時は呼び出し側でclear扱いにする（applySky内）
  }
  applySky();
  if (currentPage === 'today') render();
}

function applySky() {
  const timeOfDay = Weather.getTimeOfDay();
  const condition = weatherState ? weatherState.condition : 'clear';
  const sky = document.getElementById('sky');
  sky.dataset.time = timeOfDay;
  sky.dataset.condition = condition;

  const [top, mid, bottom] = Weather.getSkyGradient(timeOfDay, condition);
  sky.style.background = `linear-gradient(180deg, ${top} 0%, ${mid} 55%, ${bottom} 100%)`;

  const tone = Weather.getTextToneFor(timeOfDay);
  document.documentElement.dataset.tone = tone === 'light' ? 'light' : '';
  document.getElementById('theme-color-meta').setAttribute('content', top);

  const sun = document.getElementById('sky-sun');
  sun.style.background = `radial-gradient(circle, ${bottom === top ? top : mid} 0%, rgba(255,255,255,0) 70%)`;

  ensureClouds();
  ensureRain();
}

function ensureClouds() {
  const container = document.getElementById('sky-clouds');
  if (container.childElementCount > 0) return;
  const sizes = [[30, 14, 20, 30], [22, 10, 50, 15], [26, 12, 70, 45]];
  sizes.forEach(([w, h, top, delay], i) => {
    const c = document.createElement('div');
    c.className = 'cloud';
    c.style.width = w + 'vw'; c.style.height = h + 'vw'; c.style.top = top + '%';
    c.style.animationDuration = (70 + i * 20) + 's';
    c.style.animationDelay = -delay + 's';
    container.appendChild(c);
  });
}

function ensureRain() {
  const container = document.getElementById('sky-rain');
  if (container.childElementCount > 0) return;
  for (let i = 0; i < 40; i++) {
    const d = document.createElement('div');
    d.className = 'rain-drop';
    d.style.left = Math.random() * 100 + '%';
    d.style.animationDuration = (0.6 + Math.random() * 0.5) + 's';
    d.style.animationDelay = Math.random() * 1 + 's';
    container.appendChild(d);
  }
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
function init() {
  recomputeTodayPlan();
  applySky(); // まず既定（晴れ・現在時刻）で即座に描画し、体感の遅延を作らない
  render();
  refreshWeather();
  setInterval(applySky, 5 * 60 * 1000); // 時間帯の緩やかな遷移（SPEC §8）

  document.querySelectorAll('.modal-overlay, .sheet-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
  });
}

window.Temper = {
  navigateTo, completeTask, onCardPressStart, onCardPressEnd,
  openDetailSheet, closeDetailSheet, setTaskFilter,
  openAddTask, openEditTask, deleteTask, saveTaskFromModal, closeTaskModal,
  onLoadSliderInput, onCapacityInput, toggleWeatherAuto, exportHistory,
};

document.addEventListener('DOMContentLoaded', init);

// FAB（タスク一覧画面にのみ表示、動的に差し込む）
const fabObserver = new MutationObserver(() => {
  const existing = document.getElementById('add-task-fab');
  if (currentPage === 'tasks' && !existing) {
    const fab = document.createElement('button');
    fab.id = 'add-task-fab';
    fab.className = 'fab glass glass-strong';
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    fab.addEventListener('click', openAddTask);
    document.getElementById('app').appendChild(fab);
  } else if (currentPage !== 'tasks' && existing) {
    existing.remove();
  }
});
fabObserver.observe(document.getElementById('page-root') || document.body, { childList: true, subtree: true });
