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
 * @param {number} [args.alreadyDoneLoad] 今日すでに完了した分のLoad合計（省略時0）。
 *   今日の残り選定が「まだ使っていない容量」の中で行われるようにするための
 *   もので、これを渡さないと「完了後にキャパシティを変更すると合計が容量を
 *   超えて見える」不具合が起きる（詳しくはbuildTodayPlan本体のコメント参照）。
 * @returns {{
 *   entries: Array<{id, load, pattern, deadline, src, overCapacity:boolean}>,
 *   effectiveCapacity: number,
 *   fullCapacity: number,
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
  alreadyDoneLoad = 0,
}) {
  const weekday = new Date(todayStr + 'T00:00:00').getDay();
  // fullCapacity: 曜日補正等を経た「今日1日の目標容量」。表示上の分母は
  // これを使う（完了済みの分を差し引く前の、1日を通じての目標値）。
  const fullCapacity = computeEffectiveCapacity(baseCapacity, { weekday, weekdayStats });
  // effectiveCapacity: 「まだ使っていない残り予算」。今日すでに完了した分
  // (alreadyDoneLoad)をfullCapacityから差し引いておくことで、これから
  // 選ぶ（強制採用+充填）タスクの合計が、既に完了した分と合わせて
  // fullCapacityにきちんと収まるようにする。
  //
  // これを差し引かずにfullCapacityそのものを使って毎回選び直すと、
  // 「完了させた分」が考慮されないまま新しい容量いっぱいまで残りタスクが
  // 選ばれてしまい、(doneLoad + 新しく選ばれた分) が 新しい容量を超えて
  // 「16/15」のような一見おかしな表示になる（完了後にキャパシティを
  // 変更すると発生した不具合の直接の原因）。
  const doneLoadSafe = Number.isFinite(alreadyDoneLoad) && alreadyDoneLoad > 0 ? alreadyDoneLoad : 0;
  const effectiveCapacity = Math.max(0, fullCapacity - doneLoadSafe);

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

  let usedLoad = 0;

  // §14: 期限超過・本日期限は容量に関わらず必ず含める
  const mustInclude = candidates.filter((t) => t._daysUntil <= 0);
  const rest = candidates.filter((t) => t._daysUntil > 0);

  // 強制採用分のentryをここで確定する（src は期限の近さで決まるものなので
  // 並べ替えの前に固定してよい）。
  //
  // overCapacityだけは、この時点ではまだ決めない。以前はここで
  // 「mustIncludeの期限順」における累積Loadから判定していたが、
  // ユーザーが実際に目にする並びは後段のorderToAvoidRuns（Pattern連続・
  // Load偏り回避）を経た「表示順」であり、両者は一致するとは限らない
  // （例えば期限順では3番目だったタスクが、Pattern分散のため表示上は
  // 1番目に来ることがある）。overCapacityは「表示順で見ていったとき、
  // どのタスクから容量を超えるか」を表す値であるべきなので、最終的な
  // 表示順が確定した後（ordered確定後）にまとめて計算し直す。
  const forcedEntryById = new Map();
  mustInclude.forEach((t) => {
    const entry = toEntry(t, t._daysUntil < 0 ? 'overdue' : 'today_deadline', false);
    usedLoad += safeLoad(t.load);
    forcedEntryById.set(t.id, entry);
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
  // 使い残しを避ける。
  const scored = rest.map((t) => {
    const deadlineScore = t._daysUntil === Infinity ? 0 : Math.max(0, 60 - t._daysUntil * 3);
    const weekdayBonus = weekdayPatternBonus(t._pattern, weekday, weekdayPatternStats);
    return { task: t, deadlineScore, weekdayBonus, value: Math.max(0.01, deadlineScore + weekdayBonus + 1) }; // +1: 期限なしタスクにも僅かな基礎価値を与える
  });
  // 選定理由の説明（explainSelection）が実際の判断根拠を正確に言い表せる
  // よう、taskごとのdeadlineScore/weekdayBonusを引けるようにしておく。
  // knapsackSelect自体はtask本体しか返さないため、このMapを経由する。
  const scoreInfoById = new Map(scored.map((s) => [s.task.id, { deadlineScore: s.deadlineScore, weekdayBonus: s.weekdayBonus }]));

  const remainingCapacity = Math.max(0, effectiveCapacity - usedLoad);
  const chosenSet = knapsackSelect(scored, remainingCapacity);

  const filledEntryById = new Map();
  chosenSet.forEach((t) => {
    // 週次タスクは「期限が近いから」ではなく「今日がその曜日だから」
    // 選ばれているため、詳細画面の理由もそれに合わせて区別する。
    filledEntryById.set(t.id, toEntry(t, t.type === 'weekly' ? 'weekly' : 'filled', false, scoreInfoById.get(t.id)));
    usedLoad += safeLoad(t.load);
  });

  // 確定した組み合わせ（強制採用分＋充填分）の「並び」を、Pattern連続・
  // Load偏りを避けるように最適化する（§12, §13）。
  //
  // 以前は充填分（chosenSet）だけを並べ替えの対象にしており、強制採用分
  // （mustInclude）同士や、強制採用分と充填分の継ぎ目でのPattern連続は
  // 一切調整されていなかった。強制採用は「必ず含める」という選択の話で
  // あり、並びの最適化とは独立した問題（§12, §13の分離の考え方そのもの）
  // なので、強制採用分も含めた全体を並べ替え対象にする。含めるかどうか
  // （どのタスクが選ばれるか）はここでは一切変えていない。
  const combinedForOrdering = [...mustInclude, ...chosenSet];
  const ordered = orderToAvoidRuns(combinedForOrdering, null);
  const entries = ordered.map((t) => forcedEntryById.get(t.id) || filledEntryById.get(t.id));

  // overCapacityの確定（表示順で見ていったときの強制採用分の累積Loadが
  // effectiveCapacityを超えた時点からtrueにする。上のコメント参照）。
  // 充填分(filled/weekly)は常にfalseのまま（元々effectiveCapacity内に
  // 収まるよう選ばれているため）。
  let runningForced = 0;
  entries.forEach((e) => {
    if (e.src === 'overdue' || e.src === 'today_deadline') {
      runningForced += e.load;
      e.overCapacity = runningForced > effectiveCapacity;
    }
  });

  return {
    entries,
    effectiveCapacity,
    fullCapacity,
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
 * 選ばれたタスク集合を、同じPatternが隣り合わないように並べ替える。
 * ------------------------------------------------------------
 * 「直前と最も相性の良いものを毎回選ぶ」という単純な貪欲法（旧実装）は、
 * 理論上は回避可能な組み合わせでも同じPatternの隣接を作ってしまうことが
 * シミュレーションで確認された（最頻出Patternの件数がceil(全体件数/2)
 * 以下＝理論上回避可能、のケースの約14%で隣接が発生していた）。
 * 原因は、各ステップで「その場しのぎの最善」しか見ておらず、数の多い
 * Patternを消化し忘れて終盤に同じPatternしか残らない状況を作りやすい
 * ことにあった。
 *
 * 代わりに「残っている中で最も件数が多いPattern（直前と異なるものに限る）
 * を毎回選ぶ」という戦略を使う。これは「同じ要素が隣り合わない並べ替え」
 * 問題（reorganize string）の標準的な正解手順で、理論的に回避可能な
 * ケースでは必ず隣接ゼロの並びを見つけられる。件数が同点の場合や、
 * 同じPattern内でどの1件を先に出すかは、既存のペナルティ関数
 * （近い処理特性・高負荷の連続を避ける、§12, §13）で決める。
 */
function orderToAvoidRuns(tasks, initialLastPattern) {
  const NONE = '__none__';
  const groups = new Map();
  for (const t of tasks) {
    const key = t._pattern || NONE;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const ordered = [];
  let lastPattern = initialLastPattern;
  let lastLoad = null;
  let remaining = tasks.length;

  while (remaining > 0) {
    const nonEmptyKeys = [...groups.keys()].filter((k) => groups.get(k).length > 0);
    if (!nonEmptyKeys.length) break;

    // 直前と異なるPatternのグループを優先する。それしか残っていない場合
    // （＝本当に回避不能な場合）のみ、やむを得ず同じPatternを選ぶ。
    let pool = nonEmptyKeys.filter((k) => k !== lastPattern);
    if (!pool.length) pool = nonEmptyKeys;

    // 件数が最も多いグループを優先し（reorganize stringの定石。数の多い
    // Patternを後回しにすると終盤で手詰まりになりやすい）、同数の場合は
    // 相性ペナルティ（近い処理特性・高負荷連続）が小さい方を選ぶ。
    let bestKey = null, bestCount = -1, bestPenalty = Infinity;
    for (const k of pool) {
      const group = groups.get(k);
      const penalty = patternAdjacencyPenalty(lastPattern, k === NONE ? null : k) + loadRunPenaltyForValues(lastLoad, safeLoad(group[0].load));
      if (group.length > bestCount || (group.length === bestCount && penalty < bestPenalty)) {
        bestKey = k; bestCount = group.length; bestPenalty = penalty;
      }
    }

    // 選ばれたグループ内では、直前のLoadと相性の良い（loadRunPenaltyが
    // 小さい）ものを優先して取り出す（同一Pattern内でのLoad偏り回避）。
    const group = groups.get(bestKey);
    let pickIdx = 0, pickPenalty = Infinity;
    for (let i = 0; i < group.length; i++) {
      const p = loadRunPenaltyForValues(lastLoad, safeLoad(group[i].load));
      if (p < pickPenalty) { pickPenalty = p; pickIdx = i; }
    }
    const chosen = group.splice(pickIdx, 1)[0];

    ordered.push(chosen);
    lastPattern = chosen._pattern;
    lastLoad = safeLoad(chosen.load);
    remaining--;
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

function toEntry(task, src, overCapacity, scoreInfo) {
  return {
    id: task.id,
    load: safeLoad(task.load),
    pattern: task._pattern,
    deadline: task.deadline || null,
    src, // 'overdue' | 'today_deadline' | 'weekly' | 'filled'
    overCapacity: !!overCapacity,
    // 'filled'のみ持つ、選定理由の説明用の内部情報（§5, §11, §17）。
    // 実際にナップサックの価値計算で使った値をそのまま持たせることで、
    // explainSelection()が「本当の決め手」と食い違わないようにする。
    deadlineScore: scoreInfo ? scoreInfo.deadlineScore : null,
    weekdayBonus: scoreInfo ? scoreInfo.weekdayBonus : null,
  };
}

/* ------------------------------------------------------------
   選定理由の説明（§5, §11, §17）
   ------------------------------------------------------------
   UIの詳細画面が「なぜ今日選ばれたか」を表示するための、人間が読める
   短い理由文を組み立てる。常時表示はしない（長押しで確認する設計、
   SPEC §11, §17）。
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   全タスク完了目安（進捗カードに小さく添える日付の見積もり）
   ------------------------------------------------------------
   以前は「今日の残り負荷 × 15分」で今日中の終了“時刻”を出していたが、
   これは今日のタスクしか見ていなかった。ここでは発想を変え、
   「今登録されている全ての単発(once)タスクを、この先の容量ペースで
   このまま消化していくと、計算上いつ終わるか」という“日付”を出す。

   週次(weekly)タスクは終わりのないシリーズなので「完了日」の対象には
   含めない（§4, HANDOFF §1）が、毎回その曜日の容量を消費する存在
   なので、単発タスクに残せる1日あたりの予算を計算するときにはきちんと
   差し引く（そうしないと、週次タスクの分まで単発タスクに割り振って
   しまい、見積もりが楽観的になりすぎる）。

   タスクごとの正確な所要時間・優先順位までは追わない、あくまで
   「総負荷 ÷ 日々の実質容量」の粗い目安（憲法7条: 評価的な意味づけは
   しない、SPEC の目安表示と同じ位置づけ）。
   ------------------------------------------------------------ */

/** @param {string} dateStr, @param {number} n days to add → 'YYYY-MM-DD' */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * @param {object} args
 * @param {Array} args.tasks 全タスク
 * @param {string} args.todayStr 'YYYY-MM-DD'
 * @param {(dateStr:string)=>number} args.capacityForDate その日の容量を
 *   返す関数（平日/休日・手動上書きの解決はStore側の責務なので、ここは
 *   関数を受け取るだけにして依存しない。憲法6条）
 * @param {number} [args.alreadyDoneLoad] 今日すでに完了した分（今日の
 *   残り予算からだけ差し引く。翌日以降には影響しない）
 * @param {number} [args.maxDays] 無限ループ防止の打ち切り日数
 * @returns {string|null} 完了予定日('YYYY-MM-DD')。単発の残タスクが
 *   無ければ null（呼び出し側は表示自体を隠す）。打ち切り日数を超えて
 *   終わらない場合も null（見積もりようがないため）。
 */
export function estimateAllTasksFinishDate({
  tasks,
  todayStr,
  capacityForDate,
  alreadyDoneLoad = 0,
  maxDays = 3650,
}) {
  let remaining = tasks
    .filter((t) => t.type !== 'weekly' && !t.done)
    .reduce((sum, t) => sum + safeLoad(t.load), 0);
  if (remaining <= 0) return null;

  let dateStr = todayStr;
  for (let i = 0; i < maxDays; i++) {
    const weekday = new Date(dateStr + 'T00:00:00').getDay();
    const capacity = Math.max(0, Number(capacityForDate(dateStr)) || 0);

    // その日、週次タスクが先取りする分（今日はまだ済んでいないもの限定。
    // 翌日以降はまだ発生していないので常に先取りされると見なす）。
    const weeklyLoad = tasks
      .filter((t) => t.type === 'weekly'
        && Array.isArray(t.weekDays) && t.weekDays.includes(weekday)
        && !(t.deadline && dateStr > t.deadline)
        && (i > 0 || isTaskPendingOn(t, dateStr)))
      .reduce((sum, t) => sum + safeLoad(t.load), 0);

    let dayBudget = Math.max(0, capacity - weeklyLoad);
    if (i === 0) dayBudget = Math.max(0, dayBudget - (Number(alreadyDoneLoad) > 0 ? Number(alreadyDoneLoad) : 0));

    remaining -= dayBudget;
    if (remaining <= 0) return dateStr;
    dateStr = addDays(dateStr, 1);
  }
  return null;
}

/**
 * 「今日選ばれた理由」の説明文を組み立てる（§5, §11, §17）。
 * ------------------------------------------------------------
 * 以前は src === 'filled' かつ期限があれば常に「期限が近いため」、
 * 期限が無ければ常に「学習内容の偏りを避けるため」と固定で表示して
 * いたが、これは不正確だった:
 *   - 「学習内容の偏り」を避ける調整（orderToAvoidRuns、Pattern連続・
 *     Load偏りの回避）は、あくまで確定した並び順を最適化するだけで、
 *     どのタスクを選ぶか自体には関与しない（buildTodayPlan内の分離、
 *     §12/§13）。そのため filled タスクの「選ばれた」理由としては
 *     的外れで、実際は曜日別Pattern実績補正（weekdayPatternBonus）や
 *     単なる残り容量の有効活用が決め手になっていることが多かった。
 *   - 期限があっても deadlineScore がほぼ0（20日以上先）の場合、
 *     実際にはweekdayBonusの方が選定に効いていることがあり得るのに
 *     「期限が近いため」と言い切っていた。
 * ここでは実際にナップサックの価値計算に使った deadlineScore /
 * weekdayBonus の大小を比較し、どちらが決め手だったかで文言を出し
 * 分ける。
 */
export function explainSelection(entry) {
  const parts = [];
  if (entry.src === 'overdue') {
    parts.push('期限を過ぎているため');
  } else if (entry.src === 'today_deadline') {
    parts.push('今日が期限のため');
  } else if (entry.src === 'weekly') {
    parts.push('毎週この曜日に行うタスクのため');
  } else {
    // 'filled': 実際の価値計算に使った内訳から、決め手になった要因を判定する。
    const deadlineScore = Number.isFinite(entry.deadlineScore) ? entry.deadlineScore : 0;
    const weekdayBonus = Number.isFinite(entry.weekdayBonus) ? entry.weekdayBonus : 0;
    if (deadlineScore > 0 && deadlineScore >= weekdayBonus) {
      parts.push('期限が近いため');
    } else if (weekdayBonus > 0) {
      parts.push('この曜日はこの種の学習が続きやすい実績があるため');
    } else {
      parts.push('今日の残り容量を活かして無理なく進められるため');
    }
  }
  if (entry.overCapacity) parts.push('容量を超えても今日中に扱う必要があるため');
  return parts.join('、');
}
