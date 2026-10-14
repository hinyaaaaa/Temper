/* ============================================================
   sync-firebase.js — Firebase（Auth + Firestore）のバックエンド（v1.11.0 新設）
   ------------------------------------------------------------
   Firebase SDK は設定されたときだけ、gstatic の ES モジュールとして動的に読み込む
   （同期を使わない人・オフラインの人には一切影響しない。憲法11条）。
   sync-core.js の「バックエンド」インターフェースを実装する薄い層で、
   同期のロジックはここに置かない。

   Firestore の構成（すべて users/{uid} の下。ルールは firestore.rules）:
     tasks/{taskId}   { id, json, updatedAt, deletedAt }
     days/{date}      { id, date, json, updatedAt }
     meta/settings    { id, json, updatedAt }
   オフライン書き込みは Firestore の永続キャッシュが溜めて、復帰時に送る。
   読み取り課金は、変更のあった文書だけ（キャッシュ済みの分は数えられない）。
   ============================================================ */
const FB = 'https://www.gstatic.com/firebasejs/11.0.2';

let appSingleton = null;
let dbSingleton = null;

const safeId = (id) => String(id).replace(/[\/\s]/g, '_');

export async function loadFirebase(config) {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  if (!appSingleton) appSingleton = appMod.initializeApp(config);
  const auth = authMod.getAuth(appSingleton);
  if (!dbSingleton) {
    try {
      dbSingleton = fsMod.initializeFirestore(appSingleton, {
        localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
      });
    } catch (e) {
      dbSingleton = fsMod.getFirestore(appSingleton); // 永続キャッシュが使えない環境
    }
  }
  const db = dbSingleton;

  return {
    onAuthChanged: (cb) => authMod.onAuthStateChanged(auth, cb),
    signIn: (email, pw) => authMod.signInWithEmailAndPassword(auth, email, pw),
    signUp: (email, pw) => authMod.createUserWithEmailAndPassword(auth, email, pw),
    signOut: () => authMod.signOut(auth),

    /** sync-core のバックエンド（uid ごと） */
    makeBackend(uid, cutoffDate) {
      const base = `users/${uid}`;
      let unsubs = [];
      let pushStatus = () => {};
      return {
        start(handlers) {
          pushStatus = handlers.onStatus;
          const pending = { tasks: false, days: false, settings: false };
          const first = (k, docs) => {
            handlers.onDocs(docs);
            if (!pending[k]) { pending[k] = true; if (pending.tasks && pending.days && pending.settings) handlers.onStatus('synced'); }
          };
          const fail = (e) => handlers.onStatus('error:' + (e && e.code ? e.code : 'unknown'));
          const toDocs = (snap, kind) => snap.docChanges()
            .filter((c) => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites) // 自分の未確定の書き込みは取り込まない
            .map((c) => {
              const d = c.doc.data();
              return { kind, id: kind === 'day' ? (d.date || d.id) : (d.id || c.doc.id), json: d.json == null ? null : d.json, updatedAt: Number(d.updatedAt) || 0, deletedAt: d.deletedAt || null };
            });
          unsubs.push(fsMod.onSnapshot(fsMod.collection(db, `${base}/tasks`), (s) => first('tasks', toDocs(s, 'task')), fail));
          unsubs.push(fsMod.onSnapshot(
            fsMod.query(fsMod.collection(db, `${base}/days`), fsMod.where('date', '>=', cutoffDate())),
            (s) => first('days', toDocs(s, 'day')), fail));
          unsubs.push(fsMod.onSnapshot(fsMod.doc(db, `${base}/meta/settings`), (s) => {
            const d = s.exists() && !s.metadata.hasPendingWrites ? s.data() : null;
            first('settings', d ? [{ kind: 'settings', id: 'settings', json: d.json, updatedAt: Number(d.updatedAt) || 0 }] : []);
          }, fail));
        },
        stop() { unsubs.forEach((u) => { try { u(); } catch (e) { /* 解除に失敗しても続ける */ } }); unsubs = []; },
        push(items) {
          items.forEach((it) => {
            let ref, data;
            if (it.kind === 'task') { ref = fsMod.doc(db, `${base}/tasks/${safeId(it.id)}`); data = { id: it.id, json: it.json, updatedAt: it.updatedAt, deletedAt: it.deletedAt }; }
            else if (it.kind === 'day') { ref = fsMod.doc(db, `${base}/days/${safeId(it.id)}`); data = { id: it.id, date: it.id, json: it.json, updatedAt: it.updatedAt }; }
            else { ref = fsMod.doc(db, `${base}/meta/settings`); data = { id: 'settings', json: it.json, updatedAt: it.updatedAt }; }
            fsMod.setDoc(ref, data).catch((e) => pushStatus('error:' + (e && e.code ? e.code : 'unknown')));
          });
        },
      };
    },
  };
}
