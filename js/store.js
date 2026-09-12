/* ============================================================
   store.js — Temper データストア
   ------------------------------------------------------------
   憲法10条: 既存の保存データを破壊しない。TaskEngine/Flowly
   (altair_data キー) の保存形式からの移行処理を提供する。
   全てローカル完結（外部サーバー無し、SUPPLEMENT §27）。
   ============================================================ */

const STORAGE_KEY = 'temper_data_v1';
const LEGACY_KEYS = ['altair_data', 'altair_v2', 'altair_v1'];

const STATE_DEFAULTS = {
  tasks: [],
  // Plannerが記録する履歴（SUPPLEMENT §18）。分析用途のみで、
  // ユーザー評価には使わない。
  history: [],
  settings: {
    dailyCapacity: 6, // SPEC §5: 負荷は1〜10。1日の基準容量もこのスケールに合わせる
    weatherAutoLocation: true,
    manualWeatherCondition: null, // 天候取得失敗時のフォールバック用（憲法11条）
  },
  // 曜日別・曜日×Pattern別の実績統計（SUPPLEMENT §15, §17）。
  // 生の履歴から都度再集計してもよいが、軽量化のため要約を保持する。
  stats: {
    weekday: {},        // { [0-6]: { completed:number, missed:number } }
    weekdayPattern: {},  // { "0:memorization": { completed:number, missed:number } }
  },
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

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

  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.history)) state.history = [];
  state.settings = { ...STATE_DEFAULTS.settings, ...(state.settings || {}) };
  state.stats = { ...deepClone(STATE_DEFAULTS.stats), ...(state.stats || {}) };
  if (!state.stats.weekday) state.stats.weekday = {};
  if (!state.stats.weekdayPattern) state.stats.weekdayPattern = {};

  return state;
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * TaskEngine/Flowly (altair_data) 形式からの移行（憲法10条）。
 * 旧形式のタスク（once/weekly、load 0.5-5刻み）をTemperの形式
 * （load 1-10整数、deadline/unlockDate/patternを持つ単一タスク型）へ
 * できる範囲で変換する。週次タスクは、Temperがまだ繰り返しタスクを
 * 一級概念として持たないため、当面は「タイトルに(毎週)を付けた通常
 * タスク」として一回だけ移行する（データ消失より重複を許容する）。
 */
function migrateLegacy(rawJson) {
  try {
    const legacy = JSON.parse(rawJson);
    if (!legacy || typeof legacy !== 'object') return null;
    const legacyTasks = Array.isArray(legacy.tasks) ? legacy.tasks : [];

    const migratedTasks = legacyTasks.map((t) => ({
      id: t.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      title: t.type === 'weekly' ? `${t.title || ''}（毎週）` : (t.title || ''),
      description: '',
      deadline: t.deadline || null,
      unlockDate: t.unlockDate || null,
      // 旧Loadは0.5刻みの主観値。Temperは1〜10の整数スケール（SPEC §5）のため
      // 単純に2倍して丸め、範囲をクランプする（データを捨てるより粗い変換を優先）。
      load: Math.max(1, Math.min(10, Math.round((t.load || 3) * 2))),
      done: t.type === 'weekly' ? false : !!t.done,
      doneDate: t.doneDate || null,
      pattern: null, // 新規に一般モデルで推定させる
      createdAt: t.createdAt || Date.now(),
    }));

    const migrated = {
      ...deepClone(STATE_DEFAULTS),
      tasks: migratedTasks,
      settings: {
        ...STATE_DEFAULTS.settings,
        dailyCapacity: Math.max(1, Math.min(10, Math.round(((legacy.settings && legacy.settings.capacityWeekday) || 10) / 1.6))),
      },
    };
    return JSON.stringify(migrated);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------
   統計更新（SUPPLEMENT §15, §17, §23: 段階的・緩やかな適応）
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
    taskId: task.id,
    event: 'completed',
    pattern: task.pattern,
    load: task.load,
    deadline: task.deadline,
    date: completedOn,
    ts: Date.now(),
  });
}

export function recordMiss(state, task, dateStr) {
  const weekday = new Date(dateStr + 'T00:00:00').getDay();
  const wd = state.stats.weekday[weekday] || { completed: 0, missed: 0 };
  wd.missed += 1;
  state.stats.weekday[weekday] = wd;

  state.history.push({
    taskId: task.id,
    event: 'missed',
    pattern: task.pattern,
    load: task.load,
    deadline: task.deadline,
    date: dateStr,
    ts: Date.now(),
  });
}

/** weekdayStats/weekdayPatternStats を Planner が期待する completedRatio 形式へ変換する */
export function deriveWeekdayStats(state) {
  const out = {};
  Object.entries(state.stats.weekday).forEach(([wd, v]) => {
    const total = v.completed + v.missed;
    if (total > 0) out[wd] = { completedRatio: v.completed / total, samples: total };
  });
  return out;
}

export function deriveWeekdayPatternStats(state) {
  const out = {};
  Object.entries(state.stats.weekdayPattern).forEach(([key, v]) => {
    const total = v.completed + v.missed;
    if (total > 0) out[key] = { completedRatio: v.completed / total, samples: total };
  });
  return out;
}

/** Pattern個人補正用の履歴（SUPPLEMENT §6）。タイトルとPatternの組だけを渡す軽量版。 */
export function derivePatternHistory(state) {
  return state.tasks
    .filter((t) => t.pattern)
    .map((t) => ({ title: t.title, pattern: t.pattern }));
}

/** 履歴のJSONエクスポート（SUPPLEMENT §26: 外部分析用、本体には分析機能を持たない） */
export function exportHistoryJson(state) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), history: state.history, stats: state.stats }, null, 2);
}
