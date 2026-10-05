// ============================================================
// simulate.mjs — Temperのアルゴリズムをシミュレーションで検証する
// ------------------------------------------------------------
// 実際にリポジトリのplanner.js / store.jsをそのままimportし、
// 大量のランダムな状況を発生させて、期待される不変条件
// （invariant）が常に成り立つかを検査する。
//
// 目的: UIのスクリーンショット確認では気づけない、計算・
// アルゴリズムレベルのバグ（境界値、組み合わせ最適化の破綻、
// 状態遷移の不整合など）を洗い出す。
// ============================================================
import * as Planner from './js/planner.js';
import * as Store from './js/store.js';

// ---------------- 決定的な疑似乱数（再現性のため） ----------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }

const failures = [];
let assertionCount = 0;
function assert(cond, msg, ctx) {
  assertionCount++;
  if (!cond) failures.push({ msg, ctx: ctx ? JSON.stringify(ctx, null, 0).slice(0, 900) : '' });
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysBetween(dateStr, todayStr) {
  const a = new Date(todayStr + 'T00:00:00');
  const b = new Date(dateStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// ============================================================
// PART A — buildTodayPlan の単日ファジング（構造的な不変条件）
// ============================================================
function bruteForceKnapsack(items, capacity) {
  const n = items.length;
  if (n > 18) return null; // 探索コストが高すぎる場合はスキップ
  let best = 0;
  for (let mask = 0; mask < (1 << n); mask++) {
    let load = 0, value = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { load += items[i].load; value += items[i].value; }
    }
    if (load <= capacity && value > best) best = value;
  }
  return best;
}

function makeRandomTask(rng, i, todayStr) {
  const isWeekly = rng() < 0.3;
  const load = randInt(rng, 1, 10);
  let deadline = null, unlockDate = null, weekDays = [], doneDates = [], done = false, doneDate = null;

  if (!isWeekly) {
    const dRoll = rng();
    if (dRoll < 0.2) deadline = addDays(todayStr, -randInt(rng, 1, 10));      // 期限超過
    else if (dRoll < 0.3) deadline = todayStr;                                // 本日期限
    else if (dRoll < 0.6) deadline = addDays(todayStr, randInt(rng, 1, 30));  // 将来
    if (rng() < 0.1) { done = true; doneDate = todayStr; }
  } else {
    const weekday = new Date(todayStr + 'T00:00:00').getDay();
    const days = new Set();
    const count = randInt(rng, 0, 3);
    for (let k = 0; k < count; k++) days.add(randInt(rng, 0, 6));
    if (rng() < 0.5) days.add(weekday); // 今日を含むケースを厚めに
    weekDays = [...days];
    if (rng() < 0.15) doneDates.push(todayStr);
    if (rng() < 0.1) deadline = addDays(todayStr, -randInt(rng, 1, 5)); // シリーズ終了済み
  }
  if (rng() < 0.15) unlockDate = addDays(todayStr, randInt(rng, 1, 10));       // 未解禁
  else if (rng() < 0.1) unlockDate = addDays(todayStr, -randInt(rng, 1, 10));  // 解禁済み

  return {
    id: 't' + i, title: 'タスク' + i, description: '',
    type: isWeekly ? 'weekly' : 'once', load, deadline, unlockDate,
    weekDays, doneDates, done, doneDate, pattern: null, createdAt: Date.now(),
  };
}

function fuzzSingleDay(rng, iterations) {
  for (let iter = 0; iter < iterations; iter++) {
    const todayStr = `2026-${String(randInt(rng, 1, 12)).padStart(2, '0')}-${String(randInt(rng, 1, 28)).padStart(2, '0')}`;
    const capacity = randInt(rng, 1, 30);
    const nTasks = randInt(rng, 0, 14);
    const tasks = [];
    for (let i = 0; i < nTasks; i++) tasks.push(makeRandomTask(rng, i, todayStr));

    const candidates = Planner.buildCandidates(tasks, todayStr);
    const plan = Planner.buildTodayPlan({ tasks, todayStr, baseCapacity: capacity });
    const ctx = { todayStr, capacity, nTasks };

    const candIds = new Set(candidates.map((c) => c.id));
    const seen = new Set();
    for (const e of plan.entries) {
      assert(candIds.has(e.id), '選ばれたタスクが候補集合に無い', { ...ctx, entryId: e.id });
      assert(!seen.has(e.id), '同じタスクが2回選ばれている', { ...ctx, entryId: e.id });
      seen.add(e.id);
    }

    // §14: 期限超過・本日期限の候補は容量に関わらず必ず含まれるべき
    for (const c of candidates) {
      const isForced = c.type !== 'weekly' && c.deadline && daysBetween(c.deadline, todayStr) <= 0;
      if (isForced) {
        assert(seen.has(c.id), '期限超過/本日期限の候補が選ばれていない（§14違反）', { ...ctx, taskId: c.id, deadline: c.deadline });
      }
    }

    // 選ばれたタスクの実体整合性
    for (const e of plan.entries) {
      const t = tasks.find((x) => x.id === e.id);
      assert(!!t, 'entryが存在しないタスクを指している', { ...ctx, entryId: e.id });
      if (!t) continue;
      if (t.type === 'weekly') {
        const weekday = new Date(todayStr + 'T00:00:00').getDay();
        assert(t.weekDays.includes(weekday), '週次タスクが対象外の曜日に選ばれた', { ...ctx, entryId: e.id, weekday, weekDays: t.weekDays });
        assert(!t.doneDates.includes(todayStr), '今日完了済みの週次タスクが再度選ばれた', { ...ctx, entryId: e.id });
      } else {
        assert(!t.done, '完了済みの単発タスクが選ばれた', { ...ctx, entryId: e.id });
      }
      if (t.unlockDate) assert(t.unlockDate <= todayStr, '解禁日前のタスクが選ばれた', { ...ctx, entryId: e.id, unlockDate: t.unlockDate });
    }

    // totalLoad の整合性
    const sumLoad = plan.entries.reduce((s, e) => s + e.load, 0);
    assert(sumLoad === plan.totalLoad, 'totalLoadがentriesの合計と一致しない', { ...ctx, sumLoad, totalLoad: plan.totalLoad });

    // overCapacityフラグの正しさ（強制採用の累積が容量を超えた時点からtrueになるはず）
    let running = 0;
    for (const e of plan.entries) {
      if (e.src === 'overdue' || e.src === 'today_deadline') {
        running += e.load;
        const shouldBeOver = running > plan.effectiveCapacity;
        assert(e.overCapacity === shouldBeOver, 'overCapacityフラグが不正', { ...ctx, entryId: e.id, running, effectiveCapacity: plan.effectiveCapacity, flag: e.overCapacity });
      } else {
        assert(e.overCapacity === false, '充填分のentryにoverCapacityが立っている', { ...ctx, entryId: e.id });
      }
    }

    // 充填分（filled/weekly）が残り容量を超えていないか
    const forcedLoad = plan.entries.filter((e) => e.src === 'overdue' || e.src === 'today_deadline').reduce((s, e) => s + e.load, 0);
    const filledLoad = plan.entries.filter((e) => e.src === 'filled' || e.src === 'weekly').reduce((s, e) => s + e.load, 0);
    const remainingCap = Math.max(0, plan.effectiveCapacity - forcedLoad);
    assert(filledLoad <= remainingCap, '充填分の合計が残り容量を超えている', { ...ctx, filledLoad, remainingCap });

    // ナップサック最適性をブルートフォースと突き合わせる
    const restCandidates = candidates.filter((c) => {
      const forced = c.type !== 'weekly' && c.deadline && daysBetween(c.deadline, todayStr) <= 0;
      return !forced;
    });
    if (restCandidates.length <= 16) {
      const items = restCandidates.map((t) => {
        const du = (t.type === 'weekly' || !t.deadline) ? Infinity : daysBetween(t.deadline, todayStr);
        const deadlineScore = du === Infinity ? 0 : Math.max(0, 60 - du * 3);
        // weekdayBonus=0（統計未指定）、timeBonus=0（timeOfDay未指定）、
        // pressureBonus=0（capacityForDate未指定）。時期補正（締切からの逆算）だけは
        // 常に効くため、Plannerと同じ公開関数で算出して突き合わせる。
        const pattern = t.pattern || Planner.estimatePattern(t.title, t.description, []);
        const value = Math.max(0.01, deadlineScore + Planner.deadlinePhaseBonus(pattern, du) + 1);
        return { load: Math.max(1, Math.round(t.load || 1)), value, id: t.id };
      });
      const bruteBest = bruteForceKnapsack(items, remainingCap);
      if (bruteBest !== null) {
        const chosenIds = new Set(plan.entries.filter((e) => e.src === 'filled' || e.src === 'weekly').map((e) => e.id));
        const chosenValue = items.filter((it) => chosenIds.has(it.id)).reduce((s, it) => s + it.value, 0);
        assert(Math.abs(chosenValue - bruteBest) < 1e-6, 'ナップサック選択が最適でない（容量の使い残しの可能性）', { ...ctx, chosenValue, bruteBest, remainingCap, itemCount: items.length });
      }
    }

    // explainSelectionが常に例外を投げない
    for (const e of plan.entries) {
      try { Planner.explainSelection(e); }
      catch (err) { assert(false, 'explainSelectionが例外を投げた: ' + err.message, { ...ctx, entryId: e.id }); }
    }

    // effectiveCapacityは常に1以上（capacity=0や負のbaseCapacityを渡しても）
    assert(plan.effectiveCapacity >= 1, 'effectiveCapacityが1未満', { ...ctx, effectiveCapacity: plan.effectiveCapacity });
  }
}

// ============================================================
// PART B — 長期シミュレーション（実運用に近い日次進行）
// ------------------------------------------------------------
// 実際に報告されたバグ（完了後にキャパシティを変更すると消化分が
// 消える）の再発を検知するため、app.js の該当ロジックをここでも
// 再現し、毎日ランダムなタイミングでキャパシティ変更を挟む。
// ============================================================
function computeTodayLoadsLikeApp(state, plan, todayStr) {
  const pendingEntries = plan.entries.filter((e) => {
    const t = state.tasks.find((x) => x.id === e.id);
    return !(t && Store.isTaskDoneToday(t, todayStr));
  });
  const doneLoad = state.tasks
    .filter((t) => Store.isTaskDoneToday(t, todayStr))
    .reduce((sum, t) => sum + (t.load || 0), 0);
  const pendingLoad = pendingEntries.reduce((sum, e) => sum + e.load, 0);
  return { doneLoad, pendingLoad, total: doneLoad + pendingLoad, pendingCount: pendingEntries.length };
}

function simulateLongRun(rng, days, taskCount, seedTag) {
  let state = Store.normalizeState({ tasks: [], history: [], settings: {}, stats: {} });
  for (let i = 0; i < taskCount; i++) {
    const isWeekly = rng() < 0.25;
    const raw = {
      id: 's' + i, title: 'シミュタスク' + i, description: '',
      type: isWeekly ? 'weekly' : 'once',
      load: randInt(rng, 1, 10),
      deadline: !isWeekly && rng() < 0.3 ? addDays('2026-01-01', randInt(rng, -5, 60)) : null,
      unlockDate: rng() < 0.1 ? addDays('2026-01-01', randInt(rng, 1, 30)) : null,
      weekDays: isWeekly ? [...new Set(Array.from({ length: randInt(rng, 1, 3) }, () => randInt(rng, 0, 6)))] : [],
      doneDates: [], done: false, doneDate: null, pattern: null, createdAt: Date.now(),
    };
    state.tasks.push(raw);
  }
  state = Store.normalizeState(state);
  state.settings.capacityWeekday = randInt(rng, 4, 16);
  state.settings.capacityHoliday = randInt(rng, 8, 28);

  let today = '2026-01-01';
  let recordedCompletions = 0;
  let recordedUndos = 0;
  let midDayCapacityChangeChecks = 0;

  for (let day = 0; day < days; day++) {
    if (rng() < 0.05) Store.setDayType(state, today, rng() < 0.5 ? 'holiday' : 'weekday');

    let plan = Planner.buildTodayPlan({ tasks: state.tasks, todayStr: today, baseCapacity: Store.getCapacityFor(state, today) });

    // 通常のtoEntryの検証（Part Aと同じ不変条件の一部を長期状態でも確認）
    const seen = new Set();
    for (const e of plan.entries) {
      assert(!seen.has(e.id), `[long-run ${seedTag} day${day}] 同一タスクの重複選出`, { day, entryId: e.id });
      seen.add(e.id);
    }

    // 部分的に完了させる（実際のユーザー挙動を模す）
    const toComplete = plan.entries.filter(() => rng() < 0.7);
    for (const e of toComplete) {
      const t = state.tasks.find((x) => x.id === e.id);
      if (!t) continue;
      if (t.type === 'weekly') {
        if (!t.doneDates.includes(today)) t.doneDates.push(today);
      } else {
        t.done = true; t.doneDate = today;
      }
      Store.recordCompletion(state, t, today);
      recordedCompletions++;

      // 「完了させたがやっぱり取り消す」も一定確率で模す（本依頼の対象）。
      // 直後に取り消すことで、追加した完了記録が確実にhistoryにある
      // 状態から取り消すことになり、undoCompletion()が正しい1件だけを
      // 消せているかを長期ランダム進行の中でも検証できる。
      if (rng() < 0.25) {
        const completionDate = t.type === 'weekly' ? today : (t.doneDate || today);
        if (t.type === 'weekly') {
          t.doneDates = t.doneDates.filter((d) => d !== today);
        } else {
          t.done = false; t.doneDate = null;
        }
        Store.undoCompletion(state, t, completionDate);
        recordedCompletions--; // 打ち消した分はネットの完了数から引く
        recordedUndos++;
      }
    }

    const before = computeTodayLoadsLikeApp(state, plan, today);

    // ランダムにキャパシティを変更（実際に報告されたバグのシナリオ）
    if (rng() < 0.3) {
      midDayCapacityChangeChecks++;
      if (rng() < 0.5) state.settings.capacityWeekday = randInt(rng, 1, 30);
      else state.settings.capacityHoliday = randInt(rng, 1, 30);
      const plan2 = Planner.buildTodayPlan({ tasks: state.tasks, todayStr: today, baseCapacity: Store.getCapacityFor(state, today) });
      const after = computeTodayLoadsLikeApp(state, plan2, today);
      const groundTruthDone = state.tasks.filter((t) => Store.isTaskDoneToday(t, today)).reduce((s, t) => s + (t.load || 0), 0);

      assert(after.doneLoad === groundTruthDone, `[long-run ${seedTag} day${day}] キャパシティ変更後、消化負荷が実際の完了タスク合計と食い違う`, { day, doneLoadAfter: after.doneLoad, groundTruthDone });
      assert(after.doneLoad === before.doneLoad, `[long-run ${seedTag} day${day}] キャパシティ変更で消化負荷が変化した（消失or二重計上のバグ）`, { day, before: before.doneLoad, after: after.doneLoad });

      plan = plan2;
    }

    // 週次タスクのdoneDatesに同日重複が無いか
    for (const t of state.tasks) {
      if (t.type === 'weekly') {
        const count = t.doneDates.filter((d) => d === today).length;
        assert(count <= 1, `[long-run ${seedTag} day${day}] 週次タスクのdoneDatesに同日重複`, { day, taskId: t.id, doneDates: t.doneDates });
      }
    }

    today = addDays(today, 1);
  }

  assert(state.history.length === recordedCompletions, `[long-run ${seedTag}] history件数がネットの完了回数（完了-取り消し）と一致しない`, { historyLen: state.history.length, recordedCompletions, recordedUndos });

  return { state, recordedCompletions, recordedUndos, midDayCapacityChangeChecks };
}

// ============================================================
// PART C — 週次タスクの「翌週また候補に戻る」決定的テスト
// ------------------------------------------------------------
// 確率的な長期シミュレーションだけでは「毎週ちゃんと戻ってくる」ことを
// 保証できないため、容量を潤沢にした専用シナリオで決定的に確認する。
// ============================================================
function testWeeklyRecurrence() {
  let state = Store.normalizeState({
    tasks: [{
      id: 'w1', title: '毎週火曜のタスク', type: 'weekly', weekDays: [2],
      load: 3, deadline: null, unlockDate: null, doneDates: [], done: false, doneDate: null,
    }],
    settings: { capacityWeekday: 20, capacityHoliday: 20 },
  });

  let today = '2026-01-06'; // 2026-01-06は火曜
  assert(new Date(today + 'T00:00:00').getDay() === 2, '[weekly-recurrence] テスト前提の曜日計算がずれている', { today });

  let appearances = 0;
  for (let week = 0; week < 6; week++) {
    const plan = Planner.buildTodayPlan({ tasks: state.tasks, todayStr: today, baseCapacity: 20 });
    const entry = plan.entries.find((e) => e.id === 'w1');
    assert(!!entry, `[weekly-recurrence] 第${week + 1}週の火曜に週次タスクが選ばれていない`, { today });
    if (entry) {
      appearances++;
      // 完了させる
      const t = state.tasks[0];
      t.doneDates.push(today);
      // 同じ日にもう一度プランを作っても再選出されないことを確認
      const plan2 = Planner.buildTodayPlan({ tasks: state.tasks, todayStr: today, baseCapacity: 20 });
      assert(!plan2.entries.some((e) => e.id === 'w1'), '[weekly-recurrence] 同日中に完了済みタスクが再選出された', { today });
    }
    today = addDays(today, 7); // 翌週の同じ曜日
  }
  assert(appearances === 6, '[weekly-recurrence] 6週間のうち毎回選ばれるはずが一部欠けている', { appearances });
}

// ============================================================
// PART D — インポート/サマリーの整合性ファジング
// ------------------------------------------------------------
// summarizeImport()（確認シートに出す予測）と importInto()（実際の
// 反映結果）が食い違うと、ユーザーに見せる確認内容と実際の結果が
// ズレるバグになる。ランダムなTemper形式/TaskNOVA形式データで
// 両者が一致することを検証する。
// ============================================================
function randomTemperExport(rng, n) {
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push({
      id: 'imp' + i, title: 'インポートタスク' + i, description: '',
      type: rng() < 0.2 ? 'weekly' : 'once',
      load: randInt(rng, 1, 10),
      deadline: null, unlockDate: null,
      weekDays: rng() < 0.2 ? [randInt(rng, 0, 6)] : [],
      doneDates: [], done: rng() < 0.3, doneDate: null,
      pattern: null, createdAt: Date.now(),
    });
  }
  return {
    temperVersion: 1, exportedAt: new Date().toISOString(),
    tasks, history: [], stats: { weekday: {}, weekdayPattern: {} },
    settings: { capacityWeekday: randInt(rng, 1, 30), capacityHoliday: randInt(rng, 1, 30), holidayWeekdays: [0, 6], dayTypeOverrides: {} },
  };
}

function randomTaskNovaExport(rng, n) {
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push({
      id: 'nova' + i, title: 'NOVAタスク' + i, load: randInt(rng, 1, 5) * 0.5,
      type: rng() < 0.2 ? 'weekly' : 'normal',
      weekDays: rng() < 0.2 ? [randInt(rng, 0, 6)] : [],
      deadline: null, done: rng() < 0.3,
    });
  }
  return {
    tasks, sessionHistory: [],
    settings: { capacityWeekday: randInt(rng, 1, 16), capacityHoliday: randInt(rng, 1, 16) },
    learningAnalytics: { byWeekday: {} },
  };
}

function fuzzImportConsistency(rng, iterations) {
  for (let iter = 0; iter < iterations; iter++) {
    const isTemper = rng() < 0.5;
    const n = randInt(rng, 0, 10);
    const data = isTemper ? randomTemperExport(rng, n) : randomTaskNovaExport(rng, n);

    // 既存タスクをいくらか用意し、一部がインポートデータとID重複するようにする
    let state = Store.normalizeState({ tasks: [], history: [], settings: {}, stats: {} });
    const existingCount = randInt(rng, 0, 5);
    for (let i = 0; i < existingCount; i++) {
      state.tasks.push({ id: (isTemper ? 'imp' : 'nova') + i, title: '既存' + i, load: 3, type: 'once', weekDays: [], doneDates: [], done: false, doneDate: null, pattern: null, createdAt: Date.now() });
    }
    state = Store.normalizeState(state);

    const summary = Store.summarizeImport(state, data);
    if (!summary) continue; // 形式判定できないケースはスキップ（別途検証）

    const stateCopy = JSON.parse(JSON.stringify(state)); // importIntoが破壊的更新なのでコピーに対して実行
    const before = stateCopy.tasks.length;
    const result = Store.importInto(stateCopy, data);
    const after = stateCopy.tasks.length;

    assert(result.addedTasks === summary.newTasks, 'summarizeImportの予測(newTasks)とimportIntoの実結果(addedTasks)が食い違う', { iter, predicted: summary.newTasks, actual: result.addedTasks, isTemper, n });
    assert(result.skippedTasks === summary.duplicateTasks, 'summarizeImportの予測(duplicateTasks)とimportIntoの実結果(skippedTasks)が食い違う', { iter, predicted: summary.duplicateTasks, actual: result.skippedTasks, isTemper, n });
    assert(after - before === result.addedTasks, 'タスク配列の増分がaddedTasksと一致しない', { iter, before, after, addedTasks: result.addedTasks });

    // 同じデータをもう一度インポートすると、今度は全件スキップになるはず（冪等性）
    const result2 = Store.importInto(stateCopy, data);
    assert(result2.addedTasks === 0, '同一データの再インポートで新規追加が発生した（重複排除の破綻）', { iter, addedTasksOnSecondImport: result2.addedTasks });
  }
}

// ============================================================
// PART E — 境界値・悪意/破損データへの耐性
// ------------------------------------------------------------
// 「ありそうなランダム値」だけでなく、意図的に壊れた・極端な入力を
// 当ててクラッシュや不変条件の破れがないかを確認する。
// ============================================================
function testBoundaryAndAdversarial() {
  const today = '2026-06-15';

  // E1: capacity=0 / 負のcapacityを渡してもeffectiveCapacityは1以上
  for (const cap of [0, -5, -1000]) {
    const plan = Planner.buildTodayPlan({ tasks: [], todayStr: today, baseCapacity: cap });
    assert(plan.effectiveCapacity >= 1, `[boundary] capacity=${cap}でeffectiveCapacityが1未満`, { cap, effectiveCapacity: plan.effectiveCapacity });
  }

  // E2: 非常に大きいcapacity（上限が事実上無いplanner側の挙動を確認）
  {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: 'big' + i, title: 'T' + i, type: 'once', load: 5, deadline: null, unlockDate: null, done: false }));
    const plan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 100000 });
    assert(plan.entries.length === 5, '[boundary] 巨大capacityで全タスクが選ばれない', { count: plan.entries.length });
    assert(plan.totalLoad === 25, '[boundary] 巨大capacityでtotalLoadが不正', { totalLoad: plan.totalLoad });
  }

  // E3: load が NaN / undefined / 0 / 負 のタスクでもクラッシュしない
  {
    const tasks = [
      { id: 'bad1', title: '壊れたload(NaN)', type: 'once', load: NaN, deadline: null, unlockDate: null, done: false },
      { id: 'bad2', title: '壊れたload(undefined)', type: 'once', load: undefined, deadline: null, unlockDate: null, done: false },
      { id: 'bad3', title: '壊れたload(0)', type: 'once', load: 0, deadline: null, unlockDate: null, done: false },
      { id: 'bad4', title: '壊れたload(負)', type: 'once', load: -3, deadline: null, unlockDate: null, done: false },
    ];
    let plan;
    try {
      plan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 10 });
    } catch (err) {
      assert(false, '[boundary] 不正なload値でbuildTodayPlanが例外を投げた', { error: String(err) });
      plan = null;
    }
    if (plan) {
      for (const e of plan.entries) assert(Number.isFinite(e.load) && e.load >= 1, '[boundary] 不正なload値がそのままentryに漏れた', { entryId: e.id, load: e.load });
    }
  }

  // E4: 同一IDのタスクが複数存在する（壊れたデータ）場合の挙動
  {
    const tasks = [
      { id: 'dup', title: '重複1', type: 'once', load: 3, deadline: null, unlockDate: null, done: false },
      { id: 'dup', title: '重複2', type: 'once', load: 4, deadline: null, unlockDate: null, done: false },
    ];
    let plan;
    try {
      plan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 10 });
    } catch (err) {
      assert(false, '[boundary] 重複IDタスクでbuildTodayPlanが例外を投げた', { error: String(err) });
      plan = null;
    }
    // クラッシュしないことが最低条件。件数不定でも許容するが、無限ループ等の兆候（entries異常件数）が無いかだけ見る
    if (plan) assert(plan.entries.length <= tasks.length, '[boundary] 重複IDでentriesがtasks数を超えた', { entriesLen: plan.entries.length });
  }

  // E5: タイトルが空文字・極端に長い・絵文字混じりでもPattern推定が例外を投げない
  {
    const weirdTitles = ['', ' '.repeat(50), '🔥'.repeat(200), 'a'.repeat(5000), null, undefined, '　　　', '<script>alert(1)</script>'];
    for (const title of weirdTitles) {
      try {
        const p = Planner.estimatePattern(title, '', []);
        assert(typeof p === 'string' && p.length > 0, '[boundary] estimatePatternが不正な戻り値', { title: String(title).slice(0, 30), result: p });
      } catch (err) {
        assert(false, '[boundary] estimatePatternが例外を投げた: ' + err.message, { title: String(title).slice(0, 30) });
      }
    }
  }

  // E6: 年またぎ・うるう年の日付境界
  assert(addDays('2026-12-31', 1) === '2027-01-01', '[boundary] 年またぎのaddDaysが不正', { got: addDays('2026-12-31', 1) });
  assert(addDays('2028-02-28', 1) === '2028-02-29', '[boundary] うるう年2028のaddDaysが不正', { got: addDays('2028-02-28', 1) });
  assert(addDays('2026-02-28', 1) === '2026-03-01', '[boundary] 平年2026のaddDaysが不正', { got: addDays('2026-02-28', 1) });
  {
    // うるう年境界をまたぐ週次タスクの選定が壊れないか
    const tasks = [{ id: 'leap', title: 'うるう日またぎ', type: 'weekly', weekDays: [0, 1, 2, 3, 4, 5, 6], load: 2, deadline: null, unlockDate: null, doneDates: [] }];
    for (const d of ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']) {
      let plan;
      try {
        plan = Planner.buildTodayPlan({ tasks, todayStr: d, baseCapacity: 10 });
      } catch (err) {
        assert(false, `[boundary] うるう日境界(${d})でbuildTodayPlanが例外`, { error: String(err) });
        continue;
      }
      assert(plan.entries.some((e) => e.id === 'leap'), `[boundary] うるう日境界(${d})で毎日タスクが選ばれない`, { date: d });
    }
  }

  // E7: タスク配列が空・undefined相当の入力
  {
    const plan = Planner.buildTodayPlan({ tasks: [], todayStr: today, baseCapacity: 10 });
    assert(plan.entries.length === 0 && plan.totalLoad === 0, '[boundary] 空タスク配列で結果が非ゼロ', { plan });
  }

  // E8: 週次タスクでweekDaysが空配列・不正値混入
  {
    const tasks = [
      { id: 'wd1', title: '空曜日', type: 'weekly', weekDays: [], load: 2, deadline: null, unlockDate: null, doneDates: [] },
      { id: 'wd2', title: '不正曜日混入', type: 'weekly', weekDays: [2, 99, -1, 3.5], load: 2, deadline: null, unlockDate: null, doneDates: [] },
    ];
    let cands;
    try {
      cands = Planner.buildCandidates(tasks, '2026-06-16'); // 2026-06-16は火曜(2)
    } catch (err) {
      assert(false, '[boundary] 不正なweekDaysでbuildCandidatesが例外', { error: String(err) });
      cands = [];
    }
    assert(!cands.some((c) => c.id === 'wd1'), '[boundary] 空weekDaysの週次タスクが候補に入った', {});
    // wd2はweekDaysに2(火)を含むので、そのまま.includes(2)判定なら候補に入るのが仕様通りの挙動（壊れた値3.5や99は単に無視される）
  }

  console.log('  境界値・悪意データのテストを実行');
}

// ============================================================
// PART F — 大規模データでの性能と正しさ（スケールしても壊れないか）
// ============================================================
function testScale() {
  const rng = mulberry32(999);
  const today = '2026-06-15';
  const tasks = [];
  for (let i = 0; i < 500; i++) tasks.push(makeRandomTask(rng, i, today));

  const t0 = Date.now();
  const plan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 200 });
  const elapsed = Date.now() - t0;

  const seen = new Set();
  for (const e of plan.entries) {
    assert(!seen.has(e.id), '[scale] 500件規模で重複選出', { entryId: e.id });
    seen.add(e.id);
  }
  const sumLoad = plan.entries.reduce((s, e) => s + e.load, 0);
  assert(sumLoad === plan.totalLoad, '[scale] 500件規模でtotalLoad不整合', { sumLoad, totalLoad: plan.totalLoad });
  assert(sumLoad <= plan.effectiveCapacity || plan.entries.some((e) => e.overCapacity), '[scale] 500件規模で容量超過なのにoverCapacityが一つも立っていない', { sumLoad, effectiveCapacity: plan.effectiveCapacity });
  assert(elapsed < 5000, `[scale] 500件規模の計算が異常に遅い（${elapsed}ms）`, { elapsed });

  console.log(`  タスク500件・容量200での計算: ${elapsed}ms, 選出${plan.entries.length}件, totalLoad=${plan.totalLoad}`);
}

// ============================================================
// PART G — 完了/取り消しの繰り返しでhistoryが積み重ならないか
// ------------------------------------------------------------
// 「完了→取り消し」を繰り返しても、対応するhistoryエントリと統計が
// 都度きちんと打ち消され、蓄積しないことを決定的に確認する。
// app.js の toggleTask と同じ手順（型ごとの完了/取り消し処理 +
// undoCompletion呼び出し）を直接再現する。
// ============================================================
function testCompletionUndoDoesNotAccumulate() {
  const today = '2026-09-17';

  // --- 単発タスク ---
  {
    let state = Store.normalizeState({
      tasks: [{ id: 'a', title: '単発', type: 'once', load: 3, done: false, doneDate: null }],
      history: [], settings: {}, stats: {},
    });
    const t = state.tasks[0];
    for (let i = 0; i < 20; i++) {
      t.done = true; t.doneDate = today;
      Store.recordCompletion(state, t, today);
      Store.undoCompletion(state, t, t.doneDate);
      t.done = false; t.doneDate = null;
    }
    assert(state.history.length === 0, '[undo-accumulate] 単発タスクの完了/取り消し20回後にhistoryが残っている', { historyLen: state.history.length });
    const wd = state.stats.weekday[new Date(today + 'T00:00:00').getDay()];
    assert(!wd || wd.completed === 0, '[undo-accumulate] 単発タスクの完了/取り消し20回後にstatsが残っている', { wd });

    // 最後に取り消さずに残すと1件だけ残るはず
    t.done = true; t.doneDate = today;
    Store.recordCompletion(state, t, today);
    assert(state.history.length === 1, '[undo-accumulate] 取り消さなかった完了がhistoryに残っていない', { historyLen: state.history.length });
  }

  // --- 週次タスク ---
  {
    let state = Store.normalizeState({
      tasks: [{ id: 'b', title: '週次', type: 'weekly', weekDays: [4], load: 2, doneDates: [] }],
      history: [], settings: {}, stats: {},
    });
    const t = state.tasks[0];
    for (let i = 0; i < 20; i++) {
      t.doneDates.push(today);
      Store.recordCompletion(state, t, today);
      Store.undoCompletion(state, t, today);
      t.doneDates = t.doneDates.filter((d) => d !== today);
    }
    assert(state.history.length === 0, '[undo-accumulate] 週次タスクの完了/取り消し20回後にhistoryが残っている', { historyLen: state.history.length });
    assert(t.doneDates.length === 0, '[undo-accumulate] 週次タスクのdoneDatesが取り消し後も残っている', { doneDates: t.doneDates });
  }

  // --- 別の日に完了したタスクをtoggleTask相当の手順で取り消す ---
  // (isTaskComplete/isTaskDoneTodayの使い分けを誤ると、過去日の完了を
  //  「今日改めて完了」として扱ってしまうバグの直接的な回帰テスト)
  {
    const pastDate = '2026-09-10';
    let state = Store.normalizeState({
      tasks: [{ id: 'c', title: '過去に完了', type: 'once', load: 4, done: true, doneDate: pastDate }],
      history: [{ taskId: 'c', event: 'completed', pattern: null, load: 4, deadline: null, date: pastDate, ts: 1 }],
      settings: {}, stats: { weekday: { [new Date(pastDate + 'T00:00:00').getDay()]: { completed: 1, missed: 0 } }, weekdayPattern: {} },
    });
    const t = state.tasks[0];
    // app.js toggleTask と同じ判定: isTaskComplete(過去日完了でも true になるべき)
    const doneNow = Store.isTaskComplete(t, today);
    assert(doneNow === true, '[undo-accumulate] 過去日に完了した単発タスクがisTaskCompleteでfalseと判定された（取り消しでなく再完了扱いになるバグ）', { doneNow });
    // 正しく「取り消し」経路に入った場合の処理
    const completionDate = t.doneDate; // 'today'ではなく実際の完了日を使うべき
    t.done = false; t.doneDate = null;
    Store.undoCompletion(state, t, completionDate);
    assert(state.history.length === 0, '[undo-accumulate] 過去日完了タスクの取り消しでhistoryエントリが残った', { historyLen: state.history.length });
  }

  console.log('  完了/取り消しの繰り返しテストを実行（単発20回・週次20回・過去日完了1件）');
}

// ------------------------------------------------------------
// PART H: ALGORITHM_IMPROVEMENT_PLAN §0/§1/§3 の回帰テスト
// ------------------------------------------------------------
function testErgonomicsFeatures() {
  // --- §0: recordMissedOccurrencesUntilToday ---
  {
    const weekday = new Date('2026-09-10T00:00:00').getDay();
    let state = Store.normalizeState({
      tasks: [{
        id: 'w', title: '週次', type: 'weekly', weekDays: [weekday], load: 2,
        doneDates: [], createdAt: new Date('2026-09-01T00:00:00').getTime(), pattern: 'memorization',
      }],
      history: [], settings: {}, stats: {},
    });
    state.stats.lastMissCheckDate = '2026-09-08';
    Store.recordMissedOccurrencesUntilToday(state, '2026-09-15');
    const wp = state.stats.weekdayPattern[`${weekday}:memorization`];
    assert(wp && wp.missed === 1, '[ergonomics-miss] 対象曜日を未完了のまま通過した週次タスクがmissedとして記録されない', { wp });
    assert(state.stats.lastMissCheckDate === '2026-09-15', '[ergonomics-miss] lastMissCheckDateが今日に更新されない', { d: state.stats.lastMissCheckDate });

    // 冪等性: 同じtodayStrで再度呼んでも増えない
    const before = JSON.stringify(state.stats.weekdayPattern);
    Store.recordMissedOccurrencesUntilToday(state, '2026-09-15');
    assert(JSON.stringify(state.stats.weekdayPattern) === before, '[ergonomics-miss] 同日に2回呼ぶとmissedが重複加算される（冪等性違反）', { after: state.stats.weekdayPattern });

    // 完了済みの日はmissedにならない
    let state2 = Store.normalizeState({
      tasks: [{
        id: 'w2', title: '週次2', type: 'weekly', weekDays: [weekday], load: 2,
        doneDates: ['2026-09-10'], createdAt: new Date('2026-09-01T00:00:00').getTime(), pattern: 'memorization',
      }],
      history: [], settings: {}, stats: {},
    });
    state2.stats.lastMissCheckDate = '2026-09-08';
    Store.recordMissedOccurrencesUntilToday(state2, '2026-09-15');
    assert(!state2.stats.weekdayPattern[`${weekday}:memorization`], '[ergonomics-miss] doneDatesに入っている日がmissed扱いされた', { wp: state2.stats.weekdayPattern });
  }
  {
    // lastMissCheckDateがnull（導入前の既存データ）の場合は過去に遡って
    // ペナルティを課さず、今日を起点に記録を始めるだけ。
    let state = Store.normalizeState({ tasks: [], history: [], settings: {}, stats: {} });
    assert(state.stats.lastMissCheckDate === null, '[ergonomics-miss] 初期状態のlastMissCheckDateがnullでない', { d: state.stats.lastMissCheckDate });
    Store.recordMissedOccurrencesUntilToday(state, '2026-09-15');
    assert(Object.keys(state.stats.weekdayPattern).length === 0, '[ergonomics-miss] 初回呼び出しで過去に遡ってmissedが記録された（既存ユーザーへの不当なペナルティ）', { wp: state.stats.weekdayPattern });
    assert(state.stats.lastMissCheckDate === '2026-09-15', '[ergonomics-miss] 初回呼び出し後にlastMissCheckDateが今日にセットされない', { d: state.stats.lastMissCheckDate });
  }

  // --- §1: 時間帯補正が実際に選定を左右する ---
  {
    const today = '2026-09-27';
    const tasks = [
      { id: 'ps', title: '思考タスク', load: 3, type: 'once', deadline: null, pattern: 'problem_solving' },
      { id: 'mem', title: '暗記タスク', load: 3, type: 'once', deadline: null, pattern: 'memorization' },
    ];
    // 容量3（どちらか1件しか入らない）で、昼は思考系、夜は暗記系が選ばれるべき。
    const dayPlan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 3, timeOfDay: 'day' });
    const nightPlan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 3, timeOfDay: 'night' });
    assert(dayPlan.entries.length === 1 && dayPlan.entries[0].id === 'ps', '[ergonomics-time] 日中に思考系タスクが優先選定されない', { picked: dayPlan.entries.map((e) => e.id) });
    assert(nightPlan.entries.length === 1 && nightPlan.entries[0].id === 'mem', '[ergonomics-time] 夜間に暗記系タスクが優先選定されない', { picked: nightPlan.entries.map((e) => e.id) });
    // timeOfDay省略時は従来通り時間帯補正なし（後方互換）
    const noTimePlan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 3 });
    assert(noTimePlan.entries.length === 1, '[ergonomics-time] timeOfDay省略時にbuildTodayPlanが壊れる', { picked: noTimePlan.entries.map((e) => e.id) });

    // explainSelectionが時間帯要因を説明に反映する
    const reason = Planner.explainSelection(dayPlan.entries[0]);
    assert(typeof reason === 'string' && reason.length > 0, '[ergonomics-time] 時間帯が決め手のentryでexplainSelectionが空文字を返す', { reason });
  }

  // --- §3: セッションの起伏（最初の1件は低Load寄り） ---
  {
    const today = '2026-09-27';
    // 全タスクを同一Patternにして、Pattern連続回避による並べ替えの
    // 影響を排除し、純粋にLoadによるタイブレークだけを見る。
    const tasks = [
      { id: 'heavy1', title: '重い1', load: 6, type: 'once', deadline: null, pattern: 'reading' },
      { id: 'heavy2', title: '重い2', load: 6, type: 'once', deadline: null, pattern: 'reading' },
      { id: 'light', title: '軽い', load: 1, type: 'once', deadline: null, pattern: 'reading' },
    ];
    const plan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 20 });
    assert(plan.entries.length === 3, '[ergonomics-shape] 起伏テスト用タスクが全件選定されない（前提条件が崩れている）', { picked: plan.entries.map((e) => e.id) });
    assert(plan.entries[0].id === 'light', '[ergonomics-shape] 同Pattern内で最初に選ばれるのが最軽量のタスクでない（ウォームアップの意図）', { order: plan.entries.map((e) => e.id) });
  }

  console.log('  recordMissedOccurrencesUntilToday / 時間帯補正 / セッションの起伏 を検証');
}

// ------------------------------------------------------------
// PART I: 受験向け ②締切逆算の時期補正 ③間に合い具合による前倒し
//         ⑤自動バックアップ（純粋ロジック・保存の健全性） ⑥完了時刻の学習
// ------------------------------------------------------------
function testExamFeatures() {
  const today = '2026-10-05';
  const addD = (n) => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // --- ② 時期補正 ---
  assert(Planner.deadlinePhaseOf(30) === 'early' && Planner.deadlinePhaseOf(14) === 'mid' && Planner.deadlinePhaseOf(5) === 'mid' && Planner.deadlinePhaseOf(4) === 'late' && Planner.deadlinePhaseOf(1) === 'late', '[exam-phase] 時期の境界が想定と違う', {});
  assert(Planner.deadlinePhaseOf(0) === null && Planner.deadlinePhaseOf(-3) === null && Planner.deadlinePhaseOf(Infinity) === null, '[exam-phase] 締切なし/当日以降は時期なしになる', {});
  assert(Planner.deadlinePhaseBonus('memorization', 30) > 0 && Planner.deadlinePhaseBonus('simulation', 30) === 0, '[exam-phase] 遠い締切で記憶系が優先されない', {});
  assert(Planner.deadlinePhaseBonus('simulation', 3) > Planner.deadlinePhaseBonus('memorization', 3), '[exam-phase] 近い締切で実戦系が記憶系より優先されない', {});
  {
    // 同じ締切(30日後)・同じLoadの記憶系と実戦系を容量1枠で競わせると、記憶系が選ばれる
    const tasks = [
      { id: 'sim', title: '模試', load: 3, type: 'once', deadline: addD(30), pattern: 'simulation' },
      { id: 'mem', title: '単語', load: 3, type: 'once', deadline: addD(30), pattern: 'memorization' },
    ];
    const plan = Planner.buildTodayPlan({ tasks, todayStr: today, baseCapacity: 3 });
    assert(plan.entries.length === 1 && plan.entries[0].id === 'mem', '[exam-phase] 締切まで遠い時期に記憶系が選ばれない', { picked: plan.entries.map((e) => e.id) });
    assert(/土台/.test(Planner.explainSelection(plan.entries[0])), '[exam-phase] 時期が決め手の選定理由が説明に反映されない', { r: Planner.explainSelection(plan.entries[0]) });
    const tasks2 = tasks.map((t) => ({ ...t, deadline: addD(3) }));
    const plan2 = Planner.buildTodayPlan({ tasks: tasks2, todayStr: today, baseCapacity: 3 });
    assert(plan2.entries.length === 1 && plan2.entries[0].id === 'sim', '[exam-phase] 締切が近い時期に実戦系が選ばれない', { picked: plan2.entries.map((e) => e.id) });
  }

  // --- ③ 間に合い具合 ---
  const capFn = () => 3;
  {
    const heavy = Array.from({ length: 40 }, (_, i) => ({ id: 'f' + i, title: '章' + i, load: 3, type: 'once', deadline: addD(30), pattern: 'reading' }));
    const m = Planner.computeDeadlinePressure({ tasks: heavy, todayStr: today, capacityForDate: capFn });
    assert(m.size === 40 && [...m.values()].every((r) => r > 1.2 && r < 1.4), '[exam-pressure] 容量93に対し必要120の窓のratioが約1.29にならない', { r: [...m.values()][0] });
    const light = heavy.slice(0, 10);
    const m2 = Planner.computeDeadlinePressure({ tasks: light, todayStr: today, capacityForDate: capFn });
    assert([...m2.values()].every((r) => r < 0.8), '[exam-pressure] 余裕のある窓でratioが0.8以上になる', { r: [...m2.values()][0] });
    assert(Planner.pressureBonusOf(0.8) === 0 && Planner.pressureBonusOf(1.0) > 0 && Planner.pressureBonusOf(99) === 25, '[exam-pressure] 加点の下限/上限が想定と違う', {});

    // 逼迫している窓の far-deadline タスクが、期限なしタスクより前倒しで選ばれる
    const n = { id: 'n', title: '期限なし', load: 3, type: 'once', deadline: null, pattern: 'reading' };
    const withPressure = Planner.buildTodayPlan({ tasks: [n, ...heavy], todayStr: today, baseCapacity: 3, capacityForDate: capFn });
    assert(withPressure.entries.length === 1 && withPressure.entries[0].id.startsWith('f'), '[exam-pressure] 逼迫した締切のタスクが前倒しで選ばれない', { picked: withPressure.entries.map((e) => e.id) });
    assert(/前倒し/.test(Planner.explainSelection(withPressure.entries[0])), '[exam-pressure] 前倒しが決め手の選定理由が説明に反映されない', { r: Planner.explainSelection(withPressure.entries[0]) });
    const noCap = Planner.buildTodayPlan({ tasks: [n, ...heavy], todayStr: today, baseCapacity: 3 });
    assert(noCap.entries.every((e) => e.pressureBonus == null || e.pressureBonus === 0), '[exam-pressure] capacityForDate省略時に圧力が効いている（後方互換違反）', {});

    // 遅れた分は窓に残り続け、自動で圧力が増す（やれなかった日を責めずに組み直す）
    const ontime = Planner.computeDeadlinePressure({ tasks: heavy.slice(0, 25), todayStr: today, capacityForDate: capFn });
    const later = Planner.computeDeadlinePressure({ tasks: heavy.slice(0, 25), todayStr: addD(10), capacityForDate: capFn });
    assert([...later.values()][0] > [...ontime.values()][0], '[exam-pressure] 同じ残タスクで日が進んでも圧力が増えない', { a: [...ontime.values()][0], b: [...later.values()][0] });
    // 期限超過分は今日の窓に入り、完了済み・週次は対象外
    const od = Planner.computeDeadlinePressure({ tasks: [{ id: 'o', load: 6, type: 'once', deadline: addD(-2) }, { id: 'd', load: 6, type: 'once', deadline: addD(-2), done: true }, { id: 'w', load: 6, type: 'weekly', weekDays: [0], deadline: addD(3) }], todayStr: today, capacityForDate: capFn });
    assert(od.size === 1 && od.get('o') >= 2, '[exam-pressure] 期限超過/完了済み/週次の扱いが想定と違う', { od: [...od.entries()] });
    // capacityForDateが壊れた値を返してもクラッシュしない
    Planner.computeDeadlinePressure({ tasks: heavy, todayStr: today, capacityForDate: () => NaN });
    Planner.computeDeadlinePressure({ tasks: heavy, todayStr: today, capacityForDate: () => { return -5; } });
  }

  // --- ⑥ 完了時刻の学習 ---
  {
    const bucketOf = (d) => { const h = d.getHours(); return h >= 5 && h < 10 ? 'dawn' : h >= 10 && h < 16 ? 'day' : h >= 16 && h < 19 ? 'dusk' : 'night'; };
    const at = (hour, i) => new Date(2026, 8, 1 + (i % 25), hour, 0, 0).getTime();
    const mk = (n, hour, pattern, startIdx = 0) => Array.from({ length: n }, (_, i) => ({ taskId: 't' + pattern + i, event: 'completed', pattern, ts: at(hour, startIdx + i), date: '2026-09-01', load: 2 }));
    // 暗記は夜にばかり、思考は日中にばかり完了している
    const state = Store.normalizeState({ tasks: [], history: [...mk(15, 22, 'memorization'), ...mk(15, 11, 'problem_solving')], settings: {}, stats: {} });
    const stats = Store.deriveTimeOfDayPatternStats(state, { bucketOf });
    assert(stats.total.all === 30 && stats.byPattern.memorization.night === 15 && stats.byPattern.problem_solving.day === 15, '[exam-time] 完了時刻の集計が合わない', { stats });
    const aff = Planner.observedTimeAffinity('memorization', 'night', stats);
    assert(aff && aff.bonus > 0 && aff.weight === 0.5, '[exam-time] 夜に偏って完了する暗記の夜の相性が正にならない', { aff });
    const affDay = Planner.observedTimeAffinity('memorization', 'day', stats);
    assert(affDay && affDay.bonus < 0, '[exam-time] 夜型の暗記の日中の相性が負にならない', { affDay });
    // 件数不足ではnull→一般モデルのみ
    const small = Store.normalizeState({ tasks: [], history: mk(5, 22, 'memorization'), settings: {}, stats: {} });
    assert(Planner.observedTimeAffinity('memorization', 'night', Store.deriveTimeOfDayPatternStats(small, { bucketOf })) === null, '[exam-time] 件数不足でも実績補正が効く', {});
    assert(Planner.timeOfDayPatternBonus('memorization', 'night', null) === 1.5, '[exam-time] 実績なしで一般モデルの値にならない', {});
    // 一般モデルでは日中に有利な思考系も、夜にしか進めてこなかった人の昼は下がる
    const nightOwl = Store.normalizeState({ tasks: [], history: [...mk(20, 23, 'problem_solving'), ...mk(15, 11, 'memorization')], settings: {}, stats: {} });
    const nStats = Store.deriveTimeOfDayPatternStats(nightOwl, { bucketOf });
    assert(Planner.timeOfDayPatternBonus('problem_solving', 'day', nStats) < Planner.timeOfDayPatternBonus('problem_solving', 'day', null), '[exam-time] 夜にしか完了してこなかった人の昼の思考系が一般モデルより下がらない', {});
    // 取り消し・不正データ・タスク削除済みでもクラッシュしない
    const weird = Store.normalizeState({ tasks: [{ id: 'x', title: '英単語暗記' }], history: [{ event: 'completed', ts: 'abc' }, { event: 'completed', taskId: 'x', ts: at(22, 0) }, null, { event: 'missed' }], settings: {}, stats: {} });
    const wStats = Store.deriveTimeOfDayPatternStats(weird, { bucketOf, estimatePattern: (t) => Planner.estimatePatternGeneral(t.title, t.description) });
    assert(wStats.total.all === 1, '[exam-time] 不正なhistoryの扱いが想定と違う', { wStats });
    Store.deriveTimeOfDayPatternStats(weird); // bucketOf未指定でも落ちない
  }

  // --- ⑤ バックアップ世代の整理・保存データの健全性 ---
  {
    const days = Array.from({ length: 120 }, (_, i) => addD(-i));
    const keep = Store.selectSnapshotsToKeep(days, today);
    assert(days.slice(0, 14).every((d) => keep.has(d)), '[exam-backup] 直近14日が残らない', {});
    assert(!keep.has(addD(-14 - 12 * 7)) && !keep.has(addD(-119)), '[exam-backup] 12週より古い世代が残っている', {});
    const olds = [...keep].filter((d) => d < addD(-13));
    const weeks = new Set(olds.map((d) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toDateString(); }));
    assert(olds.length === weeks.size && olds.length >= 10 && olds.length <= 13, '[exam-backup] 古い世代が週ごと1件になっていない', { olds: olds.length, weeks: weeks.size });
    assert(Store.selectSnapshotsToKeep([addD(2)], today).has(addD(2)), '[exam-backup] 未来日付の世代を消そうとする（時計ずれ）', {});
    assert(Store.selectSnapshotsToKeep([], today).size === 0, '[exam-backup] 空入力で落ちる/残る', {});
  }
  {
    // localStorageが「消えた」「壊れた」「正常」のときのloadStateの判定
    const mem = new Map();
    globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
    Store.loadState();
    assert(Store.getLoadInfo().lost === true && Store.getLoadInfo().reason === 'missing', '[exam-backup] 保存データなしがlostにならない', { i: Store.getLoadInfo() });
    mem.set('temper_data_v1', '{broken json');
    const st = Store.loadState();
    assert(Store.getLoadInfo().reason === 'corrupt' && mem.get('temper_data_v1_corrupt') === '{broken json', '[exam-backup] 壊れた保存データが退避されない', { i: Store.getLoadInfo() });
    assert(Array.isArray(st.tasks) && st.tasks.length === 0, '[exam-backup] 壊れた場合に初期状態で起動しない', {});
    mem.set('temper_data_v1', JSON.stringify({ tasks: [{ id: 'a', title: 'x', load: 2, type: 'once' }], history: [] }));
    const ok = Store.loadState();
    assert(Store.getLoadInfo().lost === false && ok.tasks.length === 1, '[exam-backup] 正常な保存データがlost扱いになる', { i: Store.getLoadInfo() });
    delete globalThis.localStorage;
  }

  console.log('  締切逆算の時期補正 / 間に合い具合 / 完了時刻の学習 / バックアップ整理・保存の健全性 を検証');
}

console.log('=== PART A: buildTodayPlan 単日ファジング ===');
for (const seed of [12345, 777, 2026, 999999, 42]) fuzzSingleDay(mulberry32(seed), 3000);
console.log(`  ${assertionCount}件のアサーションを実行（5シード×3000）`);

console.log('=== PART B: 長期シミュレーション（日次進行） ===');
const before = assertionCount;
for (let s = 0; s < 8; s++) {
  const rng = mulberry32(1000 + s * 97);
  const days = 180 + s * 30;
  const taskCount = 8 + s * 3;
  const { recordedCompletions, recordedUndos, midDayCapacityChangeChecks } = simulateLongRun(rng, days, taskCount, `run${s}`);
  console.log(`  run${s}: ${days}日間 / タスク${taskCount}件 / 完了${recordedCompletions}回(取り消し${recordedUndos}回) / 容量変更検証${midDayCapacityChangeChecks}回`);
}
console.log(`  ${assertionCount - before}件のアサーションを実行`);

console.log('=== PART C: 週次タスクの再帰的な復帰 ===');
testWeeklyRecurrence();

console.log('=== PART D: インポート整合性ファジング ===');
const beforeD = assertionCount;
for (const seed of [54321, 111, 8080]) fuzzImportConsistency(mulberry32(seed), 1500);
console.log(`  ${assertionCount - beforeD}件のアサーションを実行（3シード×1500）`);

console.log('=== PART E: 境界値・悪意データ耐性 ===');
testBoundaryAndAdversarial();

console.log('=== PART F: 大規模データでの性能・正しさ ===');
testScale();

console.log('=== PART G: 完了/取り消しの繰り返しでhistoryが積み重ならないか ===');
testCompletionUndoDoesNotAccumulate();

console.log('=== PART H: 人間工学・心理学ベースの改修（missed記録・時間帯補正・セッションの起伏） ===');
testErgonomicsFeatures();

console.log('=== PART I: 受験向け（時期補正・間に合い具合・完了時刻の学習・自動バックアップ） ===');
testExamFeatures();

console.log('\n=== 結果 ===');
console.log(`総アサーション数: ${assertionCount}`);
console.log(`失敗: ${failures.length}`);
if (failures.length) {
  const grouped = {};
  for (const f of failures) grouped[f.msg] = (grouped[f.msg] || 0) + 1;
  console.log('\n--- 失敗の種類ごとの件数 ---');
  Object.entries(grouped).sort((a, b) => b[1] - a[1]).forEach(([msg, count]) => console.log(`  [${count}件] ${msg}`));
  console.log('\n--- 最初の20件の詳細 ---');
  failures.slice(0, 20).forEach((f, i) => console.log(`${i + 1}. ${f.msg}\n   ${f.ctx}`));
  process.exitCode = 1;
} else {
  console.log('すべてのアサーションを通過しました。');
}
