/* ============================================================
   viewport.js — iPhoneのホーム画面アプリ（standalone）で、レイアウト
   ビューポートが画面より短いまま残り、下端に単色の帯が出る不具合の
   検出・回復（v1.11.1。v1.11.2で記録と表示を廃止）
   ------------------------------------------------------------
   症状: #sky と #app（position:fixed; inset:0）が画面より約60pt短い
   高さで描かれ、その下は html の背景色だけになる。env(safe-area-
   inset-bottom) は正常なので、WebViewの枠ではなく「ビューポート高さの
   計算結果」が古いまま残っている状態。
   方針:
     1. 画面の物理高さ(screen.height)と innerHeight を比べて検出する。
     2. ずれていたら viewport メタの再設定・scrollTo・resize 発火で
        WebKit に高さを取り直させる（最大3回、間隔を空ける）。
     3. 直らない間も、ナビ等が帯の上で宙に浮かないよう --vv-gap を出す。
     4. （v1.11.2 で廃止）以前は起きた瞬間の数値を記録して設定タブに出していたが、
        表示が邪魔なので記録も表示もやめた。検出・回復だけを行う。
   DOMに触る処理は init() の中だけで行う（トップレベルに置かない）。
   ============================================================ */

const LOG_KEY = 'temper-vp-log';
const THRESHOLD = 8; // px。これ以上短ければ「ずれ」とみなす
let lastGap = 0;
let tries = 0;
let lastTryAt = 0;
let timer = 0;

function isStandalone() {
  try {
    return window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  } catch (e) { return false; }
}

/** 今の向きでの、画面の物理的な高さ（iOSのscreen.*は向きで入れ替わらないことがあるためmax/minで揃える） */
function expectedHeight() {
  const a = window.screen.width, b = window.screen.height;
  const portrait = window.matchMedia ? window.matchMedia('(orientation: portrait)').matches : window.innerHeight >= window.innerWidth;
  return portrait ? Math.max(a, b) : Math.min(a, b);
}

function measure() {
  const inner = window.innerHeight;
  const vv = window.visualViewport ? Math.round(window.visualViewport.height) : null;
  const client = document.documentElement.clientHeight;
  const screenH = expectedHeight();
  return { inner, vv, client, screenH, gap: Math.max(0, screenH - Math.max(inner, client)) };
}


function applyGap(gap) {
  document.documentElement.style.setProperty('--vv-gap', gap > THRESHOLD ? gap + 'px' : '0px');
}

/** WebKitにビューポートを取り直させる */
function nudge() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    const c = meta.getAttribute('content') || '';
    meta.setAttribute('content', c.replace('viewport-fit=cover', 'viewport-fit=auto'));
    requestAnimationFrame(() => {
      meta.setAttribute('content', c);
      try { window.scrollTo(0, 0); } catch (e) { /* 何もしない */ }
      window.dispatchEvent(new Event('resize'));
    });
  } else {
    try { window.scrollTo(0, 0); } catch (e) { /* 何もしない */ }
  }
}

function check(ev) {
  if (!isStandalone()) return;
  const m = measure();
  applyGap(m.gap);
  const wasBad = lastGap > THRESHOLD;
  const bad = m.gap > THRESHOLD;
  if (bad) {
    const now = Date.now();
    const canTry = tries < 3 && now - lastTryAt > 400;
    if (canTry) { tries += 1; lastTryAt = now; nudge(); schedule('retry', 450); }
  } else {
    tries = 0;
  }
  lastGap = m.gap;
}

function schedule(ev, ms) {
  clearTimeout(timer);
  timer = setTimeout(() => check(ev), ms);
}

export function initViewport() {
  // 以前の版が残した診断ログを消す（もう表示も記録もしない）
  try { localStorage.removeItem(LOG_KEY); } catch (e) { /* 消せなくても動く */ }
  if (!isStandalone()) return;
  // 起動直後は高さが後から更新されることがあるので、数回に分けて確かめる
  [0, 150, 500, 1500, 3000].forEach((ms) => setTimeout(() => check('boot'), ms));
  window.addEventListener('pageshow', (e) => { tries = 0; check(e.persisted ? 'pageshow:bfcache' : 'pageshow'); schedule('pageshow+', 400); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tries = 0; check('visible'); schedule('visible+', 400); } });
  window.addEventListener('focusout', () => schedule('focusout', 350)); // キーボードを閉じた後
  window.addEventListener('resize', () => schedule('resize', 150));
  window.addEventListener('orientationchange', () => schedule('orient', 400));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => schedule('vv', 150));
}

