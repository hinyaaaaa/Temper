/* ============================================================
   store.js — Temper データストア
   ------------------------------------------------------------
   責務（憲法6条）: 保存・読み込み・移行・インポートと、
   「設定として決まっている値」の解決のみ。
   Plannerのロジックも画面の都合もここには持ち込まない。

   憲法10条: 既存の保存データを破壊しない。
     - TaskEngine/Flowly (altair_data) からの自動移行
     - TaskNOVA / Temper のJSONファイルからの手動インポート（追加のみ）
   全てローカル完結（外部サーバー無し）。
   ============================================================ */

const STORAGE_KEY = 'temper_data_v1';
const LEGACY_KEYS = ['altair_data', 'altair_v2', 'altair_v1'];

/** 負荷スケールの上限（SPEC §5: タスクの負荷は1〜10） */
export const LOAD_MAX = 10;
/** 1日のキャパシティの上限。休日は複数タスクを積むため負荷上限より広く取る。 */
export const CAPACITY_MAX = 40;
export const CAPACITY_MIN = 1;

/**
 * 旧アプリ(TaskNOVA/Flowly)の負荷は0.5刻みの主観値で、Temperは1〜10の整数。
 * 2倍して丸めることで刻みを保ったまま整数スケールへ移す。
 * キャパシティも「同じ倍率」で変換しないと1日に入る件数が変わってしまうため、
 * 必ずこの定数を共有する（旧実装は負荷を2倍・容量を1/1.6倍しており、
 * 移行後に1日の分量が実質1/3になる不整合があった）。
 */
const LEGACY_LOAD_SCALE = 2;

const STATE_DEFAULTS = {
  tasks: [],
  // Plannerが記録する履歴。分析用途のみで、ユーザー評価には使わない。
  history: [],
  settings: {
    // SPEC §5 の負荷スケールに対する「1日に無理なく扱える量」。
    // 平日と休日で使える時間が大きく違うため、別々に持つ。
    capacityWeekday: 6,
    capacityHoliday: 10,
    // 既定で休日とみなす曜日（0=日 … 6=土）
    holidayWeekdays: [0, 6],
    // 日付単位の手動上書き { 'YYYY-MM-DD': 'weekday' | 'holiday' }
    dayTypeOverrides: {},
    weatherAutoLocation: true,
    manualWeatherCondition: null,
  },
  stats: {
    weekday: {},         // { [0-6]: { completed:number, missed:number } }
    weekdayPattern: {},  // { "0:memorization": { completed:number, missed:number } }
  },
};

/** 手動上書きを無制限に溜めない（過去の分は選定に影響しないため捨ててよい） */
const OVERRIDE_KEEP_DAYS = 90;

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------------------------------------
   読み書き
   ------------------------------------------------------------ */
export function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_KEYS) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy) { raw = migrateLegacy(legacy); break; }
      }
    }
  } catch (e) { /* ローカルストレージ不可環境（憲法11条: 主機能は継続） */ }

  let state;
  try {
    state = raw ? { ...deepClone(STATE_DEFAULTS), ...JSON.parse(raw) } : deepClone(STATE_DEFAULTS);
  } catch (e) {
    state = deepClone(STATE_DEFAULTS);
  }
  return normalizeState(state);
}

/**
 * 形の揺れ（古い保存形式・壊れた値）をここで吸収する。
 * 画面側は normalizeState を通った state しか受け取らない。
 */
export function normalizeState(state) {
  if (!state || typeof state !== 'object') state = {};
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.history)) state.history = [];

  const s = { ...deepClone(STATE_DEFAULTS.settings), ...(state.settings || {}) };

  // 旧形式: 単一の dailyCapacity しか無かった頃のデータを平日/休日へ展開する。
  if (state.settings && state.settings.dailyCapacity != null && state.settings.capacityWeekday == null) {
    const base = clampInt(state.settings.dailyCapacity, CAPACITY_MIN, CAPACITY_MAX, 6);
    s.capacityWeekday = base;
    s.capacityHoliday = clampInt(base * 1.6, CAPACITY_MIN, CAPACITY_MAX, base);
  }
  delete s.dailyCapacity;

  s.capacityWeekday = clampInt(s.capacityWeekday, CAPACITY_MIN, CAPACITY_MAX, 6);
  s.capacityHoliday = clampInt(s.capacityHoliday, CAPACITY_MIN, CAPACITY_MAX, 10);
  if (!Array.isArray(s.holidayWeekdays)) s.holidayWeekdays = [0, 6];
  if (!s.dayTypeOverrides || typeof s.dayTypeOverrides !== 'object') s.dayTypeOverrides = {};
  s.weatherAutoLocation = s.weatherAutoLocation !== false;
  state.settings = s;

  state.stats = { ...deepClone(STATE_DEFAULTS.stats), ...(state.stats || {}) };
  if (!state.stats.weekday) state.stats.weekday = {};
  if (!state.stats.weekdayPattern) state.stats.weekdayPattern = {};

  state.tasks = state.tasks.filter((t) => t && typeof t === 'object').map(normalizeTask);

  return state;
}

/**
 * 1タスク分の形を揃える。type='weekly'（§4「繰り返し」）のときだけ
 * weekDays/doneDates が意味を持つ。'once' のときは従来通り done/doneDate。
 */
function normalizeTask(t) {
  const type = t.type === 'weekly' ? 'weekly' : 'once';
  return {
    id: String(t.id || newId()),
    title: String(t.title || ''),
    description: typeof t.description === 'string' ? t.description : '',
    deadline: t.deadline || null,
    unlockDate: t.unlockDate || null,
    load: clampInt(t.load, 1, LOAD_MAX, 4),
    type,
    // 実施する曜日(0=日〜6=土)。weeklyのみ使う。
    weekDays: type === 'weekly' && Array.isArray(t.weekDays)
      ? [...new Set(t.weekDays.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
      : [],
    // 完了した日付('YYYY-MM-DD')の集合。weeklyのみ使う。
    doneDates: type === 'weekly' && Array.isArray(t.doneDates)
      ? [...new Set(t.doneDates.filter((d) => typeof d === 'string'))]
      : [],
    done: type === 'weekly' ? false : !!t.done,
    doneDate: type === 'weekly' ? null : (t.doneDate || null),
    pattern: t.pattern || null,
    createdAt: Number(t.createdAt) || Date.now(),
  };
}

/**
 * そのタスクが指定日に「もう済んでいる」か。
 * once: done && doneDate===dateStr（＝その日に完了した）
 * weekly: doneDatesにその日が含まれるか
 */
export function isTaskDoneToday(task, dateStr) {
  if (task.type === 'weekly') return Array.isArray(task.doneDates) && task.doneDates.includes(dateStr);
  return !!task.done && task.doneDate === dateStr;
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
/** [1,3,5] → '月・水・金'（設定不要ならnull） */
export function weekDaysLabel(weekDays) {
  if (!Array.isArray(weekDays) || !weekDays.length) return null;
  return weekDays.slice().sort().map((d) => WEEKDAY_LABELS[d]).join('・');
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function saveState(state) {
  try {
    pruneOverrides(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

function pruneOverrides(state) {
  const overrides = state.settings.dayTypeOverrides;
  const keys = Object.keys(overrides);
  if (keys.length <= OVERRIDE_KEEP_DAYS) return;
  keys.sort();
  keys.slice(0, keys.length - OVERRIDE_KEEP_DAYS).forEach((k) => { delete overrides[k]; });
}

/* ------------------------------------------------------------
   平日 / 休日 と、その日のキャパシティ（要件: 平日・休日で分離、手動切替）
   ------------------------------------------------------------
   「今日はどちらの容量で考えるか」は設定の解決であってPlannerの
   判断ではないため、ここに置く（憲法6条）。Plannerは数値だけを受け取る。
   ------------------------------------------------------------ */

/** @returns {'weekday'|'holiday'} */
export function getDayType(state, dateStr) {
  const override = state.settings.dayTypeOverrides[dateStr];
  if (override === 'weekday' || override === 'holiday') return override;
  const weekday = new Date(dateStr + 'T00:00:00').getDay();
  return state.settings.holidayWeekdays.includes(weekday) ? 'holiday' : 'weekday';
}

/** ユーザーが明示的に切り替えたか（＝曜日の既定と違うか）を画面が知るため */
export function isDayTypeOverridden(state, dateStr) {
  return Object.prototype.hasOwnProperty.call(state.settings.dayTypeOverrides, dateStr);
}

export function setDayType(state, dateStr, dayType) {
  const weekday = new Date(dateStr + 'T00:00:00').getDay();
  const natural = state.settings.holidayWeekdays.includes(weekday) ? 'holiday' : 'weekday';
  if (dayType === natural) delete state.settings.dayTypeOverrides[dateStr];
  else state.settings.dayTypeOverrides[dateStr] = dayType;
}

export function getCapacityFor(state, dateStr) {
  return getDayType(state, dateStr) === 'holiday'
    ? state.settings.capacityHoliday
    : state.settings.capacityWeekday;
}

/* ------------------------------------------------------------
   旧Flowly (altair_data) からの自動移行
   ------------------------------------------------------------ */
function migrateLegacy(rawJson) {
  try {
    const legacy = JSON.parse(rawJson);
    if (!legacy || typeof legacy !== 'object') return null;
    const migrated = deepClone(STATE_DEFAULTS);
    mergeTaskNovaLike(migrated, legacy);
    return JSON.stringify(migrated);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------
   JSONファイルからのインポート（要件: アップロードしたJSONを読み込む）
   ------------------------------------------------------------
   憲法10条を最優先する。インポートは常に「追加」であり、
   既存のタスク・履歴を消さない。同じIDのタスクは重複させず飛ばす。
   ------------------------------------------------------------ */

/** JSONの中身から、どのアプリの保存データかを判定する */
export function detectImportFormat(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.temperVersion || (data.settings && data.settings.capacityWeekday != null && Array.isArray(data.tasks) && data.stats)) {
    return 'temper';
  }
  if (Array.isArray(data.tasks) && data.settings && (data.settings.capacityWeekday != null || data.settings.capacityHoliday != null)) {
    return 'tasknova';
  }
  if (Array.isArray(data.tasks)) return 'tasknova'; // Flowly/TaskEngineも同じ形
  if (Array.isArray(data.history) && data.stats) return 'history';
  return null;
}

/**
 * インポート内容の要約を先に作る（実行前にユーザーへ提示するため）。
 * @returns {{format:string, newTasks:number, duplicateTasks:number,
 *            historyEntries:number, capacityWeekday:number|null, capacityHoliday:number|null}}
 */
export function summarizeImport(state, data) {
  const format = detectImportFormat(data);
  if (!format) return null;

  const existingIds = new Set(state.tasks.map((t) => t.id));
  const incoming = Array.isArray(data.tasks) ? data.tasks : [];
  let newTasks = 0, duplicateTasks = 0;
  incoming.forEach((t) => {
    if (!t || !t.title) return;
    if (t.id && existingIds.has(String(t.id))) duplicateTasks += 1;
    else newTasks += 1;
  });

  const cap = readCapacities(data);
  return {
    format,
    newTasks,
    duplicateTasks,
    historyEntries: countHistory(data),
    capacityWeekday: cap.weekday,
    capacityHoliday: cap.holiday,
  };
}

function countHistory(data) {
  if (Array.isArray(data.sessionHistory)) return data.sessionHistory.length;
  if (Array.isArray(data.history)) return data.history.length;
  return 0;
}

/**
 * 旧アプリのキャパシティをTemperのスケールへ換算する。
 * Temper形式（既にこのスケール）の場合はそのまま使う。
 */
function readCapacities(data) {
  const s = data.settings || {};
  if (data.temperVersion || s.capacityWeekday > LOAD_MAX || s.holidayWeekdays) {
    // Temper自身の書き出し
    return {
      weekday: s.capacityWeekday != null ? clampInt(s.capacityWeekday, CAPACITY_MIN, CAPACITY_MAX, null) : null,
      holiday: s.capacityHoliday != null ? clampInt(s.capacityHoliday, CAPACITY_MIN, CAPACITY_MAX, null) : null,
    };
  }
  return {
    weekday: s.capacityWeekday != null ? clampInt(s.capacityWeekday * LEGACY_LOAD_SCALE, CAPACITY_MIN, CAPACITY_MAX, null) : null,
    holiday: s.capacityHoliday != null ? clampInt(s.capacityHoliday * LEGACY_LOAD_SCALE, CAPACITY_MIN, CAPACITY_MAX, null) : null,
  };
}

/** TaskNOVAの学習タイプ → TemperのPattern（planner.js の PATTERNS に対応） */
const NOVA_TYPE_TO_PATTERN = {
  MEMORY: 'memorization',
  LOGIC: 'problem_solving',
  PRACTICE: 'practice',
  READING: 'reading',
  CREATIVE: 'writing',
};

/**
 * データを state へ取り込む（破壊しない・追加のみ）。
 * @returns {{addedTasks:number, skippedTasks:number, addedHistory:number, capacityApplied:boolean}}
 */
export function importInto(state, data) {
  const format = detectImportFormat(data);
  if (!format) throw new Error('対応していない形式のファイルです');
  if (format === 'temper' || format === 'history') return mergeTemperExport(state, data);
  return mergeTaskNovaLike(state, data);
}

function mergeTemperExport(state, data) {
  const result = { addedTasks: 0, skippedTasks: 0, addedHistory: 0, capacityApplied: false };
  const existingIds = new Set(state.tasks.map((t) => t.id));

  (Array.isArray(data.tasks) ? data.tasks : []).forEach((t) => {
    if (!t || !t.title) return;
    if (t.id && existingIds.has(String(t.id))) { result.skippedTasks += 1; return; }
    state.tasks.push(normalizeTask(t));
    existingIds.add(String(t.id));
    result.addedTasks += 1;
  });

  const seen = new Set(state.history.map(historyKey));
  (Array.isArray(data.history) ? data.history : []).forEach((h) => {
    if (!h || !h.date) return;
    if (seen.has(historyKey(h))) return;
    state.history.push(h);
    seen.add(historyKey(h));
    result.addedHistory += 1;
  });

  if (data.stats) mergeStats(state, data.stats);

  const cap = readCapacities(data);
  if (cap.weekday != null) { state.settings.capacityWeekday = cap.weekday; result.capacityApplied = true; }
  if (cap.holiday != null) { state.settings.capacityHoliday = cap.holiday; result.capacityApplied = true; }
  return result;
}

/**
 * TaskNOVA / Flowly / TaskEngine 形式の取り込み。
 * 負荷は0.5刻みの主観値なので LEGACY_LOAD_SCALE 倍して整数化する。
 * 週次タスク(type:'weekly', weekDays[])はTemperも同じ概念を持つため、
 * そのまま週次タスクとして取り込む（旧版は「タイトルに（毎週）を付けた
 * 単発タスク」として一度だけ複製する簡易対応だったが、週次を本実装した
 * ことでこの回避策は不要になった）。
 */
function mergeTaskNovaLike(state, data) {
  const result = { addedTasks: 0, skippedTasks: 0, addedHistory: 0, capacityApplied: false };
  const existingIds = new Set(state.tasks.map((t) => t.id));

  (Array.isArray(data.tasks) ? data.tasks : []).forEach((t) => {
    if (!t || !t.title) return;
    const id = String(t.id || newId());
    if (existingIds.has(id)) { result.skippedTasks += 1; return; }
    state.tasks.push(normalizeTask({
      id,
      title: String(t.title),
      description: '',
      deadline: t.deadline || null,
      unlockDate: t.unlockDate || null,
      load: (Number(t.load) || 2) * LEGACY_LOAD_SCALE,
      type: t.type === 'weekly' ? 'weekly' : 'once',
      weekDays: t.weekDays,
      doneDates: [],
      done: !!t.done,
      doneDate: t.doneDate || null,
      pattern: null, // 取り込み後に一般モデルで推定させる
      createdAt: Number(t.createdAt) || Date.now(),
    }));
    existingIds.add(id);
    result.addedTasks += 1;
  });

  // セッション履歴 → Temperのhistory
  const seen = new Set(state.history.map(historyKey));
  (Array.isArray(data.sessionHistory) ? data.sessionHistory : []).forEach((s) => {
    if (!s || !s.date) return;
    const entry = {
      taskId: s.taskId || null,
      event: 'completed',
      pattern: NOVA_TYPE_TO_PATTERN[s.type] || null,
      load: clampInt((Number(s.actualLoad) || Number(s.plannedLoad) || 1) * LEGACY_LOAD_SCALE, 1, LOAD_MAX, 2),
      deadline: null,
      date: s.date,
      ts: Number(s.endAt) || Number(s.startAt) || 0,
      source: 'tasknova',
    };
    if (seen.has(historyKey(entry))) return;
    state.history.push(entry);
    seen.add(historyKey(entry));
    result.addedHistory += 1;
  });

  // 曜日別実績（Plannerのキャパシティ補正・曜日補正が使う）
  const byWeekday = data.learningAnalytics && data.learningAnalytics.byWeekday;
  if (byWeekday) mergeStats(state, { weekday: byWeekday, weekdayPattern: {} });

  const cap = readCapacities(data);
  if (cap.weekday != null) { state.settings.capacityWeekday = cap.weekday; result.capacityApplied = true; }
  if (cap.holiday != null) { state.settings.capacityHoliday = cap.holiday; result.capacityApplied = true; }

  // 休日指定の引き継ぎ
  const s = data.settings || {};
  if (Array.isArray(s.holidays)) {
    s.holidays.forEach((d) => { if (typeof d === 'string') state.settings.dayTypeOverrides[d] = 'holiday'; });
  }
  if (s.todayOverride && s.todayOverride.date) {
    state.settings.dayTypeOverrides[s.todayOverride.date] = s.todayOverride.isHoliday ? 'holiday' : 'weekday';
  }
  return result;
}

function historyKey(h) {
  return [h.taskId || '', h.date || '', h.event || '', h.ts || ''].join('|');
}

function mergeStats(state, stats) {
  ['weekday', 'weekdayPattern'].forEach((bucket) => {
    const incoming = stats[bucket];
    if (!incoming || typeof incoming !== 'object') return;
    Object.entries(incoming).forEach(([key, v]) => {
      if (!v || typeof v !== 'object') return;
      const cur = state.stats[bucket][key] || { completed: 0, missed: 0 };
      // 同じ期間を二重に足さないよう、合算ではなく「多い方」を採る。
      cur.completed = Math.max(cur.completed, Number(v.completed) || 0);
      cur.missed = Math.max(cur.missed, Number(v.missed) || 0);
      state.stats[bucket][key] = cur;
    });
  });
}

/**
 * そのタスクが「完了状態」かどうか（チェックボックスの表示・トグル操作
 * で「これから完了にするのか、取り消すのか」を判定するために使う）。
 * ------------------------------------------------------------
 * isTaskDoneToday() とは意味が異なる。単発タスクは一度完了すれば
 * 完了日に関わらずずっと「完了」のままだが、今日の負荷集計
 * （isTaskDoneToday）は「今日完了したものだけ」を数えたい。
 * この区別を怠ると、過去の日に完了した単発タスクの完了済みタブで
 * チェックを外そうとしたときに「今日はまだ完了していない」と誤判定され、
 * 取り消しではなく「今日改めて完了」扱いになって doneDate が今日に
 * 上書きされ、履歴にもう1件積み増されてしまう。
 */
export function isTaskComplete(task, todayStr) {
  if (task.type === 'weekly') return Array.isArray(task.doneDates) && task.doneDates.includes(todayStr);
  return !!task.done;
}

/* ------------------------------------------------------------
   統計更新
   ------------------------------------------------------------ */
export function recordCompletion(state, task, completedOn) {
  const weekday = new Date(completedOn + 'T00:00:00').getDay();
  const wd = state.stats.weekday[weekday] || { completed: 0, missed: 0 };
  wd.completed += 1;
  state.stats.weekday[weekday] = wd;

  if (task.pattern) {
    const key = `${weekday}:${task.pattern}`;
    const wp = state.stats.weekdayPattern[key] || { completed: 0, missed: 0 };
    wp.completed += 1;
    state.stats.weekdayPattern[key] = wp;
  }

  state.history.push({
    taskId: task.id, event: 'completed', pattern: task.pattern,
    load: task.load, deadline: task.deadline, date: completedOn, ts: Date.now(),
  });
}

/**
 * recordCompletion() の取り消し。完了のチェックを外したときに呼ぶ。
 * ------------------------------------------------------------
 * これを呼ばずに済フラグだけ戻すと、「完了→取り消し→再完了」を
 * 繰り返すたびに history へエントリが積み重なり、曜日別の統計
 * （stats.weekday の completed 件数）も実際より多く完了したかの
 * ように狂っていく。対応するhistoryエントリ（taskId・date・
 * event='completed' が一致する直近の1件）を1件だけ削除し、統計の
 * 加算も同じ分だけ打ち消す。
 *
 * 「1件だけ」削除するのは、同じタスクが別の日に完了した記録まで
 * 誤って消さないため（同日中の完了→取り消しは通常1回分のはず
 * だが、念のため後ろから探して直近の1件のみ対象にする）。
 */
export function undoCompletion(state, task, completedOn) {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const h = state.history[i];
    if (h.taskId === task.id && h.date === completedOn && h.event === 'completed') {
      state.history.splice(i, 1);
      break;
    }
  }

  const weekday = new Date(completedOn + 'T00:00:00').getDay();
  const wd = state.stats.weekday[weekday];
  if (wd && wd.completed > 0) wd.completed -= 1;

  if (task.pattern) {
    const key = `${weekday}:${task.pattern}`;
    const wp = state.stats.weekdayPattern[key];
    if (wp && wp.completed > 0) wp.completed -= 1;
  }
}

export function recordMiss(state, task, dateStr) {
  const weekday = new Date(dateStr + 'T00:00:00').getDay();
  const wd = state.stats.weekday[weekday] || { completed: 0, missed: 0 };
  wd.missed += 1;
  state.stats.weekday[weekday] = wd;

  state.history.push({
    taskId: task.id, event: 'missed', pattern: task.pattern,
    load: task.load, deadline: task.deadline, date: dateStr, ts: Date.now(),
  });
}

/* ------------------------------------------------------------
   Plannerへ渡す集計
   ------------------------------------------------------------ */
export function deriveWeekdayStats(state) {
  const out = {};
  Object.entries(state.stats.weekday).forEach(([wd, v]) => {
    const total = (v.completed || 0) + (v.missed || 0);
    if (total > 0) out[wd] = { completedRatio: v.completed / total, samples: total };
  });
  return out;
}

export function deriveWeekdayPatternStats(state) {
  const out = {};
  Object.entries(state.stats.weekdayPattern).forEach(([key, v]) => {
    const total = (v.completed || 0) + (v.missed || 0);
    if (total > 0) out[key] = { completedRatio: v.completed / total, samples: total };
  });
  return out;
}

export function derivePatternHistory(state) {
  return state.tasks.filter((t) => t.pattern).map((t) => ({ title: t.title, pattern: t.pattern }));
}

/* ------------------------------------------------------------
   書き出し
   ------------------------------------------------------------ */
/** 外部分析用（履歴と統計のみ） */
export function exportHistoryJson(state) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), history: state.history, stats: state.stats }, null, 2);
}

/** 復元用のフルバックアップ。importInto がそのまま読み戻せる形にする。 */
export function exportBackupJson(state) {
  return JSON.stringify({
    temperVersion: 1,
    exportedAt: new Date().toISOString(),
    tasks: state.tasks,
    history: state.history,
    stats: state.stats,
    settings: state.settings,
  }, null, 2);
}
