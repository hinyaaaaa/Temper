/* ============================================================
   forecast.js — タスク状況 → 空の「見通し」（v1.8.0 新設）
   ------------------------------------------------------------
   純粋関数のみ（DOM・保存領域に触れない。憲法6条）。
   空が映すのは「今」ではなく「今日〜3日先までの見通し」。

   設計の要点（v1.9.0 で「晴れすぎて伝わらない」ため全体にゆるめた）:
     ・荒れる条件は「計画が破綻する手前（余裕がほぼ無い）」。
       締切に対し 必要Load累積 ÷ 使える容量累積（Plannerの
       computeDeadlinePressure と同じ考え方）の比を見る。
     ・締切の無いタスクでも、今日の残りと全体の量は空に出る。
       ただし量だけでは雨（小雨あたり）まで。一気に大量登録しても、
       期限が無理でなければずっと嵐にはならない。
     ・近い日ほど重く（今日1.0 / 明日0.8 / 2日先0.6 / 3日先0.45）。
     ・今日の残りLoadをはっきり効かせ、タスクを終えるほど空が
       軽くなる手応えを残す。
   評価語は使わない（憲法7条）。返すのは数値だけ。
   ============================================================ */
import { isTaskPendingOn, computeEffectiveCapacity } from './planner.js';

const DAY_WEIGHTS = [1.0, 0.8, 0.6, 0.45];
const FAR_FLOOR = 0.15;       // 4日先以降の重みの下限
const SPAN_LIMIT = 45;        // 見る日数の上限
const RAMP_FROM = 0.30;       // この比から空が曇り始める（旧0.45）
const RAMP_TO = 1.10;         // この比で最も荒れる（旧1.15）
const TODAY_SOFT_MAX = 0.30;  // 今日の残りLoadが空に与える上限（旧0.12）。今日が丸ごと残っていれば曇り〜厚い曇り
const BACKLOG_SOFT_MAX = 0.30; // 未着手の総量が空に与える上限（旧0.06）。1週間分を大きく超えると雨の気配あたり
const SOFT_CAP = 0.52;        // 量だけで進める上限。大量登録しても「小雨」より先へは進まない（旧0.18）

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const safeLoad = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysUntil(dateStr, todayStr) {
  return Math.round((new Date(dateStr + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / 86400000);
}

/**
 * @param {object} a
 * @param {Array} a.tasks
 * @param {string} a.todayStr 'YYYY-MM-DD'
 * @param {(dateStr:string)=>number} a.capacityForDate 日ごとの容量
 * @param {object|null} [a.weekdayStats]
 * @param {number} [a.alreadyDoneLoad] 今日すでに完了したLoad
 * @param {number} [a.todayPendingLoad] 今日の未完了Load
 * @param {number} [a.todayCapacity] 今日1日の目標容量
 * @returns {{pressure:number, deadline:number, todayLeft:number, backlog:number, worstRatio:number}}
 */
export function computePressure({
  tasks, todayStr, capacityForDate, weekdayStats = null,
  alreadyDoneLoad = 0, todayPendingLoad = 0, todayCapacity = 0,
}) {
  const cap = (dateStr) => Math.max(0, Number(capacityForDate(dateStr)) || 0);

  // ① 締切の窓ごとの逼迫度
  const items = tasks
    .filter((t) => t.type !== 'weekly' && !t.done && t.deadline)
    .map((t) => ({ load: safeLoad(t.load), d: t.deadline < todayStr ? todayStr : t.deadline }));

  let deadline = 0, worstRatio = 0;
  if (items.length) {
    const lastOff = Math.min(SPAN_LIMIT, Math.max(...items.map((it) => daysUntil(it.d, todayStr))));
    const avail = [];
    let acc = 0;
    for (let i = 0; i <= lastOff; i++) {
      const dateStr = addDays(todayStr, i);
      const weekday = new Date(dateStr + 'T00:00:00').getDay();
      const c = computeEffectiveCapacity(cap(dateStr), { weekday, weekdayStats });
      const weeklyLoad = tasks
        .filter((t) => t.type === 'weekly'
          && Array.isArray(t.weekDays) && t.weekDays.includes(weekday)
          && !(t.deadline && dateStr > t.deadline)
          && (i > 0 || isTaskPendingOn(t, dateStr)))
        .reduce((s, t) => s + safeLoad(t.load), 0);
      let budget = Math.max(0, c - weeklyLoad);
      if (i === 0) budget = Math.max(0, budget - Math.max(0, Number(alreadyDoneLoad) || 0));
      acc += budget;
      avail.push(acc);
    }
    const dates = [...new Set(items.map((it) => it.d))].sort();
    dates.forEach((D) => {
      const k = Math.min(SPAN_LIMIT, daysUntil(D, todayStr));
      const required = items.filter((it) => it.d <= D).reduce((s, it) => s + it.load, 0);
      const ratio = required / Math.max(avail[k], 1);
      // 4日先以降も、遠いほどゆるやかに軽くする（0.3 → 下限0.12）
      const w = k < DAY_WEIGHTS.length ? DAY_WEIGHTS[k] : Math.max(FAR_FLOOR, DAY_WEIGHTS[3] * Math.pow(0.9, k - 3));
      worstRatio = Math.max(worstRatio, ratio);
      deadline = Math.max(deadline, w * smooth(RAMP_FROM, RAMP_TO, ratio));
    });
  }

  // ② 今日の残り（終えるほど軽くなる）。締切が無くても、今日の分が丸ごと残っていれば空に出る
  const todayLeft = todayCapacity > 0 ? clamp(todayPendingLoad / todayCapacity, 0, 1.2) : 0;
  const soft1 = TODAY_SOFT_MAX * smooth(0.15, 1.10, todayLeft);

  // ③ 未着手の総量 ÷ 1週間の容量。締切が無いタスクも数える。週次タスクは
  //    終わりのないシリーズなので、この週に回ってくる分だけ量に足す
  const remaining = tasks.filter((t) => t.type !== 'weekly' && !t.done).reduce((s, t) => s + safeLoad(t.load), 0);
  let week = 0, weeklyWeek = 0;
  for (let i = 0; i < 7; i++) {
    const dateStr = addDays(todayStr, i);
    week += cap(dateStr);
    const wd = new Date(dateStr + 'T00:00:00').getDay();
    weeklyWeek += tasks
      .filter((t) => t.type === 'weekly' && Array.isArray(t.weekDays) && t.weekDays.includes(wd)
        && !(t.deadline && dateStr > t.deadline) && (i > 0 || isTaskPendingOn(t, dateStr)))
      .reduce((s, t) => s + safeLoad(t.load), 0);
  }
  const q = week > 0 ? (remaining + weeklyWeek) / week : 0;
  const backlog = BACKLOG_SOFT_MAX * smooth(0.25, 2.2, q);

  // 2つの成分は足さず「どちらかが重ければ重い」形で合わせる（足すと一方だけで上限に張り付く）
  const soft = clamp(1 - (1 - soft1) * (1 - backlog), 0, SOFT_CAP);
  const pressure = clamp(deadline + (1 - deadline) * soft);
  return { pressure, deadline, todayLeft, backlog, worstRatio };
}

/* ------------------------------------------------------------
   逼迫が解けた直後の度合い（雨上がり → 虹 → 晴れ間 → 凪）
   ------------------------------------------------------------
   直近の最大の逼迫(peak)を半減期5時間で薄めながら持ち、現在の
   見通しがそこからどれだけ下がったかを relief として返す。
   memory は呼び出し側（app.js）が保存する小さなオブジェクト。
   ------------------------------------------------------------ */
const PEAK_HALF_LIFE_MS = 5 * 3600 * 1000;

export function updateRelief(memory, pressure, nowMs) {
  const peak0 = memory && Number.isFinite(memory.peak) ? memory.peak : 0;
  const at0 = memory && Number.isFinite(memory.at) ? memory.at : nowMs;
  const decayed = peak0 * Math.pow(0.5, Math.max(0, nowMs - at0) / PEAK_HALF_LIFE_MS);
  const peak = Math.max(decayed, pressure);
  const raw = clamp((peak - pressure - 0.10) / 0.40);
  const relief = raw * (peak >= 0.45 ? 1 : peak / 0.45);
  return { memory: { peak, at: nowMs }, relief };
}
