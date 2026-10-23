/* ============================================================
   app.js — Temper アプリケーション制御層
   ------------------------------------------------------------
   責務（憲法6条: 分離の原則）:
     - store.js（データ・設定の解決）、planner.js（今日の選定）、
       forecast.js（タスク状況→見通し）、weather.js（空のモデル）、
       skyrender.js（空の描画）を「呼ぶだけ」で、判断ロジックは書かない。
     - 画面遷移・DOM描画・イベント配線のみを担当する。
   ============================================================ */
import * as Store from './store.js';
import * as Planner from './planner.js';
import * as Weather from './weather.js';
import * as Forecast from './forecast.js';
import * as Schedule from './schedule.js';
import { createSyncEngine, historyCutoff } from './sync-core.js';
import { createSky } from './skyrender.js';
import { initViewport } from './viewport.js';

/* ------------------------------------------------------------
   状態
   ------------------------------------------------------------ */
let state = Store.loadState();
let currentPage = 'today';
let currentTodayPlan = null;
let currentPlanDate = null; // currentTodayPlan がどの日付向けに作られたか
let editingTaskId = null;
let pendingImport = null;  // インポート確認中のデータ
let upcomingDay = 1;       // 予定タブで選んでいる日（1=明日 … 7=7日後）

/** 設定タブに小さく表示するだけの表示用バージョン。改修のたびに上げる。 */
const APP_VERSION = 'v1.12.1';

const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

/** 認知タイプの推定（保存されていないタスクはタイトルから。個人の履歴も参照する） */
function makePatternOf() {
  const ph = Store.derivePatternHistory(state);
  return (t) => t.pattern || Planner.estimatePattern(t.title, t.description, ph);
}

function persist() {
  Store.saveState(state);
  // 日次の世代バックアップ（IndexedDB）。30分に1回までしか実際には動かず、
  // 失敗しても主機能には影響しない（憲法11条）。
  Store.maybeSnapshot(state).catch(() => {});
  if (syncEngine) syncEngine.notifyLocalChange(); // 他の端末へ（変更があった分だけ、少し遅らせてまとめて送る）
}

/**
 * 今日という日付の時点で完了しているタスクのLoad合計。
 * ------------------------------------------------------------
 * recomputeTodayPlan()（Plannerへ渡す「既に使った予算」として）と
 * renderTodayPage()（画面表示用）の両方から参照する、単一の計算箇所。
 */
function computeDoneLoadToday(dateStr) {
  return state.tasks
    .filter((t) => Store.isTaskDoneToday(t, dateStr))
    .reduce((sum, t) => sum + (t.load || 0), 0);
}

/* ------------------------------------------------------------
   今日のプラン再計算
   ------------------------------------------------------------
   「今日は平日か休日か」「その日の容量はいくつか」の解決は store.js が
   持つ設定の話であり、Plannerは数値だけを受け取る（憲法6条）。

   alreadyDoneLoad（今日すでに完了した分のLoad合計）を渡すのは、
   完了後にキャパシティを変更したときに「完了済みの分」と「新しく
   選び直された分」を合わせた合計が容量を超えて見える不具合
   （例: 16/15）を避けるため。Planner側は「まだ使っていない予算」の
   中だけで残りのタスクを選ぶので、二重に容量を使うことがない。
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   今日の選定の固定（pin）と「追加で生成」
   ------------------------------------------------------------
   タスクを足す・容量を触るたびに今日のおすすめを全部選び直すと、
   見慣れた並びがコロコロ入れ替わって落ち着かない。そこで、その日に
   一度決めた選定と並び(ids)を端末内に持ち、再計算ではそれを保ったまま
   「新しく入るべきもの」（期限が近い・週次・追加分）だけを差し込む。
   bonus は「追加で生成」で足した、今日だけの上乗せ容量。
   日付が変われば作り直す。state・バックアップには含めない（その日限りの派生値）。
   ------------------------------------------------------------ */
const PLAN_PIN_KEY = 'temper-plan-pin';
let planPin = null; // { date, ids: string[], bonus: number, cap: number|null, full: number|null, base: number|null }

function loadPlanPin(today) {
  if (planPin && planPin.date === today) return planPin;
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_PIN_KEY) || 'null');
    if (v && v.date === today && Array.isArray(v.ids)) {
      planPin = {
        date: today,
        ids: v.ids.filter((x) => typeof x === 'string'),
        bonus: Number.isFinite(v.bonus) && v.bonus > 0 ? Math.round(v.bonus) : 0,
        cap: Number.isFinite(v.cap) ? v.cap : null, // 保存した時点の今日の容量(分母)。下の full + bonus
        // v1.11.1: 今日の実効容量(上乗せ前)と、そのときの設定容量。設定が変わらない限り日中は動かさない。
        full: Number.isFinite(v.full) ? v.full : null,
        base: Number.isFinite(v.base) ? v.base : null,
      };
      return planPin;
    }
  } catch (e) { /* 読めなければ作り直す */ }
  // 新しい日の最初の呼び出し: 前日の選定をここで学習に数えてから作り直す
  // （アプリを開き直した・日をまたいだ、どの入口からでも前日分を取りこぼさない）
  if (Store.recordDayFollowThrough && settlePreviousDayQuiet(today)) persist();
  planPin = { date: today, ids: [], bonus: 0, cap: null, full: null, base: null };
  return planPin;
}
function savePlanPin() {
  try { localStorage.setItem(PLAN_PIN_KEY, JSON.stringify(planPin)); } catch (e) { /* 保存できなくても動く */ }
}

/** 「追加で生成」で1回に足す容量。今日の目標容量の約4割（最低2） */
function extraBudgetFor(fullCapacity) {
  return Math.max(2, Math.round(fullCapacity * 0.4));
}

function recomputeTodayPlan({ forceExtra = false } = {}) {
  const today = todayStr();
  const pin = loadPlanPin(today);
  const doneLoad = computeDoneLoadToday(today);
  // 今日の容量(分母)は日中は固定する。ユーザーが容量・平日/休日を変えたとき（設定容量が
  // 変わったとき）だけ計算し直す。完了のたびに実績補正で 14→15 のように動くのを防ぐ。
  const baseCap = Store.getCapacityFor(state, today);
  const fixedFull = Number.isFinite(pin.full) && pin.base === baseCap ? pin.full : null;
  currentTodayPlan = Planner.buildTodayPlan({
    tasks: state.tasks,
    todayStr: today,
    baseCapacity: baseCap,
    fixedFullCapacity: fixedFull,
    recentDone: Store.recentCompletions(state, today, 2),
    weekdayStats: Store.deriveWeekdayStats(state, today),
    weekdayPatternStats: Store.deriveWeekdayPatternStats(state, today),
    timeOfDay: Weather.getTimeOfDay(),
    timeOfDayPatternStats: Store.deriveTimeOfDayPatternStats(state, {
      bucketOf: Weather.getTimeOfDay,
      estimatePattern: (t) => Planner.estimatePatternGeneral(t.title, t.description),
    }),
    capacityForDate: (dateStr) => Store.getCapacityFor(state, dateStr),
    patternHistory: Store.derivePatternHistory(state),
    alreadyDoneLoad: doneLoad,
    learned: Store.deriveLearning(state),
    capacityBonus: pin.bonus,
    pinIds: pin.ids,
    pinCapacity: pin.cap,
    forceExtra,
  });
  currentPlanDate = today;

  // 並びを保存する。今日すでに済んだタスクのidも残しておく（完了を取り消したとき、
  // 元の位置に戻れるように。済んだものは候補から外れるのでplanには出てこない）。
  const keptDone = pin.ids.filter((id) => !currentTodayPlan.pinIds.includes(id) && isTaskDoneToday(id, today));
  pin.ids = [...currentTodayPlan.pinIds, ...keptDone];
  // 追加分が現在の容量を超えて入ったときは、上乗せ容量を実際の量まで引き上げる
  // （そうしないと次の再計算で、その追加分が容量超過として外れてしまう）。
  // 引き上げたら、表示の分母がずれないよう、そのまま計算し直す。
  let bonusRaised = false;
  if (forceExtra) {
    const pendingLoad = currentTodayPlan.entries.reduce((sum, e) => sum + e.load, 0);
    const needed = doneLoad + pendingLoad - currentTodayPlan.fullCapacity;
    if (needed > pin.bonus) { pin.bonus = needed; bonusRaised = true; }
  }
  pin.full = currentTodayPlan.fullCapacity;
  pin.base = baseCap;
  pin.cap = currentTodayPlan.fullCapacity + pin.bonus;
  savePlanPin();
  if (bonusRaised) recomputeTodayPlan();
}

/**
 * 「追加で生成」: 今日の負荷を達成したあと、続けてやりたい人のために
 * 上乗せ容量を足して、残っている候補から追加で選ぶ。
 */
function generateExtra() {
  const today = todayStr();
  if (!currentTodayPlan || currentPlanDate !== today) recomputeTodayPlan();
  const pin = loadPlanPin(today);
  pin.bonus += extraBudgetFor(currentTodayPlan.fullCapacity);
  const before = new Set(currentTodayPlan.entries.map((e) => e.id));
  recomputeTodayPlan({ forceExtra: true });
  render();
  const added = currentTodayPlan.entries.filter((e) => !before.has(e.id)).length;
  showToast(added ? `${added}件を追加しました` : '追加できるタスクはありません');
}

/**
 * 前日までのおすすめのうち、その日のうちに終えたものを学習用に数える（Store.recordDayFollowThrough）。
 * 前日の選定は端末内のpin（localStorage）に残っている。無ければ何もしない。
 */
function settlePreviousDay(today, patternOf) {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_PIN_KEY) || 'null');
    if (v && typeof v.date === 'string' && v.date < today && Array.isArray(v.ids)) {
      return Store.recordDayFollowThrough(state, v.date, v.ids, patternOf);
    }
  } catch (e) { /* 読めなければ数えないだけ */ }
  return false;
}
function settlePreviousDayQuiet(today) { return settlePreviousDay(today, makePatternOf()); }

/**
 * 完了から24時間以上たった単発タスクを削除する（v1.11.1）。
 * 前日分の「やったか」の集計(settlePreviousDay)は日付が変わった最初の計算で済ませてから
 * 消す必要があるので、必ず recomputeTodayPlan()/ensureTodayPlanFresh() の後に呼ぶ。
 * 同期中は persist() が削除（墓標）を他の端末へ送る。
 * @returns {boolean} 1件でも削除したか
 */
function purgeExpiredCompleted() {
  const removed = Store.purgeExpiredCompleted(state, Date.now());
  if (!removed.length) return false;
  persist();
  return true;
}

/**
 * 日付が変わっていたら（アプリを閉じずに日をまたいだ場合など）
 * 今日のプランを作り直す。
 * ------------------------------------------------------------
 * 「今日」タブが日付をまたいでも自動的に反映されない不具合の対策。
 * currentTodayPlan は明示的にrecomputeTodayPlan()を呼んだ時にしか
 * 更新されない作りだったため、タスクの完了・編集・設定変更などの
 * 操作を何もしないまま日付が変わると、前日の期限計算・曜日・
 * 容量に基づいたプランが画面に残り続けてしまっていた
 * （前日は候補にならなかった「今日解禁」「今日が対象曜日」のタスクが
 * 出てこない、期限の残り日数がずれる、平日/休日や容量が前日のまま、
 * といった食い違いが起きる）。render()の入口で必ずこれを通すことで、
 * どの画面遷移・操作をきっかけにしても日付のズレを解消する。
 */
function ensureTodayPlanFresh() {
  const today = todayStr();
  if (currentPlanDate !== today) {
    // 日付が変わった時点で、前回チェック以降に「対象曜日だったのに
    // 完了しなかった」週次タスクをmissedとして記録する（ALGORITHM_
    // IMPROVEMENT_PLAN §0）。recomputeTodayPlan()より前に行うことで、
    // 今回の再計算がこのmissedを反映した曜日×Pattern統計を使える。
    const patternOf = makePatternOf();
    Store.recordMissedOccurrencesUntilToday(state, today, patternOf);
    settlePreviousDay(today, patternOf);
    persist();
    recomputeTodayPlan();
  }
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
    ensureTodayPlanFresh();
    if (currentPage === 'today') root.innerHTML = renderTodayPage();
    else if (currentPage === 'upcoming') root.innerHTML = renderUpcomingPage();
    else if (currentPage === 'tasks') root.innerHTML = renderTasksPage();
    else if (currentPage === 'settings') root.innerHTML = renderSettingsPage();
    syncRangeFills(root);
  } catch (err) {
    // 無音の失敗（真っ白な画面）を許さない。
    console.error('[Temper] render failed', err);
    root.innerHTML = `<div class="empty-state glass card"><div class="glyph">⚠</div><div class="msg">表示中にエラーが発生しました：${esc(String(err && err.message || err))}</div></div>`;
  }
  updateFab();
  refreshSky();
}

/* ------------------------------------------------------------
   小さなユーティリティ
   ------------------------------------------------------------ */
function esc(s) {
  // v1.12.1: 属性値（"..."）の中でも安全に使えるよう、引用符も変換する
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// onclick / data 属性に埋め込むID用。許可文字以外は取り除く（store.js の isValidTaskId と同じ文字種）
function attrId(id) { return String(id == null ? '' : id).replace(/[^A-Za-z0-9_.:@-]/g, ''); }

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
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

/** レンジ入力の塗り（--fill）を値に合わせる。見た目の一貫性のため全画面共通。 */
function syncRangeFills(scope) {
  (scope || document).querySelectorAll('input[type="range"]').forEach(setRangeFill);
}
function setRangeFill(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(el.value || 0);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', pct.toFixed(2) + '%');
}

/* ------------------------------------------------------------
   今日画面（SPEC §6: 日付 → 今日の進捗 → 今日のタスク）
   v1.8.0: 天候の行（時間帯・天気名・気温）は廃止した。空そのものが
   タスクの見通しを映すので、文字では説明しない。
   ------------------------------------------------------------ */
function renderTodayPage() {
  const today = todayStr();
  if (!currentTodayPlan) recomputeTodayPlan();
  const plan = currentTodayPlan;

  // plan.entries は buildCandidates の時点で「今日まだ済んでいないもの」
  // しか含まない（済んだタスクは候補から外れる）。そのため今日の
  // 消化分(doneLoad)は plan からではなく、state.tasks を直接見て
  // 「今日という日付に完了したか」で数える。こうしておけば、容量変更
  // などで plan が再計算されても、既に完了したタスクの負荷値が
  // 消えてしまうことがない（plan.entries に残っているかどうかに
  // 依存しないため）。
  const pendingEntries = plan.entries.filter((e) => isPendingEntry(e, today));
  const doneLoad = computeDoneLoadToday(today);
  // plan.totalLoad は「完了前に選ばれた時点」の合計なので、完了後も
  // そのまま使うと doneLoad と二重に数えてしまう（完了させても
  // recomputeTodayPlan() を呼ばないため、plan.entries に完了済みの
  // タスクがまだ残っている）。pendingEntries（未完了のみ）から
  // 合計し直すことで二重計上を避ける。
  const pendingLoad = pendingEntries.reduce((sum, e) => sum + e.load, 0);
  const totalLoad = doneLoad + pendingLoad; // リングの外側の弧（選定の合計）。文字の分子には使わない
  // 表示の「今日の負荷」の分子は、完了したタスクの負荷だけ（v1.11.2）。
  // v1.11.1 は 消化 + 残り(=選定の合計) にしたため、完了させても値が動かなかった。
  // 完了のたびに増え、分母（今日の容量）に近づくほど達成に近い、が一目で分かる値にする。
  // 分母は「今日1日の目標容量」(fullCapacity)。plan.effectiveCapacity は
  // Plannerが残りタスクを選ぶ際に使った「まだ使っていない予算」
  // （fullCapacityからdoneLoadを引いたもの）なので、表示の分母には使わない
  // — これを分母にすると、完了が進むほど分母が縮んでいく不自然な表示になる。
  const capacity = plan.totalCapacity; // 今日の目標容量 + 「追加で生成」で足した上乗せ分

  const C = 2 * Math.PI * 23;
  const frac = (v) => (capacity > 0 ? Math.min(1, v / capacity) : 0);
  const plannedOffset = C * (1 - frac(totalLoad));
  const doneOffset = C * (1 - frac(doneLoad));
  // 容量を超えた分は、内側の細いリングで見せる（外側は100%で頭打ちになり、超過が見えなかった）
  const overLoad = Planner.summarizeTodayLoad(doneLoad, pendingLoad, capacity).over;
  const C2 = 2 * Math.PI * 17;
  const overOffset = C2 * (1 - Math.min(1, overLoad / capacity));

  const finishLabel = estimateAllTasksFinishLabel(today, doneLoad);

  let taskListHtml;
  if (!plan.entries.length && doneLoad === 0) {
    taskListHtml = `<div class="empty-state glass card"><div class="glyph">✧</div><div class="msg">今日扱うタスクはありません</div></div>`;
  } else if (!pendingEntries.length) {
    taskListHtml = `<div class="empty-state glass card"><div class="glyph">✧</div><div class="msg">今日の分はすべて終えました</div></div>`;
  } else {
    taskListHtml = pendingEntries.map((entry) => renderTaskCard(entry)).join('');
  }

  // 今日の負荷を達成したら（または今日の分を全部終えたら）、残りの候補から追加で生成できる。
  // 候補がもう無ければ出さない。
  const goalReached = capacity > 0 && doneLoad >= capacity;
  const extraButtonHtml = (goalReached || (!pendingEntries.length && doneLoad > 0)) && plan.extraCount > 0
    ? `<button class="btn btn-secondary btn-full extra-btn" onclick="Temper.generateExtra()">追加で生成する</button>`
    : '';

  return `
    <div class="page-head">
      <div class="today-date">${formatDateLabel(today)}</div>
    </div>

    <div class="card glass progress-card">
      <div class="progress-main">
        <svg class="load-ring-svg" viewBox="0 0 54 54" aria-hidden="true">
          <circle class="load-ring-track" cx="27" cy="27" r="23"/>
          ${totalLoad > 0 ? `<circle class="load-ring-planned" cx="27" cy="27" r="23" stroke-dasharray="${C}" stroke-dashoffset="${plannedOffset}" transform="rotate(-90 27 27)"/>` : ''}
          ${doneLoad > 0 ? `<circle class="load-ring-done" cx="27" cy="27" r="23" stroke-dasharray="${C}" stroke-dashoffset="${doneOffset}" transform="rotate(-90 27 27)"/>` : ''}
          ${overLoad > 0 ? `<circle class="load-ring-over" cx="27" cy="27" r="17" stroke-dasharray="${C2}" stroke-dashoffset="${overOffset}" transform="rotate(-90 27 27)"/>` : ''}
        </svg>
        <div class="progress-text">
          <div class="progress-value">今日の負荷　<b>${Planner.summarizeTodayLoad(doneLoad, pendingLoad, capacity).numerator}</b> / ${capacity}</div>
          <div class="progress-sub">${pendingEntries.length}件が残っています${pendingLoad > 0 ? `（残り負荷 ${pendingLoad}）` : ''}${overLoad > 0 ? `　超過 +${overLoad}` : ''}</div>
          ${finishLabel ? `<div class="progress-finish">全タスク完了目安 ${finishLabel}</div>` : ''}
        </div>
      </div>
    </div>

    <div class="section-label">今日のタスク</div>
    <div id="today-task-list">${taskListHtml}</div>
    ${extraButtonHtml}
  `;
}

/* ------------------------------------------------------------
   予定タブ（v1.10.0）— 明日〜7日後
   ------------------------------------------------------------
   投影そのものは schedule.js（純粋関数）が持つ。ここは「最新の状態」を渡して
   結果を描くだけ。今日のおすすめと違い固定(pin)しないので、タスクの追加・完了・
   容量の変更・学習の更新があれば、描くたびに並びごと最新の状況で計算し直す。
   ------------------------------------------------------------ */
function computeProjection() {
  const today = todayStr();
  if (!currentTodayPlan || currentPlanDate !== today) recomputeTodayPlan();
  const pendingIds = currentTodayPlan.entries.filter((e) => isPendingEntry(e, today)).map((e) => e.id);
  return Schedule.projectDays({
    tasks: state.tasks,
    todayStr: today,
    days: 7,
    todayPendingIds: pendingIds,
    capacityForDate: (dateStr) => Store.getCapacityFor(state, dateStr),
    weekdayStats: Store.deriveWeekdayStats(state, today),
    weekdayPatternStats: Store.deriveWeekdayPatternStats(state),
    patternHistory: Store.derivePatternHistory(state),
    learned: Store.deriveLearning(state),
  });
}

function renderUpcomingPage() {
  const proj = computeProjection();
  const sel = proj.find((d) => d.offset === upcomingDay) || proj[0];
  const wd = ['日', '月', '火', '水', '木', '金', '土'];
  const chips = proj.map((d) => {
    const dt = new Date(d.date + 'T00:00:00');
    return `<button class="day-chip${d.offset === sel.offset ? ' active' : ''}" onclick="Temper.setUpcomingDay(${d.offset})" aria-label="${d.offset}日後 ${dt.getMonth() + 1}月${dt.getDate()}日">
      <span class="dc-off">${d.offset === 1 ? '明日' : d.offset + '日後'}</span>
      <span class="dc-d">${dt.getDate()}<small>${wd[dt.getDay()]}</small></span>
      <span class="dc-load">${d.load}</span>
    </button>`;
  }).join('');

  const entries = sel.plan.entries;
  const listHtml = entries.length
    ? entries.map((e) => renderTaskCard(e, { preview: true })).join('')
    : `<div class="empty-state glass card"><div class="glyph">✧</div><div class="msg">この日に扱うタスクはありません</div></div>`;

  return `
    <div class="page-head">
      <div class="today-date">${formatDateLabel(sel.date)}</div>
    </div>
    <div class="day-chips" role="tablist">${chips}</div>
    <div class="card glass progress-card">
      <div class="progress-main">
        <div class="progress-text">
          <div class="progress-value">この日の負荷　<b>${sel.load}</b> / ${sel.capacity}</div>
          <div class="progress-sub">${entries.length}件の見込み</div>
        </div>
      </div>
    </div>
    <div class="section-label">この日のタスク</div>
    <div id="upcoming-task-list">${listHtml}</div>
  `;
}

function setUpcomingDay(n) {
  upcomingDay = Math.max(1, Math.min(7, Number(n) || 1));
  render();
  refreshSky();
}

/**
 * 「終了目安」を、今日中の時刻ではなく、現在登録されている全タスクが
 * この先の容量ペースで消化されていくと計算上何日に終わるか、という
 * 日付の目安に置き換えたもの（以前の「負荷×15分」による今日の終了
 * 時刻の概算は廃止した）。
 * ------------------------------------------------------------
 * 計算そのものは Planner.estimateAllTasksFinishDate（純粋関数）が
 * 持つ。ここでは「今日の容量をどう解決するか」（Store.getCapacityFor）
 * を注入し、表示用の文字列に整形するだけ（憲法6条）。
 */
function estimateAllTasksFinishLabel(today, doneLoad) {
  const finishDate = Planner.estimateAllTasksFinishDate({
    tasks: state.tasks,
    todayStr: today,
    capacityForDate: (dateStr) => Store.getCapacityFor(state, dateStr),
    alreadyDoneLoad: doneLoad,
  });
  if (!finishDate) return null;
  if (finishDate === today) return '今日中';
  const d = new Date(finishDate + 'T00:00:00');
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
}

/** 今日の選定のうち、まだ終えていないもの。削除されたタスク（24時間経過で自動削除）は含めない */
function isPendingEntry(entry, today) {
  const t = state.tasks.find((x) => x.id === entry.id);
  return !!t && !Store.isTaskDoneToday(t, today);
}

/** 「今日」という日付の時点で済んでいるか（plan.entriesに依存しない） */
function isTaskDoneToday(taskId, dateStr) {
  const t = state.tasks.find((x) => x.id === taskId);
  return !!t && Store.isTaskDoneToday(t, dateStr || todayStr());
}

/**
 * 平日 / 休日の手動切り替え。
 * ------------------------------------------------------------
 * 要件: 通常はシステムが曜日から自動判定し、手動切替は設定タブにだけ
 * 置く（今日タブには置かない）。世間は平日でも個人的には休日、と
 * いった食い違いがありうるため、切替そのものは残しつつ置き場所を
 * 設定タブに限定する。
 */
function setTodayType(dayType) {
  const today = todayStr();
  if (Store.getDayType(state, today) === dayType) return;
  Store.setDayType(state, today, dayType);
  persist();
  recomputeTodayPlan();
  render();
  showToast(dayType === 'holiday' ? '休日として扱います' : '平日として扱います');
}

/* ------------------------------------------------------------
   タスクカード（今日画面・タスク画面で同じ部品を使う）
   ------------------------------------------------------------ */
function renderTaskCard(entryOrTask, opts = {}) {
  const t = state.tasks.find((x) => x.id === entryOrTask.id);
  if (!t) return '';
  const today = todayStr();
  // チェックボックスの表示は「完了しているか」（isTaskComplete）で判定する。
  // 「今日完了したか」（isTaskDoneToday）ではない — 単発タスクは完了日に
  // 関わらずずっと完了のままなので、過去の日に完了したタスクが完了済み
  // タブで未チェックに見えてしまわないようにするため（toggleTaskの
  // 判定と揃える必要がある。ズレると取り消しのつもりの操作が「今日
  // 改めて完了」扱いになり、履歴が余分に積まれる）。
  const doneToday = Store.isTaskComplete(t, today);

  const chips = [];
  if (t.type === 'weekly') {
    const label = Store.weekDaysLabel(t.weekDays);
    if (label) chips.push(`<span class="task-meta-chip">毎週${label}</span>`);
  } else if (t.deadline) {
    const days = daysUntilFromToday(t.deadline);
    chips.push(`<span class="task-meta-chip${days <= 1 ? ' urgent' : ''}">${deadlineLabel(days)}</span>`);
  }
  if (opts.withActions && t.type !== 'weekly' && t.done) {
    const at = Store.completedAtOf(state, t);
    if (at) {
      const d = new Date(at);
      const remain = at + Store.COMPLETED_TTL_MS - Date.now();
      const left = remain <= 3600000 ? 'まもなく削除' : `あと${Math.ceil(remain / 3600000)}時間で削除`;
      chips.unshift(`<span class="task-meta-chip">完了 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}・${left}</span>`);
    }
  }
  if (t.unlockDate && t.unlockDate > today) {
    chips.push(`<span class="task-meta-chip">${formatDateLabel(t.unlockDate)}から</span>`);
  }
  // 負荷は数字と点の並びの両方で読めるようにする（SPEC §5 / 憲法12条）。
  // 数字と点を別々のチップにすると同じ情報が二度出て煩いため、ひと塊にする。
  chips.push(`<span class="load-chip" aria-label="負荷 ${t.load}">負荷 ${t.load}<span class="load-dot-row">${loadDots(t.load)}</span></span>`);

  const actions = opts.withActions ? `
      <div class="task-list-actions">
        <button class="icon-btn" onclick="event.stopPropagation();Temper.openEditTask('${attrId(t.id)}')" aria-label="編集">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn" onclick="event.stopPropagation();Temper.deleteTask('${attrId(t.id)}')" aria-label="削除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>` : '';

  // 予定タブ（opts.preview）は見るだけ。完了のチェックも長押しの詳細も持たない
  const pressAttrs = opts.preview ? '' : `
         ontouchstart="Temper.onCardPressStart('${t.id}')" ontouchend="Temper.onCardPressEnd()" ontouchmove="Temper.onCardPressEnd()"
         onmousedown="Temper.onCardPressStart('${t.id}')" onmouseup="Temper.onCardPressEnd()" onmouseleave="Temper.onCardPressEnd()"`;
  const checkHtml = opts.preview
    ? '<span class="task-check preview" aria-hidden="true"></span>'
    : `<button class="task-check${doneToday ? ' checked' : ''}" onclick="event.stopPropagation();Temper.toggleTask('${attrId(t.id)}')" aria-label="${doneToday ? '未完了に戻す' : '完了にする'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>
      </button>`;
  return `
    <div class="task-card glass${doneToday ? ' done' : ''}" data-task-id="${attrId(t.id)}"${pressAttrs}>
      ${checkHtml}
      <div class="task-main">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta-row">${chips.join('')}</div>
      </div>${actions}
    </div>
  `;
}

/** 負荷を色以外でも読めるようにする（憲法12条・SPEC §20） */
function loadDots(load) {
  let html = '';
  const filled = Math.max(1, Math.round(load / 2));
  for (let i = 0; i < 5; i++) html += `<span class="load-dot${i < filled ? ' filled' : ''}"></span>`;
  return html;
}

/* ------------------------------------------------------------
   長押し → 詳細シート（SPEC §11、常時表示はしない）
   ------------------------------------------------------------ */
let pressTimer = null;
function onCardPressStart(taskId) {
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => openDetailSheet(taskId), 480);
}
function onCardPressEnd() { clearTimeout(pressTimer); }

/**
 * 長押しで開く詳細シート。
 * ------------------------------------------------------------
 * 要件: 長押しで伝える情報は「今日選ばれた理由」のみに絞る
 * （期限・解禁日・負荷・状態といった他の項目は、タスク一覧の編集画面
 * などで既に確認できるため、ここで重複して並べない）。
 * 編集への導線もここには置かず、一覧画面の編集アイコンに一本化する。
 */
function openDetailSheet(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  const entry = currentTodayPlan && currentTodayPlan.entries.find((e) => e.id === taskId);
  const doneToday = Store.isTaskComplete(t, todayStr());

  let reason;
  if (entry) {
    reason = Planner.explainSelection(entry);
  } else if (doneToday) {
    reason = '今日すでに完了しています';
  } else {
    reason = '今日の選定には含まれていません';
  }

  document.getElementById('detail-sheet-body').innerHTML = `
    <div class="sheet-grabber"></div>
    <div class="sheet-title">${esc(t.title)}</div>
    <div class="sheet-note">${esc(reason)}</div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" onclick="Temper.closeDetailSheet()">閉じる</button>
    </div>
  `;
  document.getElementById('detail-sheet').classList.add('open');
}
function closeDetailSheet() { document.getElementById('detail-sheet').classList.remove('open'); }

/* ------------------------------------------------------------
   完了 / 取り消し（SPEC §10: 演出をせず静かに状態が変わる）
   ------------------------------------------------------------
   単発(once): done/doneDate で一度きりの完了を表す。
   週次(weekly): doneDates に「完了した日付」を足し引きする。
   同じタスクが翌週にはまた候補へ戻るのは、その日付が
   doneDates に無いから、というだけの単純な仕組みにしてある。

   取り消し時はStore.undoCompletion()でhistory/統計の加算も
   打ち消す。これを怠ると、完了→取り消し→再完了を繰り返すたびに
   historyへエントリが積み重なってしまう。
   ------------------------------------------------------------ */
const completingIds = new Set(); // 完了演出中(320ms)のタスク。二重タップでの二重完了を防ぐ

function toggleTask(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  if (completingIds.has(taskId)) return;
  const today = todayStr();
  // 「今完了しているか」は isTaskComplete（完了日に関わらない永続状態）
  // で判定する。isTaskDoneToday（今日完了したかどうか）で判定すると、
  // 過去の日に完了した単発タスクをここで取り消そうとした際に「今日は
  // まだ完了していない」と誤判定され、取り消しではなく「今日改めて
  // 完了」扱いになって doneDate が上書きされ、履歴も余分に積まれる。
  const doneNow = Store.isTaskComplete(t, today);

  if (doneNow) {
    // 取り消し: 単発タスクは元の完了日（doneDate）を使って対応する
    // history/統計を打ち消す。既にリセットした後では日付が失われるため、
    // 先に読み取っておく。
    const completionDate = t.type === 'weekly' ? today : (t.doneDate || today);
    if (t.type === 'weekly') {
      t.doneDates = (t.doneDates || []).filter((d) => d !== today);
    } else {
      t.done = false;
      t.doneDate = null;
      t.doneAt = null;
    }
    Store.undoCompletion(state, t, completionDate);
    persist();
    recomputeTodayPlan();
    render();
    return;
  }

  const cardEl = document.querySelector(`.task-card[data-task-id="${attrId(taskId)}"]`);
  if (cardEl && currentPage === 'today') cardEl.classList.add('completing');
  completingIds.add(taskId);
  const finish = () => {
    completingIds.delete(taskId);
    // 今日の選定に入っていなかったタスクを終えた場合、消化分が増えた分だけ残りを絞り直す必要がある
    const wasInPlan = !!(currentTodayPlan && currentTodayPlan.entries.some((e) => e.id === taskId));
    if (t.type === 'weekly') {
      t.doneDates = t.doneDates || [];
      if (!t.doneDates.includes(today)) t.doneDates.push(today);
    } else {
      t.done = true;
      t.doneDate = today;
      t.doneAt = Date.now();
    }
    Store.recordCompletion(state, t, today, makePatternOf());
    persist();
    if (!wasInPlan) recomputeTodayPlan();
    render();
  };
  if (cardEl && currentPage === 'today') setTimeout(finish, 320);
  else finish();
}

/* ------------------------------------------------------------
   タスク一覧画面
   ------------------------------------------------------------
   週次タスクは終わりのないシリーズなので「完了済み」に移ることが
   ない（SPEC §12: タスクが存在することと今日選択されることは別概念、
   の延長として、タスク自体の存在と個々の日の完了も別概念として扱う）。
   常に「未完了」側に数える。
   ------------------------------------------------------------ */
let taskFilter = 'active';
let taskSort = 'deadline'; // 'deadline' | 'load'

function sortTasksForList(list) {
  const arr = list.slice();
  if (taskSort === 'load') {
    arr.sort((a, b) => (b.load || 0) - (a.load || 0));
  } else {
    const key = (t) => (t.type !== 'weekly' && t.deadline) ? daysUntilFromToday(t.deadline) : Infinity;
    arr.sort((a, b) => key(a) - key(b));
  }
  return arr;
}

function renderTasksPage() {
  const active = state.tasks.filter((t) => t.type === 'weekly' || !t.done);
  const done = state.tasks.filter((t) => t.type !== 'weekly' && t.done);
  // 完了済みは「達成した時刻の新しい順」。24時間たつと自動で消えるので、並び替えの切替は出さない。
  const list = taskFilter === 'active'
    ? sortTasksForList(active)
    : done.slice().sort((a, b) => (Store.completedAtOf(state, b) || 0) - (Store.completedAtOf(state, a) || 0));

  const listHtml = list.length
    ? list.map((t) => renderTaskCard(t, { withActions: true })).join('')
    : `<div class="empty-state glass card"><div class="glyph">✧</div><div class="msg">${taskFilter === 'active' ? 'タスクがありません' : '完了したタスクはまだありません'}</div></div>`;

  return `
    <div class="page-head">
      <div class="page-title">タスク</div>
    </div>
    <div class="segmented" style="margin:0 0 8px">
      <button class="${taskFilter === 'active' ? 'active' : ''}" onclick="Temper.setTaskFilter('active')">未完了 ${active.length}</button>
      <button class="${taskFilter === 'done' ? 'active' : ''}" onclick="Temper.setTaskFilter('done')">完了済み ${done.length}</button>
    </div>
    ${taskFilter === 'active' ? `<div class="segmented" style="margin:0 0 var(--sp-3)">
      <button class="${taskSort === 'deadline' ? 'active' : ''}" onclick="Temper.setTaskSort('deadline')">期限順</button>
      <button class="${taskSort === 'load' ? 'active' : ''}" onclick="Temper.setTaskSort('load')">負荷順</button>
    </div>` : `<div class="settings-desc" style="margin:0 var(--sp-1) var(--sp-3)">達成から24時間たつと自動で削除されます（新しい順）</div>`}
    <div>${listHtml}</div>
  `;
}

function setTaskFilter(f) { taskFilter = f; render(); }
function setTaskSort(s) { taskSort = s; render(); }

/** 削除は取り消せないため必ず確認を挟む（憲法16条: データの安全性が最優先） */
function deleteTask(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  askConfirm({
    title: 'タスクを削除',
    body: `「${esc(t.title)}」を削除します。この操作は取り消せません。`,
    okLabel: '削除する',
    danger: true,
    onOk: () => {
      state.tasks = state.tasks.filter((x) => x.id !== taskId);
      persist();
      recomputeTodayPlan();
      render();
      showToast('削除しました');
    },
  });
}

/* ------------------------------------------------------------
   タスク追加 / 編集（SPEC §13: タイトル・期限・解禁日・負荷の4項目
   + §4「繰り返し」に対応する種別・曜日）
   ------------------------------------------------------------ */
let modalTaskType = 'once';
let modalWeekDays = new Set();

function openAddTask() {
  editingTaskId = null;
  document.getElementById('modal-task-title').textContent = 'タスクを追加';
  document.getElementById('input-title').value = '';
  document.getElementById('input-deadline').value = '';
  document.getElementById('input-unlock').value = '';
  setLoadSlider(4);
  modalWeekDays = new Set();
  setTaskType('once');
  openOverlay('modal-task');
}

function openEditTask(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  editingTaskId = taskId;
  document.getElementById('modal-task-title').textContent = 'タスクを編集';
  document.getElementById('input-title').value = t.title || '';
  document.getElementById('input-deadline').value = t.deadline || '';
  document.getElementById('input-unlock').value = t.unlockDate || '';
  setLoadSlider(t.load || 4);
  modalWeekDays = new Set(Array.isArray(t.weekDays) ? t.weekDays : []);
  setTaskType(t.type === 'weekly' ? 'weekly' : 'once');
  openOverlay('modal-task');
}

/** 種別（単発/毎週）の切り替え。曜日ピッカーの表示と期限ラベルを合わせる。 */
function setTaskType(type) {
  modalTaskType = type;
  document.querySelectorAll('#task-type-segmented button').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  document.getElementById('field-weekdays').style.display = type === 'weekly' ? '' : 'none';
  // 週次タスクの「期限」は毎回の締切ではなく、シリーズを終える日という
  // 意味になるため、ラベルだけ変えて誤解を防ぐ（項目自体は増やさない）。
  document.getElementById('input-deadline-label').textContent = type === 'weekly' ? '終了日（任意）' : '期限';
  syncWeekdayPickerUI();
}

function toggleModalWeekDay(day) {
  if (modalWeekDays.has(day)) modalWeekDays.delete(day);
  else modalWeekDays.add(day);
  syncWeekdayPickerUI();
}
function syncWeekdayPickerUI() {
  document.querySelectorAll('#weekday-picker button').forEach((b) => {
    b.classList.toggle('active', modalWeekDays.has(Number(b.dataset.day)));
  });
}

function setLoadSlider(v) {
  const el = document.getElementById('input-load');
  el.value = v;
  document.getElementById('load-slider-val').textContent = v;
  setRangeFill(el);
}
function onLoadSliderInput(v) {
  document.getElementById('load-slider-val').textContent = v;
  setRangeFill(document.getElementById('input-load'));
}
function stepLoad(delta) {
  const el = document.getElementById('input-load');
  setLoadSlider(Math.max(1, Math.min(10, (parseInt(el.value, 10) || 4) + delta)));
}
function clearDateField(id) { document.getElementById(id).value = ''; }

function saveTaskFromModal() {
  const title = document.getElementById('input-title').value.trim();
  if (!title) { showToast('タイトルを入力してください'); return; }
  if (modalTaskType === 'weekly' && modalWeekDays.size === 0) {
    showToast('曜日を選んでください');
    return;
  }
  const deadline = document.getElementById('input-deadline').value || null;
  const unlockDate = document.getElementById('input-unlock').value || null;
  const load = parseInt(document.getElementById('input-load').value, 10) || 4;
  const weekDays = [...modalWeekDays].sort();

  if (editingTaskId) {
    const t = state.tasks.find((x) => x.id === editingTaskId);
    if (t) {
      const typeChanged = (t.type || 'once') !== modalTaskType;
      t.title = title; t.deadline = deadline; t.unlockDate = unlockDate; t.load = load;
      t.type = modalTaskType;
      t.weekDays = modalTaskType === 'weekly' ? weekDays : [];
      if (typeChanged) {
        // 単発↔毎週を切り替えた場合のみ、古い完了記録を持ち越さない
        // （単発のdone/doneDateと週次のdoneDatesは意味が違うため）。
        // ただの編集（種別は変えていない）で完了状態を消してしまわないよう、
        // 変わっていないときはtouchしない。
        t.doneDates = [];
        t.done = false; t.doneDate = null; t.doneAt = null;
      }
      t.pattern = Planner.estimatePattern(title, t.description, Store.derivePatternHistory(state));
    }
  } else {
    state.tasks.push({
      id: Store.newId(),
      title, description: '', deadline, unlockDate, load,
      type: modalTaskType,
      weekDays: modalTaskType === 'weekly' ? weekDays : [],
      doneDates: [],
      done: false, doneDate: null,
      pattern: Planner.estimatePattern(title, '', Store.derivePatternHistory(state)),
      createdAt: Date.now(),
    });
  }
  persist();
  closeTaskModal();
  recomputeTodayPlan();
  render();
  showToast(editingTaskId ? '更新しました' : 'タスクを追加しました');
}

function closeTaskModal() { closeOverlay('modal-task'); editingTaskId = null; }
function openOverlay(id) { document.getElementById(id).classList.add('open'); }
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }

/* ------------------------------------------------------------
   確認シート（取り消せない操作の共通入口）
   ------------------------------------------------------------ */
function askConfirm({ title, body, okLabel = '実行', danger = false, onOk }) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').innerHTML = body;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  ok.textContent = okLabel;
  ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  ok.onclick = () => { closeOverlay('modal-confirm'); onOk(); };
  cancel.onclick = () => { closeOverlay('modal-confirm'); };
  openOverlay('modal-confirm');
}

/* ------------------------------------------------------------
   設定画面
   ------------------------------------------------------------ */
function renderSettingsPage() {
  const s = state.settings;
  const today = todayStr();
  const dayType = Store.getDayType(state, today);
  const max = Store.CAPACITY_MAX;

  return `
    <div class="page-head">
      <div class="page-title">設定</div>
    </div>

    <div class="card glass">
      <div class="section-label" style="padding-left:0">負荷キャパシティ</div>
      <div class="settings-stack">
        <div>
          <div class="field-head"><span class="field-label">平日</span></div>
          <div class="range-field">
            <button type="button" class="range-step" onclick="Temper.stepCapacity('weekday',-1)" aria-label="平日の容量を下げる">−</button>
            <input type="range" id="cap-weekday" min="1" max="${max}" step="1" value="${s.capacityWeekday}" oninput="Temper.onCapacityInput('weekday',this.value)">
            <button type="button" class="range-step" onclick="Temper.stepCapacity('weekday',1)" aria-label="平日の容量を上げる">＋</button>
            <span class="range-value" id="cap-weekday-val">${s.capacityWeekday}</span>
          </div>
        </div>
        <div>
          <div class="field-head"><span class="field-label">休日</span></div>
          <div class="range-field">
            <button type="button" class="range-step" onclick="Temper.stepCapacity('holiday',-1)" aria-label="休日の容量を下げる">−</button>
            <input type="range" id="cap-holiday" min="1" max="${max}" step="1" value="${s.capacityHoliday}" oninput="Temper.onCapacityInput('holiday',this.value)">
            <button type="button" class="range-step" onclick="Temper.stepCapacity('holiday',1)" aria-label="休日の容量を上げる">＋</button>
            <span class="range-value" id="cap-holiday-val">${s.capacityHoliday}</span>
          </div>
        </div>
      </div>
      <div class="settings-divider"></div>
      <div class="segmented-row">
        <span class="segmented-caption">今日は</span>
        <div class="segmented">
          <button class="${dayType === 'weekday' ? 'active' : ''}" onclick="Temper.setTodayType('weekday')">平日</button>
          <button class="${dayType === 'holiday' ? 'active' : ''}" onclick="Temper.setTodayType('holiday')">休日</button>
        </div>
      </div>
    </div>

    <div class="card glass">
      <div class="settings-stack">
        <button class="btn btn-primary btn-full" onclick="Temper.pickImportFile()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"/></svg>
          JSONファイルから読み込む
        </button>
        <button class="btn btn-secondary btn-full" onclick="Temper.exportBackup()">バックアップを書き出す</button>
      </div>
    </div>

    ${renderSyncCard()}

    <div class="settings-version">Temper ${APP_VERSION}</div>
  `;
}

function onCapacityInput(kind, v) {
  const n = parseInt(v, 10);
  if (kind === 'holiday') state.settings.capacityHoliday = n;
  else state.settings.capacityWeekday = n;
  const el = document.getElementById(`cap-${kind}`);
  el.value = n;
  setRangeFill(el);
  document.getElementById(`cap-${kind}-val`).textContent = n;
  persist();
  recomputeTodayPlan();
}

function stepCapacity(kind, delta) {
  const cur = kind === 'holiday' ? state.settings.capacityHoliday : state.settings.capacityWeekday;
  onCapacityInput(kind, Math.max(Store.CAPACITY_MIN, Math.min(Store.CAPACITY_MAX, cur + delta)));
}

/* ------------------------------------------------------------
   インポート / エクスポート
   ------------------------------------------------------------ */
function pickImportFile() {
  const input = document.getElementById('import-file');
  input.value = '';
  input.click();
}

function onImportFileChosen(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(String(reader.result));
    } catch (e) {
      showToast('JSONとして読めませんでした');
      return;
    }
    const summary = Store.summarizeImport(state, data);
    if (!summary) { showToast('対応していない形式のファイルです'); return; }

    pendingImport = data;
    const lines = [
      `新しく追加されるタスク：${summary.newTasks}件`,
      summary.duplicateTasks ? `すでにあるタスク（スキップ）：${summary.duplicateTasks}件` : '',
      summary.historyEntries ? `学習履歴：${summary.historyEntries}件` : '',
      (summary.capacityWeekday != null || summary.capacityHoliday != null)
        ? `キャパシティを更新：平日 ${summary.capacityWeekday ?? '—'}／休日 ${summary.capacityHoliday ?? '—'}`
        : '',
    ].filter(Boolean);

    askConfirm({
      title: 'このデータを読み込みますか',
      body: lines.map((l) => `<div>${l}</div>`).join('') +
        '<div style="margin-top:10px;opacity:.75">今あるタスクと履歴は消えません。</div>',
      okLabel: '読み込む',
      onOk: runImport,
    });
  };
  reader.onerror = () => showToast('ファイルを読めませんでした');
  reader.readAsText(file);
}

function runImport() {
  if (!pendingImport) return;
  try {
    const result = Store.importInto(state, pendingImport);
    // 取り込んだタスクのPatternを一般モデルで推定しておく
    state.tasks.forEach((t) => {
      if (!t.pattern) t.pattern = Planner.estimatePattern(t.title, t.description, Store.derivePatternHistory(state));
    });
    state = Store.normalizeState(state);
    persist();
    recomputeTodayPlan();
    render();
    showToast(`${result.addedTasks}件を読み込みました`);
  } catch (e) {
    console.error('[Temper] import failed', e);
    showToast('読み込みに失敗しました');
  } finally {
    pendingImport = null;
  }
}

function downloadJson(json, filename) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 書き出すファイル名は日付を含めない固定名にしてある。
 * ------------------------------------------------------------
 * 以前は `temper_backup_2026-09-17.json` のように日付を含めていたが、
 * 毎回ファイル名が変わるとダウンロードフォルダに増え続け、
 * 「前回書き出したファイルに上書き保存する」という使い方がしづらかった。
 * 固定名にすることで、毎回同じファイルへの上書きが簡単になる
 * （アップロード時に見た `TaskNOVA_save_data.json` の命名に倣った）。
 */
function exportBackup() {
  downloadJson(Store.exportBackupJson(state), 'Temper_save_data.json');
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
   空の更新（憲法11条: 失敗しても主機能は継続）
   ------------------------------------------------------------
   v1.8.0: 空は現実の天気ではなく、今日〜3日先のタスクの見通しを映す。
     forecast.js … タスク状況 → 見通し(pressure)・逼迫が解けた度合い(relief)
     weather.js  … 見通し・時刻・季節 → 空の状態
     skyrender.js… 空の状態 → 描画（変化は約10秒かけて穏やかに）
   このファイルは3つを呼んで繋ぐだけで、判断は書かない。
   外部通信はしない（位置情報も使わない）。
   ------------------------------------------------------------ */
const SKY_MEMORY_KEY = 'temper-sky-memory';
let sky = null;
let skyMemory = null;     // { peak, at }  直近の逼迫の最大値（relief の計算用）。端末内の小さな補助値
let skyTone = 'dark';

function loadSkyMemory() {
  try {
    const v = JSON.parse(localStorage.getItem(SKY_MEMORY_KEY) || 'null');
    return v && Number.isFinite(v.peak) && Number.isFinite(v.at) ? v : null;
  } catch (e) { return null; }
}
let skyMemorySaved = { peak: -1, at: 0 };
function saveSkyMemory() {
  // render() のたびに呼ばれるので、値が動いたときか1分おきにだけ書く
  if (skyMemory && Math.abs(skyMemory.peak - skyMemorySaved.peak) < 0.01 && skyMemory.at - skyMemorySaved.at < 60000) return;
  skyMemorySaved = { ...skyMemory };
  try { localStorage.setItem(SKY_MEMORY_KEY, JSON.stringify(skyMemory)); } catch (e) { /* 保存できなくても空は動く */ }
}

function initSky() {
  const skyEl = document.getElementById('sky');
  try {
    sky = createSky({
      gl: document.getElementById('sky-gl'),
      fx: document.getElementById('sky-fx'),
      onChrome: applySkyChrome,
    });
    skyMemory = loadSkyMemory();
    refreshSky({ snap: true });
    sky.start();
  } catch (e) {
    console.error('[Temper] sky init failed', e);
    sky = null;
  }
  // 初回フレームの描画後にふわっと表示する
  requestAnimationFrame(() => requestAnimationFrame(() => skyEl.classList.add('ready')));
}

function refreshSky({ snap = false } = {}) {
  if (!sky) return;
  try {
    const today = todayStr();
    if (!currentTodayPlan || currentPlanDate !== today) recomputeTodayPlan();
    // 予定タブでは、選んでいる日の見通しを映す（日ごとに空が変わる）。
    // 「逼迫が解けた直後」の回復系は今日の話なので使わず、時刻は今の時刻のまま、日付だけその日にする。
    if (currentPage === 'upcoming') {
      const proj = computeProjection();
      const day = proj.find((d) => d.offset === upcomingDay) || proj[0];
      const now = new Date();
      const when = new Date(day.date + 'T00:00:00');
      when.setHours(now.getHours(), now.getMinutes(), now.getSeconds());
      sky.setTarget(Weather.resolveSky({ pressure: day.pressure, relief: 0, date: when, drift: Weather.skyDrift(when) }), { snap });
      return;
    }
    const plan = currentTodayPlan;
    const pendingLoad = plan.entries
      .filter((e) => isPendingEntry(e, today))
      .reduce((sum, e) => sum + e.load, 0);
    const f = Forecast.computePressure({
      tasks: state.tasks,
      todayStr: today,
      capacityForDate: (dateStr) => Store.getCapacityFor(state, dateStr),
      weekdayStats: Store.deriveWeekdayStats(state),
      alreadyDoneLoad: computeDoneLoadToday(today),
      todayPendingLoad: pendingLoad,
      todayCapacity: plan.totalCapacity,
    });
    const now = new Date();
    const r = Forecast.updateRelief(skyMemory, f.pressure, now.getTime());
    skyMemory = r.memory;
    saveSkyMemory();
    const target = Weather.resolveSky({ pressure: f.pressure, relief: r.relief, date: now, drift: Weather.skyDrift(now) });
    sky.setTarget(target, { snap });
  } catch (e) {
    console.error('[Temper] sky refresh failed', e);
  }
}

/** 描画エンジンが約0.5秒ごとに渡す、現在の空の端の色と明るさを画面に反映する */
function applySkyChrome({ zenith, edge, lum }) {
  const root = document.documentElement;
  // 文字色は、実際に描いた画素から測った明るさで決める（雲・雨・霧を含む見た目どおり）
  const tone = Weather.toneFor(lum, skyTone);
  if (tone !== skyTone || !applySkyChrome._done) {
    skyTone = tone;
    if (tone === 'light') root.setAttribute('data-tone', 'light'); else root.removeAttribute('data-tone');
  }
  // ビューポートの外側（Safariの上下バーの裏・セーフエリア）も空の続きで塗る。
  // ここを塗らないと画面下部に白帯が出る。
  root.style.backgroundImage = `linear-gradient(180deg, ${zenith} 0%, ${zenith} 33.34%, ${edge} 66.67%, ${edge} 100%)`;
  if (!applySkyChrome._done) {
    root.style.backgroundAttachment = 'fixed';
    root.style.backgroundSize = '100% 300%';
    root.style.backgroundPosition = 'center center';
    root.style.backgroundRepeat = 'no-repeat';
  }
  root.style.setProperty('--canvas', edge);
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.setAttribute('content', edge);
  applySkyChrome._done = true;
}


/* ------------------------------------------------------------
   複数端末の同期（v1.11.0）— Firebase（無料枠）
   ------------------------------------------------------------
   ロジックは sync-core.js、Firebaseとの通信は sync-firebase.js。ここは設定の保存・
   サインイン・画面表示・「他端末の内容を取り込んだら再描画」を繋ぐだけ。
   設定（Firebaseの構成）を入れていなければ何もしない。通信に失敗してもアプリは動く。
   ------------------------------------------------------------ */
const SYNC_CONFIG_KEY = 'temper-firebase-config';
const SYNC_EMAIL_KEY = 'temper-sync-email';
let syncEngine = null;
let syncFb = null;
let syncStatus = 'off'; // off | signedout | connecting | synced | offline | error:*
let syncUser = null;

function loadSyncConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY) || 'null');
    return c && c.apiKey && c.projectId && c.appId ? c : null;
  } catch (e) { return null; }
}

/** コンソールに表示される `const firebaseConfig = { ... };` をそのまま貼れるようにする */
function parseFirebaseConfig(text) {
  const a = String(text || '').indexOf('{'), b = String(text || '').lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  const body = text.slice(a, b + 1)
    .replace(/\/\/.*$/gm, '')
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
    .replace(/,\s*}/g, '}');
  try {
    const c = JSON.parse(body);
    return c && c.apiKey && c.projectId && c.appId ? c : null;
  } catch (e) { return null; }
}

function setSyncStatus(s) {
  syncStatus = s;
  const el = document.getElementById('sync-status');
  if (el) el.textContent = syncStatusLabel();
}
function syncStatusLabel() {
  if (syncStatus === 'off') return '未設定';
  if (syncStatus === 'signedout') return 'サインインしていません';
  if (syncStatus === 'connecting') return '接続中…';
  if (syncStatus === 'synced') return `同期中${syncUser && syncUser.email ? '（' + syncUser.email + '）' : ''}`;
  if (syncStatus === 'offline') return 'オフライン（戻ったら自動で同期します）';
  if (syncStatus === 'error:load') return 'Firebaseを読み込めませんでした（通信を確認してください）';
  if (syncStatus === 'error:permission-denied') return 'エラー：権限がありません（Firestoreのルールを確認）';
  return 'エラー：' + syncStatus.replace(/^error:/, '');
}

async function initSync() {
  const cfg = loadSyncConfig();
  if (!cfg) { setSyncStatus('off'); return; }
  setSyncStatus('connecting');
  try {
    const { loadFirebase } = await import('./sync-firebase.js');
    syncFb = await loadFirebase(cfg);
    syncFb.onAuthChanged((user) => {
      stopSyncEngine();
      syncUser = user || null;
      if (currentPage === 'settings') render(); // サインイン/アウトに合わせてカードを切り替える
      if (!user) { setSyncStatus('signedout'); return; }
      setSyncStatus('connecting');
      syncEngine = createSyncEngine({
        getState: () => state,
        backend: syncFb.makeBackend(user.uid, () => historyCutoff()),
        metaStore: {
          get: () => { try { return JSON.parse(localStorage.getItem('temper-sync-meta-' + user.uid) || 'null'); } catch (e) { return null; } },
          set: (m) => localStorage.setItem('temper-sync-meta-' + user.uid, JSON.stringify(m)),
        },
        normalizeTask: Store.normalizeTask,
        normalizeSettings: Store.normalizeSettings,
        replaceHistoryDay: Store.replaceHistoryDay,
        onStatus: (s) => setSyncStatus(navigator.onLine === false ? 'offline' : s),
        onRemoteApplied: () => {
          // 他の端末の内容を取り込んだ: 保存し（送り返さない）、今日のおすすめ・画面・空を最新にする
          Store.saveState(state);
          recomputeTodayPlan();
          render();
          refreshSky();
        },
      });
      syncEngine.start();
    });
    window.addEventListener('offline', () => { if (syncEngine) setSyncStatus('offline'); });
    window.addEventListener('online', () => { if (syncEngine) { setSyncStatus('synced'); syncEngine.flush(); } });
  } catch (e) {
    console.error('[Temper] sync init failed', e);
    setSyncStatus('error:load');
  }
}
function stopSyncEngine() {
  if (syncEngine) { try { syncEngine.stop(); } catch (e) { /* 止められなくても続ける */ } syncEngine = null; }
}

function saveSyncConfig() {
  const cfg = parseFirebaseConfig(document.getElementById('sync-config').value);
  if (!cfg) { showToast('Firebaseの構成（apiKey・projectId・appIdを含む）を貼り付けてください'); return; }
  try { localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { showToast('保存できませんでした'); return; }
  location.reload(); // 読み込み直して初期化する
}
async function syncAuth(kind) {
  if (!syncFb) return;
  const email = document.getElementById('sync-email').value.trim();
  const pw = document.getElementById('sync-pw').value;
  if (!email || pw.length < 6) { showToast('メールアドレスと6文字以上のパスワードを入れてください'); return; }
  try {
    localStorage.setItem(SYNC_EMAIL_KEY, email);
    if (kind === 'up') await syncFb.signUp(email, pw); else await syncFb.signIn(email, pw);
    render();
  } catch (e) {
    const code = e && e.code ? e.code : '';
    showToast(code.includes('invalid') || code.includes('wrong') ? 'メールアドレスかパスワードが違います'
      : code.includes('email-already') ? 'このメールアドレスは登録済みです。ログインしてください'
      : code.includes('weak') ? 'パスワードが短すぎます' : 'サインインできませんでした（' + (code || '通信エラー') + '）');
  }
}
async function syncSignOut() { if (syncFb) { try { await syncFb.signOut(); } catch (e) { /* 失敗しても画面は戻す */ } } render(); }
function clearSyncConfig() {
  askConfirm({
    title: '同期をやめますか', body: 'この端末の同期設定を消します。この端末のデータと、クラウド上のデータはそのまま残ります。',
    okLabel: 'やめる', danger: true,
    onOk: () => { stopSyncEngine(); try { localStorage.removeItem(SYNC_CONFIG_KEY); } catch (e) { /* 消せなくても再読込で判断される */ } location.reload(); },
  });
}

function renderSyncCard() {
  const cfg = loadSyncConfig();
  const status = `<div class="sync-status-row"><span class="field-label">同期</span><span id="sync-status" class="sync-status">${esc(syncStatusLabel())}</span></div>`;
  if (!cfg) {
    return `<div class="card glass"><div class="settings-stack">${status}
      <textarea id="sync-config" class="sync-input" rows="4" placeholder="Firebaseの構成（const firebaseConfig = {…}）を貼り付け"></textarea>
      <button class="btn btn-primary btn-full" onclick="Temper.saveSyncConfig()">同期を設定する</button>
    </div></div>`;
  }
  if (syncUser) {
    return `<div class="card glass"><div class="settings-stack">${status}
      <button class="btn btn-secondary btn-full" onclick="Temper.syncSignOut()">ログアウト</button>
      <button class="btn btn-danger btn-full" onclick="Temper.clearSyncConfig()">同期をやめる</button>
    </div></div>`;
  }
  const email = (() => { try { return localStorage.getItem(SYNC_EMAIL_KEY) || ''; } catch (e) { return ''; } })();
  return `<div class="card glass"><div class="settings-stack">${status}
    <input id="sync-email" class="sync-input" type="email" autocomplete="username" placeholder="メールアドレス" value="${esc(email)}">
    <input id="sync-pw" class="sync-input" type="password" autocomplete="current-password" placeholder="パスワード（6文字以上）">
    <div class="sheet-actions"><button class="btn btn-primary" onclick="Temper.syncAuth('in')">ログイン</button><button class="btn btn-secondary" onclick="Temper.syncAuth('up')">新規登録</button></div>
    <button class="btn btn-danger btn-full" onclick="Temper.clearSyncConfig()">同期をやめる</button>
  </div></div>`;
}

/* ------------------------------------------------------------
   FAB（タスク画面のみ）
   ------------------------------------------------------------
   render() の最後で直接呼ぶ（MutationObserver に頼らない）。
   DOMに触るコードはトップレベルに置かず、必ず init()/render() の中から
   呼ぶ — かつて画面が真っ白になった不具合の再発防止。
   ------------------------------------------------------------ */
function updateFab() {
  const appEl = document.getElementById('app');
  if (!appEl) return;
  const existing = document.getElementById('add-task-fab');
  if (currentPage === 'tasks' && !existing) {
    const fab = document.createElement('button');
    fab.id = 'add-task-fab';
    fab.className = 'fab glass glass-strong';
    fab.setAttribute('aria-label', 'タスクを追加');
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    fab.addEventListener('click', openAddTask);
    appEl.appendChild(fab);
  } else if (currentPage !== 'tasks' && existing) {
    existing.remove();
  }
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
/**
 * 保存データが消えていた/壊れていた場合に、自動バックアップから戻す（⑤）。
 * 待っている間にユーザーが何か入力していたら、その内容を優先して上書きしない。
 */
async function restoreFromBackupIfLost() {
  if (!Store.getLoadInfo().lost) return;
  const snap = await Store.loadLatestSnapshot();
  if (!snap) return;
  if (state.tasks.length > 0 || state.history.length > 0) return;
  state = snap;
  persist();
  recomputeTodayPlan();
  render();
  showToast('自動バックアップから復元しました');
}

/** オフラインでも起動できるよう、アプリ本体をキャッシュするservice workerを登録する（⑤）。 */
function registerOfflineSupport() {
  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch (e) { /* 非対応環境（file://等）では何もしない */ }
}

function init() {
  if (init._ran) return;
  init._ran = true;
  try {
    recomputeTodayPlan();
    purgeExpiredCompleted(); // 前日分の集計(上の再計算内)を済ませたあとで、24時間経過した完了タスクを消す
    initSky();
    render();
    initViewport(); // iPhoneのホーム画面アプリで下端に帯が出る不具合の検出・回復（viewport.js）
    Store.requestPersistentStorage();
    registerOfflineSupport();
    // 同期は、バックアップからの復元が終わってから始める（空の状態を「全削除」として送らないため）
    restoreFromBackupIfLost().catch(() => {}).then(() => initSync());
    // 時刻に伴う空の移ろい（日の出・夕焼けなど）と、日内のゆらぎのため、15秒ごとに更新する。
    setInterval(() => refreshSky(), 15 * 1000);
    // 長く閉じていた後に戻ってきたときは、古い空から動かさず今の空で始める。
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      ensureTodayPlanFresh();
      if (purgeExpiredCompleted() && (currentPage === 'tasks' || currentPage === 'today')) render();
      if (currentPage === 'upcoming') render(); // 戻ってきたら最新の状況で並べ直す
      refreshSky({ snap: hiddenAt && Date.now() - hiddenAt > 10 * 60 * 1000 });
    });
    // 何も操作しないままアプリを開きっぱなしで日付をまたいだ場合でも
    // 今日のプランが古いまま残らないよう、1分おきに日付の変化を確認する。
    // render()自身もensureTodayPlanFresh()で日付を見るが、それは何らかの
    // 操作（タップ等）が起きたときにしか呼ばれないため、無操作のまま
    // 日をまたぐケースはこの定期チェックが無いと拾えない。
    setInterval(() => {
      const today = todayStr();
      if (currentPlanDate !== today) {
        ensureTodayPlanFresh();
        if (currentPage === 'today') render();
      }
      // 完了から24時間たったタスクを消す（日付の確認の後。前日分の集計を先に済ませるため）
      if (purgeExpiredCompleted() && currentPage === 'tasks') render();
      // 完了済みタブの「あと◯時間で削除」も、時間が進んだ分を反映する
      else if (currentPage === 'tasks' && taskFilter === 'done') render();
      // 予定タブは、時間が進んだ分（日付・曜日・解禁日など）も含めて最新の状況で並べ直す
      if (currentPage === 'upcoming') render();
    }, 60 * 1000);

    document.querySelectorAll('.overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
    });
    document.getElementById('import-file').addEventListener('change', (e) => {
      onImportFileChosen(e.target.files && e.target.files[0]);
    });
  } catch (err) {
    console.error('[Temper] init failed', err);
    const root = document.getElementById('page-root');
    if (root) root.innerHTML = `<div class="empty-state glass card"><div class="glyph">⚠</div><div class="msg">起動時にエラーが発生しました：${esc(String(err && err.message || err))}</div></div>`;
  }
}

window.Temper = {
  navigateTo, toggleTask, onCardPressStart, onCardPressEnd,
  openDetailSheet, closeDetailSheet, setTaskFilter, setTaskSort, setTodayType,
  openAddTask, openEditTask, deleteTask, saveTaskFromModal, closeTaskModal,
  onLoadSliderInput, stepLoad, clearDateField, setTaskType, toggleModalWeekDay,
  onCapacityInput, stepCapacity, generateExtra, setUpcomingDay,
  saveSyncConfig, syncSignOut, clearSyncConfig, syncAuth,
  pickImportFile, exportBackup,
};

document.addEventListener('DOMContentLoaded', init);
// module スクリプトはDOM解析後に走るため、この行の時点で既に
// DOMContentLoaded が発火済みのことがある。その場合は即座に起動する。
if (document.readyState !== 'loading') init();
