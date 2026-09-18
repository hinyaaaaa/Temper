/* ============================================================
   planner.js — Temper Planner（今日のタスク自動選定）
   ------------------------------------------------------------
   SUPPLEMENT_ALGORITHM.md に基づく実装。

   設計原則（§2, §17）:
     最終判断 = 一般モデル + 曜日補正 + 時間帯補正 + Pattern実績補正
                + Load実績補正 + その他の個人補正
   補正は独立した関数として分離し（§29）、初期は一般モデルのみで
   妥当な結果を出す（§17: 一般モデルを基準として個人差を上乗せ）。

   処理順序（§3, §28）:
     候補生成 → 期限順で初期候補取得 → 実効Capacity算出
     → 期限の近いタスクから充填 → Pattern連続性調整
     → Loadの偏り調整 → 曜日・時間帯・個人補正 → 必要な期限タスク確保
     → TodayPlan確定 → 履歴記録

   本ファイルはPlannerロジックのみを持つ（責務分離、憲法6章）。
   UI・天候・ストレージとは分離されており、taskStore由来の
   プレーンオブジェクト配列を受け取り、プレーンオブジェクトを返す。
   ============================================================ */

/* ------------------------------------------------------------
   Pattern定義（§5）— UIには表示しない内部属性
   ------------------------------------------------------------ */
export const PATTERNS = {
  MEMORIZATION:     'memorization',      // 記憶
  REINFORCEMENT:    'reinforcement',     // 定着
  PROBLEM_SOLVING:  'problem_solving',   // 思考
  PRACTICE:         'practice',          // 演習
  READING:          'reading',           // 読解
  WRITING:          'writing',           // 記述
  ADVANCED_PRACTICE:'advanced_practice', // 応用
  SIMULATION:       'simulation',        // 実戦
};

/* ------------------------------------------------------------
   Pattern推定（§6）— ルールベースの一般モデル
   ------------------------------------------------------------
   タイトル・説明のキーワードから推定する。個人履歴からの補正は
   estimatePatternWithHistory() が担う（一般モデルはこの関数のみに
   依存し、履歴が無くても常に妥当な結果を返す）。
   ------------------------------------------------------------ */
const PATTERN_KEYWORDS = {
  [PATTERNS.MEMORIZATION]: ['暗記', '覚える', '単語', '語句', '用語', '年号', '公式', '活用', '一問一答', 'ターゲット', '単語帳'],
  [PATTERNS.REINFORCEMENT]: ['復習', '確認', '解き直し', '基本問題', '確認問題', '反復', 'ワーク'],
  [PATTERNS.PROBLEM_SOLVING]: ['考察', '方針', '発想', '仮説', '原因を考える', '解決策を考える', '探究'],
  [PATTERNS.PRACTICE]: ['問題集', '練習問題', '標準問題', '基本〜標準', '教科書問題'],
  [PATTERNS.READING]: ['読解', '長文', '現代文', '古文', '漢文'],
  [PATTERNS.WRITING]: ['記述', '論述', '英作文', '自由英作文', '小論文', '要約', '説明せよ'],
  [PATTERNS.ADVANCED_PRACTICE]: ['青チャート', 'チャート', '発展', '難問', '初見', '複合問題', 'focus gold', '1対1対応'],
  [PATTERNS.SIMULATION]: ['過去問', '模試', '本番形式', '共通テスト', '入試問題', '制限時間', '1年分', '通し'],
};

// ルールの優先順位（§6の表の並びに準拠、応用/実戦のような強いシグナルを
// 記憶等の弱いシグナルより先に評価したいが、まずはシンプルな線形走査とする。
// 実データで誤判定が確認されたら重み付けを導入する（§29: 段階的実装）。
const PATTERN_PRIORITY = [
  PATTERNS.SIMULATION,
  PATTERNS.ADVANCED_PRACTICE,
  PATTERNS.WRITING,
  PATTERNS.READING,
  PATTERNS.PROBLEM_SOLVING,
  PATTERNS.MEMORIZATION,
  PATTERNS.REINFORCEMENT,
  PATTERNS.PRACTICE,
];

function normalizeText(s) {
  return String(s || '').trim().normalize('NFKC').toLowerCase();
}

/**
 * 一般モデルによるPattern推定（タイトル・説明のみを見る）。
 * @param {string} title
 * @param {string} [description]
 * @returns {string} PATTERNS の値。一致しない場合は演習（最も汎用的な既定）。
 */
export function estimatePatternGeneral(title, description) {
  const text = normalizeText(title) + ' ' + normalizeText(description);
  for (const pattern of PATTERN_PRIORITY) {
    const keywords = PATTERN_KEYWORDS[pattern];
    if (keywords.some((kw) => text.includes(normalizeText(kw)))) return pattern;
  }
  return PATTERNS.PRACTICE;
}

/**
 * 個人履歴を考慮したPattern推定（§6: 「過去に登録・完了された類似タスクの
 * Patternを参照できる構造」「少数の履歴だけで分類を大きく変更しない」）。
 *
 * タイトルの正規化した先頭トークン（＝「タスクの型」の簡易近似）が過去タスクと
 * 一致する場合のみ履歴を参照する。一致件数が少ない場合は一般モデルを優先する
 * （不確実な時にPlannerを複雑化させない、という§6の方針に従う）。
 *
 * @param {string} title
 * @param {string} description
 * @param {Array<{title:string, pattern:string}>} history 過去タスク(完了/登録済み)
 * @param {number} [minSamples=3] 個人補正を信頼し始める最小サンプル数
 */
export function estimatePattern(title, description, history = [], minSamples = 3) {
  const general = estimatePatternGeneral(title, description);
  if (!history.length) return general;

  const key = titleFamilyKey(title);
  if (!key) return general;

  const matches = history.filter((h) => titleFamilyKey(h.title) === key && h.pattern);
  if (matches.length < minSamples) return general;

  // 最頻出のPatternを個人実績として採用する
  const counts = {};
  matches.forEach((m) => { counts[m.pattern] = (counts[m.pattern] || 0) + 1; });
  let best = general, bestCount = 0;
  Object.entries(counts).forEach(([p, c]) => { if (c > bestCount) { best = p; bestCount = c; } });
  return best;
}

/** タイトルから大まかな「タスクの型」を抽出する（類似タスク判定の簡易キー） */
function titleFamilyKey(title) {
  const s = normalizeText(title).replace(/[0-9]+/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const tokens = s.split(/\s+/).filter(Boolean);
  return tokens.slice(0, 2).join(' ');
}

/* ------------------------------------------------------------
   Pattern相性（§12）— 連続回避の一般モデル
   ------------------------------------------------------------
   値は「連続した場合のペナルティ」（大きいほど避けたい）。
   同一Patternは常に高ペナルティ。負荷の高いPattern同士・近い処理
   特性のPattern同士は中〜高、異なる処理へ切り替わる組み合わせは
   低〜ゼロとする（§12「厳密な固定値を最初から大量に設定しない」）。
   ------------------------------------------------------------ */
const HIGH_LOAD_PATTERNS = new Set([PATTERNS.ADVANCED_PRACTICE, PATTERNS.SIMULATION, PATTERNS.WRITING]);
const SAME_FAMILY = {
  // 記憶系同士・演習系同士は近い処理特性として中程度のペナルティを持つ
  [PATTERNS.MEMORIZATION]: new Set([PATTERNS.REINFORCEMENT]),
  [PATTERNS.REINFORCEMENT]: new Set([PATTERNS.MEMORIZATION, PATTERNS.PRACTICE]),
  [PATTERNS.PRACTICE]: new Set([PATTERNS.REINFORCEMENT, PATTERNS.ADVANCED_PRACTICE]),
  [PATTERNS.ADVANCED_PRACTICE]: new Set([PATTERNS.PRACTICE, PATTERNS.SIMULATION]),
};

function patternAdjacencyPenalty(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100; // 同一Pattern連続は原則回避
  if (HIGH_LOAD_PATTERNS.has(a) && HIGH_LOAD_PATTERNS.has(b)) return 55; // 高負荷同士の連続
  if (SAME_FAMILY[a] && SAME_FAMILY[a].has(b)) return 30; // 近い処理特性
  return 0; // 異なる処理への自然な切替は許容
}

/* ------------------------------------------------------------
   Capacity補正（§8）
   ------------------------------------------------------------
   ユーザー設定値を「通常状態で無理なく処理できる量」の基準として扱い、
   曜日・履歴からの補正を加えた実効Capacityを計算する。補正は
   設定値から急激に離れないようクランプする。
   ------------------------------------------------------------ */
const CAPACITY_ADJUST_MAX_RATIO = 0.2; // ユーザー設定値の±20%までしか動かさない

/**
 * @param {number} baseCapacity ユーザー設定の1日基準容量
 * @param {object} [context]
 * @param {number} [context.weekday] 0(日)〜6(土)
 * @param {object} [context.weekdayStats] { [weekday]: { completedRatio: number, samples: number } }
 */
export function computeEffectiveCapacity(baseCapacity, context = {}) {
  const { weekday, weekdayStats } = context;
  let factor = 1.0;

  if (weekday != null && weekdayStats && weekdayStats[weekday] && weekdayStats[weekday].samples >= 5) {
    const { completedRatio } = weekdayStats[weekday];
    // 完了率が低い曜日は実効容量を下げ、高い曜日はわずかに上げる（急激な変化は避ける）
    const delta = (completedRatio - 0.7) * 0.3; // 0.7を中立点とする緩やかな傾き
    factor += Math.max(-CAPACITY_ADJUST_MAX_RATIO, Math.min(CAPACITY_ADJUST_MAX_RATIO, delta));
  }

  // Loadは整数（SPEC §5）なので、容量も整数に丸める。小数のままだと
  // 画面に「10 / 10.1」のような読みにくい数字が出るうえ、
  // knapsackSelect が結局 floor するため実質の意味も無い。
  return Math.max(1, Math.round(baseCapacity * factor));
}

/* ------------------------------------------------------------
   曜日・時間帯補正（§15）— スコアへの弱い加点/減点
   ------------------------------------------------------------ */
function weekdayPatternBonus(pattern, weekday, weekdayPatternStats) {
  if (!weekdayPatternStats || weekday == null) return 0;
  const stat = weekdayPatternStats[`${weekday}:${pattern}`];
  if (!stat || stat.samples < 5) return 0;
  // 完了率が高い組み合わせほどわずかに優先する
  return (stat.completedRatio - 0.7) * 10;
}

/* ------------------------------------------------------------
   候補生成（§9）
   ------------------------------------------------------------
   §4「繰り返し」に対応する。単発(once)タスクは done フラグで
   一度きりの完了を、週次(weekly)タスクは weekDays（実施する曜日の
   集合）+ doneDates（完了した日付の集合）で「その日はもう済んだか」
   を表す。同じタスクが翌週にはまた候補へ戻ってよいため、単発の
   done とは別の仕組みが要る。
   ------------------------------------------------------------ */

/** @returns {boolean} そのタスクが todayStr の時点で「今日はまだ済んでいない」か */
export function isTaskPendingOn(task, todayStr) {
  if (task.type === 'weekly') {
    return !(Array.isArray(task.doneDates) && task.doneDates.includes(todayStr));
  }
  return !task.done;
}

/**
 * @param {Array} tasks 全タスク
 * @param {string} todayStr 'YYYY-MM-DD'
 * @returns {Array} 候補（解除済み・その日まだ済んでいないもののみ）
 */
export function buildCandidates(tasks, todayStr) {
  const weekday = new Date(todayStr + 'T00:00:00').getDay();
  return tasks.filter((t) => {
    if (t.unlockDate && t.unlockDate > todayStr) return false;
    if (t.type === 'weekly') {
      if (!Array.isArray(t.weekDays) || !t.weekDays.includes(weekday)) return false;
      // 週次タスクの期限は「その日までに1回やる」ではなく「この日以降は
      // もう繰り返さない（シリーズの終了日）」の意味で扱う。
      if (t.deadline && todayStr > t.deadline) return false;
      return isTaskPendingOn(t, todayStr);
    }
    return isTaskPendingOn(t, todayStr);
  });
}

/* ------------------------------------------------------------
   期限による初期選択（§10）
   ------------------------------------------------------------ */

function daysUntil(dateStr, todayStr) {
  const a = new Date(todayStr + 'T00:00:00');
  const b = new Date(dateStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

function deadlineSortKey(task, todayStr) {
  // 週次タスクの期限は「シリーズの終了日」であって「今日中にやる締切」
  // ではないため、§14の強制採用（期限超過・本日期限）の対象にしない。
  if (task.type === 'weekly') return Infinity;
  if (!task.deadline) return Infinity; // 期限なしは最後
  return daysUntil(task.deadline, todayStr);
}

/* ------------------------------------------------------------
   充填式Planner（§11〜§14）
   ------------------------------------------------------------
   期限の近い候補から順に、TodayPlanへ入れられるかを判断しながら
   充填する。Pattern連続・Load偏りによる調整を伴う「並べ替えを伴う
   充填」であり、単純な優先度ソートではない。
   ------------------------------------------------------------ */

const OVERDUE_MUST_INCLUDE = true; // §14: 期限が非常に近いタスクは容量計算だけで除外しない

/**
 * @param {object} args
 * @param {Array} args.tasks 全タスク（完了/未完了問わず、履歴推定に使う）
 * @param {string} args.todayStr 'YYYY-MM-DD'
 * @param {number} args.baseCapacity ユーザー設定の1日容量
 * @param {object} [args.weekdayStats] Capacity補正用の曜日別実績
 * @param {object} [args.weekdayPatternStats] 曜日×Pattern補正用の実績
 * @param {Array} [args.patternHistory] Pattern個人補正用の完了/登録履歴 [{title, pattern}]
 * @returns {{
 *   entries: Array<{id, load, pattern, deadline, src, overCapacity:boolean}>,
 *   effectiveCapacity: number,
 *   totalLoad: number,
 *   reason: object  // デバッグ・履歴用の内部情報（§5, §18）
 * }}
 */
export function buildTodayPlan({
  tasks,
  todayStr,
  baseCapacity,
  weekdayStats = null,
  weekdayPatternStats = null,
  patternHistory = [],
}) {
  const weekday = new Date(todayStr + 'T00:00:00').getDay();
  const effectiveCapacity = computeEffectiveCapacity(baseCapacity, { weekday, weekdayStats });

  const candidates = buildCandidates(tasks, todayStr).map((t) => ({
    ...t,
    _pattern: t.pattern || estimatePattern(t.title, t.description, patternHistory),
    _daysUntil: deadlineSortKey(t, todayStr),
  }));

  // 期限あり優先、期限が同じ場合はLoad降順で安定させる（§10: 追加条件による順序安定化）
  candidates.sort((a, b) => {
    if (a._daysUntil !== b._daysUntil) return a._daysUntil - b._daysUntil;
    return safeLoad(b.load) - safeLoad(a.load);
  });

  const entries = [];
  let usedLoad = 0;
  const included = new Set();

  function lastEntryPattern() {
    if (!entries.length) return null;
    return entries[entries.length - 1]._pattern;
  }

  // §14: 期限超過・本日期限は容量に関わらず必ず含める
  const mustInclude = candidates.filter((t) => t._daysUntil <= 0);
  const rest = candidates.filter((t) => t._daysUntil > 0);

  mustInclude.forEach((t) => {
    entries.push(toEntry(t, t._daysUntil < 0 ? 'overdue' : 'today_deadline', usedLoad + safeLoad(t.load) > effectiveCapacity));
    usedLoad += safeLoad(t.load);
    included.add(t.id);
  });

  // 残り容量への充填（§11〜§13: 優先度そのままではなく、組み合わせを調整する）。
  //
  // 単純な「毎回そのステップのベスト1件を選ぶ」貪欲法は、Loadの大きい
  // タスクが先に選ばれて残り容量を中途半端に使い切り、複数の小さい
  // タスクが同時に入れられたはずの余地を潰してしまう問題がある
  // （例: 容量8に対しLoad5を1件選ぶと、Load2+Load3の2件が入る余地が
  // 残っているのに試されずに終わる）。
  //
  // これを避けるため、まず「基礎スコア」（期限の近さ + 曜日/Pattern補正、
  // Pattern連続・Load偏りのペナルティは含まない静的な値）を各候補に付け、
  // 容量内で基礎スコア合計を最大化する組み合わせを部分和的に探索する
  // （候補数が小さい実用範囲を前提とした軽量なナップサック法）。
  // 同じ達成価値なら「件数が多い組み合わせ」を優先し、無駄な容量の
  // 使い残しを避ける。その後、確定した組み合わせの「並び」だけを
  // Pattern連続・Load偏りを避けるように並べ替える（§12, §13は順序の
  // 問題であり、どれを選ぶかの問題ではないため、この分離で両立できる）。
  const scored = rest.map((t) => {
    const deadlineScore = t._daysUntil === Infinity ? 0 : Math.max(0, 60 - t._daysUntil * 3);
    const weekdayBonus = weekdayPatternBonus(t._pattern, weekday, weekdayPatternStats);
    return { task: t, value: Math.max(0.01, deadlineScore + weekdayBonus + 1) }; // +1: 期限なしタスクにも僅かな基礎価値を与える
  });

  const remainingCapacity = Math.max(0, effectiveCapacity - usedLoad);
  const chosenSet = knapsackSelect(scored, remainingCapacity);

  // Pattern連続・Load偏りを避ける順序へ並べ替えてから確定する（§12, §13）。
  const ordered = orderToAvoidRuns(chosenSet, lastEntryPattern());
  ordered.forEach((t) => {
    // 週次タスクは「期限が近いから」ではなく「今日がその曜日だから」
    // 選ばれているため、詳細画面の理由もそれに合わせて区別する。
    entries.push(toEntry(t, t.type === 'weekly' ? 'weekly' : 'filled', false));
    usedLoad += safeLoad(t.load);
    included.add(t.id);
  });

  return {
    entries,
    effectiveCapacity,
    totalLoad: usedLoad,
    reason: {
      weekday,
      candidateCount: candidates.length,
      mustIncludeCount: mustInclude.length,
      capacityOverridden: entries.some((e) => e.overCapacity),
    },
  };
}

/**
 * 容量制約下で価値合計を最大化する候補の組み合わせを選ぶ（0/1ナップサック）。
 * Loadは整数前提（SPEC §5: 1〜10）のため、動的計画法で厳密解が求まる。
 * 同点の価値では、件数が多い（＝小さいタスクを複数含む）組み合わせを
 * 優先し、容量の使い残しを避ける（§11の「組み合わせを調整する」の実装）。
 *
 * @param {Array<{task:object, value:number}>} scored
 * @param {number} capacity 残り容量（Loadと同じ整数スケール、負なら0扱い）
 * @returns {Array<object>} 選ばれたタスクの配列
 */
function knapsackSelect(scored, capacity) {
  const cap = Math.max(0, Math.floor(capacity));
  if (cap <= 0 || !scored.length) return [];

  // dp[c] = { value, count, items } — 容量cちょうど以下で達成できる最良の組み合わせ
  const dp = new Array(cap + 1).fill(null).map(() => ({ value: 0, count: 0, items: [] }));

  scored.forEach(({ task, value }) => {
    const load = safeLoad(task.load);
    for (let c = cap; c >= load; c--) {
      const prev = dp[c - load];
      const candidateValue = prev.value + value;
      const candidateCount = prev.count + 1;
      const cur = dp[c];
      const better =
        candidateValue > cur.value + 1e-9 ||
        (Math.abs(candidateValue - cur.value) <= 1e-9 && candidateCount > cur.count);
      if (better) {
        dp[c] = { value: candidateValue, count: candidateCount, items: [...prev.items, task] };
      }
    }
  });

  // 容量ちょうど以下の中で最良のものを採用する（dpは各cごとの最良解を独立に
  // 持つため、cap位置が必ずしも全体最良とは限らない小さな取りこぼしを防ぐ）。
  let best = dp[cap];
  for (let c = 0; c <= cap; c++) {
    const cand = dp[c];
    const better =
      cand.value > best.value + 1e-9 ||
      (Math.abs(cand.value - best.value) <= 1e-9 && cand.count > best.count);
    if (better) best = cand;
  }
  return best.items;
}

/**
 * 選ばれたタスク集合を、Pattern連続・Load偏りのペナルティ合計が
 * 小さくなるように並べ替える（貪欲法: 毎ステップ、直前と最も相性の良い
 * ものを選ぶ）。どれを選ぶかは knapsackSelect が既に決めているため、
 * ここでは「並び」だけを最適化する（§12, §13）。
 */
function orderToAvoidRuns(tasks, initialLastPattern) {
  const remaining = tasks.slice();
  const ordered = [];
  let lastPattern = initialLastPattern;
  let lastLoad = null;

  while (remaining.length) {
    let bestIdx = 0;
    let bestPenalty = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i];
      const penalty = patternAdjacencyPenalty(lastPattern, t._pattern) + loadRunPenaltyForValues(lastLoad, safeLoad(t.load));
      if (penalty < bestPenalty) { bestPenalty = penalty; bestIdx = i; }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    ordered.push(chosen);
    lastPattern = chosen._pattern;
    lastLoad = safeLoad(chosen.load);
  }
  return ordered;
}

function loadRunPenaltyForValues(lastLoad, incomingLoad) {
  if (lastLoad == null) return 0;
  if (lastLoad >= 7 && incomingLoad >= 7) return 40;
  if (lastLoad >= 7 && incomingLoad >= 5) return 15;
  return 0;
}

/**
 * タスクのload値を安全な整数(1以上)に丸める。
 * ------------------------------------------------------------
 * 本来はstore.js側のnormalizeTask()でload(1〜10)にクランプ済みの
 * データしか流れてこない想定だが、Plannerは「taskStore由来のプレーン
 * オブジェクト配列を受け取る」（ヘッダコメント）としか契約しておらず、
 * 壊れたローカルストレージ等で不正な値（負・0・NaN・undefined）が
 * 来てもクラッシュしたり負のloadが表示に漏れたりしないよう、ここで
 * 一箇所に統一して防御する。
 *
 * 以前は個々の参照箇所で `task.load || 1` という書き方をしていたが、
 * この書き方は「falsyな値（0/null/undefined/NaN）」しか1に置き換え
 * ないため、**負の値（例: -3）はそのまま素通りする**バグがあった
 * （シミュレーション検証で発見: 壊れたloadを持つタスクのentryに
 * 負のloadが表示され、今日の負荷合計が実際より少なく計算されていた）。
 */
function safeLoad(rawLoad) {
  const n = Math.round(Number(rawLoad));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function toEntry(task, src, overCapacity) {
  return {
    id: task.id,
    load: safeLoad(task.load),
    pattern: task._pattern,
    deadline: task.deadline || null,
    src, // 'overdue' | 'today_deadline' | 'weekly' | 'filled'
    overCapacity: !!overCapacity,
  };
}

/* ------------------------------------------------------------
   選定理由の説明（§5, §11, §17）
   ------------------------------------------------------------
   UIの詳細画面が「なぜ今日選ばれたか」を表示するための、人間が読める
   短い理由文を組み立てる。常時表示はしない（長押しで確認する設計、
   SPEC §11, §17）。
   ------------------------------------------------------------ */
export function explainSelection(entry) {
  const parts = [];
  if (entry.src === 'overdue') parts.push('期限を過ぎているため');
  else if (entry.src === 'today_deadline') parts.push('今日が期限のため');
  else if (entry.src === 'weekly') parts.push('毎週この曜日に行うため');
  else if (entry.deadline) parts.push('期限が近いため');
  else parts.push('学習内容の偏りを避けるため');
  if (entry.overCapacity) parts.push('容量を超えても今日中に扱う必要があるため');
  return parts.join('、');
}
