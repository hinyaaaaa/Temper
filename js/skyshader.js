/* ============================================================
   skyshader.js — 空のフラグメントシェーダー（v1.8.0 新設）
   ------------------------------------------------------------
   円や楕円を重ねた「幾何学的な雲」を避けるため、雲は多重の
   ノイズ（領域ワープ付き）で作り、光源方向の密度差で陰影を付ける。
   層: 星 → 月 → 太陽 → 入道雲 → 巻雲 → 層雲 → 積雲 → 光芒 → 霧
       → 稜線(3層) → 虹 → 雨/雪 → 稲光 → 夕方のヴェール
   WebGL2 (GLSL ES 3.00)。
   ============================================================ */
export const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uDrift;      // 雲の位置（風で積算。風が変わっても飛ばない）
uniform float uHorizon;
uniform vec3  uSky[6];
uniform vec3  uLit, uShade, uSunCol, uGlow, uHaze;
uniform vec3  uRidgeFar, uRidgeMid, uRidgeNear;
uniform vec4  uScrim;      // rgb, alpha
uniform float uScrimFrom;
uniform vec4  uSun;        // x, y, 強さ, 半径
uniform vec4  uMoon;       // x, y, 半径, 明るさ
uniform vec3  uMoonL;      // 月の光の向き
uniform vec3  uLight;      // 雲の光源 x, y, 強さ
uniform float uStars;
uniform vec4  uCloudA;     // cirrus, cumulus, stratus, cells
uniform vec4  uCloudB;     // dark, wind, haze, fog
uniform vec4  uFx;         // rays, rain, snow, flash
uniform vec4  uFx2;        // rainbow, afterglow, tower, rainTint
uniform vec4  uFx3;        // blizzard, snowGround, moonBoost, seed
uniform vec2  uRainbowC;

/* ---------- ノイズ ---------- */
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2  h22(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
vec2 grad(vec2 i){ return normalize(h22(i) * 2.0 - 1.0 + 1e-4); }
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f);
  float b = dot(grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.7071 + 0.5;
}
const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);
float fbm(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * gnoise(p); n += a;
    p = ROT * p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s / n;
}

float contrast(float v){ return clamp((v - 0.5) * 1.95 + 0.5, 0.0, 1.0); }

/* ---------- 雲の平面（地平線に向かって遠近で縮む） ---------- */
vec2 cloudPlane(vec2 uv, float asp){
  float a = max(uHorizon - uv.y, 0.0) / uHorizon;
  float depth = 1.0 / (a * 0.95 + 0.34);
  return vec2((uv.x - 0.5) * asp * depth * 1.5, depth * 1.8) + uDrift + vec2(uFx3.w * 37.0, uFx3.w * 11.0);
}

vec3 skyGrad(float g){
  if (g < 0.20) return mix(uSky[0], uSky[1], g / 0.20);
  if (g < 0.42) return mix(uSky[1], uSky[2], (g - 0.20) / 0.22);
  if (g < 0.64) return mix(uSky[2], uSky[3], (g - 0.42) / 0.22);
  if (g < 0.84) return mix(uSky[3], uSky[4], (g - 0.64) / 0.20);
  return mix(uSky[4], uSky[5], (g - 0.84) / 0.16);
}

/* 雲の色: 陰影・内部の暗さ・光源の前方散乱・稲光 */
vec3 cloudColor(float lightAmt, float thick, float thin, vec2 uv, float asp, float alt){
  float dk = uCloudB.x;
  vec3 lit = mix(uLit, uShade * 0.46, dk * 0.90);
  vec3 sh  = uShade * (1.0 - 0.78 * dk);
  vec3 c = mix(sh, lit, lightAmt);
  c *= 1.0 - dk * 0.30 * thick;
  float lg = exp(-length((uv - uLight.xy) * vec2(asp, 1.0)) * 4.2) * uLight.z;
  c += uGlow * lg * (0.60 * thin + 0.08) * (1.0 - dk * 0.75);
  c += uLit * lg * 0.18 * thin * uFx2.y;                         // 雨上がりの縁の輝き
  c += vec3(0.58, 0.66, 1.0) * uFx.w * (0.16 + 0.34 * lightAmt); // 稲光が雲の中で光る
  c = mix(c, uHaze, smoothstep(0.30, 0.0, alt) * (0.35 + 0.4 * uCloudB.z));
  return c;
}

vec2 lightDir(vec2 uv, float asp){
  vec2 d = (uLight.xy - uv) * vec2(asp, 1.0);
  return d / (length(d) + 0.18);
}

float worley(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float m = 8.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + h22(i + g) - f;
      m = min(m, dot(r, r));
    }
  }
  return sqrt(m);
}
/* 積雲の密度。cells=1 でひつじ雲（丸い小さな群れが帯状に並ぶ） */
float cumDensity(vec2 pw, float cells){
  float b = fbm(pw * 2.3, 6);
  if (cells < 0.01) return contrast(b);
  vec2 cp = (pw + 0.35 * vec2(fbm(pw * 1.4, 3), fbm(pw * 1.4 + 5.0, 3))) * vec2(6.4, 8.6);
  float cell = 1.0 - worley(cp);
  float detail = fbm(pw * 9.0 + 4.0, 3);
  float band = fbm(pw * vec2(0.55, 1.1) + vec2(8.0, 2.0), 3);
  float rag = fbm(pw * 17.0 + 2.0, 3);
  float c = cell * 0.62 + 0.55 * detail * (0.6 + 0.8 * rag) - 0.16;
  c *= smoothstep(0.26, 0.60, band);
  return mix(contrast(b), clamp(c * 1.25, 0.0, 1.0), cells);
}

/* ---------- 巻雲（すじ雲）: 流れに沿って曲がり、途切れ、薄く消える ---------- */
vec4 cirrusLayer(vec2 uv, float asp, float alt){
  float amt = uCloudA.x;
  if (amt < 0.01) return vec4(0.0);
  vec2 c = (uv - vec2(0.5, 0.42)) * vec2(asp, 1.0);
  c = mat2(0.96, -0.28, 0.28, 0.96) * c;
  vec2 dr = vec2(uDrift.x * 0.09, 0.0);
  vec2 w = vec2(fbm(c * 1.5 + dr + vec2(1.0, 2.0), 4), fbm(c * 1.5 + dr + vec2(6.0, 9.0), 4));
  vec2 q = c + (w - 0.5) * 0.30;
  float n = fbm(vec2(q.x * 1.1 + dr.x, q.y * 7.5), 5);
  float r = 1.0 - abs(contrast(n) * 2.0 - 1.0);
  float streak = pow(r, 2.6);
  float fine = fbm(vec2(q.x * 4.0 + dr.x * 2.0, q.y * 24.0) + 4.0, 4);
  streak *= 0.55 + 0.9 * fine;
  float gaps = contrast(fbm(c * 1.9 + dr * 0.7 + vec2(9.0, 3.0), 4));
  float cov = smoothstep(0.28, 0.80, streak) * smoothstep(0.62 - amt * 0.55, 0.86 - amt * 0.35, gaps);
  cov *= smoothstep(0.03, 0.30, alt);
  float lg = exp(-length((uv - uLight.xy) * vec2(asp, 1.0)) * 3.2) * uLight.z;
  vec3 c0 = mix(uLit, uGlow, 0.22 * lg + 0.06) * (0.90 + 0.14 * fine) + uGlow * lg * 0.25;
  c0 = mix(c0, uShade, 0.20 * uCloudB.x + 0.10 * (1.0 - streak));
  c0 += vec3(0.6, 0.68, 1.0) * uFx.w * 0.4;
  return vec4(c0, cov * 0.72 * clamp(amt * 1.2, 0.0, 1.0));
}

/* ---------- 層雲（空を覆う）: ゆるやかな濃淡。渦を巻かない ---------- */
vec4 stratusLayer(vec2 uv, float asp, float alt){
  float amt = uCloudA.z;
  if (amt < 0.01) return vec4(0.0);
  vec2 p = cloudPlane(uv, asp) * 0.62;
  vec2 w = vec2(fbm(p * 0.7 + vec2(2.0, 0.0), 3), fbm(p * 0.7 + vec2(8.0, 5.0), 3));
  vec2 pw = p + (w - 0.5) * 0.45;
  float d  = contrast(fbm(pw * 1.35, 5));
  float T = mix(0.84, 0.10, amt);
  float dens = smoothstep(T, T + 0.30 + 0.30 * (1.0 - amt), d);
  vec2 L = lightDir(uv, asp);
  float d1 = contrast(fbm((pw + L * 0.06) * 1.35, 5));
  float lightAmt = clamp(0.56 + (d - d1) * 1.5 + 0.30 * (d - 0.5), 0.0, 1.0);
  lightAmt = mix(lightAmt, 0.5 + 0.2 * alt, 0.25 * uCloudB.x);
  float thick = smoothstep(T, T + 0.50, d);
  float thin = 1.0 - thick;
  vec3 c = cloudColor(lightAmt, thick, thin, uv, asp, alt);
  float a = dens * smoothstep(0.0, 0.08, alt + 0.03);
  a *= mix(0.60, 1.0, smoothstep(0.35, 1.0, amt));
  return vec4(c, a);
}

/* ---------- 積雲（ふくらみ・ひつじ雲）---------- */
vec4 cumulusLayer(vec2 uv, float asp, float alt){
  float amt = uCloudA.y;
  if (amt < 0.01) return vec4(0.0);
  vec2 p = cloudPlane(uv, asp);
  float cells = uCloudA.w;
  vec2 q = vec2(fbm(p * 0.55 + vec2(0.0, uTime * 0.004), 3), fbm(p * 0.55 + vec2(5.2, 1.3), 3));
  vec2 pw = p + (q - 0.5) * 0.5;
  float d = cumDensity(pw, cells);
  float T = mix(0.80, 0.34, amt);
  float soft = mix(0.075, 0.36, cells) + 0.05 * (1.0 - amt);
  float dens = smoothstep(T, T + soft, d);
  vec2 L = lightDir(uv, asp);
  float d1 = cumDensity(pw + L * mix(0.05, 0.035, cells), cells);
  float lightAmt = clamp(0.60 + (d - d1) * mix(3.8, 2.2, cells), 0.0, 1.0);
  float thick = smoothstep(T, T + 0.30, d);
  float thin = 1.0 - thick;
  float rim = dens * (1.0 - dens) * 4.0;
  vec3 c = cloudColor(lightAmt, thick, thin + rim * 0.6, uv, asp, alt);
  c += uGlow * rim * 0.12 * uLight.z * (1.0 - uCloudB.x);
  float a = dens * smoothstep(0.0, 0.09, alt) * mix(0.85, 1.0, thick) * mix(1.0, 0.86, cells);
  return vec4(c, a);
}

/* ---------- 入道雲（積乱雲）---------- */
vec4 towerLayer(vec2 uv, float asp, float alt){
  float tw = uFx2.z;
  if (tw < 0.01) return vec4(0.0);
  vec2 q = vec2((uv.x - 0.72) * asp, uHorizon - uv.y);
  float h = q.y / 0.44;
  if (h < -0.06 || h > 1.35) return vec4(0.0);
  float n  = fbm(vec2(q.x * 5.2 + 2.0, q.y * 4.6) + vec2(0.0, uTime * 0.012), 5);
  float w0 = mix(0.105, 0.070, smoothstep(0.0, 0.85, h));
  float flare = smoothstep(0.70, 1.02, h) * (1.0 - smoothstep(1.02, 1.22, h));
  float w = (w0 + 0.12 * flare) * (0.72 + 0.70 * n);
  float edge = abs(q.x + 0.02 * sin(q.y * 9.0)) / w;
  float dens = smoothstep(1.0, 0.52, edge);
  dens *= smoothstep(-0.03, 0.08, h) * (1.0 - smoothstep(1.00, 1.22 + 0.10 * n, h));
  vec2 L = lightDir(uv, asp);
  float n1 = fbm(vec2((q.x + L.x * 0.05) * 5.2 + 2.0, (q.y - L.y * 0.05) * 4.6) + vec2(0.0, uTime * 0.012), 5);
  float lightAmt = clamp(0.62 + (n - n1) * 6.0 + 0.25 * (n - 0.5), 0.0, 1.0);
  vec3 c = cloudColor(lightAmt, 0.6, 0.25, uv, asp, alt * 0.6 + 0.12);
  c = mix(c, uLit, 0.18);
  return vec4(c, dens * tw * 0.96);
}

/* ---------- 星 ---------- */
float starField(vec2 uv, float asp){
  float s = 0.0;
  for (int L = 0; L < 3; L++){
    float sc = L == 0 ? 52.0 : (L == 1 ? 96.0 : 170.0);
    vec2 g = uv * vec2(asp, 1.0) * sc;
    vec2 id = floor(g), f = fract(g) - 0.5;
    float r = h21(id + float(L) * 13.7);
    float thr = 0.955 + 0.014 * float(L);
    if (r > thr){
      vec2 off = (h22(id + 3.1) - 0.5) * 0.6;
      float d = length(f - off);
      float tw = 0.62 + 0.38 * sin(uTime * (1.2 + r * 4.0) + r * 61.0);
      float sz = (L == 0 ? 0.11 : (L == 1 ? 0.075 : 0.05)) * (0.7 + (r - thr) * 12.0);
      s += (smoothstep(sz, 0.0, d) + 0.25 * smoothstep(sz * 3.2, 0.0, d)) * tw * (0.45 + 0.8 * (r - thr) / (1.0 - thr));
    }
  }
  return s;
}

/* ---------- 虹 ---------- */
vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

/* ---------- 雨・雪 ---------- */
float rainLayer(vec2 uv, float asp, float cols, float speed, float len, float width, float prob, float slant, float seed, float freq){
  float u = uv.x * asp - uv.y * slant;
  float cx = u * cols;
  float id = floor(cx);
  float fx = fract(cx) - 0.5 + 0.10 * sin(uv.y * 11.0 + id * 1.7);
  float r = h21(vec2(id, seed));
  float pres = step(r, prob);
  float s = uv.y * freq - uTime * speed * (0.85 + 0.3 * h21(vec2(id, seed + 3.0))) + r * 9.0;
  float f = fract(s);
  float L = len * (0.55 + 0.9 * h21(vec2(id + 11.0, seed)));
  float b = f < L ? pow(f / L, 1.8) : 0.0;
  return pres * b * smoothstep(width, 0.0, abs(fx));
}
float snowLayer(vec2 uv, float asp, float scale, float speed, float size, float seed, float wind, float dens){
  vec2 p = uv * vec2(asp, 1.0) * scale;
  p.y -= uTime * speed;
  p.x += sin(uTime * 0.45 + p.y * 0.55 + seed) * 0.7 + uTime * wind;
  vec2 id = floor(p), f = fract(p);
  vec2 r = h22(id + seed);
  vec2 c = 0.22 + 0.56 * r;
  float d = length((f - c) * vec2(1.0, 1.0 + uFx3.x * 2.2));
  float rad = size * (0.45 + 0.55 * h21(id + 7.0));
  float vis = step(h21(id + 3.0), dens);
  return smoothstep(rad, rad * 0.15, d) * vis * (0.55 + 0.45 * h21(id));
}

void main(){
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  float asp = uRes.x / uRes.y;
  float H = uHorizon;
  float g = clamp(uv.y / H, 0.0, 1.0);
  float alt = max(H - uv.y, 0.0) / H;
  float px = 1.5 / uRes.y;

  /* 空の勾配と霞 */
  vec3 col = skyGrad(g);
  col = mix(col, uHaze, uCloudB.z * (0.10 + 0.55 * smoothstep(0.30, 1.0, g)));

  /* 星・天の川 */
  if (uStars > 0.01){
    float sf = starField(uv, asp) * uStars * smoothstep(1.0, 0.45, g);
    vec2 mq = (uv - 0.5) * vec2(asp, 1.0);
    float band = exp(-pow((mq.x * 0.62 + mq.y * 0.78 + 0.05) * 3.4, 2.0));
    float mw = band * (0.55 + 0.9 * fbm(mq * 6.0 + 3.0, 4)) * uStars * 0.075 * smoothstep(1.0, 0.4, g);
    col += vec3(0.78, 0.84, 1.0) * mw;
    col += vec3(0.95, 0.97, 1.0) * sf;
  }

  /* 月 */
  if (uMoon.w > 0.01){
    vec2 md = (uv - uMoon.xy) * vec2(asp, 1.0);
    float dist = length(md);
    float R = uMoon.z;
    float halo = exp(-dist / R * 0.9) * 0.20 + exp(-dist / R * 0.22) * 0.07;
    col += vec3(0.72, 0.80, 0.98) * halo * uMoon.w * (1.0 + 0.8 * uFx3.z);
    if (dist < R * 1.15){
      vec2 m = md / R;
      float r2 = dot(m, m);
      vec3 n = vec3(m.x, -m.y, sqrt(max(1.0 - r2, 0.0)));
      float lit = smoothstep(-0.04, 0.10, dot(n, normalize(uMoonL)));
      float mar = smoothstep(0.46, 0.64, fbm(m * 1.8 + vec2(3.0, 7.0), 4)) * 0.20
                + 0.07 * fbm(m * 7.0 + 1.0, 3);
      mar += 0.10 * pow(r2, 3.0);                                  // 縁の周辺減光
      vec3 surf = mix(vec3(1.0, 0.97, 0.91), vec3(1.0, 0.92, 0.78), uFx3.z) * (0.97 - mar);
      vec3 mc = surf * lit + vec3(0.05, 0.07, 0.11) * (1.0 - lit);
      float body = smoothstep(R * 1.0, R * 0.965, sqrt(r2) * R) * clamp(uMoon.w * 1.2, 0.0, 1.0);
      col = mix(col, mc, body * (0.14 + 0.86 * lit));              // 影の側はほとんど空に溶ける
    }
  }

  /* 太陽 */
  if (uSun.z > 0.01){
    vec2 sd = (uv - uSun.xy) * vec2(asp, 1.0);
    float dist = length(sd);
    float R = uSun.w;
    float glow = exp(-dist * 6.5) * 0.30 + exp(-dist * 20.0) * 0.40 + exp(-dist * 2.3) * 0.075;
    vec3 gc = clamp(uGlow * glow * uSun.z, 0.0, 0.92);
    col = 1.0 - (1.0 - col) * (1.0 - gc);                      // スクリーン合成（青空で水色に濁らない）
    float veil = clamp((1.0 - uSun.z) * 1.7, 0.0, 1.0);
    float disc = smoothstep(R * (1.0 + 1.6 * veil), R * (0.72 - 0.6 * veil), dist) * (1.0 - 0.55 * veil);
    vec3 dcol = mix(uSunCol, vec3(1.0), 0.45 * smoothstep(R, 0.0, dist));
    col = mix(col, dcol, disc * clamp(uSun.z * 1.15, 0.0, 1.0));
  }

  /* 雲 */
  vec4 cl;
  cl = towerLayer(uv, asp, alt);  col = mix(col, cl.rgb, cl.a);
  cl = cirrusLayer(uv, asp, alt); col = mix(col, cl.rgb, cl.a);
  cl = stratusLayer(uv, asp, alt); col = mix(col, cl.rgb, cl.a);
  cl = cumulusLayer(uv, asp, alt); col = mix(col, cl.rgb, cl.a);
  float cloudA = cl.a;

  /* 光芒: 雲の切れ間から下へ広がる、ぼんやりした柱（放射状の直線にしない） */
  float rays = uFx.x;
  if (rays > 0.01 && uLight.z > 0.05){
    vec2 dd = (uv - uLight.xy) * vec2(asp, 1.0);
    float dist = length(dd) + 1e-4;
    float ang = atan(dd.y, dd.x);
    float rr = fbm(vec2(ang * 2.3 + uDrift.x * 0.05, dist * 1.4 + uTime * 0.01), 4);
    rr = smoothstep(0.38, 0.82, contrast(rr));
    float down = smoothstep(-0.35, 0.65, dd.y / dist);
    float fall = exp(-dist * 1.7) * smoothstep(0.03, 0.22, dist);
    vec3 rc = uGlow * rr * fall * down * rays * uLight.z * (0.22 + 0.55 * (1.0 - cloudA));
    col = 1.0 - (1.0 - col) * (1.0 - clamp(rc * 0.55, 0.0, 0.8));
  }

  /* 地平線の霧 */
  float fg = uCloudB.w;
  if (fg > 0.01){
    float fh = smoothstep(0.95, 0.0, alt) * (0.55 + 0.45 * fbm(vec2(uv.x * asp * 2.2 + uTime * 0.01, uv.y * 3.0), 4));
    col = mix(col, uHaze * 0.96 + 0.04, clamp(fg * (0.35 + 0.65 * fh) * (0.5 + 0.5 * smoothstep(0.9, 0.0, alt)), 0.0, 0.96));
  }

  /* 虹 */
  if (uFx2.x > 0.01){
    vec2 rq = (uv - uRainbowC) * vec2(asp, 1.0);
    float rr = length(rq);
    float R1 = 0.62, bw = 0.062;
    float x1 = (rr - R1) / bw;
    float a1 = smoothstep(1.25, 0.45, abs(x1));
    vec3 s1 = hsv2rgb(vec3(clamp(0.76 * (1.0 - clamp(x1 * 0.5 + 0.5, 0.0, 1.0)), 0.0, 0.76), 0.78, 1.0));
    float R2 = R1 * 1.27;
    float x2 = (rr - R2) / (bw * 1.3);
    float a2 = smoothstep(1.25, 0.45, abs(x2)) * 0.30;
    vec3 s2 = hsv2rgb(vec3(clamp(0.76 * clamp(x2 * 0.5 + 0.5, 0.0, 1.0), 0.0, 0.76), 0.62, 1.0));
    float mask = smoothstep(H + 0.03, H - 0.10, uv.y);
    vec3 rb = (s1 * a1 + s2 * a2) * mask * uFx2.x;
    col = 1.0 - (1.0 - col) * (1.0 - clamp(rb * (0.50 - 0.22 * cloudA), 0.0, 0.85));
    float inner = exp(-pow((rr - R1 * 0.80) / 0.20, 2.0));
    col = 1.0 - (1.0 - col) * (1.0 - uGlow * inner * mask * uFx2.x * 0.05);   // 虹の内側がわずかに明るい
  }

  /* 稜線（遠・中・近）。空気遠近法 + 谷霧 */
  float x = uv.x;
  float nF = fbm(vec2(x * 2.0 + 3.1, 1.3), 5);
  float nM = fbm(vec2(x * 2.8 + 7.0, 4.1), 5);
  float nN = fbm(vec2(x * 3.6 + 11.3, 8.7), 4);
  float tF = H - 0.095 * smoothstep(0.30, 0.82, nF) + 0.006;
  float tM = H + 0.022 - 0.052 * smoothstep(0.25, 0.85, nM);
  float tN = H + 0.088 - 0.042 * nN + 0.011 * (fbm(vec2(x * 24.0, 3.0), 3) - 0.5) + 0.004 * (h21(vec2(floor(x * 190.0), 2.0)) - 0.5);
  float mistAmt = clamp(0.18 + uCloudB.w * 0.9 + uCloudB.z * 0.5, 0.0, 1.0);
  float lightK = uLight.z * (1.0 - uCloudB.x * 0.6);

  vec3 farC = mix(uRidgeFar, uHaze, 0.18 + 0.45 * uCloudB.z);
  float mF = smoothstep(0.0, px, uv.y - tF);
  farC += uGlow * exp(-(uv.y - tF) * 70.0) * 0.14 * lightK;
  col = mix(col, farC, mF);

  float mist1 = smoothstep(tF - 0.03, tF + 0.05, uv.y) * (1.0 - smoothstep(tM - 0.01, tM + 0.06, uv.y));
  col = mix(col, uHaze, mist1 * mistAmt * 0.55 * (0.6 + 0.4 * fbm(vec2(x * 6.0 + uTime * 0.006, 2.0), 3)));

  vec3 midC = mix(uRidgeMid, uHaze, 0.08 + 0.3 * uCloudB.z);
  midC += uGlow * exp(-(uv.y - tM) * 80.0) * 0.12 * lightK;
  col = mix(col, midC, smoothstep(0.0, px, uv.y - tM));

  float mist2 = smoothstep(tM - 0.02, tM + 0.05, uv.y) * (1.0 - smoothstep(tN - 0.01, tN + 0.05, uv.y));
  col = mix(col, uHaze, mist2 * mistAmt * 0.45);

  vec3 nearC = mix(mix(uRidgeNear, uRidgeMid, 0.40), uRidgeNear, smoothstep(0.0, 0.10, uv.y - tN));
  nearC *= 0.94 + 0.10 * fbm(vec2(x * 8.0, uv.y * 30.0), 3) * smoothstep(0.96, 0.84, uv.y);
  float snowTop = uFx3.y;
  nearC += vec3(0.80, 0.86, 0.96) * exp(-(uv.y - tN) * 90.0) * 0.30 * snowTop;
  col = mix(col, nearC, smoothstep(0.0, px, uv.y - tN));

  /* 雨・雪（下端は端色と合わせるため薄める） */
  float edgeFade = smoothstep(1.0, 0.93, uv.y);
  float rain = uFx.y;
  if (rain > 0.01){
    float gust = 0.55 + 0.9 * fbm(vec2(uv.x * asp * 1.6 + uTime * 0.05, uv.y * 0.9 + uTime * 0.03), 3);
    float slant = (0.04 + 0.60 * uCloudB.y) * (0.85 + 0.3 * sin(uTime * 0.35 + uv.y * 3.0));
    float fine = mix(0.55, 1.0, smoothstep(0.1, 0.45, rain));
    float fq = 1.35 + 1.5 * rain;
    float dense = 1.0 + 0.7 * smoothstep(0.55, 1.0, rain);
    float rsum = 0.0;
    rsum += rainLayer(uv, asp, 70.0, 2.7, 0.075 * fine, 0.12, rain * 0.62 * dense * gust, slant, 1.0, fq) * 0.62;
    rsum += rainLayer(uv, asp, 120.0, 2.2, 0.060 * fine, 0.10, rain * 0.72 * dense * gust, slant, 7.0, fq) * 0.46;
    rsum += rainLayer(uv, asp, 210.0, 1.8, 0.050 * fine, 0.09, rain * 0.80 * dense * gust, slant * 0.9, 13.0, fq) * 0.32;
    vec3 rc = mix(mix(uHaze, vec3(1.0), 0.55), vec3(0.72, 0.68, 1.0), uFx2.w * 0.7);
    col += rc * rsum * edgeFade * (0.6 + 0.4 * (1.0 - uCloudB.x * 0.4));
    col = mix(col, uHaze * 0.9, rain * 0.10 * smoothstep(0.7, 0.0, alt) * edgeFade);
  }
  float snow = uFx.z;
  if (snow > 0.01){
    float bw = uFx3.x * 1.6 + 0.12 * uCloudB.y;
    float ssum = 0.0;
    ssum += snowLayer(uv, asp, 9.0, 0.55, 0.12, 1.0, bw * 0.8, snow * 0.55) * 0.95;
    ssum += snowLayer(uv, asp, 16.0, 0.42, 0.10, 5.0, bw * 0.6, snow * 0.7) * 0.80;
    ssum += snowLayer(uv, asp, 28.0, 0.32, 0.085, 9.0, bw * 0.4, snow * 0.85) * 0.65;
    ssum += snowLayer(uv, asp, 50.0, 0.24, 0.07, 13.0, bw * 0.25, snow) * 0.50;
    col = mix(col, vec3(0.95, 0.97, 1.0), clamp(ssum, 0.0, 1.0) * 0.85 * edgeFade);
    col = mix(col, uHaze, uFx3.x * 0.25 * edgeFade);
  }

  /* 稲光の面的な明滅 */
  col += vec3(0.50, 0.58, 0.90) * uFx.w * 0.10 * smoothstep(1.0, 0.0, uv.y * 1.2) * edgeFade;

  /* 夕方の可読性ヴェール */
  col = mix(col, uScrim.rgb, uScrim.a * smoothstep(uScrimFrom, 1.0, uv.y));

  /* ディザ（グラデーションの縞を消す） */
  col += (h21(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0 * 2.0;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
