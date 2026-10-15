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

  const ws = weekday != null && weekdayStats ? weekdayStats[weekday] : null;
  let delta = 0;
  if (ws && ws.samples >= 5) {
    // 完了率が低い曜日は実効容量を下げ、高い曜日はわずかに上げる（急激な変化は避ける）
    delta += Math.max(-CAPACITY_ADJUST_MAX_RATIO, Math.min(CAPACITY_ADJUST_MAX_RATIO, (ws.completedRatio - 0.7) * 0.3)); // 0.7を中立点とする緩やかな傾き
  }
  // v1.10.0: その曜日に実際に終えた負荷が設定容量より多い／少ないなら、それに寄せる（3日以上の実績があるときだけ）。
  // 「追加で生成」を押す人の容量は上がり、いつも余らせる人は下がる。
  if (ws && ws.loadDays >= 3 && Number.isFinite(ws.loadRatio)) {
    delta += Math.max(-0.15, Math.min(0.15, (ws.loadRatio - 1) * 0.25));
  }
  factor += Math.max(-CAPACITY_ADJUST_MAX_RATIO, Math.min(CAPACITY_ADJUST_MAX_RATIO, delta));

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
   時間帯補正（ALGORITHM_IMPROVEMENT_PLAN §1）
   ------------------------------------------------------------
   人間工学・睡眠科学の一般的な知見（一般モデル、§17）:
     - 深い思考を要するPattern（思考・応用・実戦）は覚醒度の高い時間帯
       （多くの人にとって午前〜日中）に取り組みやすい。
     - 暗記系（記憶）は覚醒度への依存が比較的弱く、かつ就寝前に近い
       時間帯は睡眠中の記憶定着と相性が良いとされる。
   これらは万人に当てはまる断定ではなく「初期値として妥当な一般モデル」
   に過ぎないため、値は小さく抑える。ユーザーの自己入力（朝型/夜型の
   申告など）は一切使わない（HANDOFF §14）。時間帯そのものはweather.jsの
   getTimeOfDay()と同じ 'dawn'|'day'|'dusk'|'night' の4区分を再利用し、
   UIと同じ語彙で一貫させる。
   ------------------------------------------------------------ */
const TIME_PATTERN_AFFINITY = {
  dawn: { [PATTERNS.PROBLEM_SOLVING]: 1, [PATTERNS.ADVANCED_PRACTICE]: 0.5 },
  day: {
    [PATTERNS.PROBLEM_SOLVING]: 1.5, [PATTERNS.ADVANCED_PRACTICE]: 1.5,
    [PATTERNS.SIMULATION]: 1.5, [PATTERNS.PRACTICE]: 0.5,
  },
  dusk: { [PATTERNS.REINFORCEMENT]: 0.5, [PATTERNS.PRACTICE]: 0.5 },
  night: { [PATTERNS.MEMORIZATION]: 1.5, [PATTERNS.REINFORCEMENT]: 0.5 },
};

/**
 * 実績（完了した時刻の履歴）から見た、そのPatternとその時間帯の相性。
 * ------------------------------------------------------------
 * 自己申告を使わず、ユーザー自身の完了時刻だけから個人差を学習する
 * （HANDOFF §14: 自己入力を要する機能は実装しない）。
 *
 * lift = 「そのPatternがその時間帯に完了された割合」÷「全タスクがその時間帯に
 * 完了された割合」。1より大きければ、そのPatternは普段その時間帯に進めやすい。
 * 件数が少ないうちは割合が暴れるため、ラプラス平滑化と最小件数
 * （Pattern単位8件・全体20件）で保護し、件数が増えるほど信頼度（weight）を
 * 上げて一般モデルから実績へ重みを移す。
 *
 * 注意: これは「できた時刻」であって「向いている時刻」ではなく、Planner自身が
 * 選んだ時間帯に完了が偏る自己強化の面がある。そのため上限を小さく抑える。
 *
 * @param {{total:object, byPattern:object}|null} stats Store.deriveTimeOfDayPatternStats()の結果
 * @returns {{bonus:number, weight:number}|null} 件数不足ならnull
 */
export function observedTimeAffinity(pattern, timeOfDay, stats) {
  if (!stats || !stats.total || !stats.byPattern || !timeOfDay) return null;
  const p = stats.byPattern[pattern];
  const t = stats.total;
  if (!p || p.all < 8 || t.all < 20) return null;
  const shareP = ((p[timeOfDay] || 0) + 1) / (p.all + 4);
  const shareAll = ((t[timeOfDay] || 0) + 1) / (t.all + 4);
  const lift = shareP / shareAll;
  const bonus = Math.max(-1.5, Math.min(3, (lift - 1) * 2));
  const weight = Math.min(1, p.all / 30);
  return { bonus, weight };
}

/**
 * @param {string} pattern
 * @param {string|null} timeOfDay 'dawn'|'day'|'dusk'|'night'（weather.jsのgetTimeOfDay()と同じ区分）
 * @param {object|null} observedStats 完了時刻の実績。無ければ一般モデルのみ
 * @returns {number} 一般モデルと実績を、実績の件数に応じた重みでブレンドした加点
 */
export function timeOfDayPatternBonus(pattern, timeOfDay, observedStats = null) {
  if (!timeOfDay) return 0;
  const general = (TIME_PATTERN_AFFINITY[timeOfDay] && TIME_PATTERN_AFFINITY[timeOfDay][pattern]) || 0;
  const obs = observedTimeAffinity(pattern, timeOfDay, observedStats);
  if (!obs) return general;
  return general * (1 - obs.weight) + obs.bonus * obs.weight;
}

/* ------------------------------------------------------------
   締切からの逆算による時期の補正（ALGORITHM_IMPROVEMENT_PLAN 受験向け②）
   ------------------------------------------------------------
   締切（試験日など）まで遠い間は記憶・読解を、中盤は定着・演習・思考を、
   近づいたら演習・応用・実戦を、わずかに優先する。締切は登録済みの情報
   なので追加入力は要らない。週次タスクはシリーズの終了日が締切では
   ないため対象外（_daysUntil が Infinity）。値は小さく抑え、締切そのものの
   近さ（deadlineScore）を覆さない。
   ------------------------------------------------------------ */
const PHASE_AFFINITY = {
  early: { [PATTERNS.MEMORIZATION]: 1.5, [PATTERNS.READING]: 1, [PATTERNS.REINFORCEMENT]: 0.5 },
  mid: {
    [PATTERNS.REINFORCEMENT]: 1, [PATTERNS.PRACTICE]: 1,
    [PATTERNS.PROBLEM_SOLVING]: 1, [PATTERNS.WRITING]: 0.5,
  },
  late: {
    [PATTERNS.PRACTICE]: 1.5, [PATTERNS.ADVANCED_PRACTICE]: 1.5,
    [PATTERNS.SIMULATION]: 2, [PATTERNS.WRITING]: 1,
  },
};

/** @returns {'early'|'mid'|'late'|null} 締切までの日数から見た時期。締切なし/当日以降はnull */
export function deadlinePhaseOf(daysUntilDeadline) {
  if (!Number.isFinite(daysUntilDeadline) || daysUntilDeadline < 1) return null;
  if (daysUntilDeadline >= 15) return 'early';
  if (daysUntilDeadline >= 5) return 'mid';
  return 'late';
}

export function deadlinePhaseBonus(pattern, daysUntilDeadline) {
  const phase = deadlinePhaseOf(daysUntilDeadline);
  return phase ? (PHASE_AFFINITY[phase][pattern] || 0) : 0;
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

/* ------------------------------------------------------------
   v1.9.0 の追加定数
   ------------------------------------------------------------ */
const SOON_DAYS = 1;                 // 明日が期限のタスクは今日のおすすめに必ず出す
const SOON_OVERFLOW_RATIO = 0.3;     // 明日期限の前倒しは、容量の+30%まで容量を超えて入れてよい
const PATTERN_SHARE_MAX = 0.5;       // 1日の容量のうち、同じ認知タイプが占めてよい割合
const BOOK_TASKS_MAX = 2;            // 同じ問題集は1日2件まで
const MIN_FILL_RATIO = 0.65;         // 多様性の上限で容量の35%以上が余る場合は、上限をゆるめて埋める
const RECENT_DAYS = 2;               // 直近何日の完了を「最近やったもの」と見るか

/* ------------------------------------------------------------
   「同じ問題集」の近似キー
   ------------------------------------------------------------
   タイトルから数字・ページ・章番号などを落として、本体の名前だけを残す。
   「青チャート 例題12」と「青チャート 例題13」は同じ問題集として扱い、
   よく使われる教材名が含まれていれば、その教材名そのものをキーにする
   （「青チャート 数IA」と「青チャート 数IIB」も同じ問題集）。
   ------------------------------------------------------------ */
const BOOK_HINTS = [
  '青チャート', '黄チャート', '白チャート', '赤チャート', 'フォーカスゴールド', 'focus gold', '1対1対応',
  'ターゲット', 'システム英単語', 'シス単', '鉄壁', '速読英単語', 'ネクステージ', 'next stage', 'vintage',
  '基礎問題精講', '標準問題精講', '過去問', '共通テスト', 'リード', '大学入試',
];
export function bookKeyOf(title) {
  const s = normalizeText(title);
  for (const h of BOOK_HINTS) {
    const hn = normalizeText(h);
    if (s.includes(hn)) return hn;
  }
  const stripped = s
    .replace(/第?[0-9]+(章|節|回|問|課|講|周|週|日目)?/g, '')
    .replace(/(p|pp)\.?\s*[0-9]+/g, '')
    .replace(/[~〜\-ー–—_・,.、。()（）【】\[\]#:：/／]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || s;
}

/** 今日済み／直近RECENT_DAYS日に済んだタスクの、認知タイプ・問題集ごとの件数（Plannerが tasks だけから数える） */
function countFinished(tasks, todayStr, recentDone = null) {
  const out = { today: { patterns: {}, books: {} }, recent: { patterns: {}, books: {} } };
  const recentFrom = addDays(todayStr, -RECENT_DAYS);
  const bump = (bucket, t) => {
    const p = t.pattern || estimatePatternGeneral(t.title, t.description);
    const b = bookKeyOf(t.title);
    bucket.patterns[p] = (bucket.patterns[p] || 0) + 1;
    bucket.books[b] = (bucket.books[b] || 0) + 1;
  };
  // 完了から24時間たった単発タスクは削除されるので、「直近の日」の完了は履歴(recentDone)からも数える。
  // 同じ完了を二重に数えないよう、履歴にある (taskId, 日付) はタスク側では数えない。
  const fromHistory = new Set();
  (Array.isArray(recentDone) ? recentDone : []).forEach((h) => {
    if (!h || !(h.date >= recentFrom && h.date < todayStr)) return;
    if (h.taskId) fromHistory.add(h.taskId + '|' + h.date);
    const p = h.pattern || (h.title ? estimatePatternGeneral(h.title, '') : 'unknown');
    out.recent.patterns[p] = (out.recent.patterns[p] || 0) + 1;
    if (h.title) {
      const b = bookKeyOf(h.title);
      out.recent.books[b] = (out.recent.books[b] || 0) + 1;
    }
  });
  tasks.forEach((t) => {
    if (t.type === 'weekly') {
      (Array.isArray(t.doneDates) ? t.doneDates : []).forEach((d) => {
        if (d === todayStr) bump(out.today, t);
        else if (d >= recentFrom && d < todayStr && !fromHistory.has(t.id + '|' + d)) bump(out.recent, t);
      });
    } else if (t.done && t.doneDate) {
      if (t.doneDate === todayStr) bump(out.today, t);
      else if (t.doneDate >= recentFrom && t.doneDate < todayStr && !fromHistory.has(t.id + '|' + t.doneDate)) bump(out.recent, t);
    }
  });
  return out;
}

/**
 * @param {object} args
 * @param {Array} args.tasks 全タスク（完了/未完了問わず、履歴推定に使う）
 * @param {string} args.todayStr 'YYYY-MM-DD'
 * @param {number} args.baseCapacity ユーザー設定の1日容量
 * @param {object} [args.weekdayStats] Capacity補正用の曜日別実績
 * @param {object} [args.weekdayPatternStats] 曜日×Pattern補正用の実績
 * @param {string|null} [args.timeOfDay] 'dawn'|'day'|'dusk'|'night'。省略時は時間帯補正なし
 * @param {object|null} [args.timeOfDayPatternStats] 完了時刻の実績（Store.deriveTimeOfDayPatternStats）。省略時は一般モデルのみ
 * @param {(dateStr:string)=>number} [args.capacityForDate] 日ごとの容量。渡すと締切への間に合い具合（computeDeadlinePressure）による前倒しが効く。省略時は無効
 * @param {Array} [args.patternHistory] Pattern個人補正用の完了/登録履歴 [{title, pattern}]
 * @param {number} [args.alreadyDoneLoad] 今日すでに完了した分のLoad合計（省略時0）。
 *   今日の残り選定が「まだ使っていない容量」の中で行われるようにするためのもので、
 *   これを渡さないと「完了後にキャパシティを変更すると合計が容量を超えて見える」不具合が起きる。
 * @param {number} [args.capacityBonus] 「追加で生成」で足された、今日だけの上乗せ容量（既定0）
 * @param {string[]|null} [args.pinIds] 今日すでに決めた並び（タスクID）。あれば、その選定と並びを
 *   なるべく保ったまま、足りない分・新しく入ったタスクだけを差し込む（毎回選び直さない）
 * @param {number|null} [args.pinCapacity] pinIdsを保存した時点の今日の容量(totalCapacity)。今の容量がこれより
 *   下がっているときだけ、保存済みの選定を後ろから外す。下がっていなければ、期限が近い・週次などで
 *   新しく入るものがあっても、すでに決めた選定は外さない（コロコロ入れ替えない）
 * @param {boolean} [args.forceExtra] 「追加で生成」用。上乗せ容量に収まらなくても、候補が残っていれば最低1件は追加する
 * @param {boolean} [args.diversity] 認知タイプ・問題集の偏り回避（既定true。検証用に切れる）
 * @param {object|null} [args.learned] Store.deriveLearning()の結果。その人が「やり切れる」認知タイプ・負荷帯の傾向
 * @returns {{
 *   entries: Array<{id, load, pattern, deadline, src, overCapacity:boolean}>,
 *   effectiveCapacity: number,   // まだ使っていない残り予算（上乗せ込み）
 *   fullCapacity: number,        // 曜日補正後の今日1日の目標容量（上乗せを含まない）
 *   totalCapacity: number,       // fullCapacity + capacityBonus（表示の分母）
 *   totalLoad: number,
 *   pinIds: string[],            // 呼び出し側が保存しておく、今日の並び
 *   extraCount: number,          // まだ選ばれていない候補の数（「追加で生成」を出せるか）
 *   reason: object
 * }}
 */
export function buildTodayPlan({
  tasks,
  todayStr,
  baseCapacity,
  weekdayStats = null,
  weekdayPatternStats = null,
  timeOfDay = null,
  timeOfDayPatternStats = null,
  capacityForDate = null,
  patternHistory = [],
  alreadyDoneLoad = 0,
  capacityBonus = 0,
  pinIds = null,
  pinCapacity = null,
  forceExtra = false,
  fixedFullCapacity = null,
  recentDone = null,
  diversity = true,
  learned = null,
}) {
  const weekday = new Date(todayStr + 'T00:00:00').getDay();
  // v1.11.1: 今日の容量(分母)は日中は動かさない。呼び出し側が「今日の最初の計算結果」を
  // fixedFullCapacity として渡す。渡されなければ従来どおり実績から計算する。
  const fullCapacity = Number.isFinite(fixedFullCapacity) && fixedFullCapacity >= 1
    ? Math.round(fixedFullCapacity)
    : computeEffectiveCapacity(baseCapacity, { weekday, weekdayStats });
  const bonus = Number.isFinite(capacityBonus) && capacityBonus > 0 ? Math.round(capacityBonus) : 0;
  const totalCapacity = fullCapacity + bonus;
  // effectiveCapacity: 「まだ使っていない残り予算」。今日すでに完了した分(alreadyDoneLoad)を
  // 差し引いておくことで、これから選ぶ分の合計が、既に完了した分と合わせて今日の容量に
  // きちんと収まるようにする（差し引かないと「16/15」のような表示になる。完了後に
  // キャパシティを変更すると発生した不具合の直接の原因）。
  const doneLoadSafe = Number.isFinite(alreadyDoneLoad) && alreadyDoneLoad > 0 ? alreadyDoneLoad : 0;
  const effectiveCapacity = Math.max(0, totalCapacity - doneLoadSafe);

  const candidates = buildCandidates(tasks, todayStr).map((t) => ({
    ...t,
    _pattern: t.pattern || estimatePattern(t.title, t.description, patternHistory),
    _book: bookKeyOf(t.title),
    _daysUntil: deadlineSortKey(t, todayStr),
  }));

  // 期限あり優先、期限が同じ場合はLoad降順で安定させる（§10: 追加条件による順序安定化）
  candidates.sort((a, b) => {
    if (a._daysUntil !== b._daysUntil) return a._daysUntil - b._daysUntil;
    return safeLoad(b.load) - safeLoad(a.load);
  });

  let usedLoad = 0;
  const entryById = new Map();

  // ① §14: 期限超過・本日期限は容量に関わらず必ず含める。
  //    overCapacityだけは、並びが確定した後（表示順）でまとめて計算し直す。
  const mustInclude = candidates.filter((t) => t._daysUntil <= 0);
  mustInclude.forEach((t) => {
    entryById.set(t.id, toEntry(t, t._daysUntil < 0 ? 'overdue' : 'today_deadline', false));
    usedLoad += safeLoad(t.load);
  });

  // ② 週次タスクは「今日がその曜日で、まだ済んでいない」なら必ず出す。
  //    以前はナップサックの一候補にすぎず、価値が低いため容量が埋まると落ちていた。
  //    終わりのないシリーズなので、期限の強制採用とは別枠で、容量を先に消費する。
  const weeklyTasks = candidates.filter((t) => t.type === 'weekly');
  weeklyTasks.forEach((t) => {
    entryById.set(t.id, toEntry(t, 'weekly', false));
    usedLoad += safeLoad(t.load);
  });

  // 締切への間に合い具合（capacityForDateが渡された時だけ有効）
  const pressureById = capacityForDate
    ? computeDeadlinePressure({ tasks, todayStr, capacityForDate, weekdayStats, alreadyDoneLoad: doneLoadSafe })
    : new Map();

  // 今日・直近に済んだものの偏り（同じ認知タイプ・問題集が続かないように）
  const finished = diversity ? countFinished(tasks, todayStr, recentDone) : null;

  const decided0 = new Set(entryById.keys());
  const undecided = candidates.filter((t) => !decided0.has(t.id));
  const scored = undecided.map((t) => {
    const deadlineScore = t._daysUntil === Infinity ? 0 : Math.max(0, 60 - t._daysUntil * 3);
    const weekdayBonus = weekdayPatternBonus(t._pattern, weekday, weekdayPatternStats);
    const timeBonus = timeOfDayPatternBonus(t._pattern, timeOfDay, timeOfDayPatternStats);
    const phaseBonus = deadlinePhaseBonus(t._pattern, t._daysUntil);
    const pressureBonus = pressureBonusOf(pressureById.get(t.id));
    // 直近2日に同じ問題集・認知タイプをやっていたら、少しだけ後ろへ（期限の近さは覆さない小さな重み）
    let recentPenalty = 0;
    if (finished) {
      recentPenalty += Math.min(8, 3 * (finished.recent.books[t._book] || 0));
      recentPenalty += Math.min(4, 1.2 * (finished.recent.patterns[t._pattern] || 0));
    }
    const followBonus = followBonusOf(t._pattern, learned);
    return {
      task: t, deadlineScore, weekdayBonus, timeBonus, phaseBonus, pressureBonus, followBonus,
      value: Math.max(0.01, deadlineScore + weekdayBonus + timeBonus + phaseBonus + pressureBonus + followBonus - recentPenalty + 1), // +1: 期限なしタスクにも僅かな基礎価値を与える
    };
  });
  const scoreInfoById = new Map(scored.map((s) => [s.task.id, { deadlineScore: s.deadlineScore, weekdayBonus: s.weekdayBonus, timeBonus: s.timeBonus, phaseBonus: s.phaseBonus, pressureBonus: s.pressureBonus, phase: deadlinePhaseOf(s.task._daysUntil) }]));
  const scoredById = new Map(scored.map((s) => [s.task.id, s]));

  // ③ すでに決めてある今日の選定（pinIds）は、そのまま保つ。
  //    タスクを足すたびに全部選び直すと、見慣れた並びがコロコロ入れ替わって落ち着かない。
  //    外れるのは、ユーザーが容量を下げたときだけ（後ろのものから）。期限が近いタスクや
  //    週次が新しく入っても、すでに決めた分は押し出さない。
  const isSoon = (t) => t.type !== 'weekly' && t._daysUntil > 0 && t._daysUntil <= SOON_DAYS;
  const pinnedKept = [];
  if (Array.isArray(pinIds) && pinIds.length) {
    // v1.11.1: 固定した選定でも、今日の残り予算(effectiveCapacity)に収まる分だけを残す。
    // 以前は容量を下げたときだけ絞っていたため、選定外のタスクを完了して消化分が増えても
    // 残りが絞られず、「消化 + 残り」が容量を超えたまま（例: 18 / 15）になっていた。
    // 完了済みの分は alreadyDoneLoad として差し引き済みなので、選定内のタスクを完了しただけでは何も外れない。
    let room = Math.max(0, effectiveCapacity - usedLoad);
    pinIds.forEach((id) => {
      const s = scoredById.get(id);
      if (!s || isSoon(s.task)) return; // 明日期限になったものは次のブロックで必ず入る
      const l = safeLoad(s.task.load);
      if (l <= room) {
        room -= l;
        pinnedKept.push(s.task);
      }
    });
  }
  pinnedKept.forEach((t) => {
    entryById.set(t.id, toEntry(t, 'filled', false, scoreInfoById.get(t.id)));
    usedLoad += safeLoad(t.load);
  });

  // ④ 明日が期限のタスクは、今日のおすすめに必ず出す（容量の+30%までは超えて入れる）。
  //    入れ方は「今日の容量が空いていれば普通に」「満杯でも一定量までは前倒し」。
  //    超える分は、明日以降に「本日期限」として必ず出るのでここでは諦める。
  const soonCands = candidates.filter((t) => isSoon(t));
  // 明日期限は、いま空いている容量に加えて+30%を専用の枠として持つ。さらに、枠に収まらなくても
  // 最初の1件（期限が同じならLoadの大きいもの）は必ず入れる。「入れたのに出てこない」を無くすため。
  const soonBudget = Math.max(0, effectiveCapacity - usedLoad) + Math.ceil(totalCapacity * SOON_OVERFLOW_RATIO);
  let soonLoad = 0;
  const soonPending = [];
  soonCands.forEach((t) => {
    const l = safeLoad(t.load);
    if (soonLoad === 0 || soonLoad + l <= soonBudget) {
      entryById.set(t.id, toEntry(t, 'soon', false));
      usedLoad += l;
      soonLoad += l;
    } else {
      soonPending.push(t);
    }
  });

  // 期限が近いものや週次が後から入ってきても、今日の合計が「容量+30%」を超えない範囲までしか
  // 膨らませない。超える分は、すでに決めた選定のうち一番後ろ（優先度の低い）ものから外す。
  // （強制採用・週次・明日期限そのものは外さない）
  const totalCeiling = effectiveCapacity + Math.ceil(totalCapacity * SOON_OVERFLOW_RATIO);
  for (let i = pinnedKept.length - 1; i >= 0 && usedLoad > totalCeiling; i--) {
    const t = pinnedKept[i];
    entryById.delete(t.id);
    usedLoad -= safeLoad(t.load);
    pinnedKept.splice(i, 1);
  }

  // ⑤ 残り容量を充填（§11〜§13）。認知タイプ・問題集が偏らない範囲で価値を最大化する。
  const pool = scored.filter((s) => !entryById.has(s.task.id));
  const remainingCapacity = Math.max(0, effectiveCapacity - usedLoad);

  // 偏りの上限は「すでに今日の枠に入っているもの＋今日済んだもの」を含めて数える
  const baseCounts = { patterns: {}, books: {}, patternLoad: {} };
  const countInto = (t) => {
    baseCounts.patterns[t._pattern] = (baseCounts.patterns[t._pattern] || 0) + 1;
    baseCounts.patternLoad[t._pattern] = (baseCounts.patternLoad[t._pattern] || 0) + safeLoad(t.load);
    baseCounts.books[t._book] = (baseCounts.books[t._book] || 0) + 1;
  };
  candidates.filter((t) => entryById.has(t.id)).forEach(countInto);
  if (finished) {
    Object.entries(finished.today.patterns).forEach(([p, c]) => { baseCounts.patterns[p] = (baseCounts.patterns[p] || 0) + c; });
    Object.entries(finished.today.books).forEach(([b, c]) => { baseCounts.books[b] = (baseCounts.books[b] || 0) + c; });
  }

  let chosenSet = diversity
    ? selectDiverse(pool, remainingCapacity, baseCounts, totalCapacity, heavyCapOf(learned))
    : knapsackSelect(pool, remainingCapacity);

  // 「追加で生成」: 上乗せ容量に収まる候補が無くても、最低1件は出す
  if (forceExtra && !chosenSet.length && pool.length) {
    const best = [...pool].sort((a, b) => b.value - a.value || safeLoad(a.task.load) - safeLoad(b.task.load))[0];
    chosenSet = [best.task];
  }
  chosenSet.forEach((t) => {
    entryById.set(t.id, toEntry(t, 'filled', false, scoreInfoById.get(t.id)));
    usedLoad += safeLoad(t.load);
  });

  // ⑥ 並び。初回は Pattern連続・Load偏り・同じ問題集の連続を避ける最適化、
  //    2回目以降は前回の並びを保ち、新しく入ったものだけを一番収まりのよい位置へ差し込む。
  const allTasks = candidates.filter((t) => entryById.has(t.id));
  const allIds = new Set(allTasks.map((t) => t.id));
  let ordered;
  const prior = Array.isArray(pinIds) ? pinIds.filter((id) => allIds.has(id)) : [];
  if (prior.length) {
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    ordered = prior.map((id) => byId.get(id));
    const inserted = allTasks.filter((t) => !prior.includes(t.id));
    // 期限が近いもの（強制採用・明日期限）は先頭寄りに、他は隣と相性のよい位置へ
    inserted.sort((a, b) => urgencyRank(a) - urgencyRank(b));
    inserted.forEach((t) => { ordered = insertAtBestPosition(ordered, t); });
  } else {
    ordered = improveOrder(orderToAvoidRuns(allTasks, null));
  }
  const entries = ordered.map((t) => entryById.get(t.id));

  // overCapacityの確定（表示順で見ていったときの強制採用分の累積Loadが
  // effectiveCapacityを超えた時点からtrueにする）。週次・明日期限・充填分は常にfalse。
  let runningForced = 0;
  entries.forEach((e) => {
    if (e.src === 'overdue' || e.src === 'today_deadline') {
      runningForced += e.load;
      e.overCapacity = runningForced > effectiveCapacity;
    }
  });

  const chosenIds = new Set(entries.map((e) => e.id));
  const extraCount = candidates.filter((t) => !chosenIds.has(t.id)).length;

  return {
    entries,
    effectiveCapacity,
    fullCapacity,
    totalCapacity,
    totalLoad: usedLoad,
    pinIds: entries.map((e) => e.id),
    extraCount,
    reason: {
      weekday,
      candidateCount: candidates.length,
      mustIncludeCount: mustInclude.length,
      weeklyCount: weeklyTasks.length,
      soonCount: soonCands.length - soonPending.length,
      capacityOverridden: entries.some((e) => e.overCapacity),
    },
  };
}

/**
 * その人が実際に「その日のうちに終えている」認知タイプを、わずかに優先する（学習した傾向）。
 * 件数が少ないうちは効かせない（6件未満は0、20件で満額）。上限は±2.5と小さく、期限の近さは覆さない。
 */
function followBonusOf(pattern, learned) {
  const f = learned && learned.patternFollow && learned.patternFollow[pattern];
  if (!f || f.n < 6) return 0;
  const weight = Math.min(1, f.n / 20);
  return Math.max(-2.5, Math.min(2.5, (f.ratio - 0.7) * 8)) * weight;
}

/** 重い(負荷7以上)タスクをいつもやり切れない人は、1日1件までにする（実績が十分あるときだけ） */
function heavyCapOf(learned) {
  const h = learned && learned.heavyFollow;
  return h && h.n >= 6 && h.ratio < 0.5 ? 1 : Infinity;
}

function urgencyRank(t) {
  if (t._daysUntil <= 0) return 0;
  if (t.type === 'weekly') return 2;
  if (t._daysUntil <= SOON_DAYS) return 1;
  return 3;
}

/* ------------------------------------------------------------
   並びの「隣り合わせの悪さ」（小さいほどよい）
   ------------------------------------------------------------
   優先順位は 認知タイプの連続（最悪）＞ 同じ問題集の連続 ＞ 近い処理特性 ＞ 高負荷の連続。
   認知タイプの連続は他の何を犠牲にしても増やさない（桁を分けて辞書式に比べる）。
   ------------------------------------------------------------ */
function adjacencyCost(a, b) {
  if (!a || !b) return 0;
  let c = 0;
  if (a._pattern && a._pattern === b._pattern) c += 100000;
  else c += patternAdjacencyPenalty(a._pattern, b._pattern) * 10;
  if (a._book && a._book === b._book) c += 3000;
  c += loadRunPenaltyForValues(safeLoad(a.load), safeLoad(b.load)) * 10;
  return c;
}

function orderCost(list) {
  let c = 0;
  for (let i = 0; i + 1 < list.length; i++) c += adjacencyCost(list[i], list[i + 1]);
  return c;
}

function insertAtBestPosition(list, task) {
  const urgent = urgencyRank(task) <= 1;
  const costAt = (i) => {
    const cand = [...list.slice(0, i), task, ...list.slice(i)];
    // 期限が迫っているものは、相性が同程度なら前へ
    return orderCost(cand) + (urgent ? i * 20 : 0) + (i === 0 ? safeLoad(task.load) * 0.5 : 0);
  };
  let bestIdx = list.length, bestCost = Infinity;
  for (let i = 0; i <= list.length; i++) {
    const c = costAt(i);
    if (c < bestCost) { bestCost = c; bestIdx = i; }
  }
  // 急ぎでないものは、末尾に置いて同じ認知タイプ・問題集が隣り合わないなら末尾へ（既存の並びを動かさない）
  if (!urgent && costAt(list.length) - bestCost < 2500) bestIdx = list.length;
  return [...list.slice(0, bestIdx), task, ...list.slice(bestIdx)];
}

/** 2件の入れ替えで隣り合わせの悪さが減る限り改善する（件数は小さいので総当たりで十分） */
function improveOrder(list) {
  const out = [...list];
  if (out.length < 3) return out;
  let best = orderCost(out);
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        [out[i], out[j]] = [out[j], out[i]];
        const c = orderCost(out);
        if (c < best - 1e-9) { best = c; improved = true; }
        else [out[i], out[j]] = [out[j], out[i]];
      }
    }
    if (!improved) break;
  }
  return out;
}

/**
 * 認知タイプ・問題集が偏らないように、容量内で価値を最大化する。
 * ------------------------------------------------------------
 * 上限: 同じ認知タイプは今日の容量の半分まで（最低1件は可）、同じ問題集は2件まで。
 * 今日すでに済んだ分と、今日の枠にすでに入っている分も数える。
 * 通常のナップサックを解き、上限を超えた分は価値の低い順に除いて解き直す。
 * それでも容量の35%以上が余るなら、一日が空っぽにならないよう上限をゆるめて埋める
 * （「できる限り」避ける、であって、候補が偏っている日に何も出さないことはしない）。
 */
function selectDiverse(pool, capacity, base, totalCapacity, maxHeavy = Infinity) {
  const cap = Math.max(0, Math.floor(capacity));
  if (cap <= 0 || !pool.length) return [];
  const patternLoadMax = Math.max(1, Math.floor(totalCapacity * PATTERN_SHARE_MAX));
  const excluded = new Set();
  let chosen = [];
  for (let iter = 0; iter < 24; iter++) {
    const live = pool.filter((s) => !excluded.has(s.task.id));
    chosen = knapsackSelectScored(live, cap);
    // 上限を超えている集まりを探し、その中で価値の低いものを1件除く
    const byPattern = new Map(), byBook = new Map();
    chosen.forEach((s) => {
      const p = s.task._pattern, b = s.task._book;
      if (!byPattern.has(p)) byPattern.set(p, []);
      byPattern.get(p).push(s);
      if (!byBook.has(b)) byBook.set(b, []);
      byBook.get(b).push(s);
    });
    let victim = null;
    byPattern.forEach((list, p) => {
      const load = (base.patternLoad[p] || 0) + list.reduce((sum, s) => sum + safeLoad(s.task.load), 0);
      const hasOther = (base.patterns[p] || 0) > 0 || list.length > 1;
      if (load > patternLoadMax && hasOther) {
        const v = [...list].sort((a, b) => a.value - b.value)[0];
        if (!victim || v.value < victim.value) victim = v;
      }
    });
    byBook.forEach((list, b) => {
      const n = (base.books[b] || 0) + list.length;
      if (n > BOOK_TASKS_MAX) {
        const v = [...list].sort((a, b2) => a.value - b2.value)[0];
        if (!victim || v.value < victim.value) victim = v;
      }
    });
    if (Number.isFinite(maxHeavy)) {
      const heavy = chosen.filter((x) => safeLoad(x.task.load) >= 7);
      if (heavy.length > maxHeavy) {
        const v = [...heavy].sort((a, b) => a.value - b.value)[0];
        if (!victim || v.value < victim.value) victim = v;
      }
    }
    if (!victim) break;
    excluded.add(victim.task.id);
  }
  const used = chosen.reduce((s, x) => s + safeLoad(x.task.load), 0);
  const left = cap - used;
  if (left >= Math.ceil(cap * (1 - MIN_FILL_RATIO)) && excluded.size) {
    const chosenIds = new Set(chosen.map((s) => s.task.id));
    // 重いタスクを絞る傾向がある人には、ゆるめる段でも重いものは足さない（偏り回避とは別の理由の上限）
    const heavyNow = chosen.filter((x) => safeLoad(x.task.load) >= 7).length;
    const allowHeavy = !Number.isFinite(maxHeavy) || heavyNow < maxHeavy;
    const extraPool = pool.filter((s) => !chosenIds.has(s.task.id) && (allowHeavy || safeLoad(s.task.load) < 7));
    let extra = knapsackSelectScored(extraPool, left);
    if (Number.isFinite(maxHeavy)) {
      let room = Math.max(0, maxHeavy - heavyNow);
      extra = extra.filter((x) => safeLoad(x.task.load) < 7 || (room-- > 0));
    }
    chosen = chosen.concat(extra);
  }
  return chosen.map((s) => s.task);
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
function knapsackSelectScored(scored, capacity) {
  const cap = Math.max(0, Math.floor(capacity));
  if (cap <= 0 || !scored.length) return [];

  // dp[c] = { value, count, items } — 容量cちょうど以下で達成できる最良の組み合わせ
  const dp = new Array(cap + 1).fill(null).map(() => ({ value: 0, count: 0, items: [] }));

  scored.forEach((entry) => {
    const { task, value } = entry;
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
        dp[c] = { value: candidateValue, count: candidateCount, items: [...prev.items, entry] };
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

/** knapsackSelectScored のタスク版（選ばれたタスク本体の配列を返す） */
function knapsackSelect(scored, capacity) {
  return knapsackSelectScored(scored, capacity).map((s) => s.task);
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
    // 最初の1件・最後の1件は、それに加えて「起伏」のタイブレークを足す
    // （ALGORITHM_IMPROVEMENT_PLAN §3: ウォームアップ／クールダウン）。
    // これはPattern連続回避・Load偏り回避という既存の主要な制約を上書き
    // しない程度の小さい重みに留め、あくまで同グループ内の候補が複数
    // あるときの最終的な一押しとしてだけ働かせる。
    const isFirstPick = ordered.length === 0;
    // remaining===1（＝もう1件しか残っていない）時点では選択の余地が
    // そもそも無い（その1件を置くしかない）ため、バイアスをかけても
    // 意味がない。実際に「軽いものを後半に残す」効果を持たせるには、
    // まだ複数の選択肢が残っている終盤（目安として残り3件以内）の
    // 時点から効かせる必要がある。
    const isLastPick = remaining <= 3;
    const group = groups.get(bestKey);
    let pickIdx = 0, pickPenalty = Infinity;
    for (let i = 0; i < group.length; i++) {
      const loadVal = safeLoad(group[i].load);
      let p = loadRunPenaltyForValues(lastLoad, loadVal);
      if (isFirstPick || isLastPick) p += loadVal * 0.5;
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
    timeBonus: scoreInfo ? scoreInfo.timeBonus : null,
    phaseBonus: scoreInfo ? scoreInfo.phaseBonus : null,
    pressureBonus: scoreInfo ? scoreInfo.pressureBonus : null,
    phase: scoreInfo ? scoreInfo.phase : null,
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
 * 締切に対する「間に合い具合」を、自動で測る（受験向け③）。
 * ------------------------------------------------------------
 * 各締切 D について、「D までに終えるべき未完了の単発Load合計」÷
 * 「今日から D までに使える容量（週次の先取り分を除く）」を求め、その比を
 * 締切の窓の逼迫度（ratio）とする。1を超えれば、このままでは窓の中に
 * 収まらない。各タスクの圧力は「自分の締切以降の窓のratioの最大値」。
 * 遅れて未完了の分は自動的に窓に残り続けるため、「やれなかった日」を
 * 咎めることなく、残りの日数と容量から前倒しの強さが組み直される
 * （評価語は使わず、数値だけを返す。憲法7条）。
 *
 * 近似: 解禁日（unlockDate）による着手可能日の制約は考慮しない
 * （考慮しない側＝実際より余裕があると見積もる側に倒れる）。
 *
 * @returns {Map<string, number>} taskId → 圧力ratio（締切を持つ単発の未完了タスクのみ）
 */
export function computeDeadlinePressure({
  tasks,
  todayStr,
  capacityForDate,
  weekdayStats = null,
  alreadyDoneLoad = 0,
  maxHorizonDays = 400,
}) {
  const out = new Map();
  if (typeof capacityForDate !== 'function') return out;
  const items = tasks
    .filter((t) => t.type !== 'weekly' && !t.done && t.deadline)
    .map((t) => {
      let d = t.deadline < todayStr ? todayStr : t.deadline; // 期限超過分は「今日まで」の窓に入れる
      const span = daysUntil(d, todayStr);
      if (!Number.isFinite(span)) return null;
      if (span > maxHorizonDays) d = addDays(todayStr, maxHorizonDays);
      return { id: t.id, load: safeLoad(t.load), d };
    })
    .filter(Boolean);
  if (items.length === 0) return out;

  const lastD = items.reduce((m, it) => (it.d > m ? it.d : m), todayStr);
  const horizon = daysUntil(lastD, todayStr);

  // 日ごとの使える容量の累積（avail[i] = 今日〜今日+i日）
  const avail = [];
  let acc = 0;
  for (let i = 0; i <= horizon; i++) {
    const dateStr = addDays(todayStr, i);
    const weekday = new Date(dateStr + 'T00:00:00').getDay();
    const cap = computeEffectiveCapacity(Math.max(0, Number(capacityForDate(dateStr)) || 0), { weekday, weekdayStats });
    const weeklyLoad = tasks
      .filter((t) => t.type === 'weekly'
        && Array.isArray(t.weekDays) && t.weekDays.includes(weekday)
        && !(t.deadline && dateStr > t.deadline)
        && (i > 0 || isTaskPendingOn(t, dateStr)))
      .reduce((sum, t) => sum + safeLoad(t.load), 0);
    let budget = Math.max(0, cap - weeklyLoad);
    if (i === 0) budget = Math.max(0, budget - (Number(alreadyDoneLoad) > 0 ? Number(alreadyDoneLoad) : 0));
    acc += budget;
    avail.push(acc);
  }

  // 締切の窓ごとのratio（必要Load累積 ÷ 使える容量累積）
  const dates = [...new Set(items.map((it) => it.d))].sort();
  const ratioByDate = new Map();
  dates.forEach((D) => {
    const required = items.filter((it) => it.d <= D).reduce((s, it) => s + it.load, 0);
    const available = avail[daysUntil(D, todayStr)];
    ratioByDate.set(D, required / Math.max(available, 1));
  });

  // 各タスクの圧力 = 自分の締切以降の窓のratioの最大値
  items.forEach((it) => {
    let worst = 0;
    dates.forEach((D) => { if (D >= it.d) worst = Math.max(worst, ratioByDate.get(D)); });
    out.set(it.id, worst);
  });
  return out;
}

/** 圧力ratio → 前倒し加点。0.8未満は0、以降なだらかに増え25で頭打ち。 */
export function pressureBonusOf(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0.8) return 0;
  return Math.min(25, (ratio - 0.8) * 40);
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
 * weekdayBonus / timeBonus（時間帯補正、
 * ALGORITHM_IMPROVEMENT_PLAN §1）の大小を比較し、どちらが決め手
 * だったかで文言を出し分ける。
 */
export function explainSelection(entry) {
  const parts = [];
  if (entry.src === 'overdue') {
    parts.push('期限を過ぎているため');
  } else if (entry.src === 'today_deadline') {
    parts.push('今日が期限のため');
  } else if (entry.src === 'soon') {
    parts.push('明日が期限のため');
  } else if (entry.src === 'weekly') {
    parts.push('毎週この曜日に行うタスクのため');
  } else {
    // 'filled': 実際の価値計算に使った内訳から、決め手になった要因を判定する。
    // 加点が同点の場合は、事実としての切迫度が高い順（期限→間に合い具合→
    // 時期→曜日実績→時間帯）に採用する。
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const deadlineScore = num(entry.deadlineScore);
    const pressureBonus = num(entry.pressureBonus);
    const phaseBonus = num(entry.phaseBonus);
    const weekdayBonus = num(entry.weekdayBonus);
    const timeBonus = num(entry.timeBonus);
    const factors = [
      { v: deadlineScore, text: '期限が近いため' },
      { v: pressureBonus, text: '締切までの残り容量に対して負荷が大きく、前倒しで進める必要があるため' },
      { v: phaseBonus, text: entry.phase === 'late'
        ? '締切が近く、仕上げの段階に向いた学習のため'
        : entry.phase === 'mid'
          ? '締切までの中盤に向いた学習のため'
          : '締切までまだ日数があり、土台づくりに向いた学習のため' },
      { v: weekdayBonus, text: 'この曜日はこの種の学習が続きやすい実績があるため' },
      { v: timeBonus, text: '今の時間帯に向いている学習のため' },
    ];
    let best = null;
    factors.forEach((f) => { if (f.v > 0 && (!best || f.v > best.v)) best = f; });
    parts.push(best ? best.text : '今日の残り容量を活かして無理なく進められるため');
  }
  if (entry.overCapacity) parts.push('容量を超えても今日中に扱う必要があるため');
  return parts.join('、');
}
