/* ============================================================
   viewport.js — iPhoneのホーム画面アプリ（standalone）で、レイアウト
   ビューポートが画面より短いまま残り、下端に単色の帯が出る不具合の
   検出・回復・記録（v1.11.1）
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
     4. 起きた瞬間の数値を localStorage に残し、設定タブの下部で見られる
        （引き金の特定用。ずれが一度も起きていなければ何も表示しない）。
   DOMに触る処理は init() の中だけで行う（トップレベルに置かない）。
   ============================================================ */

const LOG_KEY = 'temper-vp-log';
const LOG_MAX = 30;
const THRESHOLD = 8; // px。これ以上短ければ「ずれ」とみなす
let bootAt = 0;
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

function readLog() {
  try { const v = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function writeLog(ev, m, extra) {
  const log = readLog();
  const d = new Date();
  log.push({
    t: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
    ev, up: Math.round((Date.now() - bootAt) / 100) / 10,
    inner: m.inner, vv: m.vv, client: m.client, scr: m.screenH, gap: m.gap,
    vis: document.visibilityState, ...extra,
  });
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-LOG_MAX))); } catch (e) { /* 記録できなくても動く */ }
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
    writeLog(ev, m, { try: canTry ? tries + 1 : 0 });
    if (canTry) { tries += 1; lastTryAt = now; nudge(); schedule('retry', 450); }
  } else {
    if (wasBad) writeLog(ev + ':ok', m, {});
    tries = 0;
  }
  lastGap = m.gap;
}

function schedule(ev, ms) {
  clearTimeout(timer);
  timer = setTimeout(() => check(ev), ms);
}

export function initViewport() {
  bootAt = Date.now();
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

/** 設定タブ下部の診断表示。ずれが一度も記録されていなければ空文字 */
export function viewportDebugHtml(esc) {
  const bad = readLog().filter((x) => x.gap > THRESHOLD);
  if (!bad.length) return '';
  const rows = readLog().slice(-6).map((x) =>
    `${esc(x.t)} ${esc(x.ev)} +${x.up}s 内${x.inner}/画面${x.scr}/差${x.gap}${x.try ? ' 補正' + x.try : ''}`).join('<br>');
  return `<div class="settings-desc" style="margin-top:6px;opacity:.7">表示の高さのずれ（記録）<br>${rows}</div>`;
}
