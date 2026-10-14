/* ============================================================
   schedule.js — 明日以降の予定（見通し）の投影（v1.10.0 新設）
   ------------------------------------------------------------
   純粋関数のみ（DOM・保存領域に触れない。憲法6条）。
   「今日のおすすめを（その人のやり切り傾向どおりに）進めたら、
   明日以降はこうなる」を、1日ずつ順に計算して返す。

   ・今日の分は、いまの今日のおすすめ（未完了）をその日に進める前提で置く。
   ・各日は Planner.buildTodayPlan を、その日付で呼んで作る。
     今日と違い固定(pin)はしない。タスクの追加・完了・容量の変更・
     学習した傾向の更新があれば、次に呼んだときに最新の状況で並びごと計算し直す。
   ・「その日の分を全部終える」とは仮定しない。その人の全体のやり切り率
     （learned.overallFollow、6件以上の実績があるときだけ。無ければ100%）の分だけ
     先頭から終えたものとし、残りは翌日以降へ持ち越す。
   ・日ごとの空の見通し(pressure)も同じ状態から計算する。
   ============================================================ */
import { buildTodayPlan, isTaskPendingOn } from './planner.js';
import { computePressure } from './forecast.js';

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function finishOn(task, dateStr) {
  if (task.type === 'weekly') {
    task.doneDates = Array.isArray(task.doneDates) ? task.doneDates : [];
    if (!task.doneDates.includes(dateStr)) task.doneDates.push(dateStr);
  } else {
    task.done = true;
    task.doneDate = dateStr;
  }
}

/**
 * @param {object} a
 * @param {Array} a.tasks 全タスク（元の配列は変更しない）
 * @param {string} a.todayStr
 * @param {number} [a.days] 何日先まで（既定7）
 * @param {string[]} a.todayPendingIds 今日のおすすめのうち未完了のタスクID（表示順）
 * @param {(dateStr:string)=>number} a.capacityForDate
 * @param {object|null} [a.weekdayStats]
 * @param {object|null} [a.weekdayPatternStats]
 * @param {Array} [a.patternHistory]
 * @param {object|null} [a.learned] Store.deriveLearning()
 * @returns {Array<{date:string, offset:number, plan:object, pressure:number, load:number, capacity:number}>}
 *   offset=1 が明日。pressure は 0..1（forecast.js と同じ尺度）
 */
export function projectDays({
  tasks, todayStr, days = 7, todayPendingIds = [], capacityForDate,
  weekdayStats = null, weekdayPatternStats = null, patternHistory = [], learned = null,
}) {
  const sim = tasks.map((t) => ({ ...t, doneDates: Array.isArray(t.doneDates) ? [...t.doneDates] : [] }));
  const byId = new Map(sim.map((t) => [t.id, t]));
  const overall = learned && learned.overallFollow && learned.overallFollow.n >= 6 ? learned.overallFollow.ratio : 1;
  const followRatio = Math.max(0.4, Math.min(1, overall));

  // 今日の残りは、やり切り率の分だけ今日のうちに進む
  carryOut(todayPendingIds.map((id) => byId.get(id)).filter(Boolean), todayStr, followRatio);

  const out = [];
  for (let i = 1; i <= days; i++) {
    const date = addDays(todayStr, i);
    const cap = Math.max(0, Number(capacityForDate(date)) || 0);
    const plan = buildTodayPlan({
      tasks: sim, todayStr: date, baseCapacity: cap,
      weekdayStats, weekdayPatternStats, capacityForDate, patternHistory, learned,
      // 未来の時刻は分からないので、時間帯補正・完了時刻の学習・固定(pin)は使わない
    });
    const f = computePressure({
      tasks: sim, todayStr: date, capacityForDate, weekdayStats,
      alreadyDoneLoad: 0, todayPendingLoad: plan.totalLoad, todayCapacity: plan.totalCapacity,
    });
    out.push({ date, offset: i, plan, pressure: f.pressure, load: plan.totalLoad, capacity: plan.totalCapacity });
    carryOut(plan.entries.map((e) => byId.get(e.id)).filter(Boolean), date, followRatio);
  }
  return out;
}

/** 表示順に、負荷の合計が ratio 分に達するまでを終えたことにする（残りは持ち越し） */
function carryOut(list, dateStr, ratio) {
  const total = list.reduce((s, t) => s + Math.max(1, Number(t.load) || 1), 0);
  const target = total * ratio;
  let acc = 0;
  for (const t of list) {
    if (!isTaskPendingOn(t, dateStr)) continue;
    // 週次は終えなくても翌週にまた戻るので、ここでは「その日は済んだ」扱いで進める
    if (t.type !== 'weekly' && acc >= target - 1e-9 && ratio < 1) continue;
    finishOn(t, dateStr);
    acc += Math.max(1, Number(t.load) || 1);
  }
}
