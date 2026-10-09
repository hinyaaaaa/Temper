/* ============================================================
   skyrender.js — 空の描画エンジン（v1.8.0 新設）
   ------------------------------------------------------------
   weather.js が決めた「空の状態」を受け取り、
     ① WebGL2 のシェーダー（skyshader.js）で空・雲・雨雪・稜線を描き、
     ② 2D キャンバスで季節の粒子（桜・紅葉・蛍・流星・花火）と
        稲妻の枝を重ねる。
   状態は目標値へゆっくり近づく（天気の変化は約10秒かけて穏やかに）。
   憲法11条: 描画の失敗でアプリ本体を止めない。WebGL2が使えない
   端末では、空の色のグラデーションだけに退避する。
   ============================================================ */
import { VERT, FRAG } from './skyshader.js';

const TAU_WEATHER = 9.0;   // 天気パラメータの追従（秒）
const TAU_COLOR = 2.5;     // 色・光源の追従（秒）
const FPS = 30;

const SCALARS = ['cirrus', 'cumulus', 'stratus', 'cells', 'cloudDark', 'wind', 'haze', 'fog', 'rays', 'rain', 'snow',
  'blizzard', 'lightning', 'rainbow', 'afterglow', 'tower', 'rainTint', 'snowGround', 'stars', 'moonBoost'];
const COLORISH = ['sky', 'lit', 'shade', 'sunColor', 'glowColor', 'hazeColor', 'ridgeFar', 'ridgeMid', 'ridgeNear',
  'scrim', 'sun', 'moon', 'moonLight', 'light', 'rainbowC'];

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const deepCopy = (v) => (Array.isArray(v) ? v.map(deepCopy) : v);
const approach = (cur, tgt, k) => {
  if (typeof tgt === 'number') return cur + (tgt - cur) * k;
  if (Array.isArray(tgt)) return tgt.map((t, i) => approach(cur[i], t, k));
  return tgt;
};
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }
const css = (c) => '#' + c.slice(0, 3).map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('');
const rgba = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

/* ============================================================
   2D 粒子レイヤー
   ============================================================ */
class FxLayer {
  constructor(canvas, reduced) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.reduced = reduced;
    this.W = 1; this.H = 1; this.dpr = 1;
    this.parts = [];
    this.kind = null;
    this.strength = 0;
    this.t = 0;
    this.sprites = {};
    this.bolts = [];
    this.flashEvents = [];
    this.nextStrike = 4;
    this.flash = 0;
    this.meteors = []; this.nextMeteor = 2;
    this.bursts = []; this.nextBurst = 3;
    this.flies = null;
    this.bokeh = null;
  }
  resize(w, h, dpr) {
    this.W = w; this.H = h; this.dpr = dpr;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this.flies = null; this.bokeh = null;
  }

  /* ---- スプライト ---- */
  sprite(kind, variant) {
    const key = kind + variant;
    if (this.sprites[key]) return this.sprites[key];
    const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.translate(S / 2, S / 2);
    if (kind === 'sakura') {
      const base = ['#F2A0BB', '#F7BDD0', '#EE8CAC'][variant % 3];
      const sc = 2.4; g.scale(sc, sc);
      g.beginPath();
      g.moveTo(0, 10); g.bezierCurveTo(9, 6, 11.5, -8, 3.4, -12.2);
      g.lineTo(0, -9.4); g.lineTo(-3.4, -12.2);
      g.bezierCurveTo(-11.5, -8, -9, 6, 0, 10); g.closePath();
      const lg = g.createLinearGradient(0, 10, 0, -12);
      lg.addColorStop(0, base); lg.addColorStop(0.55, '#FBD3E0'); lg.addColorStop(1, '#FFF1F5');
      g.fillStyle = lg; g.fill();
      g.strokeStyle = 'rgba(210,80,120,0.22)'; g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(0, 9); g.quadraticCurveTo(0.6, 0, 0, -7); g.stroke();
      g.beginPath(); g.moveTo(0, 7); g.quadraticCurveTo(4, 0, 4.6, -6); g.stroke();
      g.beginPath(); g.moveTo(0, 7); g.quadraticCurveTo(-4, 0, -4.6, -6); g.stroke();
    } else if (kind === 'ume') {
      g.scale(1.5, 1.5);
      for (let i = 0; i < 5; i++) {
        g.save(); g.rotate((i * 72 * Math.PI) / 180);
        const rg = g.createRadialGradient(0, -7, 0.5, 0, -7, 7.2);
        rg.addColorStop(0, '#FFFFFF'); rg.addColorStop(1, ['#F9D4DF', '#F6C3D2', '#FBE0E8'][variant % 3]);
        g.fillStyle = rg; g.beginPath(); g.ellipse(0, -7, 5.4, 6.4, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      g.fillStyle = '#E7A14B'; g.beginPath(); g.arc(0, 0, 1.7, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(190,90,70,.5)'; g.lineWidth = 0.4;
      for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 3.8, Math.sin(a) * 3.8); g.stroke(); }
    } else if (kind === 'momiji') {
      const cols = [['#F4C84E', '#D2381E'], ['#F4A83E', '#C4301C'], ['#EC7A2C', '#A82A18'], ['#F7D55E', '#E07B26']][variant % 4];
      const lobes = [[90, 0.70, 0.27], [44, 0.58, 0.27], [136, 0.58, 0.27], [-2, 0.36, 0.24], [182, 0.36, 0.24]];
      const pts = [];
      let maxR = 0;
      for (let th = -Math.PI; th < Math.PI; th += 0.01) {
        let r = 0.30;
        for (const [ad, A, w] of lobes) {
          let d = th - (ad * Math.PI) / 180;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          r += A * Math.exp(-Math.pow(d / w, 2));
        }
        r += 0.05 * Math.cos(15 * th) * (r - 0.30);                         // 縁のぎざぎざ
        r *= 1 - 0.55 * Math.exp(-Math.pow((th + Math.PI / 2) / 0.30, 2));  // 柄のつけ根の切れ込み
        pts.push([r * Math.cos(th), -r * Math.sin(th)]);
        if (r > maxR) maxR = r;
      }
      const k = 27 / maxR;
      g.translate(0, 4);
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0] * k, p[1] * k) : g.moveTo(p[0] * k, p[1] * k))); g.closePath();
      const rg = g.createRadialGradient(0, -6, 1, 0, -6, 28);
      rg.addColorStop(0, cols[0]); rg.addColorStop(1, cols[1]);
      g.fillStyle = rg; g.fill();
      g.strokeStyle = 'rgba(100,22,10,.30)'; g.lineWidth = 0.9; g.lineCap = 'round';
      lobes.forEach(([ad, A]) => { const a = (ad * Math.PI) / 180, l = (0.30 + A) * k * 0.86; g.beginPath(); g.moveTo(0, 2); g.lineTo(Math.cos(a) * l, 2 - Math.sin(a) * l); g.stroke(); });
      g.strokeStyle = cols[1]; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, 4); g.lineTo(0, 12); g.stroke();
    }
    this.sprites[key] = c;
    return c;
  }

  /* ---- 落ちる粒子（桜・梅・紅葉） ---- */
  spawnFall(kind) {
    const z = Math.random();                    // 0=手前 1=奥
    const W = this.W, H = this.H;
    const base = { sakura: 15, ume: 10, momiji: 19 }[kind];
    const size = base * (1.25 - 0.65 * z) * (0.8 + Math.random() * 0.4);
    return {
      kind, variant: Math.floor(Math.random() * 4), z, size,
      x: Math.random() * (W + 80) - 40, y: -size * 2 - Math.random() * H * 0.15,
      vy: (kind === 'momiji' ? 34 : 26) * (1.15 - 0.5 * z) * (0.75 + Math.random() * 0.5),
      sway: 14 + Math.random() * 26, swayF: 0.5 + Math.random() * 0.9, ph: Math.random() * 6.28,
      rot: Math.random() * 6.28, rv: (Math.random() - 0.5) * (kind === 'momiji' ? 2.2 : 1.6),
      fl: Math.random() * 6.28, fv: 1.2 + Math.random() * 2.4,
      a: (0.95 - 0.4 * z),
    };
  }
  drawFall(p, alphaK) {
    const ctx = this.ctx, d = this.dpr;
    const spr = this.sprite(p.kind, p.variant);
    const flat = Math.abs(Math.cos(p.fl));
    const sx = 0.18 + 0.82 * flat;
    const s = p.size * 2 * d / 64 * 2.1;
    ctx.globalAlpha = clamp(p.a * alphaK * (0.55 + 0.45 * flat));
    ctx.setTransform(Math.cos(p.rot) * d, Math.sin(p.rot) * d, -Math.sin(p.rot) * sx * d, Math.cos(p.rot) * sx * d, p.x * d, p.y * d);
    ctx.drawImage(spr, -spr.width * s / (2 * d), -spr.height * s / (2 * d), spr.width * s / d, spr.height * s / d);
  }

  /* ---- 蛍 ---- */
  drawFlies(dt, k) {
    const ctx = this.ctx, W = this.W, H = this.H, d = this.dpr;
    if (!this.flies) {
      this.flies = Array.from({ length: 17 }, () => ({
        x: Math.random() * W, y: H * (0.42 + Math.random() * 0.36), ax: 20 + Math.random() * 50, ay: 10 + Math.random() * 28,
        fx: 0.10 + Math.random() * 0.22, fy: 0.13 + Math.random() * 0.2, ph: Math.random() * 40, pf: 0.35 + Math.random() * 0.5, s: 0.7 + Math.random() * 0.8,
      }));
    }
    ctx.globalCompositeOperation = 'lighter';
    this.flies.forEach((f) => {
      const x = f.x + Math.sin(this.t * f.fx + f.ph) * f.ax, y = f.y + Math.cos(this.t * f.fy + f.ph * 1.3) * f.ay;
      const v = Math.pow(Math.max(0, Math.sin(this.t * f.pf * 2.1 + f.ph)), 3);
      if (v < 0.02) return;
      const r = (7 + 9 * v) * f.s * d;
      const g = ctx.createRadialGradient(x * d, y * d, 0, x * d, y * d, r);
      g.addColorStop(0, `rgba(215,255,150,${0.95 * v * k})`); g.addColorStop(0.25, `rgba(170,240,100,${0.45 * v * k})`); g.addColorStop(1, 'rgba(120,220,80,0)');
      ctx.fillStyle = g; ctx.fillRect(x * d - r, y * d - r, r * 2, r * 2);
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- 紫陽花の雨: 画面の下辺に、焦点の外れた花房 ---- */
  drawBokeh(dt, k) {
    const ctx = this.ctx, W = this.W, H = this.H, d = this.dpr;
    if (!this.bokeh) {
      const cols = [[118, 142, 226], [150, 128, 214], [104, 170, 232], [196, 140, 214], [132, 116, 200], [168, 160, 236]];
      const centers = [[0.10, 0.90, 82], [0.36, 0.97, 70], [0.66, 0.95, 78], [0.92, 0.88, 88]];
      this.bokeh = [];
      centers.forEach(([cx, cy, R]) => {
        const base = cols[Math.floor(Math.random() * cols.length)];
        for (let i = 0; i < 46; i++) {
          const a = Math.random() * 6.283, r = R * Math.sqrt(Math.random());
          const c = Math.random() < 0.7 ? base : cols[Math.floor(Math.random() * cols.length)];
          this.bokeh.push({ x: cx * W + Math.cos(a) * r, y: cy * H + Math.sin(a) * r * 0.8, r: 9 + Math.random() * 11, c, ph: Math.random() * 6, f: 0.15 + Math.random() * 0.2, a: 0.30 + Math.random() * 0.25 });
        }
      });
    }
    this.bokeh.forEach((b) => {
      const x = b.x + Math.sin(this.t * b.f + b.ph) * 2.2, y = b.y + Math.cos(this.t * b.f * 0.8 + b.ph) * 1.6;
      const col = b.c.map((v) => v / 255);
      const g = ctx.createRadialGradient(x * d, y * d, 0, x * d, y * d, b.r * d);
      g.addColorStop(0, rgba(col, b.a * k)); g.addColorStop(0.55, rgba(col, b.a * 0.7 * k)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.fillRect((x - b.r) * d, (y - b.r) * d, b.r * 2 * d, b.r * 2 * d);
    });
  }

  /* ---- 流星 ---- */
  drawMeteors(dt, k, active) {
    const ctx = this.ctx, W = this.W, H = this.H, d = this.dpr;
    if (active) {
      this.nextMeteor -= dt;
      if (this.nextMeteor <= 0) {
        this.nextMeteor = 2.5 + Math.random() * 6;
        const dir = Math.random() < 0.5 ? 1 : -1;
        this.meteors.push({ x: W * (0.15 + Math.random() * 0.7), y: H * (0.05 + Math.random() * 0.32), ang: (0.45 + Math.random() * 0.3) * (dir > 0 ? 1 : -1) , dir, len: 90 + Math.random() * 140, sp: 520 + Math.random() * 380, t: 0, life: 0.55 + Math.random() * 0.4 });
      }
    }
    this.meteors = this.meteors.filter((m) => m.t < m.life);
    ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    this.meteors.forEach((m) => {
      m.t += dt;
      const vx = Math.cos(Math.abs(m.ang)) * m.dir, vy = Math.sin(Math.abs(m.ang));
      const hx = m.x + vx * m.sp * m.t, hy = m.y + vy * m.sp * m.t;
      const fade = Math.sin((m.t / m.life) * Math.PI);
      const L = m.len * Math.min(1, m.t * 6);
      const g = ctx.createLinearGradient(hx * d, hy * d, (hx - vx * L) * d, (hy - vy * L) * d);
      g.addColorStop(0, `rgba(255,255,255,${0.95 * fade * k})`); g.addColorStop(0.2, `rgba(200,220,255,${0.45 * fade * k})`); g.addColorStop(1, 'rgba(150,180,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.6 * d; ctx.beginPath(); ctx.moveTo(hx * d, hy * d); ctx.lineTo((hx - vx * L) * d, (hy - vy * L) * d); ctx.stroke();
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- 花火（遠景）---- */
  drawBursts(dt, k, active) {
    const ctx = this.ctx, W = this.W, H = this.H, d = this.dpr;
    if (active) {
      this.nextBurst -= dt;
      if (this.nextBurst <= 0 && this.bursts.length < 2) {
        this.nextBurst = 5 + Math.random() * 8;
        const R = Math.min(W, H) * (0.16 + Math.random() * 0.10);
        const hue = Math.random() * 360, hue2 = (hue + 40 + Math.random() * 120) % 360;
        const n = 70 + Math.floor(Math.random() * 40);
        const ps = Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2 + Math.random() * 0.06, sp = R * 2.2 * (0.85 + Math.random() * 0.3);
          return { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, h: i % 2 ? hue : hue2, tw: Math.random() * 6 };
        });
        this.bursts.push({ x: W * (0.2 + Math.random() * 0.6), y: H * (0.16 + Math.random() * 0.26), sy: H * 0.62, t: 0, rise: 0.75, life: 2.6, ps });
      }
    }
    ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    this.bursts = this.bursts.filter((b) => b.t < b.rise + b.life);
    this.bursts.forEach((b) => {
      b.t += dt;
      if (b.t < b.rise) {
        const u = b.t / b.rise, y = lerp(b.sy, b.y, 1 - Math.pow(1 - u, 2));
        ctx.strokeStyle = `rgba(255,220,160,${0.6 * k})`; ctx.lineWidth = 1.4 * d;
        ctx.beginPath(); ctx.moveTo(b.x * d, y * d); ctx.lineTo(b.x * d, (y + 14) * d); ctx.stroke();
        return;
      }
      const t = b.t - b.rise, kk = 2.2, fade = Math.pow(Math.max(0, 1 - t / b.life), 1.4);
      const flash = Math.exp(-t * 5) * 0.3 * k;
      if (flash > 0.01) {
        const g = ctx.createRadialGradient(b.x * d, b.y * d, 0, b.x * d, b.y * d, 120 * d);
        g.addColorStop(0, `rgba(255,240,220,${flash})`); g.addColorStop(1, 'rgba(255,240,220,0)');
        ctx.fillStyle = g; ctx.fillRect((b.x - 120) * d, (b.y - 120) * d, 240 * d, 240 * d);
      }
      b.ps.forEach((p) => {
        const pos = (tt) => { const e = (1 - Math.exp(-kk * tt)) / kk; return [b.x + p.vx * e, b.y + p.vy * e + 26 * tt * tt]; };
        const [x, y] = pos(t), [x0, y0] = pos(Math.max(0, t - 0.09));
        const tw = 0.65 + 0.35 * Math.sin(t * 22 + p.tw);
        ctx.strokeStyle = `hsla(${p.h},85%,${68 + 14 * fade}%,${fade * tw * 0.9 * k})`;
        ctx.lineWidth = 1.7 * d; ctx.beginPath(); ctx.moveTo(x0 * d, y0 * d); ctx.lineTo(x * d, y * d); ctx.stroke();
      });
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- 稲妻 ---- */
  strike(L) {
    const W = this.W, H = this.H;
    const amp = (this.reduced ? 0.22 : 1) * (0.55 + 0.45 * L);
    const t0 = this.t;
    [[0, 1], [0.10, 0.45], [0.21, 0.8]].forEach(([dt, a]) => this.flashEvents.push({ t: t0 + dt, a: a * amp }));
    if (Math.random() < 0.55) {
      const x0 = W * (0.12 + Math.random() * 0.76), x1 = x0 + (Math.random() - 0.5) * W * 0.4, y1 = H * (0.42 + Math.random() * 0.3);
      const path = [[x0, -10]];
      const rec = (ax, ay, bx, by, disp, depth) => {
        if (depth === 0) { path.push([bx, by]); return; }
        const mx = (ax + bx) / 2 + (Math.random() - 0.5) * disp, my = (ay + by) / 2 + (Math.random() - 0.5) * disp * 0.35;
        rec(ax, ay, mx, my, disp * 0.56, depth - 1); rec(mx, my, bx, by, disp * 0.56, depth - 1);
      };
      rec(x0, -10, x1, y1, H * 0.2, 6);
      const branches = [];
      for (let b = 0; b < 3; b++) {
        const i = 6 + Math.floor(Math.random() * (path.length - 14));
        const [bx, by] = path[i];
        const ex = bx + (Math.random() - 0.5) * W * 0.45, ey = by + H * (0.10 + Math.random() * 0.16);
        const sub = [[bx, by]];
        const r2 = (ax, ay, cx, cy, disp, depth) => { if (depth === 0) { sub.push([cx, cy]); return; } const mx = (ax + cx) / 2 + (Math.random() - 0.5) * disp, my = (ay + cy) / 2 + (Math.random() - 0.5) * disp * 0.4; r2(ax, ay, mx, my, disp * 0.58, depth - 1); r2(mx, my, cx, cy, disp * 0.58, depth - 1); };
        r2(bx, by, ex, ey, H * 0.07, 4);
        branches.push(sub);
      }
      this.bolts.push({ path, branches, t: t0, life: 0.32, amp });
    }
  }
  drawBolts() {
    const ctx = this.ctx, d = this.dpr;
    this.bolts = this.bolts.filter((b) => this.t - b.t < b.life);
    ctx.globalCompositeOperation = 'lighter'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    this.bolts.forEach((b) => {
      const u = (this.t - b.t) / b.life;
      const fl = (u < 0.3 ? 1 : (0.5 + 0.5 * Math.sin(u * 40))) * Math.pow(1 - u, 1.3) * b.amp;
      const strokes = (pts, wScale) => {
        [[9, 0.10, '#8FA8FF'], [4, 0.30, '#BFD0FF'], [1.6, 0.95, '#FFFFFF']].forEach(([w, a, c]) => {
          ctx.strokeStyle = c; ctx.globalAlpha = clamp(a * fl); ctx.lineWidth = w * wScale * d;
          ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0] * d, p[1] * d) : ctx.moveTo(p[0] * d, p[1] * d))); ctx.stroke();
        });
      };
      strokes(b.path, 1); b.branches.forEach((br) => strokes(br, 0.55));
    });
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- 1フレーム ---- */
  step(dt, st) {
    this.t += dt;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);

    /* 稲光 */
    const L = st.lightning;
    if (L > 0.05) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) { this.strike(L); this.nextStrike = (this.reduced ? 8 : lerp(15, 3.2, L)) * (0.6 + Math.random() * 0.8); }
    }
    let f = 0;
    this.flashEvents = this.flashEvents.filter((e) => this.t - e.t < 0.6);
    this.flashEvents.forEach((e) => { const u = this.t - e.t; if (u >= 0) f += e.a * Math.exp(-u / 0.07); });
    this.flash = clamp(f);
    this.drawBolts();

    /* 季節 */
    const seas = st.seasonal;
    const kind = seas ? seas.kind : null;
    const s = seas ? seas.strength : 0;
    if (kind !== this.kind) {
      this.kind = kind;
      const fk = { sakura: 46, ume: 15, momiji: 24 }[kind];
      if (fk && !this.reduced) for (let i = 0; i < fk * 0.85; i++) { const q = this.spawnFall(kind); q.y = Math.random() * this.H; this.parts.push(q); }
    }
    this.strength = lerp(this.strength, s, 1 - Math.exp(-dt / 3));
    const k = clamp(this.strength * 1.4);
    const motion = this.reduced ? 0 : 1;
    const wind = (4 + 46 * st.wind) * (st.wind > 0.01 ? 1 : 0.4);

    const fallKinds = { sakura: 46, ume: 15, momiji: 24 };
    if (this.kind && fallKinds[this.kind] && motion) {
      const want = Math.round(fallKinds[this.kind] * clamp(this.strength * 1.3));
      const have = this.parts.filter((p) => p.kind === this.kind).length;
      if (have < want && Math.random() < dt * 9) this.parts.push(this.spawnFall(this.kind));
    }
    for (const p of this.parts) {
      p.y += p.vy * dt;
      p.x += (wind * (1.1 - 0.5 * p.z) + Math.cos(this.t * p.swayF + p.ph) * p.sway) * dt;
      p.rot += p.rv * dt; p.fl += p.fv * dt;
    }
    this.parts = this.parts.filter((p) => p.y < this.H + 40 && p.x < this.W + 80);
    const keepKind = this.kind;
    this.parts.sort((a, b) => b.z - a.z);
    for (const p of this.parts) this.drawFall(p, p.kind === keepKind ? clamp(0.4 + this.strength * 1.2) : 0.9);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;

    if (motion) {
      if (this.kind === 'hotaru') this.drawFlies(dt, k);
      if (this.kind === 'ajisai') this.drawBokeh(dt, k);
      this.drawMeteors(dt, k, this.kind === 'ryuusei' && this.strength > 0.1);
      this.drawBursts(dt, k, this.kind === 'hanabi' && this.strength > 0.1);
    }
    ctx.globalAlpha = 1;
  }
}

/* ============================================================
   空の描画エンジン
   ============================================================ */
export function createSky({ gl: glCanvas, fx: fxCanvas, onChrome = null }) {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let gl = null, prog = null, U = {};
  let contextLost = false;
  const skyBuf = new Float32Array(18);
  function initGL() {
    try {
      gl = glCanvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
      if (!gl) return false;
      const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
      prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      U = {};
      ['uRes', 'uTime', 'uDrift', 'uHorizon', 'uSky', 'uLit', 'uShade', 'uSunCol', 'uGlow', 'uHaze', 'uRidgeFar', 'uRidgeMid', 'uRidgeNear',
        'uScrim', 'uScrimFrom', 'uSun', 'uMoon', 'uMoonL', 'uLight', 'uStars', 'uCloudA', 'uCloudB', 'uFx', 'uFx2', 'uFx3', 'uRainbowC']
        .forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
      return true;
    } catch (e) {
      console.warn('[sky] WebGL2 unavailable, fallback to gradient:', e && e.message);
      gl = null;
      return false;
    }
  }
  initGL();
  // 端末がバックグラウンドでGPUコンテキストを手放しても、戻ったときに描画を復帰する（憲法11条）
  glCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost = true; });
  glCanvas.addEventListener('webglcontextrestored', () => { contextLost = !initGL(); if (!contextLost) resize(); });
  const fx = new FxLayer(fxCanvas, reduced);

  let cur = null, tgt = null;
  let scale = 0.6, W = 1, H = 1, dpr = 1;
  let tAcc = (Date.now() / 1000) % 20000;
  const drift = [hashStr(new Date().toDateString()) * 40, 0];
  let seed = hashStr(new Date().toDateString());
  let raf = 0, last = 0, acc = 0, chromeAcc = 99, running = false;
  let slow = 0, frames = 0;
  let measured = null, sampleAcc = 99;
  const pix = new Uint8Array(4);
  const dbg = { freeze: false, time: 0, fxOn: true };

  function resize() {
    const w = Math.max(1, glCanvas.clientWidth || window.innerWidth), h = Math.max(1, glCanvas.clientHeight || window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = w; H = h;
    if (gl) { glCanvas.width = Math.max(2, Math.round(w * scale)); glCanvas.height = Math.max(2, Math.round(h * scale)); gl.viewport(0, 0, glCanvas.width, glCanvas.height); }
    fx.resize(w, h, dpr);
  }

  function setTarget(state, { snap = false } = {}) {
    tgt = state;
    if (!cur || snap) {
      cur = {}; SCALARS.forEach((k) => { cur[k] = state[k] || 0; }); COLORISH.forEach((k) => { cur[k] = deepCopy(state[k]); });
      cur.lum = state.lum;
    }
  }

  function advance(dt) {
    if (!cur || !tgt) return;
    const kw = 1 - Math.exp(-dt / TAU_WEATHER), kc = 1 - Math.exp(-dt / TAU_COLOR);
    SCALARS.forEach((k) => { cur[k] = approach(cur[k], tgt[k] || 0, kw); });
    COLORISH.forEach((k) => { cur[k] = approach(cur[k], tgt[k], kc); });
    cur.lum = approach(cur.lum, tgt.lum, 1 - Math.exp(-dt / 5));
    if (tgt.moon[3] < 0.02 || cur.moon[3] < 0.02) cur.moon = deepCopy(tgt.moon);
    cur.moonLight = deepCopy(tgt.moonLight);
  }

  function chrome() {
    if (!cur) return;
    const near = cur.ridgeNear, sc = cur.scrim;
    const edge = near.map((c, i) => lerp(c, sc[i], sc[3]));
    const zen = cur.sky[0];
    const stops = [[0, 0], [0.2, 1], [0.42, 2], [0.64, 3], [0.84, 4], [1, 5]].map(([p, i]) => `${css(cur.sky[i])} ${(p * 80).toFixed(1)}%`).join(', ');
    const payload = { zenith: css(zen), edge: css(edge), lum: measured != null ? measured : cur.lum };
    if (!gl || contextLost) glCanvas.style.background = `linear-gradient(180deg, ${stops}, ${css(near)} 82%, ${css(edge)} 100%)`;
    if (onChrome) onChrome(payload);
  }

  function draw(dt) {
    if (!cur) return;
    const flash = fx.flash;
    if (!gl || contextLost) return;
    const wind = cur.wind;
    const sp = 0.012 + 0.07 * wind;
    drift[0] += sp * dt; drift[1] += sp * 0.12 * dt;
    const c = cur;
    gl.uniform2f(U.uRes, glCanvas.width, glCanvas.height);
    gl.uniform1f(U.uTime, dbg.freeze ? dbg.time : tAcc);
    gl.uniform2f(U.uDrift, dbg.freeze ? dbg.time * 0.02 : drift[0], dbg.freeze ? 0 : drift[1]);
    gl.uniform1f(U.uHorizon, tgt.horizonY);
    for (let i = 0; i < 6; i++) { skyBuf[i * 3] = c.sky[i][0]; skyBuf[i * 3 + 1] = c.sky[i][1]; skyBuf[i * 3 + 2] = c.sky[i][2]; }
    gl.uniform3fv(U.uSky, skyBuf);
    gl.uniform3fv(U.uLit, c.lit); gl.uniform3fv(U.uShade, c.shade); gl.uniform3fv(U.uSunCol, c.sunColor);
    gl.uniform3fv(U.uGlow, c.glowColor); gl.uniform3fv(U.uHaze, c.hazeColor);
    gl.uniform3fv(U.uRidgeFar, c.ridgeFar); gl.uniform3fv(U.uRidgeMid, c.ridgeMid); gl.uniform3fv(U.uRidgeNear, c.ridgeNear);
    gl.uniform4fv(U.uScrim, c.scrim); gl.uniform1f(U.uScrimFrom, tgt.scrimFrom);
    gl.uniform4fv(U.uSun, c.sun); gl.uniform4fv(U.uMoon, c.moon); gl.uniform3fv(U.uMoonL, c.moonLight);
    gl.uniform3fv(U.uLight, c.light); gl.uniform1f(U.uStars, c.stars);
    gl.uniform4f(U.uCloudA, c.cirrus, c.cumulus, c.stratus, c.cells);
    gl.uniform4f(U.uCloudB, c.cloudDark, c.wind, c.haze, c.fog);
    gl.uniform4f(U.uFx, c.rays, c.rain, c.snow, flash);
    gl.uniform4f(U.uFx2, c.rainbow, c.afterglow, c.tower, c.rainTint);
    gl.uniform4f(U.uFx3, c.blizzard, c.snowGround, c.moonBoost, seed);
    gl.uniform2fv(U.uRainbowC, c.rainbowC);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 実際に描いた画素から、文字色を決める明るさを測る（雲・雨・霧を含む見た目どおりの値）
    sampleAcc += dt;
    if (sampleAcc > 1.5 && flash < 0.05) {
      sampleAcc = 0;
      // 文字は画面の上〜中ほどに載る。明るい所と暗い所が混ざる空（夕焼けなど）で、
      // 平均を取ると暗い領域の文字が読めなくなるので、暗いほうに寄せた値（下位25%）を使う。日付は画面の最上部に載るので、そこも測る。
      const vals = [];
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      for (const fy of [0.05, 0.2, 0.4, 0.58]) for (const fx_ of [0.25, 0.5, 0.75]) {
        gl.readPixels(Math.floor(glCanvas.width * fx_), Math.floor(glCanvas.height * (1 - fy)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pix);
        vals.push(0.2126 * lin(pix[0]) + 0.7152 * lin(pix[1]) + 0.0722 * lin(pix[2]));
      }
      vals.sort((p, q) => p - q);
      const y = vals[3];   // 12点のうち暗いほうから4番目
      measured = measured == null ? y : lerp(measured, y, 0.5);
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!running) return;
    const dtMs = now - last;
    if (dtMs < 1000 / (reduced ? 12 : FPS) - 2) return;
    last = now;
    const dt = Math.min(dtMs / 1000, 0.25) * (reduced ? 0.25 : 1);
    tAcc += dt;
    advance(dt);
    if (cur && tgt) {
      fx.step(dbg.freeze ? 0.0001 : dt, { ...cur, seasonal: tgt.seasonal, lightning: cur.lightning });
      draw(dt);
    }
    chromeAcc += dt;
    if (chromeAcc > 0.5) { chromeAcc = 0; chrome(); }
    // 処理が重い端末では解像度を下げる
    frames++;
    if (dtMs > 1000 / FPS * 1.9) slow++;
    if (frames >= 60) { if (slow > 24 && scale > 0.4) { scale = Math.max(0.4, scale * 0.8); resize(); } frames = 0; slow = 0; }
  }

  function start() {
    if (running) return;
    running = true; last = performance.now(); resize();
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
  window.addEventListener('resize', () => { resize(); });
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  return {
    setTarget, start, stop, resize, hasGL: !!gl,
    debug: dbg,
    /** 検証用: 状態を即時反映して、指定時刻で1フレーム描く */
    debugRender(state, { time = 100, seasonalOverride = null, flash = 0 } = {}) {
      dbg.freeze = true; dbg.time = time; running = false;
      setTarget(state, { snap: true });
      resize(); measured = null; sampleAcc = 99;
      fx.t = time; fx.flash = flash;
      fx.parts = []; fx.bolts = []; fx.flashEvents = []; fx.meteors = []; fx.bursts = []; fx.flies = null; fx.bokeh = null; fx.strength = 0; fx.kind = null;
      fx.nextMeteor = 0.05; fx.nextBurst = 0.05; fx.nextStrike = 0.2;
      if (seasonalOverride !== undefined) tgt.seasonal = seasonalOverride;
      draw(0);
      chrome();
    },
    debugStrike(L = 0.8) { fx.flashEvents = []; fx.bolts = []; fx.strike(L); fx.bolts.length || fx.strike(L); },
    debugFxFrames(n = 90, dt = 1 / 30) {
      for (let i = 0; i < n; i++) fx.step(dt, { ...cur, seasonal: tgt.seasonal });
    },
  };
}
