/* ============================================================
   app.js — Temper アプリケーション制御層
   ------------------------------------------------------------
   責務（憲法6条: 分離の原則）:
     - store.js（データ・設定の解決）、planner.js（今日の選定）、
       weather.js（空の色）を「呼ぶだけ」で、判断ロジックは書かない。
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
let currentTodayPlan = null;
let currentPlanDate = null; // currentTodayPlan がどの日付向けに作られたか
let editingTaskId = null;
let weatherState = null;   // { condition, temperature, source } | null（取得失敗時）
let pendingImport = null;  // インポート確認中のデータ

const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

function persist() { Store.saveState(state); }

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
function recomputeTodayPlan() {
  const today = todayStr();
  currentTodayPlan = Planner.buildTodayPlan({
    tasks: state.tasks,
    todayStr: today,
    baseCapacity: Store.getCapacityFor(state, today),
    weekdayStats: Store.deriveWeekdayStats(state),
    weekdayPatternStats: Store.deriveWeekdayPatternStats(state),
    patternHistory: Store.derivePatternHistory(state),
    alreadyDoneLoad: computeDoneLoadToday(today),
  });
  currentPlanDate = today;
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
  if (currentPlanDate !== today) recomputeTodayPlan();
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
    else if (currentPage === 'tasks') root.innerHTML = renderTasksPage();
    else if (currentPage === 'settings') root.innerHTML = renderSettingsPage();
    syncRangeFills(root);
  } catch (err) {
    // 無音の失敗（真っ白な画面）を許さない。
    console.error('[Temper] render failed', err);
    root.innerHTML = `<div class="empty-state glass card"><div class="glyph">⚠</div><div class="msg">表示中にエラーが発生しました：${esc(String(err && err.message || err))}</div></div>`;
  }
  updateFab();
}

/* ------------------------------------------------------------
   小さなユーティリティ
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
   今日画面（SPEC §6: 日付 → 天候 → 今日の進捗 → 今日のタスク）
   ------------------------------------------------------------ */
function weatherGlyphSvg(condition, timeOfDay) {
  const open = '<svg class="weather-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">';
  if (condition === 'rain') {
    return open + '<path d="M7 16.5a4.5 4.5 0 01.5-8.98A6 6 0 0119 10.5a3.75 3.75 0 01-.5 7.48"/><line x1="9" y1="19" x2="9" y2="21.5"/><line x1="13" y1="19" x2="13" y2="21.5"/><line x1="17" y1="19" x2="17" y2="21.5"/></svg>';
  }
  if (condition === 'cloudy') {
    return open + '<path d="M7 16.5a4.5 4.5 0 01.5-8.98A6 6 0 0119 10.5a3.75 3.75 0 01-.5 7.48H7z"/></svg>';
  }
  if (timeOfDay === 'night') {
    return open + '<path d="M20 14.2A8.2 8.2 0 019.8 4 8.4 8.4 0 1020 14.2z"/></svg>';
  }
  return open + '<circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="21.5"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="2.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="21.5" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/></svg>';
}

/**
 * 天候行の文言。
 * 取得に失敗しても「取得できませんでした」というエラー文をヒーローに
 * 出さない（SPEC §18 / 憲法11条: 失敗しても主機能は静かに続く）。
 * 分かっている情報だけを状態語として並べる。
 */
function skyRowText(timeOfDay) {
  const parts = [Weather.TIME_LABELS[timeOfDay] || ''];
  if (weatherState) {
    parts.push(Weather.WEATHER_LABELS[weatherState.condition] || '晴れ');
    if (weatherState.temperature != null) parts.push(weatherState.temperature + '℃');
  }
  return parts.filter(Boolean).join('　');
}

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
  const pendingEntries = plan.entries.filter((e) => !isTaskDoneToday(e.id, today));
  const doneLoad = computeDoneLoadToday(today);
  // plan.totalLoad は「完了前に選ばれた時点」の合計なので、完了後も
  // そのまま使うと doneLoad と二重に数えてしまう（完了させても
  // recomputeTodayPlan() を呼ばないため、plan.entries に完了済みの
  // タスクがまだ残っている）。pendingEntries（未完了のみ）から
  // 合計し直すことで二重計上を避ける。
  const pendingLoad = pendingEntries.reduce((sum, e) => sum + e.load, 0);
  const totalLoad = doneLoad + pendingLoad;
  // 分母は「今日1日の目標容量」(fullCapacity)。plan.effectiveCapacity は
  // Plannerが残りタスクを選ぶ際に使った「まだ使っていない予算」
  // （fullCapacityからdoneLoadを引いたもの）なので、表示の分母には使わない
  // — これを分母にすると、完了が進むほど分母が縮んでいく不自然な表示になる。
  const capacity = plan.fullCapacity;

  const C = 2 * Math.PI * 23;
  const frac = (v) => (capacity > 0 ? Math.min(1, v / capacity) : 0);
  const plannedOffset = C * (1 - frac(totalLoad));
  const doneOffset = C * (1 - frac(doneLoad));

  const timeOfDay = Weather.getTimeOfDay();
  const condition = weatherState ? weatherState.condition : 'clear';
  const finishLabel = estimateFinishLabel(pendingLoad);

  let taskListHtml;
  if (!plan.entries.length && doneLoad === 0) {
    taskListHtml = `<div class="empty-state glass card"><div class="glyph">✧</div><div class="msg">今日扱うタスクはありません</div></div>`;
  } else if (!pendingEntries.length) {
    taskListHtml = `<div class="empty-state glass card"><div class="glyph">✧</div><div class="msg">今日の分はすべて終えました</div></div>`;
  } else {
    taskListHtml = pendingEntries.map((entry) => renderTaskCard(entry)).join('');
  }

  return `
    <div class="page-head">
      <div class="today-date">${formatDateLabel(today)}</div>
      <div class="today-sky-row">${weatherGlyphSvg(condition, timeOfDay)}<span>${esc(skyRowText(timeOfDay))}</span></div>
    </div>

    <div class="card glass progress-card">
      <div class="progress-main">
        <svg class="load-ring-svg" viewBox="0 0 54 54" aria-hidden="true">
          <circle class="load-ring-track" cx="27" cy="27" r="23"/>
          ${totalLoad > 0 ? `<circle class="load-ring-planned" cx="27" cy="27" r="23" stroke-dasharray="${C}" stroke-dashoffset="${plannedOffset}" transform="rotate(-90 27 27)"/>` : ''}
          ${doneLoad > 0 ? `<circle class="load-ring-done" cx="27" cy="27" r="23" stroke-dasharray="${C}" stroke-dashoffset="${doneOffset}" transform="rotate(-90 27 27)"/>` : ''}
        </svg>
        <div class="progress-text">
          <div class="progress-value">今日の負荷　<b>${totalLoad}</b> / ${capacity}</div>
          <div class="progress-sub">${pendingEntries.length}件が残っています${doneLoad > 0 ? `　（消化 ${doneLoad}）` : ''}</div>
          ${finishLabel ? `<div class="progress-finish">終了目安 ${finishLabel}</div>` : ''}
        </div>
      </div>
    </div>

    <div class="section-label">今日のタスク</div>
    <div id="today-task-list">${taskListHtml}</div>
  `;
}

/**
 * 残りの負荷から、終了目安の時刻を概算する（小さく添える程度の目安）。
 * ------------------------------------------------------------
 * タスクごとの所要時間は記録していないため、「負荷1につき約
 * MINUTES_PER_LOAD分」という粗い仮定で概算する。正確な所要時間の
 * 見積もりではなく、あくまで目安。残りが無ければ表示しない。
 */
const MINUTES_PER_LOAD = 15;
function estimateFinishLabel(pendingLoad) {
  if (!(pendingLoad > 0)) return null;
  const finish = new Date(Date.now() + pendingLoad * MINUTES_PER_LOAD * 60000);
  return String(finish.getHours()).padStart(2, '0') + ':' + String(finish.getMinutes()).padStart(2, '0');
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
  if (t.unlockDate && t.unlockDate > today) {
    chips.push(`<span class="task-meta-chip">${formatDateLabel(t.unlockDate)}から</span>`);
  }
  // 負荷は数字と点の並びの両方で読めるようにする（SPEC §5 / 憲法12条）。
  // 数字と点を別々のチップにすると同じ情報が二度出て煩いため、ひと塊にする。
  chips.push(`<span class="load-chip" aria-label="負荷 ${t.load}">負荷 ${t.load}<span class="load-dot-row">${loadDots(t.load)}</span></span>`);

  const actions = opts.withActions ? `
      <div class="task-list-actions">
        <button class="icon-btn" onclick="event.stopPropagation();Temper.openEditTask('${t.id}')" aria-label="編集">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn" onclick="event.stopPropagation();Temper.deleteTask('${t.id}')" aria-label="削除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>` : '';

  return `
    <div class="task-card glass${doneToday ? ' done' : ''}" data-task-id="${t.id}"
         ontouchstart="Temper.onCardPressStart('${t.id}')" ontouchend="Temper.onCardPressEnd()" ontouchmove="Temper.onCardPressEnd()"
         onmousedown="Temper.onCardPressStart('${t.id}')" onmouseup="Temper.onCardPressEnd()" onmouseleave="Temper.onCardPressEnd()">
      <button class="task-check${doneToday ? ' checked' : ''}" onclick="event.stopPropagation();Temper.toggleTask('${t.id}')" aria-label="${doneToday ? '未完了に戻す' : '完了にする'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>
      </button>
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

function openDetailSheet(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  const entry = currentTodayPlan && currentTodayPlan.entries.find((e) => e.id === taskId);
  const reason = entry ? Planner.explainSelection(entry) : null;
  const weekly = t.type === 'weekly';
  const doneToday = Store.isTaskComplete(t, todayStr());

  document.getElementById('detail-sheet-body').innerHTML = `
    <div class="sheet-grabber"></div>
    <div class="sheet-title">${esc(t.title)}</div>
    ${weekly
      ? `<div class="sheet-row"><span class="sheet-row-label">曜日</span><span>毎週${esc(Store.weekDaysLabel(t.weekDays) || '未設定')}</span></div>`
      : `<div class="sheet-row"><span class="sheet-row-label">期限</span><span>${t.deadline ? formatDateLabel(t.deadline) : 'なし'}</span></div>`}
    <div class="sheet-row"><span class="sheet-row-label">解禁日</span><span>${t.unlockDate ? formatDateLabel(t.unlockDate) : 'なし'}</span></div>
    <div class="sheet-row"><span class="sheet-row-label">負荷</span><span>${t.load} / 10</span></div>
    <div class="sheet-row"><span class="sheet-row-label">状態</span><span>${doneToday ? (weekly ? '今日は完了' : '完了') : '未完了'}</span></div>
    ${reason ? `<div class="sheet-note">今日選ばれた理由：${esc(reason)}</div>` : ''}
    <div class="sheet-actions">
      <button class="btn btn-secondary" onclick="Temper.closeDetailSheet()">閉じる</button>
      <button class="btn btn-primary" onclick="Temper.closeDetailSheet();Temper.openEditTask('${t.id}')">編集する</button>
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
function toggleTask(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
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
    }
    Store.undoCompletion(state, t, completionDate);
    persist();
    recomputeTodayPlan();
    render();
    return;
  }

  const cardEl = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
  if (cardEl && currentPage === 'today') cardEl.classList.add('completing');
  const finish = () => {
    if (t.type === 'weekly') {
      t.doneDates = t.doneDates || [];
      if (!t.doneDates.includes(today)) t.doneDates.push(today);
    } else {
      t.done = true;
      t.doneDate = today;
    }
    Store.recordCompletion(state, t, today);
    persist();
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
  const list = sortTasksForList(taskFilter === 'active' ? active : done);

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
    <div class="segmented" style="margin:0 0 var(--sp-3)">
      <button class="${taskSort === 'deadline' ? 'active' : ''}" onclick="Temper.setTaskSort('deadline')">期限順</button>
      <button class="${taskSort === 'load' ? 'active' : ''}" onclick="Temper.setTaskSort('load')">負荷順</button>
    </div>
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
        t.done = false; t.doneDate = null;
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
      <div class="settings-row">
        <div class="settings-row-title">天気を自動取得</div>
        <button class="toggle ${s.weatherAutoLocation ? 'on' : ''}" role="switch" aria-checked="${s.weatherAutoLocation}" onclick="Temper.toggleWeatherAuto()"></button>
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

function toggleWeatherAuto() {
  state.settings.weatherAutoLocation = !state.settings.weatherAutoLocation;
  persist();
  render();
  refreshWeather();
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
   天候・空の更新（憲法11条: 失敗しても主機能は継続）
   ------------------------------------------------------------ */
async function refreshWeather() {
  try {
    const manual = state.settings.weatherAutoLocation ? null : (state.settings.manualWeatherCondition || 'clear');
    weatherState = await Weather.getWeather(manual);
  } catch (e) {
    weatherState = null;
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
  sky.style.background = Weather.skyGradient(profile);
  document.getElementById('sky-scrim').style.background = Weather.scrimGradient(profile);

  const tone = Weather.getTextToneFor(timeOfDay);
  document.documentElement.dataset.tone = tone === 'light' ? 'light' : '';

  // ビューポートの外側（Safariの上下バーの裏・セーフエリア）も空の続きで塗る。
  // ここを塗らないと画面下部に白帯が出る。
  const root = document.documentElement;
  root.style.backgroundImage = Weather.canvasGradient(profile);
  root.style.backgroundAttachment = 'fixed';
  root.style.backgroundSize = '100% 300%';
  root.style.backgroundPosition = 'center center';
  root.style.backgroundRepeat = 'no-repeat';
  root.style.setProperty('--canvas', Weather.edgeColor(profile));
  document.getElementById('theme-color-meta').setAttribute('content', Weather.edgeColor(profile));

  const sun = document.getElementById('sky-sun');
  sun.style.left = profile.sun.x + '%';
  sun.style.top = profile.sun.y + '%';
  sun.style.width = profile.sun.size + 'vmax';
  sun.style.height = profile.sun.size + 'vmax';
  sun.style.opacity = String(profile.sun.strength);
  sun.style.background = Weather.sunGradient(profile);

  const cloudsContainer = document.getElementById('sky-clouds');
  cloudsContainer.style.opacity = String(profile.cloud.opacity);
  ensureClouds();
  cloudsContainer.querySelectorAll('.cloud').forEach((c) => { c.style.color = profile.cloud.tint; });

  ensureStars();
  document.getElementById('sky-stars').style.opacity = String(profile.starOpacity);
  ensureRain();
}

/** 積雲らしい輪郭を、深く重ねた楕円とSVGぼかしで描く */
function ensureClouds() {
  const container = document.getElementById('sky-clouds');
  if (container.childElementCount > 0) return;
  const puffLayouts = [
    [50, 6, 26, 15],
    [32, 10, 22, 13], [68, 10, 22, 13],
    [18, 14, 16, 10], [82, 14, 16, 10],
    [40, -6, 20, 13], [60, -6, 20, 13],
    [8, 18, 11, 7], [92, 18, 11, 7],
  ];
  const clouds = [
    { w: 40, top: 10, duration: 150, delay: -10, driftX: 8 },
    { w: 30, top: 26, duration: 190, delay: -90, driftX: 55 },
    { w: 34, top: 4, duration: 165, delay: -140, driftX: -15 },
  ];
  clouds.forEach((cfg) => {
    const wrap = document.createElement('div');
    wrap.className = 'cloud';
    wrap.style.width = cfg.w + 'vw';
    wrap.style.top = cfg.top + '%';
    wrap.style.left = cfg.driftX + 'vw';
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

function ensureStars() {
  const container = document.getElementById('sky-stars');
  if (container.childElementCount > 0) return;
  for (let i = 0; i < 90; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const size = Math.random() < 0.15 ? 2.4 : Math.random() < 0.5 ? 1.6 : 1.1;
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 62 + '%';
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
function init() {
  if (init._ran) return;
  init._ran = true;
  try {
    recomputeTodayPlan();
    applySky();
    render();
    refreshWeather();
    setInterval(applySky, 5 * 60 * 1000);
    // 何も操作しないままアプリを開きっぱなしで日付をまたいだ場合でも
    // 今日のプランが古いまま残らないよう、1分おきに日付の変化を確認する。
    // render()自身もensureTodayPlanFresh()で日付を見るが、それは何らかの
    // 操作（タップ等）が起きたときにしか呼ばれないため、無操作のまま
    // 日をまたぐケースはこの定期チェックが無いと拾えない。
    setInterval(() => {
      const today = todayStr();
      if (currentPlanDate !== today) {
        recomputeTodayPlan();
        if (currentPage === 'today') render();
      }
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
  onCapacityInput, stepCapacity, toggleWeatherAuto,
  pickImportFile, exportBackup,
};

document.addEventListener('DOMContentLoaded', init);
// module スクリプトはDOM解析後に走るため、この行の時点で既に
// DOMContentLoaded が発火済みのことがある。その場合は即座に起動する。
if (document.readyState !== 'loading') init();
