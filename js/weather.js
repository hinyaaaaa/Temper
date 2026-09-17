/* ============================================================
   weather.js — 天候・空の状態（Temper UIの主要表現）
   ------------------------------------------------------------
   憲法6条: UIとタスク管理から分離する。この関数が失敗しても
   呼び出し側はフォールバック（晴れ・現在時刻ベースの空）に
   切り替えられる（憲法7条・11条、SPEC §18）。

   評価的な「良い/悪い」の意味付けは行わない（憲法7条、SPEC §7）。
   Open-Meteo（APIキー不要・無料）を使用。取得失敗時は
   呼び出し側が晴天として扱えるよう null を返すのみに徹する。
   ============================================================ */

const WEATHER_CODE_MAP = {
  // WMO Weather interpretation codes（Open-Meteo準拠）
  0: 'clear', 1: 'clear', 2: 'cloudy', 3: 'cloudy',
  45: 'cloudy', 48: 'cloudy',
  51: 'rain', 53: 'rain', 55: 'rain', 56: 'rain', 57: 'rain',
  61: 'rain', 63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain',
  71: 'rain', 73: 'rain', 75: 'rain', 77: 'rain',
  80: 'rain', 81: 'rain', 82: 'rain',
  85: 'rain', 86: 'rain',
  95: 'rain', 96: 'rain', 99: 'rain',
};

/**
 * @returns {Promise<{lat:number, lon:number}|null>}
 */
function getGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 6000, maximumAge: 600000 }
    );
  });
}

/**
 * @param {{lat:number, lon:number}} coords
 * @returns {Promise<{condition:string, temperature:number|null}|null>}
 */
async function fetchWeather(coords) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const code = data && data.current && data.current.weather_code;
    const temp = data && data.current && data.current.temperature_2m;
    return {
      condition: WEATHER_CODE_MAP[code] || 'cloudy',
      temperature: typeof temp === 'number' ? Math.round(temp) : null,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 天候取得の一括処理。失敗時は null（呼び出し側はフォールバックへ）。
 * @param {string|null} manualOverride ユーザーが手動設定した天候（設定画面、任意）
 */
export async function getWeather(manualOverride = null) {
  if (manualOverride) return { condition: manualOverride, temperature: null, source: 'manual' };
  const coords = await getGeolocation();
  if (!coords) return null;
  const weather = await fetchWeather(coords);
  if (!weather) return null;
  return { ...weather, source: 'auto' };
}

/* ------------------------------------------------------------
   時間帯の判定（SPEC §7, §8）— 朝・昼・夕方・夜
   ------------------------------------------------------------ */
export function getTimeOfDay(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 10) return 'dawn';
  if (h >= 10 && h < 16) return 'day';
  if (h >= 16 && h < 19) return 'dusk';
  return 'night';
}

/* ------------------------------------------------------------
   空のプロファイル定義（時間帯 × 天候）
   ------------------------------------------------------------
   評価語（良い/悪い）ではなく状態語で命名する（憲法7条）。

   従来は「上中下3色の線形グラデーション」だけで空を表現していたが、
   実際に描画した結果、ただの色帯にしか見えず「空」という現象
   （光源の位置・大気の霞み・雲の陰影）が一切感じられないという
   重大な見た目の問題があった（自己採点でD評価とした核心の指摘）。

   この修正では、各時間帯×天候の組を「グラデーション停止点(4点)」
   「光源(太陽/月)の色・位置・大きさ・強さ」「雲の色調・不透明度・
   高度」「星の見え方」を持つプロファイルとして再定義し、app.js側で
   これらすべてを層として重ねて描画する。
   ------------------------------------------------------------ */
const SKY_PROFILES = {
  dawn: {
    clear: {
      stops: ['#FFB37A 0%', '#F9A88C 22%', '#F3C7A8 48%', '#FCE8CE 75%', '#FFF6E8 100%'],
      sun: { color: '#FFF2D2', glow: '#FFB37A', x: 78, y: 42, size: 26, strength: 0.9 },
      cloud: { tint: 'rgba(255,230,210,0.55)', opacity: 0.0 },
      starOpacity: 0,
    },
    cloudy: {
      stops: ['#C9AFA0 0%', '#D6BEB0 25%', '#E2CFC4 50%', '#EDDFD6 75%', '#F3EAE3 100%'],
      sun: { color: '#F3D9BE', glow: '#E8C4A0', x: 76, y: 40, size: 34, strength: 0.35 },
      cloud: { tint: 'rgba(255,255,255,0.5)', opacity: 0.85 },
      starOpacity: 0,
    },
    rain: {
      stops: ['#7C8494 0%', '#8E93A0 25%', '#A3A8B4 50%', '#B9BEC7 75%', '#CBCFD6 100%'],
      sun: { color: '#B7BCC6', glow: '#9BA0AC', x: 74, y: 38, size: 40, strength: 0.12 },
      cloud: { tint: 'rgba(120,126,140,0.6)', opacity: 0.95 },
      starOpacity: 0,
    },
  },
  day: {
    clear: {
      stops: ['#2E86DE 0%', '#4F97DE 20%', '#7CB9EC 45%', '#B7DDF6 72%', '#E8F5FF 100%'],
      sun: { color: '#FFFCF0', glow: '#FFF3C4', x: 80, y: 38, size: 20, strength: 1.0 },
      cloud: { tint: 'rgba(255,255,255,0.85)', opacity: 0.0 },
      starOpacity: 0,
    },
    cloudy: {
      stops: ['#7C93A8 0%', '#8FA3B5 22%', '#A6B8C6 48%', '#C4D1DA 75%', '#DFE7EC 100%'],
      sun: { color: '#F3F6F8', glow: '#DDE6EC', x: 78, y: 40, size: 32, strength: 0.3 },
      cloud: { tint: 'rgba(255,255,255,0.92)', opacity: 0.9 },
      starOpacity: 0,
    },
    rain: {
      stops: ['#414F5E 0%', '#4E5C6B 25%', '#606E7C 50%', '#7A8794 75%', '#96A1AB 100%'],
      sun: { color: '#8A94A0', glow: '#6F7A87', x: 76, y: 40, size: 38, strength: 0.1 },
      cloud: { tint: 'rgba(70,78,90,0.7)', opacity: 1.0 },
      starOpacity: 0,
    },
  },
  dusk: {
    clear: {
      // 従来案は中間色(#B15A72)だけ彩度が突出して段差(バンディング)のように
      // 見える問題があった。実際の夕焼けは天頂の紺→中天でいったん彩度の
      // 低いグレー味を帯びた遷移帯を経て→地平線の濃い朱色→最下部の金色、
      // という「彩度が単調に増減しない」構造を持つ。この谷を作ることで
      // 段差感を消し、自然な移行にした。
      stops: ['#232152 0%', '#413659 26%', '#6B4B62 46%', '#B85C4E 68%', '#E8934A 84%', '#F9C77E 100%'],
      sun: { color: '#FFE1A6', glow: '#F0895C', x: 50, y: 84, size: 30, strength: 0.85 },
      cloud: { tint: 'rgba(230,150,140,0.5)', opacity: 0.0 },
      starOpacity: 0.25,
    },
    cloudy: {
      stops: ['#282744 0%', '#413B50 26%', '#69525A 46%', '#8F6259 68%', '#AD7359 84%', '#C48F6C 100%'],
      sun: { color: '#E8B896', glow: '#C97E68', x: 50, y: 80, size: 40, strength: 0.28 },
      cloud: { tint: 'rgba(140,110,120,0.65)', opacity: 0.85 },
      starOpacity: 0.1,
    },
    rain: {
      stops: ['#1D1B38 0%', '#2C2840 26%', '#403A48 46%', '#534A4E 68%', '#615350 84%', '#6E5F58 100%'],
      sun: { color: '#7A6E78', glow: '#5C5260', x: 50, y: 78, size: 46, strength: 0.08 },
      cloud: { tint: 'rgba(50,45,60,0.75)', opacity: 1.0 },
      starOpacity: 0,
    },
  },
  night: {
    clear: {
      stops: ['#050714 0%', '#0A0F24 28%', '#121A36 55%', '#1C2748 78%', '#293860 100%'],
      sun: { color: '#E8ECF5', glow: '#B9C4DD', x: 80, y: 40, size: 13, strength: 0.55 },
      cloud: { tint: 'rgba(120,135,170,0.3)', opacity: 0.0 },
      starOpacity: 1.0,
    },
    cloudy: {
      stops: ['#080A16 0%', '#0E121F 28%', '#161C2C 55%', '#20283A 78%', '#2C3548 100%'],
      sun: { color: '#C7CEDD', glow: '#9AA4BC', x: 78, y: 42, size: 24, strength: 0.15 },
      cloud: { tint: 'rgba(60,68,90,0.55)', opacity: 0.75 },
      starOpacity: 0.35,
    },
    rain: {
      stops: ['#05060E 0%', '#090B16 28%', '#0E1220 55%', '#141A2A 78%', '#1B2436 100%'],
      sun: { color: '#8791A8', glow: '#626C82', x: 76, y: 42, size: 30, strength: 0.05 },
      cloud: { tint: 'rgba(20,24,36,0.7)', opacity: 0.95 },
      starOpacity: 0,
    },
  },
};

/**
 * @param {string} timeOfDay 'dawn'|'day'|'dusk'|'night'
 * @param {string} condition 'clear'|'cloudy'|'rain'
 * @returns {object} SKY_PROFILESの該当エントリ
 */
export function getSkyProfile(timeOfDay, condition) {
  const byTime = SKY_PROFILES[timeOfDay] || SKY_PROFILES.day;
  return byTime[condition] || byTime.clear;
}

/** 空の色に対して十分なコントラストを持つテキスト色（明/暗）を返す */
export function getTextToneFor(timeOfDay) {
  return timeOfDay === 'night' || timeOfDay === 'dusk' ? 'light' : 'dark';
}

export const WEATHER_LABELS = {
  clear: '晴れ',
  cloudy: '曇り',
  rain: '雨',
};

export const TIME_LABELS = {
  dawn: '朝',
  day: '昼',
  dusk: '夕方',
  night: '夜',
};
