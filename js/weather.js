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
   空のグラデーション定義（時間帯 × 天候）
   ------------------------------------------------------------
   評価語（良い/悪い）ではなく状態語で命名する（憲法7条）。
   ------------------------------------------------------------ */
const SKY_GRADIENTS = {
  dawn:  { clear: ['#F4C9A0', '#F9DDBE', '#FCEEDD'], cloudy: ['#C9B9B2', '#DCD0C8', '#EDE6DE'], rain: ['#8C93A6', '#A8AEBD', '#C4C9D2'] },
  day:   { clear: ['#4F97DE', '#8FC5F0', '#DFF1FF'], cloudy: ['#8CA0B3', '#B5C4D2', '#DDE6ED'], rain: ['#5C6B7D', '#7C8B9C', '#A8B4BE'] },
  dusk:  { clear: ['#D9784F', '#C9678A', '#4A3B6B'], cloudy: ['#8E7286', '#93758E', '#463A5C'], rain: ['#5E5A72', '#5A5468', '#332B45'] },
  night: { clear: ['#0B1024', '#141C3A', '#232F52'], cloudy: ['#12162A', '#1B2138', '#272E48'], rain: ['#0A0D1C', '#12162A', '#1A2036'] },
};

/**
 * @param {string} timeOfDay 'dawn'|'day'|'dusk'|'night'
 * @param {string} condition 'clear'|'cloudy'|'rain'
 * @returns {[string,string,string]} 上→下のグラデーション3色
 */
export function getSkyGradient(timeOfDay, condition) {
  const byTime = SKY_GRADIENTS[timeOfDay] || SKY_GRADIENTS.day;
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
