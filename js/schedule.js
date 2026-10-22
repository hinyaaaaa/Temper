/* ============================================================
   schedule.js — 明日以降の予定（見通し）の投影（v1.10.0 新設 / v1.12.0 で組み方を変更）
   ------------------------------------------------------------
   純粋関数のみ（DOM・保存領域に触れない。憲法6条）。
   「今日のおすすめを進めたら、明日以降はこうなる」を、1日ずつ順に計算して返す。

   ・今日の分は、いまの今日のおすすめ（未完了）をその日に進める前提で置く。
   ・各日は Planner.buildTodayPlan を、その日付で呼んで作る。固定(pin)はしない。
     追加・完了・容量の変更・学習した傾向の更新があれば、次に呼んだときに最新の状況で組み直す。
   ・v1.12.0: 単発タスクは「置いた日に済ませたもの」として必ず1回だけ置く。
     以前はその人のやり切り率だけ先頭から終えたことにして残りを翌日へ持ち越していたため、
     同じタスクが複数の日付に並び、予定が正確でなかった。持ち越しはやめ、置かれなかった
     タスクは単に後の日の候補に残る。週次は曜日ごとに出る（毎回その日に済ませたもの扱い）。
   ・ユーザーの傾向への寄せと「楽にしない歯止め」は buildTodayPlan の tendencyBonusOf が担う
     （learned を渡すだけ。weekdayPatternStats も同様）。
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

  // 今日の残りは今日のうちに進む（以降の日には出さない）
  placeAll(todayPendingIds.map((id) => byId.get(id)).filter(Boolean), todayStr);

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
    placeAll(plan.entries.map((e) => byId.get(e.id)).filter(Boolean), date);
  }
  return out;
}

/** その日に置いたタスクは、その日に済ませたものとして以降の日から外す（単発の重複を防ぐ） */
function placeAll(list, dateStr) {
  for (const t of list) {
    if (!isTaskPendingOn(t, dateStr)) continue;
    finishOn(t, dateStr);
  }
}
