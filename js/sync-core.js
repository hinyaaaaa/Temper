/* ============================================================
   sync-core.js — 複数端末の同期の中核（v1.11.0 新設）
   ------------------------------------------------------------
   Firebase等の通信は一切知らない（バックエンドは差し替え可能なインターフェース）。
   ここは「何を送り、届いたものをどう取り込むか」だけを持つ純粋なロジックで、
   メモリ上の偽バックエンドでテストできる（simulate.mjs Part L）。

   モデル（すべて「更新が新しい方が勝つ」= LWW。時計のずれは端末の時計に依存）:
     ・タスク    … 1件ごとに1文書。削除は墓標(deletedAt)を残す
     ・設定      … 1文書
     ・履歴      … 1日ごとに1文書（直近 HISTORY_DAYS 日だけ）。統計は差分で調整
   共有しないもの: 今日の固定(pin)・空の補助値・やり切りの集計(stats.follow)・
   missedの最終確認日。端末ごとの派生値で、共有すると二重に数える。

   変更の検出は、各操作に手を入れず、保存のたびに「前回送った内容のハッシュ」と比べる。
   取り込んだ内容は同時にハッシュを更新するので、自分の書き込みが跳ね返って
   再送信されることはない（エコー抑止）。未送信の手元の変更がある文書には、
   届いた古い内容を上書きしない。
   ============================================================ */
export const HISTORY_DAYS = 120;

/** 同期する履歴の最も古い日（YYYY-MM-DD） */
export function historyCutoff(nowMs = Date.now()) {
  const d = new Date(nowMs); d.setDate(d.getDate() - HISTORY_DAYS);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** キー順を固定したJSON（ハッシュを端末間で一致させるため） */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
export function hashOf(v) {
  const s = typeof v === 'string' ? v : stableStringify(v);
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

function emptyMeta() { return { tasks: {}, days: {}, settings: null }; }
const sortHistory = (list) => [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.taskId).localeCompare(String(b.taskId)) || String(a.event).localeCompare(String(b.event)));

/**
 * @param {object} o
 * @param {()=>object} o.getState 現在のstate（tasks/history/settings/stats）
 * @param {object} o.backend { start(handlers), push(items) }
 * @param {{get:()=>object|null, set:(m:object)=>void}} o.metaStore 前回送った内容の記録
 * @param {(t:object)=>object} o.normalizeTask
 * @param {(s:object)=>object} o.normalizeSettings 設定の正規化（受け取った設定を整える）
 * @param {(state:object, date:string, entries:Array)=>void} o.replaceHistoryDay
 * @param {()=>void} o.onRemoteApplied 他端末の内容を取り込んだ後に呼ぶ（保存・再描画）
 * @param {()=>number} [o.now]
 * @param {(status:string)=>void} [o.onStatus]
 */
export function createSyncEngine(o) {
  const now = o.now || (() => Date.now());
  let meta = o.metaStore.get() || emptyMeta();
  if (!meta.tasks) meta = emptyMeta();
  let timer = null;
  let started = false;

  const save = () => { try { o.metaStore.set(meta); } catch (e) { /* 保存できなくても動く */ } };
  const todayCutoff = () => historyCutoff(now());

  function localDays(state) {
    const cutoff = todayCutoff();
    const by = {};
    state.history.forEach((h) => { if (h && typeof h.date === 'string' && h.date >= cutoff) (by[h.date] || (by[h.date] = [])).push(h); });
    Object.keys(by).forEach((d) => { by[d] = sortHistory(by[d]); });
    return by;
  }

  /** 手元の変更を検出して送る */
  function flush() {
    if (!started) return [];
    const state = o.getState();
    const t = now();
    const items = [];

    const seen = new Set();
    state.tasks.forEach((task) => {
      seen.add(task.id);
      const h = hashOf(task);
      const m = meta.tasks[task.id];
      if (!m || m.h !== h || m.d) {
        meta.tasks[task.id] = { h, u: t, d: false };
        items.push({ kind: 'task', id: task.id, json: stableStringify(task), updatedAt: t, deletedAt: null });
      }
    });
    // 安全弁: 手元のタスクが空なのに、これまで同期したタスクが3件以上ある場合は、
    // 復元の失敗・読み込みの失敗の可能性が高いので「全部削除された」とは送らない（クラウドを守る）
    const liveMeta = Object.keys(meta.tasks).filter((id) => !meta.tasks[id].d).length;
    const suspiciousWipe = state.tasks.length === 0 && liveMeta >= 3;
    Object.keys(meta.tasks).forEach((id) => {
      const m = meta.tasks[id];
      if (!seen.has(id) && !m.d && !suspiciousWipe) {
        meta.tasks[id] = { h: '', u: t, d: true };
        items.push({ kind: 'task', id, json: null, updatedAt: t, deletedAt: t });
      }
    });

    const sh = hashOf(state.settings);
    if (!meta.settings || meta.settings.h !== sh) {
      meta.settings = { h: sh, u: t };
      items.push({ kind: 'settings', id: 'settings', json: stableStringify(state.settings), updatedAt: t });
    }

    const days = localDays(state);
    Object.keys(days).forEach((date) => {
      const h = hashOf(days[date]);
      const m = meta.days[date];
      if (!m || m.h !== h) {
        meta.days[date] = { h, u: t };
        items.push({ kind: 'day', id: date, json: stableStringify(days[date]), updatedAt: t });
      }
    });
    Object.keys(meta.days).forEach((date) => {
      if (!days[date] && meta.days[date].h !== hashOf([])) {
        meta.days[date] = { h: hashOf([]), u: t };
        items.push({ kind: 'day', id: date, json: '[]', updatedAt: t });
      }
    });

    if (items.length) { save(); o.backend.push(items); }
    return items;
  }

  const remoteWins = (m, doc, remoteHash) => !m || doc.updatedAt > m.u || (doc.updatedAt === m.u && remoteHash > m.h);

  /** 他端末（または自分の別の書き込み）から届いた1件を取り込む。変更があれば true */
  function applyRemote(doc) {
    if (!doc || typeof doc.id !== 'string') return false;
    const state = o.getState();
    try {
      if (doc.kind === 'task') {
        const m = meta.tasks[doc.id];
        const local = state.tasks.find((x) => x.id === doc.id);
        if (local && m && !m.d && hashOf(local) !== m.h) return false; // 未送信の手元の変更を優先
        if (doc.deletedAt) {
          if (m && m.u >= doc.updatedAt) return false;
          meta.tasks[doc.id] = { h: '', u: doc.updatedAt, d: true };
          if (local) state.tasks = state.tasks.filter((x) => x.id !== doc.id);
          return !!local;
        }
        const task = o.normalizeTask(JSON.parse(doc.json));
        task.id = doc.id;
        const rh = hashOf(task);
        if (!remoteWins(m, doc, rh)) return false;
        meta.tasks[doc.id] = { h: rh, u: doc.updatedAt, d: false };
        const idx = state.tasks.findIndex((x) => x.id === doc.id);
        if (idx >= 0) { if (hashOf(state.tasks[idx]) === rh) return false; state.tasks[idx] = task; } else state.tasks.push(task);
        return true;
      }
      if (doc.kind === 'settings') {
        const m = meta.settings;
        if (m && hashOf(state.settings) !== m.h) return false;
        const s = o.normalizeSettings(JSON.parse(doc.json));
        const rh = hashOf(s);
        if (m && !(doc.updatedAt > m.u || (doc.updatedAt === m.u && rh > m.h))) return false;
        meta.settings = { h: rh, u: doc.updatedAt };
        if (hashOf(state.settings) === rh) return false;
        state.settings = s;
        return true;
      }
      if (doc.kind === 'day') {
        const date = doc.id;
        if (date < todayCutoff()) return false;
        const m = meta.days[date];
        const local = localDays(state)[date] || [];
        if (m && hashOf(local) !== m.h) return false;
        const entries = sortHistory(JSON.parse(doc.json).filter((h) => h && h.date === date));
        const rh = hashOf(entries);
        if (m && !(doc.updatedAt > m.u || (doc.updatedAt === m.u && rh > m.h))) return false;
        meta.days[date] = { h: rh, u: doc.updatedAt };
        if (hashOf(local) === rh) return false;
        o.replaceHistoryDay(state, date, entries);
        return true;
      }
    } catch (e) {
      return false; // 壊れた文書は無視する（主機能を止めない）
    }
    return false;
  }

  const handlers = {
    onDocs(docs) {
      let changed = false;
      docs.forEach((d) => { if (applyRemote(d)) changed = true; });
      save();
      if (changed) o.onRemoteApplied();
      schedule(0); // 取り込み後の差分（初回は手元にだけある分）を送る
    },
    onStatus(s) { if (o.onStatus) o.onStatus(s); },
  };

  function schedule(ms = 1200) {
    if (!started) return;
    clearTimeout(timer);
    timer = setTimeout(flush, ms);
  }

  return {
    start() { started = true; o.backend.start(handlers); },
    stop() { started = false; clearTimeout(timer); if (o.backend.stop) o.backend.stop(); },
    /** 保存のたびに呼ぶ（送信はまとめて少し遅らせる） */
    notifyLocalChange() { schedule(); },
    flush,
    applyRemote,
    get meta() { return meta; },
  };
}
