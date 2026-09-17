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
  try {
    if (currentPage === 'today') root.innerHTML = renderTodayPage();
    else if (currentPage === 'tasks') root.innerHTML = renderTasksPage();
    else if (currentPage === 'settings') root.innerHTML = renderSettingsPage();
  } catch (err) {
    // 画面が真っ白のまま原因不明で止まる事故を防ぐため、失敗時は
    // エラー内容を画面に出す（無音の失敗より、目に見える失敗の方が
    // 復旧しやすいという判断。本番相当でも最低限の可視化は残す）。
    console.error('[Temper] render failed', err);
    root.innerHTML = `<div class="empty-state glass"><div class="glyph">⚠</div><div class="msg">表示中にエラーが発生しました：${String(err && err.message || err)}</div></div>`;
  }
  updateFab();
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

  const profile = Weather.getSkyProfile(timeOfDay, condition);

  // 空本体: 4停止点のグラデーション（従来の3色帯から拡張し、地平線側の
  // 霞み・天頂側の深みを表現できるようにした）。
  sky.style.background = `linear-gradient(180deg, ${profile.stops.join(', ')})`;

  const tone = Weather.getTextToneFor(timeOfDay);
  document.documentElement.dataset.tone = tone === 'light' ? 'light' : '';
  document.getElementById('theme-color-meta').setAttribute('content', profile.stops[0].split(' ')[0]);

  // 太陽/月: 単なる円ではなく「光源の色 → 光暈 → 透明」の同心円グラデーションを
  // 実際の位置(x,y)・大きさ・強さに応じて配置する。雨天では強さをほぼ0にして
  // 存在感を消すが、要素自体は残す（急なレイアウト変化を避けるため）。
  const sun = document.getElementById('sky-sun');
  sun.style.left = profile.sun.x + '%';
  sun.style.top = profile.sun.y + '%';
  sun.style.width = profile.sun.size + 'vmax';
  sun.style.height = profile.sun.size + 'vmax';
  sun.style.opacity = String(profile.sun.strength);
  sun.style.background = `radial-gradient(circle, ${profile.sun.color} 0%, ${profile.sun.glow} 35%, rgba(255,255,255,0) 72%)`;

  // 雲: 色調(tint)と全体の不透明度をプロファイルに応じて変える。
  // 個々の雲の形・配置はensureClouds()で一度だけ生成し、以後は
  // このtint/opacityの変更だけで見た目を切り替える（DOM再生成しない）。
  const cloudsContainer = document.getElementById('sky-clouds');
  cloudsContainer.style.opacity = String(profile.cloud.opacity);
  ensureClouds();
  cloudsContainer.querySelectorAll('.cloud').forEach((c) => { c.style.color = profile.cloud.tint; });

  // 星: 密度は固定（ensureStars）、可視性のみプロファイルで変える。
  ensureStars();
  document.getElementById('sky-stars').style.opacity = String(profile.starOpacity);

  ensureRain();
}

/**
 * 雲を実際に「雲らしい輪郭」で描く。
 * ------------------------------------------------------------
 * 旧実装は単一の角丸長方形にblur(18px)をかけるだけで、結果として
 * ただのぼやけた帯にしかならず、雲として視認できなかった
 * （自己採点で指摘した「雲・雨が全く見えない」の直接原因）。
 *
 * 複数の円を重ねた綿雲のシルエットで再設計したが、初回の実装は
 * 円同士の重なりが浅く・大きさが均一すぎたため「連なった水玉」に
 * 見える問題があった（実際にレンダリングして確認した結果の指摘）。
 * この修正では、中心に大きな塊を置き、左右に段々小さくなる円を
 * 深く重ねて配置し、さらにSVG全体にわずかなぼかしを掛けて
 * 継ぎ目を溶かすことで、実際の積雲のような一体感のある輪郭にする。
 */
function ensureClouds() {
  const container = document.getElementById('sky-clouds');
  if (container.childElementCount > 0) return;
  // [cx, cy, rx, ry] — 中心に最大の塊、左右へ向かって小さくかつ
  // 高さを上げながら重ねることで、積雲らしい「もこっとした」輪郭になる。
  const puffLayouts = [
    [50, 6, 26, 15],
    [32, 10, 22, 13], [68, 10, 22, 13],
    [18, 14, 16, 10], [82, 14, 16, 10],
    [40, -6, 20, 13], [60, -6, 20, 13],
    [8, 18, 11, 7], [92, 18, 11, 7],
  ];
  const clouds = [
    { w: 40, top: 10, duration: 150, delay: -10, driftX: [8, 40] },
    { w: 30, top: 26, duration: 190, delay: -90, driftX: [55, 78] },
    { w: 34, top: 4, duration: 165, delay: -140, driftX: [-15, 8] },
  ];
  clouds.forEach((cfg) => {
    const wrap = document.createElement('div');
    wrap.className = 'cloud';
    wrap.style.width = cfg.w + 'vw';
    wrap.style.top = cfg.top + '%';
    wrap.style.left = cfg.driftX[0] + 'vw';
    wrap.style.animationDuration = cfg.duration + 's';
    wrap.style.animationDelay = cfg.delay + 's';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 32');
    svg.setAttribute('preserveAspectRatio', 'none');
    const filterId = 'cloud-blur-' + Math.random().toString(36).slice(2, 8);
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('x', '-20%'); filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%'); filter.setAttribute('height', '140%');
    const blur = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '1.6');
    filter.appendChild(blur);
    defs.appendChild(filter);
    svg.appendChild(defs);

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('filter', `url(#${filterId})`);
    puffLayouts.forEach(([cx, cy, rx, ry]) => {
      const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      ellipse.setAttribute('cx', cx);
      ellipse.setAttribute('cy', 18 + cy * 0.32);
      ellipse.setAttribute('rx', rx * 0.42);
      ellipse.setAttribute('ry', ry * 0.42);
      ellipse.setAttribute('class', 'cloud-puff');
      group.appendChild(ellipse);
    });
    svg.appendChild(group);
    wrap.appendChild(svg);
    container.appendChild(wrap);
  });
}

/** 星を実際の密度で生成する（従来はbackground-imageの点10個だけで密度不足だった）。 */
function ensureStars() {
  const container = document.getElementById('sky-stars');
  if (container.childElementCount > 0) return;
  const STAR_COUNT = 90;
  for (let i = 0; i < STAR_COUNT; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const size = Math.random() < 0.15 ? 2.4 : Math.random() < 0.5 ? 1.6 : 1.1;
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 62 + '%'; // 地平線付近には星を置かない（実際の空の見え方に寄せる）
    s.style.opacity = String(0.4 + Math.random() * 0.6);
    s.style.animationDuration = (2.5 + Math.random() * 3.5) + 's';
    s.style.animationDelay = (Math.random() * 4) + 's';
    container.appendChild(s);
  }
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
  if (init._ran) return; // DOMContentLoadedと即時呼び出しの二重発火を防ぐ
  init._ran = true;
  try {
    recomputeTodayPlan();
    applySky(); // まず既定（晴れ・現在時刻）で即座に描画し、体感の遅延を作らない
    render();
    refreshWeather();
    setInterval(applySky, 5 * 60 * 1000); // 時間帯の緩やかな遷移（SPEC §8）

    document.querySelectorAll('.modal-overlay, .sheet-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    });
  } catch (err) {
    // render()より前の段階（データ読み込み・Planner計算等）で例外が起きると、
    // 従来は何も表示されないまま画面が真っ白になっていた。ここで捕まえて
    // 最低限のエラー表示だけは必ず出す。
    console.error('[Temper] init failed', err);
    const root = document.getElementById('page-root');
    if (root) root.innerHTML = `<div class="empty-state glass"><div class="glyph">⚠</div><div class="msg">起動時にエラーが発生しました：${String(err && err.message || err)}</div></div>`;
  }
}

window.Temper = {
  navigateTo, completeTask, onCardPressStart, onCardPressEnd,
  openDetailSheet, closeDetailSheet, setTaskFilter,
  openAddTask, openEditTask, deleteTask, saveTaskFromModal, closeTaskModal,
  onLoadSliderInput, onCapacityInput, toggleWeatherAuto, exportHistory,
};

document.addEventListener('DOMContentLoaded', init);
// type="module"スクリプトはDOM解析後に実行されるため、この行に到達した時点で
// 既にDOMContentLoadedが発火済み（readyState !== 'loading'）のケースがある。
// その場合上のイベントリスナーは一生呼ばれず、画面が真っ白のまま止まる
// （実機で発生した不具合）。読み込み済みなら即座にinit()を呼ぶ安全策を足す。
if (document.readyState !== 'loading') init();

// FAB（タスク一覧画面にのみ表示、動的に差し込む）
// ------------------------------------------------------------
// 従来はMutationObserverでpage-rootの変化を監視して間接的にFABの
// 表示/非表示を切り替えていたが、これは「render()が呼ばれた」という
// 直接の事実を、DOM変化の観測という一段回り道した経路で検知する
// 設計であり、非同期マイクロタスクのタイミングに依存する分だけ
// 不必要に複雑だった（実機では問題にならないが、挙動を追いにくい）。
// render()は必ずこのファイル内から呼ばれる（唯一の描画経路）ため、
// render()の最後で直接呼び出す形に単純化した（挙動は変えていない）。
function updateFab() {
  const appEl = document.getElementById('app');
  if (!appEl) return;
  const existing = document.getElementById('add-task-fab');
  if (currentPage === 'tasks' && !existing) {
    const fab = document.createElement('button');
    fab.id = 'add-task-fab';
    fab.className = 'fab glass glass-strong';
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    fab.addEventListener('click', openAddTask);
    appEl.appendChild(fab);
  } else if (currentPage !== 'tasks' && existing) {
    existing.remove();
  }
}
