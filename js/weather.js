/* ============================================================
   weather.js — 空のモデル（v1.8.0 全面改修）
   ------------------------------------------------------------
   旧版は現実の天気（Open-Meteo・位置情報・IP推定）を取得して
   晴れ/曇り/雨の3種に丸めていた。v1.8.0 で現実の天気は完全に
   廃止し（外部通信なし）、空は「直近の見通し」を映す。

   このファイルが決めるのは「空がどういう状態か」だけ（純粋関数）:
     入力  pressure … 今日〜3日先の見通しの詰まり具合 0..1（forecast.js）
           relief   … 逼迫が解けた直後の度合い 0..1（forecast.js）
           date     … 時刻・季節
     出力  色・光源・雲・雨雪・季節のレア等のパラメータ一式
   描画は skyrender.js が担う（憲法6条: 分離の原則）。
   このファイルはDOMにも保存領域にも触れない。

   憲法7条: 評価語（良い/悪い）を使わない。空の名前はすべて
   状態語で、画面に文字としては出さない（空そのものが表現）。
   ============================================================ */

/* ------------------------------------------------------------
   Planner互換: 4つの時間帯バケット（Plannerの時間帯補正が使う）
   空の描画はこれを使わず、連続した時刻モデルで動く。
   ------------------------------------------------------------ */
export function getTimeOfDay(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 10) return 'dawn';
  if (h >= 10 && h < 16) return 'day';
  if (h >= 16 && h < 19) return 'dusk';
  return 'night';
}
export const TIME_LABELS = { dawn: '朝', day: '昼', dusk: '夕方', night: '夜' };

/* ------------------------------------------------------------
   数学・色（OKLab で混ぜる。sRGBで混ぜると中間が濁る）
   ------------------------------------------------------------ */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const RAD = Math.PI / 180;

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
function rgbToLab([r, g, b]) {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function labToRgb([L, a, b]) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
    clamp(toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp(toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp(toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)),
  ];
}
const hexLab = (h) => rgbToLab(hexToRgb(h));
const mixLab = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
/** 色相を回して混ぜる（夜→朝焼けが灰褐色に濁らず、紫・薔薇色を通る） */
function mixLch(A, B, t) {
  const cA = Math.hypot(A[1], A[2]), cB = Math.hypot(B[1], B[2]);
  if (cA < 0.012 || cB < 0.012) return mixLab(A, B, t);
  const hA = Math.atan2(A[2], A[1]), hB = Math.atan2(B[2], B[1]);
  let dh = hB - hA;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  // 経路の中間が緑〜青緑（OKLabの色相で約110°〜230°）を通るなら、反対回り（紫・薔薇色）を選ぶ
  const mid = ((hA + dh / 2) * 180 / Math.PI % 360 + 360) % 360;
  if (mid > 110 && mid < 230) dh += dh > 0 ? -2 * Math.PI : 2 * Math.PI;
  const h = hA + dh * t, c = lerp(cA, cB, t);
  return [lerp(A[0], B[0], t), Math.cos(h) * c, Math.sin(h) * c];
}
export function rgbCss([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('');
}
/** 相対輝度（sRGB→線形→Y） */
export function luminance([r, g, b]) {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

/* ------------------------------------------------------------
   空の色（旧版で手調整した値をそのまま移植し、連続時刻で補間）
   ------------------------------------------------------------
   旧SKY_PROFILESの stops（時間帯×天候）を、6つの固定位置へ
   再サンプリングして持つ。位置は天頂0 … 地平線1。
   ------------------------------------------------------------ */
const STOP_POS = [0, 0.2, 0.42, 0.64, 0.84, 1.0];
const RAW = {
  dawn: {
    clear:  ['#FFB37A 0%', '#F9A88C 22%', '#F3C7A8 48%', '#FCE8CE 75%', '#FFF6E8 100%'],
    cloudy: ['#C9AFA0 0%', '#D6BEB0 25%', '#E2CFC4 50%', '#EDDFD6 75%', '#F3EAE3 100%'],
    rain:   ['#7C8494 0%', '#8E93A0 25%', '#A3A8B4 50%', '#B9BEC7 75%', '#CBCFD6 100%'],
  },
  day: {
    clear:  ['#2E86DE 0%', '#4F97DE 20%', '#7CB9EC 45%', '#B7DDF6 72%', '#E8F5FF 100%'],
    cloudy: ['#7C93A8 0%', '#8FA3B5 22%', '#A6B8C6 48%', '#C4D1DA 75%', '#DFE7EC 100%'],
    rain:   ['#414F5E 0%', '#4E5C6B 25%', '#606E7C 50%', '#7A8794 75%', '#96A1AB 100%'],
  },
  dusk: {
    clear:  ['#232152 0%', '#413659 26%', '#6B4B62 46%', '#B85C4E 68%', '#E8934A 84%', '#F9C77E 100%'],
    cloudy: ['#282744 0%', '#413B50 26%', '#69525A 46%', '#8F6259 68%', '#AD7359 84%', '#C48F6C 100%'],
    rain:   ['#1D1B38 0%', '#2C2840 26%', '#403A48 46%', '#534A4E 68%', '#615350 84%', '#6E5F58 100%'],
  },
  night: {
    clear:  ['#0C112B 0%', '#111838 28%', '#182246 55%', '#213061 78%', '#2E4078 100%'],
    cloudy: ['#0D1020 0%', '#131829 28%', '#1B2236 55%', '#252F45 78%', '#333F58 100%'],
    rain:   ['#05060E 0%', '#090B16 28%', '#0E1220 55%', '#141A2A 78%', '#1B2436 100%'],
  },
};
function resample(stops) {
  const pts = stops.map((s) => { const [c, p] = s.split(' '); return [parseFloat(p) / 100, hexLab(c)]; });
  return STOP_POS.map((x) => {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const t = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0] || 1);
        return mixLab(pts[i - 1][1], pts[i][1], t);
      }
    }
    return pts[pts.length - 1][1];
  });
}
const PAL = {};
Object.keys(RAW).forEach((t) => { PAL[t] = {}; Object.keys(RAW[t]).forEach((w) => { PAL[t][w] = resample(RAW[t][w]); }); });

/* 時間帯ごとの、空の色以外の色。 */
const TOD = {
  night: { lit: '#8390B6', shade: '#141A30', sun: '#F2F5FB', glow: '#8E9BBC', haze: '#2A3866', ground: '#05070F' },
  dawn:  { lit: '#FFE6CF', shade: '#9A8497', sun: '#FFF0CC', glow: '#FFAE72', haze: '#FBDCC0', ground: '#4F3F4E' },
  day:   { lit: '#FFFFFF', shade: '#8D9DB4', sun: '#FFFCF0', glow: '#FFF1C0', haze: '#DCEEFB', ground: '#2F4C66' },
  dusk:  { lit: '#FFC9A0', shade: '#4B3F60', sun: '#FFDDA0', glow: '#F0864F', haze: '#EE9C6E', ground: '#1B1330' },
};
const TOD_LAB = {};
Object.keys(TOD).forEach((k) => { TOD_LAB[k] = {}; Object.keys(TOD[k]).forEach((c) => { TOD_LAB[k][c] = hexLab(TOD[k][c]); }); });

/* ------------------------------------------------------------
   天文: 太陽と月（位置情報なし。日本の中緯度を仮定した近似）
   ------------------------------------------------------------ */
const LAT = 36 * RAD;
const SOLAR_NOON = 11.7; // 日本標準時で東日本の南中はおよそ11:40
const HORIZON_Y = 0.80;  // 画面上の地平線の高さ（上0 … 下1）

function dayOfYear(d) {
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86400000);
}
export function sunModel(date) {
  const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (dayOfYear(date) - 81)) / 365);
  const H0 = Math.acos(clamp(-Math.tan(LAT) * Math.tan(decl), -1, 1));
  const hours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const H = ((hours - SOLAR_NOON) * Math.PI) / 12;
  const alt = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  return {
    hours, H, H0, decl, alt,
    sunrise: SOLAR_NOON - (H0 * 12) / Math.PI,
    sunset: SOLAR_NOON + (H0 * 12) / Math.PI,
    noonAlt: Math.PI / 2 - LAT + decl,
  };
}
/** 新月からの月齢位相 0..1（0=新月, 0.5=満月） */
export function moonPhase(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const p = ((jd - 2451550.1) / 29.530588853) % 1;
  return p < 0 ? p + 1 : p;
}
function screenPos(Hrad, alt, sm) {
  const x = 0.5 + 0.40 * (Hrad / sm.H0);
  const an = alt / Math.max(sm.noonAlt, 0.2);
  return [x, HORIZON_Y - an * (HORIZON_Y - 0.13)];
}

/* ------------------------------------------------------------
   30種の空（アンカー）
   ------------------------------------------------------------
   各アンカーは、描画パラメータの組。種類の境目で切り替えず、
   アンカー間を線形補間するので、空は連続して移り変わる。
     cirrus/cumulus/stratus … 巻雲・積雲・層雲の量
     cells    … 積雲を小さな群れ(ひつじ雲)にする度合い
     cloudDark… 雲の底の暗さ   gloom … 空の色の沈み(0晴/1曇/2雨/2.5+嵐)
     wind     … 雲の速さ・雨の傾き
     haze/fog … 霞・霧         sun  … 太陽(月)の見え方
     rays     … 光芒           rain/lightning … 雨・雷
     rainbow  … 虹             afterglow … 雨上がりの光
     tower    … 入道雲
   ------------------------------------------------------------ */
const KEYS = ['cirrus', 'cumulus', 'stratus', 'cells', 'cloudDark', 'gloom', 'wind', 'haze', 'fog',
  'sun', 'rays', 'rain', 'lightning', 'rainbow', 'afterglow', 'tower'];
const mk = (name, p, o) => { const v = {}; KEYS.forEach((k) => { v[k] = o[k] || 0; }); return { name, p, v }; };

/** 見通しの詰まり具合 p に沿って並ぶ連続帯（1〜24） */
const BAND = [
  mk('快晴', 0.00, { wind: .10, haze: .02, sun: 1 }),
  mk('晴れ(すじ雲)', 0.025, { cirrus: .85, wind: .2, haze: .04, sun: 1 }),
  mk('晴れ(ひつじ雲)', 0.05, { cirrus: .2, cumulus: .52, cells: 1, wind: .2, haze: .05, sun: .95 }),
  mk('晴れ時々曇り', 0.075, { cirrus: .12, cumulus: .56, wind: .3, haze: .06, sun: .9, cloudDark: .05, gloom: .05 }),
  mk('光芒', 0.10, { cumulus: .58, stratus: .12, cloudDark: .15, gloom: .15, haze: .12, sun: .85, rays: .9, wind: .25 }),
  mk('薄曇り', 0.125, { cirrus: .3, cumulus: .12, stratus: .42, cloudDark: .08, gloom: .35, haze: .22, sun: .6, wind: .2 }),
  mk('霞', 0.15, { cirrus: .2, stratus: .3, haze: .6, gloom: .3, sun: .5, wind: .05, cloudDark: .05 }),
  mk('曇り', 0.20, { stratus: .72, cumulus: .2, cloudDark: .28, gloom: .7, haze: .15, sun: .22, wind: .2 }),
  mk('厚い曇り', 0.24, { stratus: .9, cumulus: .25, cloudDark: .45, gloom: .9, haze: .12, sun: .1, wind: .2 }),
  mk('鉛色の空', 0.29, { stratus: 1, cumulus: .25, cloudDark: .68, gloom: 1.15, haze: .1, sun: .04, wind: .2 }),
  mk('風のある曇り', 0.33, { stratus: .78, cumulus: .6, cloudDark: .52, gloom: 1.0, wind: .9, sun: .1, haze: .08 }),
  mk('朝靄', 0.36, { stratus: .4, fog: .55, haze: .5, gloom: .6, sun: .3, wind: .03, cloudDark: .12, cirrus: .15 }),
  mk('濃霧', 0.39, { stratus: .2, fog: .93, haze: .65, gloom: .85, sun: .1, cloudDark: .12 }),
  mk('雨の気配', 0.43, { stratus: .95, cumulus: .4, cloudDark: .75, gloom: 1.25, wind: .45, sun: .03, haze: .1, rain: .05 }),
  mk('霧雨', 0.47, { stratus: 1, cumulus: .3, cloudDark: .72, gloom: 1.35, fog: .3, rain: .16, wind: .2, sun: .03, haze: .15 }),
  mk('小雨', 0.51, { stratus: 1, cumulus: .4, cloudDark: .78, gloom: 1.5, rain: .33, wind: .35, fog: .12, sun: .02 }),
  mk('雨', 0.56, { stratus: 1, cumulus: .5, cloudDark: .82, gloom: 1.7, rain: .55, wind: .4, fog: .12 }),
  mk('強い雨', 0.62, { stratus: 1, cumulus: .6, cloudDark: .88, gloom: 1.85, rain: .8, wind: .5, fog: .2 }),
  mk('風雨', 0.68, { stratus: 1, cumulus: .7, cloudDark: .9, gloom: 1.95, rain: .85, wind: .95, fog: .2 }),
  mk('遠雷', 0.72, { stratus: 1, cumulus: .8, cloudDark: .88, gloom: 2.0, rain: .28, wind: .55, lightning: .28, fog: .1 }),
  mk('雷雨', 0.78, { stratus: 1, cumulus: .85, cloudDark: .93, gloom: 2.15, rain: .72, wind: .65, lightning: .55, fog: .15 }),
  mk('豪雨', 0.84, { stratus: 1, cumulus: .85, cloudDark: .95, gloom: 2.25, rain: 1, wind: .7, lightning: .45, fog: .3 }),
  mk('嵐', 0.90, { stratus: 1, cumulus: .9, cloudDark: 1, gloom: 2.4, rain: .95, wind: 1, lightning: .7, fog: .3 }),
  mk('激しい嵐', 1.00, { stratus: 1, cumulus: 1, cloudDark: 1, gloom: 2.55, rain: 1, wind: 1, lightning: 1, fog: .38 }),
];
/** 逼迫が解けた直後に挟まる回復系（25〜28）。s=0が直後、1が収まり切る頃 */
const RECOVERY = [
  mk('雨上がり', 0.00, { stratus: .55, cumulus: .55, cloudDark: .45, gloom: .95, sun: .55, rays: .65, haze: .4, fog: .18, afterglow: .85, wind: .25 }),
  mk('虹', 0.33, { cumulus: .5, stratus: .22, cloudDark: .3, gloom: .55, sun: .85, rays: .3, haze: .28, rainbow: 1, afterglow: .6, rain: .08, wind: .15 }),
  mk('嵐のあとの晴れ間', 0.66, { cumulus: .68, stratus: .18, cloudDark: .25, gloom: .35, sun: .92, rays: .6, afterglow: .35, haze: .1, wind: .3 }),
  mk('凪', 1.00, { stratus: .5, cirrus: .2, cumulus: .2, cloudDark: .3, gloom: .55, sun: .35, haze: .38, fog: .15, afterglow: .25 }),
];
export const SKY_CATALOG = [...BAND.map((a) => a.name), ...RECOVERY.map((a) => a.name), '雪', '吹雪'];

function blendList(list, x, key) {
  const n = list.length;
  if (x <= list[0][key]) return { ...list[0].v, _i: 0, _f: 0 };
  for (let i = 1; i < n; i++) {
    if (x <= list[i][key]) {
      const a = list[i - 1], b = list[i];
      const t = (x - a[key]) / (b[key] - a[key] || 1);
      const out = {};
      KEYS.forEach((k) => { out[k] = lerp(a.v[k], b.v[k], t); });
      out._i = t < 0.5 ? i - 1 : i;
      return out;
    }
  }
  return { ...list[n - 1].v, _i: n - 1 };
}
RECOVERY.forEach((a) => { a.s = a.p; });

/* ------------------------------------------------------------
   日内のゆらぎ: 一日中同じ空にならないよう、見通しの値を
   ゆっくり揺らす（日付で決まる位相。再起動しても連続する）
   ------------------------------------------------------------ */
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  // 仕上げの攪拌（murmur3 fmix）。隣り合う日付で値が似通い、レアが連日出てしまうのを防ぐ
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}
const dateKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

export function skyDrift(date) {
  const k = dateKey(date);
  const min = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const f1 = strHash(k + 'a') * 6.283, f2 = strHash(k + 'b') * 6.283, f3 = strHash(k + 'c') * 6.283;
  return Math.sin((min / 47) * 6.283 + f1) * 0.5 + Math.sin((min / 29) * 6.283 + f2) * 0.3 + Math.sin((min / 83) * 6.283 + f3) * 0.2;
}

/* ------------------------------------------------------------
   季節のレア（30種とは別レイヤー）
   ------------------------------------------------------------
   日付で決まる出現（同じ日は一日中同じ）。出現は狭い時期の中でも
   数日に1回程度。荒れた空（雷雨以上）には重ねない。
   ------------------------------------------------------------ */
const md = (m, d) => m * 100 + d;
/** 月日 → 通し日数（時期の中心からの距離を、月をまたいでも正しく測るため） */
const dayNum = (v) => Math.floor(Date.UTC(2026, Math.floor(v / 100) - 1, v % 100) / 86400000);
const SEASONALS = [
  { kind: 'hatsuhinode', a: md(1, 1), b: md(1, 3), prob: 0.7, peak: md(1, 1), pMax: 0.5, when: 'dawn' },
  { kind: 'ume', a: md(2, 12), b: md(3, 10), prob: 0.38, peak: md(2, 26), pMax: 0.5, when: 'day' },
  { kind: 'sakura', a: md(3, 24), b: md(4, 12), prob: 0.5, peak: md(4, 2), pMax: 0.52, when: 'day' },
  { kind: 'hotaru', a: md(6, 1), b: md(6, 22), prob: 0.5, peak: md(6, 10), pMax: 0.4, when: 'night' },
  { kind: 'ajisai', a: md(6, 8), b: md(7, 12), prob: 0.6, peak: md(6, 24), pMin: 0.38, pMax: 0.66, when: 'any' },
  { kind: 'nyudo', a: md(7, 12), b: md(8, 31), prob: 0.38, peak: md(8, 1), pMax: 0.3, when: 'day' },
  { kind: 'hanabi', a: md(8, 1), b: md(8, 31), prob: 0.2, peak: md(8, 15), pMax: 0.45, when: 'night' },
  { kind: 'ryuusei', a: md(8, 11), b: md(8, 13), prob: 0.9, peak: md(8, 12), pMax: 0.3, when: 'night' },
  { kind: 'ryuusei', a: md(12, 13), b: md(12, 15), prob: 0.9, peak: md(12, 14), pMax: 0.3, when: 'night' },
  { kind: 'jugoya', a: md(9, 7), b: md(10, 7), prob: 1, peak: md(9, 25), pMax: 0.45, when: 'night', moon: true },
  { kind: 'momiji', a: md(11, 8), b: md(12, 6), prob: 0.42, peak: md(11, 26), pMax: 0.52, when: 'day' },
];
function seasonalFor(date, p, sm, relief) {
  const v = (date.getMonth() + 1) * 100 + date.getDate();
  const key = dateKey(date);
  const altDeg = sm.alt / RAD;
  for (const s of SEASONALS) {
    if (v < s.a || v > s.b) continue;
    if (s.moon) { const ph = moonPhase(date); if (Math.abs(ph - 0.5) > 0.034) continue; }
    else if (strHash(key + s.kind) > s.prob) continue;
    const span = Math.max(1, dayNum(s.b) - dayNum(s.a));
    const env = s.kind === 'hatsuhinode' ? 1 : lerp(0.55, 1, 1 - Math.min(1, Math.abs(dayNum(v) - dayNum(s.peak)) / (span * 0.6)));
    let tod = 1;
    if (s.when === 'night') tod = smooth(-6, -12, altDeg);
    else if (s.when === 'day') tod = smooth(-2, 6, altDeg);
    else if (s.when === 'dawn') tod = smooth(1.0, 0.2, Math.abs(sm.hours - sm.sunrise)); // 日の出の前後約1時間
    const pMin = s.pMin || 0;
    const gate = (1 - smooth(s.pMax - 0.08, s.pMax, p)) * smooth(pMin - 0.06, pMin, p) + (relief > 0.15 && !pMin ? 0.4 * relief : 0);
    const strength = clamp(env * tod * clamp(gate));
    if (strength > 0.02) return { kind: s.kind, strength };
  }
  return null;
}
/** 冬の度合い 0..1（雨が雪に置き換わる。12月上旬〜2月下旬） */
function winterFactor(date) {
  const m = date.getMonth() + 1, d = date.getDate();
  if (m >= 4 && m <= 9) return 0;
  const x = (m >= 10 ? (m - 10) * 30.5 : (m + 2) * 30.5) + d;
  return smooth(60, 80, x) * (1 - smooth(140, 162, x));
}

/* ------------------------------------------------------------
   時刻キーフレーム: 夜 → 夜明け → 昼 → 夕 → 夜（日の出・日の入りに追従）
   ------------------------------------------------------------ */
function timeFrames(sm) {
  const h = sm.hours;
  const keys = [
    [sm.sunrise - 1.4, 'night'], [sm.sunrise - 0.10, 'dawn'], [sm.sunrise + 1.7, 'day'],
    [sm.sunset - 1.35, 'day'], [sm.sunset - 0.06, 'dusk'], [sm.sunset + 1.25, 'night'],
  ];
  if (h <= keys[0][0] || h >= keys[5][0]) return { a: 'night', b: 'night', f: 0 };
  for (let i = 1; i < keys.length; i++) {
    if (h <= keys[i][0]) {
      const t = (h - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      return { a: keys[i - 1][1], b: keys[i][1], f: t * t * (3 - 2 * t) };
    }
  }
  return { a: 'night', b: 'night', f: 0 };
}

function paletteFor(set, gloom) {
  const g = gloom;
  const wc = clamp(g, 0, 1) * (g > 1 ? clamp(2 - g, 0, 1) : 1);
  const wr = clamp(g - 1, 0, 1);
  const w0 = clamp(1 - g, 0, 1);
  const wC = g <= 1 ? g : clamp(2 - g, 0, 1);
  const out = [];
  const k = clamp((g - 1.9) / 0.7, 0, 1);
  for (let i = 0; i < 6; i++) {
    const A = PAL[set].clear[i], B = PAL[set].cloudy[i], C = PAL[set].rain[i];
    let lab = g <= 1 ? mixLab(A, B, g) : mixLab(B, C, clamp(g - 1, 0, 1));
    if (k > 0) lab = [lab[0] * (1 - 0.42 * k), lab[1] * (1 - 0.2 * k), lab[2] * (1 - 0.2 * k) - 0.004 * k];
    out.push(lab);
  }
  void wc; void wr; void w0; void wC;
  return out;
}

/* ------------------------------------------------------------
   空の解決（入口）
   ------------------------------------------------------------ */
/**
 * @param {{pressure:number, relief?:number, date?:Date, drift?:number, force?:object}} args
 *   force: デバッグ・検証用。{ band:0..1 | index } 等で見通しを直接指定できる
 */
export function resolveSky({ pressure = 0, relief = 0, date = new Date(), drift = 0, force = null } = {}) {
  const sm = sunModel(date);
  const altDeg = sm.alt / RAD;

  // ① 見通し → 連続帯のどこにいるか（ゆらぎで近隣の空を行き来する）
  const p0 = clamp(pressure);
  const pEff = clamp(p0 + drift * 0.07);
  let base = blendList(BAND, pEff, 'p');
  let nameIdx = base._i;
  let name = BAND[nameIdx].name;

  // ② 回復系（逼迫が解けた直後）
  let rv = clamp(relief);
  if (force && force.recovery != null) rv = force.recovery;
  let rec = null;
  if (rv > 0.02) {
    rec = blendList(RECOVERY, 1 - rv, 's');
    const k = smooth(0.02, 0.22, rv) * 0.92;
    KEYS.forEach((key) => { base[key] = lerp(base[key], rec[key], k); });
    if (k > 0.5) name = RECOVERY[rec._i].name;
  }
  const P = {};
  KEYS.forEach((k) => { P[k] = base[k]; });

  // ③ 冬: 雨は雪に置き換わる
  const winter = force && force.winter != null ? force.winter : winterFactor(date);
  let snow = 0, blizzard = 0;
  if (winter > 0.01 && P.rain > 0.02) {
    snow = P.rain * winter;
    P.rain *= 1 - winter;
    P.lightning *= 1 - winter;
    P.gloom = lerp(P.gloom, Math.min(P.gloom, 1.5), winter);
    P.cloudDark = lerp(P.cloudDark, P.cloudDark * 0.8, winter);
    blizzard = smooth(0.7, 1.0, Math.max(P.wind, 0)) * smooth(0.5, 0.95, snow);
    if (snow > 0.12) name = blizzard > 0.4 ? '吹雪' : '雪';
  }

  // ④ 時刻に伴う補正: 朝の薄い靄（穏やかな日のみ）
  const frames = timeFrames(sm);
  const dawnW = (frames.a === 'dawn' ? 1 - frames.f : 0) + (frames.b === 'dawn' ? frames.f : 0);
  const calm = 1 - smooth(0.2, 0.45, pEff);
  const mist = dawnW * calm * (0.35 + 0.65 * strHash(dateKey(date) + 'mist'));
  P.fog = clamp(P.fog + 0.34 * mist);
  P.haze = clamp(P.haze + 0.2 * mist);

  // ⑤ 季節のレア
  let seasonal = force && force.seasonal ? { kind: force.seasonal, strength: 1 } : seasonalFor(date, pEff, sm, rv);
  let rainTint = 0, sunBoost = 0, moonBoost = 0, towerOn = 0;
  if (seasonal) {
    const s = seasonal.strength;
    if (seasonal.kind === 'ajisai') rainTint = s;
    if (seasonal.kind === 'hatsuhinode') {
      sunBoost = s; P.rays = Math.max(P.rays, 0.55 * s); P.sun = lerp(P.sun, 1, s);
      P.stratus *= 1 - 0.7 * s; P.cumulus *= 1 - 0.5 * s; P.gloom *= 1 - 0.8 * s;
    }
    if (seasonal.kind === 'jugoya') { moonBoost = s; P.sun = Math.max(P.sun, 0.9 * s); P.stratus *= 1 - 0.5 * s; P.gloom *= 1 - 0.5 * s; }
    if (seasonal.kind === 'nyudo') {
      towerOn = s; P.cumulus = Math.max(P.cumulus, 0.3);
      P.cirrus = P.cirrus * 0.4; P.stratus *= 0.3; P.gloom = Math.min(P.gloom, 0.2 + 0.1 * (1 - s));
    }
    if (['hotaru', 'hanabi', 'ryuusei'].includes(seasonal.kind)) {
      P.stratus *= 1 - 0.6 * s; P.cumulus *= 1 - 0.6 * s; P.cirrus *= 1 - 0.5 * s; P.haze *= 0.5;
    }
  }
  P.tower = Math.max(P.tower, towerOn);
  if (force) Object.keys(force).forEach((k) => { if (KEYS.includes(k)) P[k] = force[k]; });

  // ⑥ 色: 時刻 × 空の沈み(gloom)
  const palA = paletteFor(frames.a, P.gloom), palB = paletteFor(frames.b, P.gloom);
  let sky = palA.map((c, i) => mixLch(c, palB[i], frames.f));
  const tod = (c) => mixLch(TOD_LAB[frames.a][c], TOD_LAB[frames.b][c], frames.f);
  let lit = tod('lit'), shade = tod('shade'), sunC = tod('sun'), glowC = tod('glow'), hazeC = tod('haze'), ground = tod('ground');

  if (winter > 0.01 && (snow > 0.05)) {
    // 雪空は彩度を落として明るく
    sky = sky.map((c) => [c[0] + 0.05 * snow, c[1] * (1 - 0.45 * snow), c[2] * (1 - 0.45 * snow)]);
  }
  if (rainTint > 0) {
    const lav = hexLab('#8F8CCB');
    sky = sky.map((c, i) => mixLab(c, [c[0], lav[1] * 0.9, lav[2] * 0.9], 0.28 * rainTint * (i < 5 ? 1 : 0.6)));
  }
  if (sunBoost > 0) {
    const gold = hexLab('#FF9A4A');
    const idx = [3, 4, 5];
    idx.forEach((i) => { sky[i] = mixLab(sky[i], gold, 0.42 * sunBoost); });
    glowC = mixLab(glowC, hexLab('#FF7A3A'), 0.5 * sunBoost);
    sunC = mixLab(sunC, hexLab('#FFD08A'), 0.5 * sunBoost);
  }
  // 雨上がりの光: 地平線側が温まり、雲の縁が金色を帯びる
  if (P.afterglow > 0.01) {
    const warm = hexLab('#FFD7A0');
    sky[4] = mixLab(sky[4], warm, 0.22 * P.afterglow);
    sky[5] = mixLab(sky[5], warm, 0.30 * P.afterglow);
    lit = mixLab(lit, hexLab('#FFE9C8'), 0.25 * P.afterglow);
  }

  // 空が沈むほど、霧や霞は地平線の色（灰色）に寄る
  hazeC = mixLab(hazeC, sky[5], smooth(0.3, 1.6, P.gloom) * 0.85);

  // 地平線の色から稜線の色を導く（空気遠近法）
  const horizon = sky[5];
  const snowCover = winter * (0.35 + 0.5 * smooth(0, 0.6, snow + 0.15));
  let ridgeFar = mixLab(horizon, ground, 0.30), ridgeMid = mixLab(horizon, ground, 0.55), ridgeNear = mixLab(horizon, ground, 0.84);
  if (snowCover > 0.01) {
    const snowC = mixLab(hexLab('#DCE5F2'), horizon, 0.35);
    ridgeFar = mixLab(ridgeFar, snowC, 0.35 * snowCover);
    ridgeMid = mixLab(ridgeMid, snowC, 0.30 * snowCover);
    ridgeNear = mixLab(ridgeNear, mixLab(snowC, ground, 0.35), 0.40 * snowCover);
  }
  if (P.afterglow > 0.01) ridgeNear = mixLab(ridgeNear, horizon, 0.14 * P.afterglow); // 濡れた地面の照り

  // 夕方の可読性ヴェール（旧版の scrim を連続化）
  const duskW = (frames.a === 'dusk' ? 1 - frames.f : 0) + (frames.b === 'dusk' ? frames.f : 0);
  const scrimA = duskW * (0.52 - 0.14 * clamp(P.gloom, 0, 1));
  const scrimRgb = hexToRgb('#100A20');
  const rgb = (lab) => labToRgb(lab);

  // 光源（雲の陰影・光芒の基準）
  const [sx, sy] = screenPos(sm.H, sm.alt, sm);
  const sunVis = P.sun * smooth(-6, 2, altDeg);
  const sunRadius = 0.026 * (1 + 0.55 * clamp(1 - sm.alt / Math.max(sm.noonAlt, 0.2), 0, 1)) * (1 + 0.7 * sunBoost);

  const ph = moonPhase(date);
  const moonH = ((sm.H - ph * 2 * Math.PI + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const moonAlt = Math.asin(Math.sin(LAT) * Math.sin(sm.decl) + Math.cos(LAT) * Math.cos(sm.decl) * Math.cos(moonH));
  const [mx, my] = screenPos(moonH, moonAlt, sm);
  const illum = (1 - Math.cos(ph * 2 * Math.PI)) / 2;
  const moonVis = clamp(smooth(-1, 4, moonAlt / RAD) * smooth(-4, -10, altDeg + 0) * (0.35 + 0.65 * Math.max(P.sun, moonBoost)) * (0.3 + 0.7 * illum + 0.5 * moonBoost));
  // 月の明るい側は太陽の方向を向く
  let ldx = sx - mx, ldy = sy - my; const ll = Math.hypot(ldx, ldy) || 1; ldx /= ll; ldy /= ll;
  const alpha = ph * 2 * Math.PI;
  const moonL = [Math.sin(alpha) * ldx, -Math.sin(alpha) * ldy, -Math.cos(alpha)];

  const stars = smooth(-3, -13, altDeg) * (1 - 0.35 * illum * (1 - moonBoost * 0.3));
  const lightIsSun = altDeg > -4;
  const light = lightIsSun
    ? [sx, sy, clamp(0.25 + sunVis * 0.75)]
    : [mx, my, clamp(moonVis * 0.8)];

  // 虹: 太陽の反対側（高い太陽では見えない）
  const rbVis = P.rainbow * smooth(55, 18, altDeg) * smooth(-1, 5, altDeg);
  const rainbowC = [1 - sx * 0.9 + 0.05, HORIZON_Y + 0.12 + 0.08 * (1 - clamp(altDeg / 40))];

  // 文字トーン用の輝度（画面中ほどの色。雲が厚いほど実際は暗い）
  const mid = labToRgb(mixLab(sky[2], sky[3], 0.5));
  const scrimAtMid = scrimA * smooth(0.34, 1, 0.55);
  const midMix = mid.map((c, i) => lerp(c, scrimRgb[i], scrimAtMid));
  const cover = clamp(P.stratus * 0.85 + P.cumulus * 0.35);
  const lum = luminance(midMix) * (1 - 0.5 * P.cloudDark * cover) * (1 + 0.15 * snow);

  const nearRgb = rgb(ridgeNear);
  const edge = nearRgb.map((c, i) => lerp(c, scrimRgb[i], scrimA));

  return {
    name,
    sky: sky.map(rgb), horizonY: HORIZON_Y,
    lit: rgb(lit), shade: rgb(shade), sunColor: rgb(sunC), glowColor: rgb(glowC), hazeColor: rgb(hazeC),
    ridgeFar: rgb(ridgeFar), ridgeMid: rgb(ridgeMid), ridgeNear: nearRgb,
    scrim: [scrimRgb[0], scrimRgb[1], scrimRgb[2], scrimA], scrimFrom: 0.34,
    sun: [sx, sy, sunVis, sunRadius],
    moon: [mx, my, 0.034 * (1 + 0.35 * moonBoost), moonVis * (1 + 0.15 * moonBoost)],
    moonLight: moonL,
    light, stars: clamp(stars),
    cirrus: P.cirrus, cumulus: P.cumulus, stratus: P.stratus, cells: P.cells,
    cloudDark: P.cloudDark, wind: P.wind, haze: P.haze, fog: P.fog,
    rays: P.rays * (0.35 + 0.65 * smooth(-3, 12, altDeg)), rain: P.rain, snow, blizzard, lightning: P.lightning,
    rainbow: rbVis, rainbowC, afterglow: P.afterglow, tower: P.tower, rainTint,
    snowGround: snowCover, gloom: P.gloom,
    lum, zenith: rgbCss(rgb(sky[0])), edge: rgbCss(edge),
    seasonal, sunAlt: altDeg, moonBoost,
  };
}

/**
 * 文字トーン（ヒステリシス付き）。輝度が低い空では明るい文字にする。
 * しきい値0.19は、白文字と濃色文字(#26241E)のコントラストが釣り合う
 * 背景輝度（約0.2）に合わせた値。
 */
export function toneFor(lum, prev = 'dark') {
  const T = 0.19;
  if (prev === 'light') return lum > T + 0.025 ? 'dark' : 'light';
  return lum < T - 0.025 ? 'light' : 'dark';
}
