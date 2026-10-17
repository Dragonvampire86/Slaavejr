'use strict';
// Botaniske tegninger i stil med håndkolorerede kobberstik: blæklinjer, skravering og akvarellag.
// Alle planter tegnes med roden/jordpunktet i (0,0) og vokser opad (negativ y).
const Botany = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;
  const f = v => (Math.round(v * 10) / 10).toString();
  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== '') e.setAttribute(k, attrs[k]);
    if (parent) parent.append(e);
    return e;
  }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const lerp = (a, b, t) => a + (b - a) * t;

  // Glatte kurver gennem punkter (Catmull-Rom → kubiske Bézier).
  function smooth(pts, closed) {
    const n = pts.length; if (n < 2) return '';
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
      const p1 = pts[i], p2 = pts[(i + 1) % n];
      const p3 = closed ? pts[(i + 2) % n] : pts[Math.min(n - 1, i + 2)];
      d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
    }
    return closed ? d + ' Z' : d;
  }
  const poly = (pts, closed) => 'M' + pts.map(p => `${f(p[0])},${f(p[1])}`).join(' L') + (closed ? ' Z' : '');

  // Fælles definitioner: akvarelfilter med bløde, lidt ujævne kanter.
  function ensureDefs(svg) {
    if (svg.querySelector('#bWash')) return;
    const defs = el('defs', {}, svg);
    const w = el('filter', { id: 'bWash', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
    el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.06', numOctaves: '2', seed: '7', result: 'n' }, w);
    el('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: '2.6', xChannelSelector: 'R', yChannelSelector: 'G' }, w);
  }
  function layers(g) {
    // akvarel under blæk, så stregen står skarpt
    const wash = el('g', { filter: 'url(#bWash)', class: 'bw' }, g);
    const ink = el('g', {}, g);
    return { wash, ink };
  }
  const wash = (L, d, cls, dx = 0.5, dy = 0.4) => el('path', { d, class: cls, transform: dx || dy ? `translate(${dx} ${dy})` : undefined }, L.wash);
  const ink = (L, d, cls = 'b-ink') => el('path', { d, class: cls }, L.ink);

  // Et blad eller strå langs en kubisk midterlinje. ang: retning (0 = lodret op, + = mod højre), bend: krumning mod spidsen.
  function blade(base, ang, len, w, bend, profile = 'leaf', N = 18) {
    const dir = a => [Math.sin(a), -Math.cos(a)];
    const d0 = dir(ang), d1 = dir(ang + bend * 0.55), d2 = dir(ang + bend);
    const p0 = base, p1 = [p0[0] + d0[0] * len * 0.38, p0[1] + d0[1] * len * 0.38];
    const p2 = [p1[0] + d1[0] * len * 0.33, p1[1] + d1[1] * len * 0.33];
    const p3 = [p2[0] + d2[0] * len * 0.33, p2[1] + d2[1] * len * 0.33];
    const C = [], Lf = [], R = [], W = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      const c = [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
      const dx = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
      const dy = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
      const m = Math.hypot(dx, dy) || 1, nx = -dy / m, ny = dx / m;
      let wt;
      if (profile === 'leaf') wt = w * Math.min(1, 0.7 + t * 4) * Math.pow(1 - t, 0.9);
      else if (profile === 'stem') wt = w * (1 - t * 0.35);
      else if (profile === 'spikelet') wt = w * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.75) * (1 - t * 0.2);
      else wt = w * Math.sin(Math.PI * t);
      C.push(c); W.push(wt); Lf.push([c[0] + nx * wt / 2, c[1] + ny * wt / 2]); R.push([c[0] - nx * wt / 2, c[1] - ny * wt / 2]);
      if (i === N) { C.tip = c; }
    }
    const outline = smooth(Lf.concat(R.slice().reverse()), true);
    const shade = smooth(C.concat(R.slice().reverse()), true);
    return { C, L: Lf, R, W, outline, shade, tip: p3, dirEnd: d2 };
  }
  function bladeInk(L, b, opts = {}) {
    wash(L, b.outline, opts.cls || 'c-leaf');
    wash(L, b.shade, opts.shade || 'c-leafd', 0.3, 0.3);
    ink(L, b.outline, opts.inkCls || 'b-ink');
    // parallelle nerver og skravering på skyggesiden
    const n = b.C.length;
    const vein = [], vein2 = [];
    for (let i = 1; i < n - 2; i++) { const c = b.C[i], l = b.L[i], r = b.R[i]; vein.push([lerp(c[0], l[0], 0.35), lerp(c[1], l[1], 0.35)]); vein2.push([lerp(c[0], r[0], 0.3), lerp(c[1], r[1], 0.3)]); }
    if (vein.length > 2) { ink(L, smooth(vein), 'b-hair'); if (!opts.noVein2) ink(L, smooth(vein2), 'b-hair'); }
    if (!opts.noHatch) for (let i = 2; i < n - 3; i += 2) {
      const c = b.C[i], r = b.R[i], c2 = b.C[i + 1];
      ink(L, `M${f(r[0])},${f(r[1])} L${f(lerp(r[0], c2[0], 0.55))},${f(lerp(r[1], c2[1], 0.55))}`, 'b-hair');
      void c;
    }
  }

  function dewDrop(L, x, y, r, frozen) {
    if (frozen) {
      for (let k = 0; k < 3; k++) { const a = k * Math.PI / 3; ink(L, `M${f(x - Math.cos(a) * r)},${f(y - Math.sin(a) * r)} L${f(x + Math.cos(a) * r)},${f(y + Math.sin(a) * r)}`, 'b-rime'); }
      return;
    }
    // skygge på bladet, selve dråben, mørkere underkant, lysrefleks
    const D = el('g', { class: 'dew' }, L.ink);
    L = { wash: D, ink: D };
    el('ellipse', { cx: f(x + r * 0.3), cy: f(y + r * 0.55), rx: f(r * 0.95), ry: f(r * 0.42), class: 'c-dropshade' }, L.wash);
    el('circle', { cx: f(x), cy: f(y), r: f(r), class: 'c-water' }, L.ink);
    el('path', { d: `M${f(x - r * 0.92)},${f(y + r * 0.2)} A${f(r)},${f(r)} 0 0 0 ${f(x + r * 0.92)},${f(y + r * 0.2)} A${f(r * 1.25)},${f(r * 1.25)} 0 0 1 ${f(x - r * 0.92)},${f(y + r * 0.2)} Z`, class: 'c-dropin' }, L.ink);
    el('circle', { cx: f(x), cy: f(y), r: f(r), class: 'b-fine' }, L.ink);
    el('ellipse', { cx: f(x - r * 0.35), cy: f(y - r * 0.38), rx: f(r * 0.3), ry: f(r * 0.2), class: 'c-glint', transform: `rotate(-35 ${f(x - r * 0.35)} ${f(y - r * 0.38)})` }, L.ink);
    el('circle', { cx: f(x + r * 0.38), cy: f(y + r * 0.42), r: f(r * 0.12), class: 'c-glint' }, L.ink);
  }

  /* ------------------------------ græs ------------------------------ */
  function spikelet(L, base, ang, len, w, cls, R) {
    const b = blade(base, ang, len, w, (R() - 0.5) * 0.1, 'spikelet', 10);
    wash(L, b.outline, cls);
    ink(L, b.outline, 'b-fine');
    for (const t of [0.3, 0.5, 0.7, 0.88]) {
      const i = Math.round(t * 10), c = b.C[i], l = b.L[i], r = b.R[i], up = b.C[Math.min(10, i + 1)];
      ink(L, `M${f(l[0])},${f(l[1])} Q${f(up[0])},${f(up[1])} ${f(r[0])},${f(r[1])}`, 'b-hair');
      void c;
    }
    return b;
  }
  function anther(L, x, y, R) {
    const lx = x + (R() - 0.5) * 3, ly = y + 4 + R() * 3;
    ink(L, `M${f(x)},${f(y)} Q${f(x + (lx - x) * 0.3)},${f(y + 2)} ${f(lx)},${f(ly)}`, 'b-hair');
    el('ellipse', { cx: f(lx), cy: f(ly + 1.1), rx: 0.7, ry: 1.4, class: 'c-anther' }, L.ink);
    el('ellipse', { cx: f(lx), cy: f(ly + 1.1), rx: 0.7, ry: 1.4, class: 'b-hair' }, L.ink);
  }
  function inflorescence(L, top, ang, len, kind, season, R) {
    const dried = season === 'autumn';
    const cls = dried ? 'c-straw' : kind === 'fescue' ? 'c-rubra' : 'c-leaf';
    const flowering = season === 'summer';
    const axis = blade(top, ang, len, 1.1, (R() - 0.5) * 0.35, 'stem', 14);
    if (kind === 'spike') {
      const n = 10;
      const pts = [];
      for (let k = 0; k < n; k++) {
        const t = 0.06 + k * (0.86 / n), i = Math.round(t * 14), c = axis.C[i];
        const side = k % 2 ? 1 : -1;
        pts.push([c[0] + side * 0.9, c[1]]);
        const a = ang + side * 0.36 + (R() - 0.5) * 0.08;
        const sb = spikelet(L, c, a, 13.5 - k * 0.35, 4.8, cls, R);
        if (flowering && R() < 0.45) anther(L, (sb.L[5][0] + sb.R[5][0]) / 2 + side * 1.5, (sb.L[5][1] + sb.R[5][1]) / 2, R);
      }
      ink(L, smooth(pts), 'b-fine');
    } else {
      ink(L, smooth(axis.C), 'b-fine');
      const narrow = kind === 'fescue', big = kind === 'tall';
      const whorls = [0.18, 0.36, 0.55, 0.74, 0.9];
      whorls.forEach((t, wi) => {
        const c = axis.C[Math.round(t * 14)];
        const nb = wi === 0 ? 2 : 3;
        for (let k = 0; k < nb; k++) {
          const side = k % 2 ? 1 : -1;
          const spread = narrow ? 0.28 + R() * 0.12 : big ? 0.55 + R() * 0.25 : 0.7 + R() * 0.3;
          const bl = (big ? 26 : 20) * (1 - t * 0.55) * (0.7 + R() * 0.4);
          const br = blade(c, ang + side * spread, bl, 0.6, side * (big ? 0.5 : 0.25), 'stem', 8);
          ink(L, smooth(br.C), 'b-hair');
          const ns = narrow ? 2 : 3;
          for (let s = 0; s < ns; s++) {
            const q = 0.45 + s * (0.55 / ns), pt = br.C[Math.round(q * 8)];
            const sb = spikelet(L, pt, ang + side * (spread * 0.6) + (R() - 0.5) * 0.4, narrow ? 7 : 5.5, narrow ? 2.2 : 2.8, cls, R);
            if (flowering && R() < 0.35) anther(L, sb.tip[0], sb.tip[1], R);
          }
        }
      });
      spikelet(L, axis.tip, ang, 6, 2.6, cls, R);
    }
    return axis;
  }
  // Græsplante: tue med strå, knæ, bladskeder, blade og blomsterstand; rødder og detaljefigur på planchen.
  function grass(g, o = {}) {
    const L = layers(g), R = rng(o.seed || 21);
    const season = o.season || 'summer', kind = o.kind || 'spike', plate = o.detail === 'plate';
    const leafCls = season === 'winter' ? 'c-winter' : 'c-leaf';
    const H = o.height || 100;
    if (plate) roots(L, 0, 0, 18, 46, R);
    // grundblade
    const nBase = plate ? 9 : 7;
    for (let i = 0; i < nBase; i++) {
      const a = -0.9 + i * (1.8 / (nBase - 1)) + (R() - 0.5) * 0.15;
      const b = blade([(R() - 0.5) * 6, 0], a, H * (0.42 + R() * 0.25), 5.2 + R() * 1.8, a * 1.1 + (R() - 0.5) * 0.5);
      bladeInk(L, b, { cls: R() < (season === 'autumn' ? 0.35 : 0.1) ? 'c-ochre' : leafCls });
    }
    // strå med blomsterstand
    const culms = season === 'winter' ? 0 : plate ? 3 : 2;
    for (let i = 0; i < culms; i++) {
      const a = (i - (culms - 1) / 2) * 0.22 + (R() - 0.5) * 0.08;
      const hgt = H * (season === 'spring' ? 0.62 : 0.78) * (0.92 + R() * 0.15);
      const stem = blade([(R() - 0.5) * 4, 0], a, hgt, 1.9, (R() - 0.5) * 0.18, 'stem', 18);
      bladeInk(L, stem, { cls: season === 'autumn' ? 'c-straw' : 'c-leaf2', noHatch: true, noVein2: true });
      // knæ og stråblade
      for (const t of [0.28, 0.52]) {
        const i2 = Math.round(t * 18), c = stem.C[i2];
        el('ellipse', { cx: f(c[0]), cy: f(c[1]), rx: 1.6, ry: 1.0, class: 'c-node' }, L.ink);
        const side = (i + (t > 0.4 ? 1 : 0)) % 2 ? 1 : -1;
        ink(L, `M${f(c[0] - 1.4)},${f(c[1])} L${f(stem.C[i2 - 2][0] - 1.2)},${f(stem.C[i2 - 2][1])}`, 'b-fine');
        const lb = blade(c, a + side * 0.45, H * 0.32, 3.4, side * (0.9 + R() * 0.5));
        bladeInk(L, lb, { cls: season === 'autumn' && R() < 0.5 ? 'c-ochre' : leafCls });
      }
      inflorescence(L, stem.tip, a + (R() - 0.5) * 0.15, H * (kind === 'spike' ? 0.44 : 0.32), kind, season, R);
    }
    if (o.frost) rimeOver(L, R, H);
    if (plate && season !== 'winter') {
      // detaljefigur: forstørret småaks
      const d = el('g', { transform: `translate(${f(H * 0.62)} ${f(-H * 0.86)}) scale(2.1)` }, g);
      const DL = layers(d);
      spikelet(DL, [0, 0], 0.15, 13, 5, season === 'autumn' ? 'c-straw' : kind === 'fescue' ? 'c-rubra' : 'c-leaf', R);
      el('text', { x: -6, y: 2, class: 'b-num' }, d).textContent = '1.';
    }
  }
  function roots(L, x, y, n, len, R) {
    for (let i = 0; i < n; i++) {
      const pts = [[x + (R() - 0.5) * 6, y]];
      let a = (R() - 0.5) * 1.6, px = pts[0][0], py = y;
      const seg = 6;
      for (let s = 1; s <= seg; s++) { a += (R() - 0.5) * 0.5; const l = len * (0.5 + R() * 0.6) / seg; px += Math.sin(a) * l; py += Math.cos(a) * l; pts.push([px, py]); }
      ink(L, smooth(pts), 'b-root');
      if (R() < 0.6) { const p = pts[2 + Math.floor(R() * 3)]; const b2 = [[p[0], p[1]], [p[0] + (R() - 0.5) * 10, p[1] + 5 + R() * 6]]; ink(L, smooth(b2), 'b-root'); }
    }
    el('ellipse', { cx: f(x), cy: f(y + 2), rx: 10, ry: 3, class: 'c-soil' }, L.wash);
  }
  function rimeOver(L, R, H) {
    for (let i = 0; i < 26; i++) {
      const x = (R() - 0.5) * H * 0.9, y = -R() * H * 0.7, s = 1 + R() * 1.4;
      ink(L, `M${f(x - s)},${f(y)} L${f(x + s)},${f(y)} M${f(x)},${f(y - s)} L${f(x)},${f(y + s)}`, 'b-rime');
    }
  }

  /* ------------------------------ løvefod ------------------------------ */
  function alchLeafPts(R0, lobes, teethPer, gap) {
    const pts = [], N = 260;
    const a0 = Math.PI / 2 + gap / 2, a1 = Math.PI / 2 + 2 * Math.PI - gap / 2;
    for (let i = 0; i <= N; i++) {
      const u = i / N, th = a0 + (a1 - a0) * u;
      const ph = u * lobes, fr = ph - Math.floor(ph);
      const lobe = 1 - 0.13 * Math.pow((fr - 0.5) * 2, 2);
      const tp = u * lobes * teethPer, tf = tp - Math.floor(tp);
      const tooth = 0.028 * (1 - Math.abs(tf - 0.5) * 2);
      const sinus = 0.55 + 0.45 * Math.min(1, u / 0.07) * Math.min(1, (1 - u) / 0.07);
      const r = R0 * lobe * (1 + tooth) * sinus;
      pts.push([Math.cos(th) * r, Math.sin(th) * r, th, u]);
    }
    return { pts, a0, a1 };
  }
  function alchLeaf(L, g, cx, cy, R0, rot, tilt, o, R) {
    const lobes = 9;
    const geo = alchLeafPts(R0, lobes, 7, 0.55);
    const tr = p => { const x = p[0], y = p[1] * tilt; const c = Math.cos(rot), s = Math.sin(rot); return [cx + x * c - y * s, cy + x * s + y * c]; };
    const P = geo.pts.map(tr);
    const outline = poly(P, true);
    wash(L, outline, o.autumn ? 'c-olive' : 'c-alch');
    // folder mellem nerverne
    const veinEnds = [];
    for (let k = 0; k < lobes; k++) {
      const u = (k + 0.5) / lobes, idx = Math.round(u * (P.length - 1));
      veinEnds.push(idx);
      if (k % 2 === 0) {
        const i0 = Math.round((k / lobes) * (P.length - 1)), i1 = Math.round(((k + 1) / lobes) * (P.length - 1));
        const wedge = [[cx, cy]].concat(P.slice(i0, idx + 1));
        wash(L, poly(wedge, true), 'c-alchd', 0.2, 0.2);
        void i1;
      }
    }
    if (o.autumn) el('path', { d: outline, class: 'b-tint' }, L.wash);
    ink(L, outline, 'b-ink');
    for (const idx of veinEnds) {
      const e = P[idx], m = [lerp(cx, e[0], 0.5) + (R() - 0.5) * 1.5, lerp(cy, e[1], 0.5) + (R() - 0.5) * 1.5];
      ink(L, `M${f(cx)},${f(cy)} Q${f(m[0])},${f(m[1])} ${f(lerp(cx, e[0], 0.92))},${f(lerp(cy, e[1], 0.92))}`, 'b-fine');
      // sidenerver
      for (const q of [0.45, 0.7]) {
        const px = lerp(cx, e[0], q), py = lerp(cy, e[1], q);
        const ang = Math.atan2(e[1] - cy, e[0] - cx);
        for (const sd of [-1, 1]) ink(L, `M${f(px)},${f(py)} l${f(Math.cos(ang + sd * 0.7) * R0 * 0.16)},${f(Math.sin(ang + sd * 0.7) * R0 * 0.16 * tilt)}`, 'b-hair');
      }
    }
    // skravering i bladets skyggeside
    for (let i = 0; i < 9; i++) {
      const idx = Math.round((0.62 + i * 0.035) * (P.length - 1)), e = P[idx];
      ink(L, `M${f(lerp(cx, e[0], 0.55))},${f(lerp(cy, e[1], 0.55))} L${f(lerp(cx, e[0], 0.86))},${f(lerp(cy, e[1], 0.86))}`, 'b-hair');
    }
    const lobeTips = veinEnds.map(i => P[i]);
    if (o.frost) {
      el('path', { d: outline, class: 'b-rimeline' }, L.ink);
    } else if (o.wet > 0.05) {
      dewDrop(L, cx + (R() - 0.5) * R0 * 0.15, cy - R0 * 0.12 * tilt, R0 * (0.07 + 0.08 * o.wet), false);
      for (let k = 1; k < lobeTips.length; k += 3) { const t = lobeTips[k]; dewDrop(L, t[0], t[1] + R0 * 0.03, R0 * (0.025 + 0.02 * o.wet), false); }
    }
    return { cx, cy };
  }
  function alchemilla(g, o = {}) {
    const L = layers(g), R = rng(o.seed || 5), plate = o.detail === 'plate';
    const season = o.season || 'summer', autumn = season === 'autumn', H = o.height || 100;
    if (plate) roots(L, 0, 0, 12, 34, R);
    const leaves = plate
      ? [[-H * 0.26, -H * 0.5, H * 0.26, -0.15, 0.48], [H * 0.24, -H * 0.36, H * 0.22, 0.2, 0.52], [-H * 0.02, -H * 0.2, H * 0.2, 0.05, 0.38], [H * 0.02, -H * 0.72, H * 0.24, 0.05, 0.92]]
      : [[-H * 0.24, -H * 0.38, H * 0.22, -0.2, 0.5], [H * 0.22, -H * 0.3, H * 0.2, 0.25, 0.55], [H * 0.0, -H * 0.62, H * 0.27, 0.0, 0.9]];
    // blomsterstand bagved
    if (season !== 'winter') {
      const st = blade([3, 0], 0.18, H * (plate ? 1.0 : 0.95), 1.3, -0.2, 'stem', 14);
      ink(L, smooth(st.C), 'b-fine');
      for (const t of [0.6, 0.75, 0.9, 1]) {
        const c = st.C[Math.round(t * 14)];
        for (let k = 0; k < 2; k++) {
          const sd = k ? 1 : -1, br = blade(c, 0.18 + sd * 0.7, 10 + R() * 6, 0.6, sd * 0.3, 'stem', 6);
          ink(L, smooth(br.C), 'b-hair');
          for (let q = 0; q < 6; q++) {
            const p = br.C[6], x = p[0] + (R() - 0.5) * 6, y = p[1] + (R() - 0.5) * 5;
            el('circle', { cx: f(x), cy: f(y), r: 1.3, class: autumn ? 'c-straw' : 'c-alchflower' }, L.wash);
            el('circle', { cx: f(x), cy: f(y), r: 1.15, class: 'b-hair' }, L.ink);
          }
        }
      }
    }
    for (const [x, y, r, rot, tilt] of leaves) {
      // hårede bladstilke
      const pts = [[(R() - 0.5) * 4, 0], [x * 0.35, y * 0.55], [x, y]];
      ink(L, smooth(pts), 'b-ink');
      for (let k = 1; k < 6; k++) { const t = k / 6, px = lerp(pts[0][0], x, t), py = lerp(0, y, t); ink(L, `M${f(px)},${f(py)} l${f(1.6)},${f(-1)}`, 'b-hair'); }
      alchLeaf(L, g, x, y, season === 'winter' ? r * 0.8 : r, rot, tilt, { wet: o.wet || 0, frost: o.frost, autumn }, R);
    }
    if (plate) {
      const d = el('g', { transform: `translate(${f(H * 0.55)} ${f(-H * 0.95)}) scale(2.4)` }, g);
      const DL = layers(d);
      for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; const p = `M0,0 Q${f(Math.cos(a - 0.4) * 4)},${f(Math.sin(a - 0.4) * 4)} ${f(Math.cos(a) * 4.5)},${f(Math.sin(a) * 4.5)} Q${f(Math.cos(a + 0.4) * 4)},${f(Math.sin(a + 0.4) * 4)} 0,0 Z`; wash(DL, p, 'c-alchflower'); ink(DL, p, 'b-fine'); }
      el('circle', { r: 0.9, class: 'c-anther' }, DL.ink);
      el('text', { x: -9, y: 1.5, class: 'b-num' }, d).textContent = '1.';
    }
  }

  /* ------------------------------ hvidkløver ------------------------------ */
  function leaflet(L, base, ang, len, wid, o, R) {
    const pts = [], N = 70;
    for (let i = 0; i < N; i++) {
      const th = -Math.PI / 2 + (i / N) * Math.PI * 2;
      const s = Math.sin(th);
      let x = Math.cos(th) * wid / 2 * (s > 0 ? 1 - 0.72 * s : 1);
      let y = -len * 0.58 + s * len * 0.42 * (s > 0 ? 1 + 0.38 * s : 1);
      y += 1.2 * Math.exp(-Math.pow((th + Math.PI / 2) / 0.16, 2)) * (len / 14);
      const tooth = 1 + 0.03 * Math.abs(Math.sin(th * 14));
      x *= tooth;
      pts.push([x, y]);
    }
    const c = Math.cos(ang), sn = Math.sin(ang);
    const T = p => [base[0] + p[0] * c - p[1] * sn, base[1] + p[0] * sn + p[1] * c];
    const P = pts.map(T);
    const d = poly(P, true);
    wash(L, d, o.cls || 'c-clover');
    // det lyse vinkelbånd
    const band = [[-wid * 0.42, -len * 0.62], [0, -len * 0.38], [wid * 0.42, -len * 0.62], [wid * 0.38, -len * 0.54], [0, -len * 0.3], [-wid * 0.38, -len * 0.54]].map(T);
    el('path', { d: poly(band, true), class: 'c-band' }, L.wash);
    wash(L, poly([[0, 0], [0, -len], [wid * 0.45, -len * 0.6], [wid * 0.3, -len * 0.2]].map(T), true), 'c-leafd', 0.2, 0.2);
    ink(L, d, 'b-ink');
    const mid = [[0, 0], [0, -len * 0.97]].map(T);
    ink(L, poly(mid), 'b-fine');
    for (let k = 1; k < 8; k++) {
      const t = k / 8.5, y = -len * t;
      for (const sd of [-1, 1]) { const a = T([0, y]), b = T([sd * wid * 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.1)), y - len * 0.1]); ink(L, `M${f(a[0])},${f(a[1])} L${f(b[0])},${f(b[1])}`, 'b-hair'); }
    }
    return P;
  }
  function cloverHead(L0, x, y, r, state, R) {
    const H0 = el('g', { class: 'bloom' }, L0.ink);
    const L = { wash: H0, ink: H0 };
    // kuglerundt hoved af mange små ærteblomster; de nederste, ældste hænger ned og bliver brunlige
    el('circle', { cx: f(x), cy: f(y), r: f(r * 0.82), class: state === 'brown' ? 'c-ochre' : 'c-cloverbody' }, L.wash);
    const fl = [];
    const rings = [[0.15, 5], [0.42, 11], [0.68, 16], [0.92, 20]];
    for (const [rf, n] of rings) for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rf * 3 + (R() - 0.5) * 0.15;
      fl.push([rf, a]);
    }
    fl.sort((p, q) => Math.sin(p[1]) * p[0] - Math.sin(q[1]) * q[0]);
    for (const [rf, a] of fl) {
      const lower = Math.sin(a) > 0.35 && rf > 0.5;
      const bx = x + Math.cos(a) * r * rf * 0.55, by = y + Math.sin(a) * r * rf * 0.55;
      const dirA = lower ? Math.PI / 2 + Math.cos(a) * 0.7 : a - Math.PI / 2 * (1 - rf) * 0.4;
      const len = r * (0.32 + rf * 0.42), wd = r * 0.13;
      const ex = bx + Math.cos(dirA) * len, ey = by + Math.sin(dirA) * len;
      const nx = -Math.sin(dirA) * wd, ny = Math.cos(dirA) * wd;
      const d = `M${f(bx)},${f(by)} C${f(bx + nx * 1.2)},${f(by + ny * 1.2)} ${f(ex + nx)},${f(ey + ny)} ${f(ex)},${f(ey)} C${f(ex - nx)},${f(ey - ny)} ${f(bx - nx * 1.2)},${f(by - ny * 1.2)} ${f(bx)},${f(by)} Z`;
      el('path', { d, class: state === 'brown' ? 'c-ochre' : lower ? 'c-cloverold' : 'c-paper' }, L.ink);
      if (!lower && state !== 'brown') el('path', { d: `M${f(bx)},${f(by)} L${f(lerp(bx, ex, 0.45))},${f(lerp(by, ey, 0.45))}`, class: 'b-pinkline' }, L.ink);
      el('path', { d, class: 'b-hair' }, L.ink);
    }
  }
  function trifolium(g, o = {}) {
    const L = layers(g), R = rng(o.seed || 9), plate = o.detail === 'plate';
    const season = o.season || 'summer', H = o.height || 100;
    const W = H * 0.9;
    // krybende udløber
    const st = [];
    for (let i = 0; i <= 8; i++) st.push([-W / 2 + i * W / 8, -2 + Math.sin(i * 1.3) * 2.2]);
    const stol = smooth(st);
    el('path', { d: stol, class: 'b-stolon' }, L.wash);
    ink(L, stol, 'b-ink');
    const nodes = [1, 3, 5, 7].map(i => st[i]);
    for (const nd of nodes) {
      el('ellipse', { cx: f(nd[0]), cy: f(nd[1]), rx: 1.8, ry: 1.1, class: 'c-node' }, L.ink);
      for (let k = 0; k < (plate ? 5 : 3); k++) ink(L, smooth([[nd[0], nd[1]], [nd[0] + (R() - 0.5) * 5, nd[1] + 4 + R() * 3], [nd[0] + (R() - 0.5) * 8, nd[1] + 8 + R() * 6]]), 'b-root');
    }
    const leafCls = season === 'winter' ? 'c-winter' : 'c-clover';
    const leafs = [[nodes[0], -0.35, 0.62], [nodes[1], 0.15, 0.82], [nodes[2], -0.1, 0.7], [nodes[3], 0.35, 0.58]];
    const heads = season === 'summer' ? [nodes[1], nodes[2]] : season === 'spring' ? [nodes[2]] : season === 'autumn' ? [nodes[1]] : [];
    for (const [nd, a, h] of leafs) {
      const pet = blade(nd, a, H * h * (season === 'winter' ? 0.7 : 1), 1.1, (R() - 0.5) * 0.4, 'stem', 12);
      ink(L, smooth(pet.C), 'b-fine');
      const t = pet.tip, s = H * (season === 'winter' ? 0.12 : 0.16);
      const base = Math.atan2(pet.dirEnd[0], -pet.dirEnd[1]);
      for (const da of [-1.15, 0, 1.15]) leaflet(L, t, base + da + (R() - 0.5) * 0.12, s, s * 0.82, { cls: leafCls }, R);
      el('circle', { cx: f(t[0]), cy: f(t[1]), r: 0.9, class: 'c-node' }, L.ink);
    }
    for (const nd of heads) {
      const a = (R() - 0.5) * 0.3, hgt = H * 0.95;
      const ped = blade(nd, a, hgt, 1.2, (R() - 0.5) * 0.3, 'stem', 14);
      ink(L, smooth(ped.C), 'b-fine');
      const t = ped.tip;
      if (season === 'spring') { el('circle', { cx: f(t[0]), cy: f(t[1]), r: 3.5, class: 'c-clover' }, L.wash); el('circle', { cx: f(t[0]), cy: f(t[1]), r: 3.5, class: 'b-fine' }, L.ink); }
      else cloverHead(L, t[0], t[1] - 3, H * 0.12, season === 'autumn' ? 'brown' : 'fresh', R);
    }
    if (o.frost) rimeOver(L, R, H);
    if (plate && season !== 'winter') {
      const d = el('g', { transform: `translate(${f(H * 0.6)} ${f(-H * 1.05)}) scale(2.6)` }, g);
      const DL = layers(d);
      const p = 'M0,6 C-1.5,3 -2.4,-1 -1.6,-4 C-1,-6 1,-6 1.6,-4 C2.4,-1 1.5,3 0,6 Z';
      wash(DL, p, 'c-paper'); ink(DL, p, 'b-fine');
      el('path', { d: 'M-1.4,4 L-2.6,7 M1.4,4 L2.6,7 M0,5 L0,8', class: 'b-hair' }, DL.ink);
      el('path', { d: 'M0,6 L0,-3', class: 'b-pinkline' }, DL.ink);
      el('text', { x: -8, y: 1.5, class: 'b-num' }, d).textContent = '1.';
    }
  }

  /* ------------------------------ tusindfryd ------------------------------ */
  function bellisLeaf(L, ang, len, wid, R) {
    const N = 26, Lf = [], Rt = [], C = [];
    const dir = [Math.sin(ang), -Math.cos(ang)], nrm = [-dir[1], dir[0]];
    const bend = (R() - 0.5) * 0.25;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      let w = t < 0.42 ? wid * 0.14 : wid * Math.sin(Math.PI * Math.min(1, (t - 0.32) / 0.7)) ** 0.7;
      if (t > 0.45) w *= 1 + 0.07 * Math.sin(t * 46);
      const bx = dir[0] * len * t + nrm[0] * bend * len * t * t, by = dir[1] * len * t + nrm[1] * bend * len * t * t;
      C.push([bx, by]); Lf.push([bx + nrm[0] * w / 2, by + nrm[1] * w / 2]); Rt.push([bx - nrm[0] * w / 2, by - nrm[1] * w / 2]);
    }
    const outline = smooth(Lf.concat(Rt.slice().reverse()), true);
    wash(L, outline, 'c-bellisleaf');
    wash(L, smooth(C.concat(Rt.slice().reverse()), true), 'c-leafd', 0.2, 0.2);
    ink(L, outline, 'b-ink');
    ink(L, smooth(C.slice(0, N - 1)), 'b-fine');
    for (let i = 13; i < N - 2; i += 3) { const c = C[i], r = Rt[i + 1]; ink(L, `M${f(c[0])},${f(c[1])} L${f(lerp(c[0], r[0], 0.7))},${f(lerp(c[1], r[1], 0.7))}`, 'b-hair'); const l = Lf[i + 1]; ink(L, `M${f(c[0])},${f(c[1])} L${f(lerp(c[0], l[0], 0.7))},${f(lerp(c[1], l[1], 0.7))}`, 'b-hair'); }
    for (let i = 12; i < N; i += 2) { const p = Lf[i]; ink(L, `M${f(p[0])},${f(p[1])} l${f(nrm[0] * 1.3)},${f(nrm[1] * 1.3 - 0.4)}`, 'b-hair'); }
  }
  function bellisHead(L0, x, y, r, tilt, rot, R) {
    const B = el('g', { class: 'bloom' }, L0.ink);
    const L = { wash: L0.wash, ink: B };
    const n = 36, c = Math.cos(rot), s = Math.sin(rot);
    const T = (px, py) => [x + px * c - py * tilt * s, y + px * s + py * tilt * c];
    const rays = [];
    for (let k = 0; k < n; k++) rays.push([(k / n) * Math.PI * 2 + (R() - 0.5) * 0.06, 0.92 + R() * 0.16]);
    rays.sort((a, b) => Math.sin(a[0]) - Math.sin(b[0]));   // bagerste først
    for (const [a, lf] of rays) {
      const r0 = r * 0.38, r1 = r * lf, w = r * 0.075;
      const ca = Math.cos(a), sa = Math.sin(a), na = -sa, nb = ca;
      const q = [[ca * r0 + na * w * 0.6, sa * r0 + nb * w * 0.6], [ca * r1 + na * w, sa * r1 + nb * w], [ca * (r1 + w * 0.8), sa * (r1 + w * 0.8)], [ca * r1 - na * w, sa * r1 - nb * w], [ca * r0 - na * w * 0.6, sa * r0 - nb * w * 0.6]].map(p => T(p[0], p[1]));
      const d = smooth(q, true);
      el('path', { d, class: 'c-paper' }, L.ink);
      const tipA = T(ca * r1 * 0.78, sa * r1 * 0.78), tipB = T(ca * (r1 + w * 0.6), sa * (r1 + w * 0.6));
      el('path', { d: `M${f(tipA[0])},${f(tipA[1])} L${f(tipB[0])},${f(tipB[1])}`, class: 'b-pinktip' }, L.ink);
      el('path', { d, class: 'b-hair' }, L.ink);
    }
    const disc = [];
    for (let k = 0; k < 40; k++) { const a = k / 40 * Math.PI * 2; disc.push(T(Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36)); }
    const dd = poly(disc, true);
    el('path', { d: dd, class: 'c-yellow' }, L.ink);
    const half = []; for (let k = 0; k <= 20; k++) { const a = k / 20 * Math.PI; half.push(T(Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36)); }
    el('path', { d: poly(half, true), class: 'c-yolk' }, L.ink);
    el('path', { d: dd, class: 'b-fine' }, L.ink);
    for (let k = 0; k < 26; k++) { const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * r * 0.3, p = T(Math.cos(a) * rr, Math.sin(a) * rr); el('circle', { cx: f(p[0]), cy: f(p[1]), r: 0.32, class: 'b-dot' }, L.ink); }
  }
  function bellisBud(L, x, y, r, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const T = (px, py) => [x + px * c - py * s, y + px * s + py * c];
    const inv = [[-r * 0.55, 0], [-r * 0.6, -r * 0.5], [-r * 0.3, -r * 0.85], [r * 0.3, -r * 0.85], [r * 0.6, -r * 0.5], [r * 0.55, 0], [0, r * 0.25]].map(p => T(p[0], p[1]));
    const tips = [];
    for (let k = -3; k <= 3; k++) tips.push(T(k * r * 0.13, -r * (1.25 - Math.abs(k) * 0.06)));
    for (let k = 0; k < tips.length; k++) {
      const b0 = T((k - 3) * r * 0.12 - r * 0.05, -r * 0.7), b1 = T((k - 3) * r * 0.12 + r * 0.05, -r * 0.7), t = tips[k];
      const d = `M${f(b0[0])},${f(b0[1])} L${f(t[0])},${f(t[1])} L${f(b1[0])},${f(b1[1])} Z`;
      el('path', { d, class: 'c-rosetip' }, L.ink); el('path', { d, class: 'b-hair' }, L.ink);
    }
    const d = smooth(inv, true);
    wash(L, d, 'c-bellisleaf'); ink(L, d, 'b-fine');
    for (let k = -2; k <= 2; k++) { const a = T(k * r * 0.18, r * 0.1), b = T(k * r * 0.24, -r * 0.7); ink(L, `M${f(a[0])},${f(a[1])} L${f(b[0])},${f(b[1])}`, 'b-hair'); }
  }
  function bellis(g, o = {}) {
    const L = layers(g), R = rng(o.seed || 13), plate = o.detail === 'plate';
    const season = o.season || 'summer', H = o.height || 100;
    if (plate) roots(L, 0, 0, 14, 30, R);
    const scapes = season === 'winter' ? [] : season === 'autumn' ? [[-0.12, 0.72, 'open'], [0.3, 0.55, 'bud']] : [[-0.18, 0.82, 'open'], [0.16, 0.7, 'open'], [0.38, 0.5, 'bud']];
    for (const [a, h, kind] of scapes) {
      const sc = blade([(R() - 0.5) * 4, -2], a, H * h, 1.3, -a * 0.6 + (R() - 0.5) * 0.15, 'stem', 14);
      ink(L, smooth(sc.C), 'b-fine');
      for (let i = 3; i < 13; i += 2) { const c = sc.C[i]; ink(L, `M${f(c[0])},${f(c[1])} l${f(1.2)},${f(-0.8)} M${f(c[0])},${f(c[1])} l${f(-1.2)},${f(-0.9)}`, 'b-hair'); }
      const t = sc.tip;
      if (kind === 'open') bellisHead(L, t[0], t[1] - 2, H * 0.12, 0.62 + R() * 0.25, (R() - 0.5) * 0.5, R);
      else bellisBud(L, t[0], t[1], H * 0.05, Math.atan2(sc.dirEnd[0], -sc.dirEnd[1]));
    }
    if (season === 'winter') bellisBud(L, 2, -H * 0.18, H * 0.045, 0.2);
    const nLeaf = plate ? 9 : 7;
    for (let i = 0; i < nLeaf; i++) {
      const a = -1.35 + i * (2.7 / (nLeaf - 1)) + (R() - 0.5) * 0.12;
      bellisLeaf(L, a, H * (0.26 + R() * 0.1) * (Math.abs(a) > 1 ? 0.85 : 1), H * 0.11, R);
    }
    if (o.frost) rimeOver(L, R, H * 0.5);
    if (plate && season !== 'winter') {
      const d = el('g', { transform: `translate(${f(H * 0.62)} ${f(-H * 0.92)}) scale(2.3)` }, g);
      const DL = layers(d);
      const ray = 'M0,4 C-1.2,1 -1.3,-5 -0.8,-8 C-0.3,-9 0.3,-9 0.8,-8 C1.3,-5 1.2,1 0,4 Z';
      el('path', { d: ray, class: 'c-paper' }, DL.ink);
      el('path', { d: 'M0,-6 L0,-8.4', class: 'b-pinktip' }, DL.ink);
      ink(DL, ray, 'b-fine');
      el('text', { x: -7, y: 1.5, class: 'b-num' }, d).textContent = '1.';
      const d2 = el('g', { transform: `translate(${f(H * 0.62)} ${f(-H * 0.6)}) scale(2.3)` }, g);
      const DL2 = layers(d2);
      const fl = 'M0,3 C-1.2,2 -1.3,-2 -1,-3.5 L-1.4,-5 L-0.5,-4.2 L0,-5.4 L0.5,-4.2 L1.4,-5 L1,-3.5 C1.3,-2 1.2,2 0,3 Z';
      el('path', { d: fl, class: 'c-yellow' }, DL2.ink); ink(DL2, fl, 'b-fine');
      el('text', { x: -7, y: 1.5, class: 'b-num' }, d2).textContent = '2.';
    }
  }


  /* ------------------------------ motiver til felterne ------------------------------ */
  // Rør eller håndtag langs en kurve: glat omrids med en given bredde.
  function tube(pts, w) {
    const Lf = [], Rt = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
      const nx = -dy / m, ny = dx / m, ww = typeof w === 'function' ? w(i / (pts.length - 1)) : w;
      Lf.push([pts[i][0] + nx * ww / 2, pts[i][1] + ny * ww / 2]); Rt.push([pts[i][0] - nx * ww / 2, pts[i][1] - ny * ww / 2]);
    }
    return { outline: smooth(Lf.concat(Rt.reverse()), true), left: Lf };
  }
  function tuft(L, x, y, H, n, spread, R, o = {}) {
    const tips = [];
    for (let i = 0; i < n; i++) {
      const a = -spread + (n > 1 ? i * (2 * spread / (n - 1)) : 0) + (R() - 0.5) * 0.18;
      const b = blade([x + (R() - 0.5) * H * 0.12, y], a, H * (0.55 + R() * 0.45), Math.max(2.2, H * 0.07), a * 0.9 + (R() - 0.5) * 0.5);
      bladeInk(L, b, { cls: o.cls ? o.cls(R) : 'c-leaf' });
      tips.push(b.tip);
    }
    return tips;
  }
  function weatherOnTips(L, tips, o, H) {
    if (o.frost) { for (const [x, y] of tips) ink(L, `M${f(x - 2)},${f(y + 2.5)} L${f(x)},${f(y)} L${f(x + 2)},${f(y + 2.5)}`, 'b-rime'); return; }
    if (o.wet > 0.05) tips.forEach(([x, y], i) => { if (i % 2 === 0) dewDrop(L, x, y + H * 0.035, H * (0.011 + 0.011 * o.wet), false); });
  }
  function rainLines(L, x0, y0, w, h, n, R) {
    for (let i = 0; i < n; i++) { const x = x0 + R() * w, y = y0 + R() * h; ink(L, `M${f(x)},${f(y)} l-1.6,${f(5 + R() * 3)}`, 'b-fine'); }
  }
  function cloud(L, x, y, s) {
    const bumps = [[-1.2, 0.1, 0.8], [-0.4, -0.5, 1], [0.6, -0.35, 0.9], [1.3, 0.15, 0.65]];
    for (const [bx, by, br] of bumps) el('circle', { cx: f(x + bx * s), cy: f(y + by * s), r: f(br * s + 0.5), class: 'b-ink' }, L.ink);
    for (const [bx, by, br] of bumps) el('circle', { cx: f(x + bx * s), cy: f(y + by * s), r: f(br * s), class: 'c-paper' }, L.ink);
    el('rect', { x: f(x - 2 * s), y: f(y + 0.12 * s), width: f(4 * s), height: f(s), class: 'c-paper' }, L.ink);
    ink(L, `M${f(x - 1.95 * s)},${f(y + 0.15 * s)} L${f(x + 1.95 * s)},${f(y + 0.15 * s)}`, 'b-ink');
    for (let k = 0; k < 5; k++) ink(L, `M${f(x - 1.4 * s + k * 0.6 * s)},${f(y - 0.05 * s)} l${f(0.4 * s)},0`, 'b-hair');
  }

  // Slå nu: en gammeldags cylinderklipper med malede støbejernshjul og træskaft.
  // Højt græs foran, kort stub bagved og afklip, der flyver fra knivcylinderen.
  function mower(g, o = {}) {
    const R = rng(o.seed || 71), plate = o.detail === 'plate', H = o.height || 100;
    const season = o.season || 'summer', leafCls = season === 'winter' ? 'c-winter' : 'c-leaf';
    const BG = layers(g);
    el('ellipse', { cx: f(H * 0.05), cy: 1.5, rx: f(H * 0.75), ry: 2.6, class: 'c-soil' }, BG.wash);
    // kort stub, hvor der er slået
    for (let i = 0; i < (plate ? 46 : 28); i++) {
      const x = -H * 0.7 + R() * H * 0.68, b = blade([x, 0], (R() - 0.5) * 0.5, H * (0.035 + R() * 0.03), Math.max(1.4, H * 0.02), (R() - 0.5) * 0.3, 'leaf', 6);
      wash(BG, b.outline, leafCls); ink(BG, b.outline, 'b-hair');
    }
    const M = el('g', { class: 'mower' }, g), L = layers(M);
    const Rw = H * 0.19, Cn = [H * 0.04, -Rw], Cf = [H * 0.24, -Rw - H * 0.07];
    const wheel = (c, r, near) => {
      const W = el('g', { class: 'wheelspin' }, L.ink), WL = { wash: el('g', { filter: 'url(#bWash)', class: 'bw' }, W), ink: W };
      const circ = rr => `M${f(c[0] + rr)},${f(c[1])} A${f(rr)},${f(rr)} 0 1,1 ${f(c[0] - rr)},${f(c[1])} A${f(rr)},${f(rr)} 0 1,1 ${f(c[0] + rr)},${f(c[1])} Z`;
      wash(WL, circ(r), 'c-iron', 0, 0);
      wash(WL, circ(r * 0.84), near ? 'c-paint' : 'c-paintd', 0, 0);
      ink(WL, circ(r), 'b-ink'); ink(WL, circ(r * 0.84), 'b-fine');
      if (near) {
        el('path', { d: circ(r * 0.74), class: 'b-gold' }, W);
        for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; ink(WL, `M${f(c[0] + Math.cos(a) * r * 0.86)},${f(c[1] + Math.sin(a) * r * 0.86)} L${f(c[0] + Math.cos(a) * r * 0.98)},${f(c[1] + Math.sin(a) * r * 0.98)}`, 'b-hair'); }
        for (let k = 0; k < 6; k++) {
          const a = k / 6 * Math.PI * 2 + 0.3, a2 = a + 0.35;
          const sp = `M${f(c[0] + Math.cos(a) * r * 0.16)},${f(c[1] + Math.sin(a) * r * 0.16)} Q${f(c[0] + Math.cos(a + 0.25) * r * 0.5)},${f(c[1] + Math.sin(a + 0.25) * r * 0.5)} ${f(c[0] + Math.cos(a2) * r * 0.8)},${f(c[1] + Math.sin(a2) * r * 0.8)}`;
          el('path', { d: sp, class: 'b-spoke' }, W); ink(WL, sp, 'b-fine');
        }
        el('circle', { cx: f(c[0]), cy: f(c[1]), r: f(r * 0.18), class: 'c-iron' }, W);
        el('circle', { cx: f(c[0]), cy: f(c[1]), r: f(r * 0.18), class: 'b-fine' }, W);
        el('circle', { cx: f(c[0]), cy: f(c[1]), r: f(r * 0.07), class: 'c-brass' }, W);
        for (let k = 0; k < 7; k++) { const a = 3.6 + k * 0.12; ink(WL, `M${f(c[0] + Math.cos(a) * r * 0.86)},${f(c[1] + Math.sin(a) * r * 0.86)} L${f(c[0] + Math.cos(a) * r * 0.62)},${f(c[1] + Math.sin(a) * r * 0.62)}`, 'b-hair'); }
      }
      return W;
    };
    wheel(Cf, Rw * 0.92, false);
    // knivcylinder mellem hjulene
    const rr = H * 0.1, Rn = [H * 0.11, -H * 0.115], Rf = [H * 0.31, -H * 0.185];
    const rx = rr * 0.38;
    const reel = `M${f(Rn[0])},${f(Rn[1] - rr)} L${f(Rf[0])},${f(Rf[1] - rr)} A${f(rx)},${f(rr)} 0 0 1 ${f(Rf[0])},${f(Rf[1] + rr)} L${f(Rn[0])},${f(Rn[1] + rr)} Z`;
    wash(L, reel, 'c-steel'); wash(L, `M${f(Rn[0])},${f(Rn[1] + rr * 0.2)} L${f(Rf[0])},${f(Rf[1] + rr * 0.2)} L${f(Rf[0])},${f(Rf[1] + rr)} L${f(Rn[0])},${f(Rn[1] + rr)} Z`, 'c-steeld', 0.2, 0.2);
    ink(L, reel, 'b-ink');
    for (let k = 0; k < 5; k++) {
      const u = k / 4.5 - 0.1;
      const a = [lerp(Rn[0], Rf[0], u), lerp(Rn[1], Rf[1], u) - rr * 0.95], b = [lerp(Rn[0], Rf[0], u + 0.28), lerp(Rn[1], Rf[1], u + 0.28) + rr * 0.95];
      ink(L, `M${f(a[0])},${f(a[1])} Q${f(lerp(a[0], b[0], 0.5) + rr * 0.25)},${f(lerp(a[1], b[1], 0.5))} ${f(b[0])},${f(b[1])}`, 'b-fine');
      ink(L, `M${f(a[0] + 1)},${f(a[1])} Q${f(lerp(a[0], b[0], 0.5) + rr * 0.25 + 1)},${f(lerp(a[1], b[1], 0.5))} ${f(b[0] + 1)},${f(b[1])}`, 'b-glintline');
    }
    el('ellipse', { cx: f(Rf[0]), cy: f(Rf[1]), rx: f(rx), ry: f(rr), class: 'b-fine' }, L.ink);
    ink(L, `M${f(Rn[0] - 3)},${f(-1.5)} L${f(Rf[0] - 3)},${f(-H * 0.07)}`, 'b-spine');
    // bagvalse
    const vr = H * 0.05, Vn = [-H * 0.25, -vr], Vf = [-H * 0.05, -vr - H * 0.07];
    const roll = `M${f(Vn[0])},${f(Vn[1] - vr)} L${f(Vf[0])},${f(Vf[1] - vr)} A${f(vr * 0.4)},${f(vr)} 0 0 1 ${f(Vf[0])},${f(Vf[1] + vr)} L${f(Vn[0])},${f(Vn[1] + vr)} Z`;
    wash(L, roll, 'c-iron'); ink(L, roll, 'b-ink');
    for (let k = 1; k < 6; k++) { const u = k / 6; ink(L, `M${f(lerp(Vn[0], Vf[0], u))},${f(lerp(Vn[1], Vf[1], u) - vr)} l0,${f(vr * 2)}`, 'b-hair'); }
    el('ellipse', { cx: f(Vn[0]), cy: f(Vn[1]), rx: f(vr * 0.4), ry: f(vr), class: 'c-iron' }, L.ink);
    el('ellipse', { cx: f(Vn[0]), cy: f(Vn[1]), rx: f(vr * 0.4), ry: f(vr), class: 'b-fine' }, L.ink);
    // sideplade i støbejern
    const plateP = smooth([[Cn[0] + Rw * 0.25, Cn[1] - Rw * 0.2], [Cn[0] - Rw * 0.4, Cn[1] - Rw * 0.45], [Vn[0] + vr, Vn[1] - vr * 1.6], [Vn[0] - vr * 0.2, Vn[1] - vr * 0.4], [Vn[0] + vr * 0.9, Vn[1] + vr * 0.4], [Cn[0] - Rw * 0.6, Cn[1] + Rw * 0.35], [Cn[0] + Rw * 0.1, Cn[1] + Rw * 0.25]], true);
    wash(L, plateP, 'c-paintd'); ink(L, plateP, 'b-ink');
    el('circle', { cx: f(lerp(Cn[0], Vn[0], 0.55)), cy: f(lerp(Cn[1], Vn[1], 0.55) - H * 0.01), r: f(H * 0.025), class: 'c-paper' }, L.ink);
    el('circle', { cx: f(lerp(Cn[0], Vn[0], 0.55)), cy: f(lerp(Cn[1], Vn[1], 0.55) - H * 0.01), r: f(H * 0.025), class: 'b-fine' }, L.ink);
    wheel(Cn, Rw, true);
    // skaft med gaffel og T-greb
    const Hb = [-H * 0.08, -H * 0.3], Ht = [-H * 0.56, -H * 0.94];
    for (const end of [Cn, Cf]) { const br = tube([end, [lerp(end[0], Hb[0], 0.5), lerp(end[1], Hb[1], 0.5) - H * 0.01], Hb], Math.max(1.2, H * 0.016)); wash(L, br.outline, 'c-iron'); ink(L, br.outline, 'b-fine'); }
    const sh = tube([Hb, [lerp(Hb[0], Ht[0], 0.5) + H * 0.01, lerp(Hb[1], Ht[1], 0.5)], Ht], Math.max(2, H * 0.032));
    wash(L, sh.outline, 'c-wood'); ink(L, sh.outline, 'b-ink');
    ink(L, smooth([Hb, [lerp(Hb[0], Ht[0], 0.5) + H * 0.012, lerp(Hb[1], Ht[1], 0.5) + 0.4], Ht]), 'b-hair');
    const dx = Ht[0] - Hb[0], dy = Ht[1] - Hb[1], m = Math.hypot(dx, dy), nx = -dy / m, ny = dx / m;
    const T0 = [Ht[0] - nx * H * 0.13, Ht[1] - ny * H * 0.13], T1 = [Ht[0] + nx * H * 0.13, Ht[1] + ny * H * 0.13];
    const tb = tube([T0, Ht, T1], Math.max(2.2, H * 0.036));
    wash(L, tb.outline, 'c-wood'); wash(L, tb.outline, 'c-woodd', 0.2, 0.2); ink(L, tb.outline, 'b-ink');
    for (const e of [T0, T1]) { el('ellipse', { cx: f(e[0]), cy: f(e[1]), rx: f(H * 0.012), ry: f(H * 0.02), class: 'c-brass', transform: `rotate(${f(Math.atan2(dy, dx) * 180 / Math.PI)} ${f(e[0])} ${f(e[1])})` }, L.ink); }
    el('circle', { cx: f(Hb[0]), cy: f(Hb[1]), r: f(H * 0.018), class: 'c-iron' }, L.ink);
    el('circle', { cx: f(Hb[0]), cy: f(Hb[1]), r: f(H * 0.018), class: 'b-fine' }, L.ink);
    // afklip, der flyver fra cylinderen
    const CL = el('g', { class: 'clippings' }, g);
    for (let i = 0; i < (plate ? 9 : 6); i++) {
      const x = Rf[0] + H * (0.02 + R() * 0.18), y = Rf[1] - rr - H * (0.02 + R() * 0.16);
      const piece = el('g', { transform: `translate(${f(x)} ${f(y)}) rotate(${f(R() * 360)})` }, el('g', { class: 'clip' }, CL)), P = { wash: piece, ink: piece };
      const b = blade([0, 0], 0, H * (0.04 + R() * 0.03), Math.max(1.4, H * 0.024), (R() - 0.5) * 0.4, 'leaf', 6);
      bladeInk(P, b, { cls: 'c-leaf2', noHatch: true, noVein2: true });
    }
    // højt græs foran klipperen
    const FR = layers(g);
    const tips = tuft(FR, H * 0.52, 0, H * 0.4, plate ? 11 : 8, 0.72, R, { cls: r => (season === 'autumn' && r() < 0.3 ? 'c-ochre' : leafCls) });
    tips.push(...tuft(FR, H * 0.74, 0, H * 0.3, 5, 0.6, R, { cls: () => leafCls }));
    weatherOnTips(FR, tips, o, H);
    if (o.rain) rainLines(FR, -H * 0.6, -H * 1.0, H * 1.3, H * 0.5, plate ? 40 : 24, R);
    if (plate) {
      const d = el('g', { transform: `translate(${f(H * 0.6)} ${f(-H * 0.82)}) scale(2.2)` }, g), DL = layers(d);
      const b = blade([0, 9], 0.12, 12, 3.6, 0.15);
      if (o.wet > 0.05 && !o.frost) { bladeInk(DL, b, { cls: leafCls, noHatch: true }); dewDrop(DL, b.tip[0] + 0.3, b.tip[1] + 2.2, 2.2, false); }
      else {
        // et rent afskåret strå: skarpe knive giver et lige snit
        const cut = 'M-1.8,9 C-1.8,4 -1.6,0 -1.5,-3 L1.5,-3.6 C1.6,0 1.8,4 1.8,9 Z';
        wash(DL, cut, leafCls); ink(DL, cut, 'b-fine'); ink(DL, 'M-1.5,-3 L1.5,-3.6', 'b-ink');
        for (const yy of [6, 3, 0]) ink(DL, `M-0.6,${yy + 2} L-0.6,${yy - 1}`, 'b-hair');
      }
      el('text', { x: -8, y: 3, class: 'b-num' }, d).textContent = '1.';
    }
  }

  // Klippeplan: græsarten med en tommestok, klippelinje og afklippede spidser.
  function measure(g, o = {}) {
    const R = rng((o.seed || 61) + 7), H = o.height || 100, plate = o.detail === 'plate';
    const pg = el('g', { class: 'growgrass' }, g);
    grass(pg, Object.assign({}, o, { detail: plate ? 'plate' : 'vignette', height: H * 0.92 }));
    const L = layers(g);
    // tommestok
    const rx = H * 0.5, rw = Math.max(4, H * 0.06), seg = H * 0.2, nseg = 5;
    for (let k = 0; k < nseg; k++) {
      const y1 = -k * seg, y0 = y1 - seg;
      const d = `M${f(rx)},${f(y1)} L${f(rx + rw)},${f(y1)} L${f(rx + rw)},${f(y0)} L${f(rx)},${f(y0)} Z`;
      wash(L, d, 'c-rule', 0, 0); ink(L, d, 'b-ink');
      for (let m = 1; m < 10; m++) { const y = y1 - m * seg / 10; ink(L, `M${f(rx)},${f(y)} l${f(m === 5 ? rw * 0.55 : rw * 0.3)},0`, 'b-hair'); }
      el('text', { x: f(rx + rw * 0.62), y: f(y1 - seg * 0.42), class: 'b-rulenum' }, L.ink).textContent = String(k + 1);
      el('circle', { cx: f(rx + rw / 2), cy: f(y0), r: f(rw * 0.16), class: 'c-brass' }, L.ink);
      el('circle', { cx: f(rx + rw / 2), cy: f(y0), r: f(rw * 0.16), class: 'b-hair' }, L.ink);
    }
    // klippelinje og afklip
    const cy = -H * 0.36;
    el('path', { d: `M${f(-H * 0.62)},${f(cy)} L${f(rx)},${f(cy)}`, class: 'b-cut' }, L.ink);
    el('path', { d: `M${f(rx - 4)},${f(cy - 3)} L${f(rx)},${f(cy)} L${f(rx - 4)},${f(cy + 3)}`, class: 'b-fine' }, L.ink);
    const CL = el('g', { class: 'clippings' }, g), C2 = { wash: CL, ink: CL };
    for (let i = 0; i < (plate ? 9 : 6); i++) {
      const x = -H * 0.45 + R() * H * 0.85, y = cy - H * (0.05 + R() * 0.25);
      const piece = el('g', { class: 'clip', transform: `translate(${f(x)} ${f(y)}) rotate(${f((R() - 0.5) * 140)})` }, CL);
      const P = { wash: piece, ink: piece };
      const b = blade([0, 0], 0, H * (0.06 + R() * 0.05), Math.max(1.6, H * 0.035), (R() - 0.5) * 0.4, 'leaf', 8);
      bladeInk(P, b, { cls: 'c-leaf2', noHatch: true, noVein2: true });
    }
    void C2;
  }

  // Regn & vand: en zinkvandkande, der vander en lille tue, og en sky med regn.
  function wateringCan(g, o = {}) {
    const R = rng(o.seed || 41), H = o.height || 100, plate = o.detail === 'plate';
    const season = o.season || 'summer';
    // kandens geometri først, så græstuen kan placeres der, hvor strålen lander
    const th = 20 * Math.PI / 180, ct = Math.cos(th), sn = Math.sin(th);
    const rot = p => [p[0] * ct - p[1] * sn, p[0] * sn + p[1] * ct];
    const w2 = H * 0.23, hgt = H * 0.42, ry = H * 0.05;
    const sp0 = [w2 * 0.9, -H * 0.09], sp1 = [H * (o.compact ? 0.66 : 0.72), -H * (o.compact ? 0.52 : 0.58)];
    const spts = []; for (let i = 0; i <= 12; i++) { const t = i / 12; spts.push([lerp(sp0[0], sp1[0], t) + Math.sin(Math.PI * t) * H * 0.03, lerp(sp0[1], sp1[1], t)]); }
    const ang = Math.atan2(sp1[1] - spts[10][1], sp1[0] - spts[10][0]);
    const rgx = sp1[0] + Math.cos(ang) * H * 0.03, rgy = sp1[1] + Math.sin(ang) * H * 0.03;
    const roseG = rot([rgx, rgy]);
    const L0 = layers(g);
    const tgx = roseG[0] + H * (o.compact ? 0.22 : 0.4);
    const tips = tuft(L0, tgx, 0, H * 0.3, 7, 0.75, R, { cls: () => (season === 'winter' ? 'c-winter' : 'c-leaf') });
    void tips;
    for (const [dx, a] of [[-H * 0.12, -0.5], [H * 0.12, 0.45]]) {
      const pet = blade([tgx + dx, 0], a, H * 0.2, 1, 0, 'stem', 8);
      ink(L0, smooth(pet.C), 'b-fine');
      for (const da of [-1.15, 0, 1.15]) leaflet(L0, pet.tip, a + da, H * 0.07, H * 0.058, { cls: 'c-clover' }, R);
    }
    el('ellipse', { cx: f(tgx), cy: 1.5, rx: f(H * 0.22), ry: 2.5, class: 'c-soil' }, L0.wash);
    // sky og regn
    const CL = layers(g);
    const cxy = o.compact ? [tgx - H * 0.04, -H * 0.86] : [tgx + H * 0.02, -H * 1.0];
    cloud(CL, cxy[0], cxy[1], H * 0.085);
    const rain = el('g', { class: 'skyrain' }, g);
    rainLines({ wash: rain, ink: rain }, cxy[0] - H * 0.15, cxy[1] + H * 0.08, H * 0.3, H * (o.compact ? 0.32 : 0.45), plate ? 18 : 9, R);
    // kanden, vippet frem
    const C = el('g', { class: 'can', transform: 'rotate(20)' }, g), L = layers(C);
    // tud
    const spout = tube(spts, t => H * (0.055 - 0.03 * t));
    wash(L, spout.outline, 'c-zinc'); ink(L, spout.outline, 'b-ink');
    // bruser
    const cone = `M${f(sp1[0] - Math.sin(ang) * H * 0.014)},${f(sp1[1] + Math.cos(ang) * H * 0.014)} L${f(rgx - Math.sin(ang) * H * 0.045)},${f(rgy + Math.cos(ang) * H * 0.045)} L${f(rgx + Math.sin(ang) * H * 0.045)},${f(rgy - Math.cos(ang) * H * 0.045)} L${f(sp1[0] + Math.sin(ang) * H * 0.014)},${f(sp1[1] - Math.cos(ang) * H * 0.014)} Z`;
    wash(L, cone, 'c-zinc'); ink(L, cone, 'b-fine');
    const deg = ang * 180 / Math.PI + 90;
    el('ellipse', { cx: f(rgx), cy: f(rgy), rx: f(H * 0.046), ry: f(H * 0.017), transform: `rotate(${f(deg)} ${f(rgx)} ${f(rgy)})`, class: 'c-zincd' }, L.ink);
    el('ellipse', { cx: f(rgx), cy: f(rgy), rx: f(H * 0.046), ry: f(H * 0.017), transform: `rotate(${f(deg)} ${f(rgx)} ${f(rgy)})`, class: 'b-fine' }, L.ink);
    // bagerste hank
    const hk = tube([[-w2 * 0.95, -hgt * 0.92], [-w2 * 1.55, -hgt * 0.78], [-w2 * 1.62, -hgt * 0.45], [-w2 * 1.2, -hgt * 0.2], [-w2 * 0.95, -hgt * 0.16]], H * 0.032);
    wash(L, hk.outline, 'c-zinc'); ink(L, hk.outline, 'b-ink');
    // krop
    const body = `M${f(-w2)},${f(-hgt)} L${f(-w2)},0 A${f(w2)},${f(ry)} 0 0 0 ${f(w2)},0 L${f(w2)},${f(-hgt)} Z`;
    wash(L, body, 'c-zinc', 0.3, 0.3);
    wash(L, `M${f(w2 * 0.3)},${f(-hgt)} L${f(w2 * 0.3)},${f(ry * 0.9)} A${f(w2)},${f(ry)} 0 0 0 ${f(w2)},0 L${f(w2)},${f(-hgt)} Z`, 'c-zincd', 0.2, 0.2);
    ink(L, body, 'b-ink');
    for (let k = 0; k < 7; k++) { const x = w2 * (0.42 + k * 0.08); ink(L, `M${f(x)},${f(-hgt + 2)} L${f(x)},${f(-1)}`, 'b-hair'); }
    for (let k = 0; k < 3; k++) { const x = -w2 * (0.9 - k * 0.06); ink(L, `M${f(x)},${f(-hgt + 2)} L${f(x)},${f(-1)}`, 'b-hair'); }
    ink(L, `M${f(-w2 * 0.45)},${f(-hgt + 3)} L${f(-w2 * 0.45)},${f(-3)}`, 'b-glintline');
    for (const yy of [-hgt * 0.22, -hgt * 0.8]) ink(L, `M${f(-w2)},${f(yy)} A${f(w2)},${f(ry)} 0 0 0 ${f(w2)},${f(yy)}`, 'b-fine');
    el('ellipse', { cx: 0, cy: f(-hgt), rx: f(w2), ry: f(ry), class: 'c-zincd' }, L.ink);
    el('ellipse', { cx: 0, cy: f(-hgt), rx: f(w2), ry: f(ry), class: 'b-ink' }, L.ink);
    el('ellipse', { cx: 0, cy: f(-hgt + ry * 0.25), rx: f(w2 * 0.86), ry: f(ry * 0.7), class: 'c-water' }, L.ink);
    // øverste bøjle
    const th2 = tube([[-w2 * 0.7, -hgt], [-w2 * 0.45, -hgt - H * 0.17], [w2 * 0.35, -hgt - H * 0.17], [w2 * 0.62, -hgt]], H * 0.026);
    wash(L, th2.outline, 'c-zinc'); ink(L, th2.outline, 'b-ink');
    // vandstråler fra bruseren (i sidens koordinater, så tyngdekraften virker nedad)
    const W = el('g', { class: 'spray' }, g);
    const rg = rot([rgx, rgy]), dir = rot([Math.cos(ang), Math.sin(ang)]);
    const ns = plate ? 15 : 11, grav = H * 0.55;
    for (let k = 0; k < ns; k++) {
      const u = k / (ns - 1) - 0.5;
      const off = u * H * 0.07;
      const sx = rg[0] - dir[1] * off, sy = rg[1] + dir[0] * off;
      // sigtepunkt i toppen af tuen; strålen fortsætter lidt ned mellem stråene
      const tx = tgx + u * H * 0.26 + (R() - 0.5) * H * 0.03, ty = -H * (0.17 + R() * 0.08);
      const ddx = dir[0] + u * 0.06, ddy = dir[1] - Math.abs(u) * 0.05, dm = Math.hypot(ddx, ddy), ux = ddx / dm, uy = ddy / dm;
      const den = ux * ux * (ty - sy - uy * (tx - sx) / ux);
      if (!(ux > 0.05 && den > 0)) continue;
      const v = Math.sqrt(grav * (tx - sx) * (tx - sx) / den);
      const tHit = (tx - sx) / (v * ux), tEnd = tHit * 1.06;
      const pts = [];
      for (let i = 0; i <= 18; i++) { const t = tEnd * i / 18; pts.push([sx + v * ux * t, sy + v * uy * t + grav * t * t]); }
      el('path', { d: smooth(pts), class: 'b-water' }, W);
      const e = pts[pts.length - 1];
      el('circle', { cx: f(e[0]), cy: f(e[1]), r: f(H * 0.009), class: 'c-water' }, W);
      if (k % 3 === 0) for (const sd of [-1, 1]) el('path', { d: `M${f(e[0])},${f(e[1])} q${f(sd * H * 0.012)},${f(-H * 0.02)} ${f(sd * H * 0.022)},${f(-H * 0.004)}`, class: 'b-water' }, W);
    }
    if (plate) {
      const d = el('g', { transform: `translate(${f(H * 0.5)} ${f(-H * 0.92)}) scale(2.4)` }, g), DL = layers(d);
      el('circle', { r: 6, class: 'c-zinc' }, DL.wash); el('circle', { r: 6, class: 'b-ink' }, DL.ink);
      el('circle', { r: 5, class: 'b-hair' }, DL.ink);
      for (let rr = 1; rr <= 4; rr++) for (let k = 0; k < rr * 6; k++) { const a = k / (rr * 6) * Math.PI * 2; el('circle', { cx: f(Math.cos(a) * rr * 1.15), cy: f(Math.sin(a) * rr * 1.15), r: 0.28, class: 'b-dot' }, DL.ink); }
      el('circle', { r: 0.28, class: 'b-dot' }, DL.ink);
      el('text', { x: -9.5, y: 1.5, class: 'b-num' }, d).textContent = '1.';
    }
  }

  // Din plæne: et snit gennem plænen med græstørv, muldlag og undergrund efter jordbunden.
  function soilProfile(g, o = {}) {
    const R = rng(o.seed || 51), H = o.height || 100, plate = o.detail === 'plate';
    const soil = o.soil || 'loam', season = o.season || 'summer', rootF = o.root || 1;
    const W = H * 0.86, D = H * 0.72, ox = H * 0.24, oy = -H * 0.13, top = -D;
    const L = layers(g);
    const fx0 = -W / 2, fx1 = W / 2;
    const turf = top + D * 0.1, muld = top + D * (soil === 'sand' ? 0.3 : 0.38);
    const wav = (y, a) => { const pts = []; for (let i = 0; i <= 10; i++) pts.push([lerp(fx0, fx1, i / 10), y + Math.sin(i * 1.7 + a) * H * 0.012]); return pts; };
    const lay = (yA, yB, cls) => { const A = wav(yA, 1), B = wav(yB, 2.3).reverse(); return { d: poly(A.concat(B), true), cls }; };
    const lower = soil === 'sand' ? 'c-sand' : soil === 'clay' ? 'c-clay' : 'c-loam';
    const bands = [lay(top, turf, 'c-turf'), lay(turf, muld, 'c-muld'), lay(muld, 0, lower)];
    const SG = el('g', { class: 'soilfront' }, g), SL = { wash: el('g', { filter: 'url(#bWash)', class: 'bw' }, SG), ink: el('g', {}, SG) };
    for (const b of bands) wash(SL, b.d, b.cls, 0, 0);
    // sideflade og overflade
    const side = `M${f(fx1)},${f(top)} L${f(fx1 + ox)},${f(top + oy)} L${f(fx1 + ox)},${f(oy)} L${f(fx1)},0 Z`;
    wash(L, side, lower, 0, 0); wash(L, side, 'c-shade', 0, 0);
    const sideTurf = `M${f(fx1)},${f(top)} L${f(fx1 + ox)},${f(top + oy)} L${f(fx1 + ox)},${f(muld + oy)} L${f(fx1)},${f(muld)} Z`;
    wash(L, sideTurf, 'c-muld', 0, 0); wash(L, sideTurf, 'c-shade', 0, 0);
    for (let k = 1; k < 9; k++) { const t = k / 9; ink(L, `M${f(fx1 + ox * t)},${f(top + oy * t + 3)} L${f(fx1 + ox * t)},${f(oy * t - 2)}`, 'b-hair'); }
    const topf = `M${f(fx0)},${f(top)} L${f(fx1)},${f(top)} L${f(fx1 + ox)},${f(top + oy)} L${f(fx0 + ox)},${f(top + oy)} Z`;
    wash(L, topf, season === 'winter' ? 'c-winter' : 'c-leaf', 0, 0);
    for (let k = 0; k < 40; k++) { const t = R(), u = R(); const x = fx0 + (fx1 - fx0) * t + ox * u, y = top + oy * u; ink(L, `M${f(x)},${f(y)} l${f((R() - 0.5) * 1.5)},${f(-2 - R() * 2)}`, 'b-hair'); }
    // tekstur i lagene
    const inFront = (x, y) => x > fx0 + 1 && x < fx1 - 1 && y > top + 1 && y < -1;
    for (let k = 0; k < (plate ? 70 : 40); k++) { const x = lerp(fx0, fx1, R()), y = lerp(turf, muld, R()); if (inFront(x, y)) el('circle', { cx: f(x), cy: f(y), r: f(0.4 + R() * 0.7), class: 'c-crumb' }, SL.ink); }
    if (soil === 'sand') for (let k = 0; k < (plate ? 260 : 140); k++) { const x = lerp(fx0, fx1, R()), y = lerp(muld, 0, R()); if (inFront(x, y)) el('circle', { cx: f(x), cy: f(y), r: f(0.25 + R() * 0.3), class: 'b-dot' }, SL.ink); }
    if (soil === 'clay') for (let k = 0; k < 9; k++) { const y = lerp(muld + 4, -3, k / 8); ink(SL, smooth(wav(y, k).map(p => [p[0], p[1] + (R() - 0.5)]).slice(1, 10)), 'b-hair'); }
    if (soil !== 'sand') for (let k = 0; k < (plate ? 60 : 30); k++) { const x = lerp(fx0, fx1, R()), y = lerp(muld, 0, R()); if (inFront(x, y)) el('circle', { cx: f(x), cy: f(y), r: f(0.4 + R() * 0.6), class: 'c-crumb' }, SL.ink); }
    for (let k = 0; k < (soil === 'sand' ? 5 : 3); k++) {
      const x = lerp(fx0 + 6, fx1 - 6, R()), y = lerp(muld + 5, -5, R()), r = H * (0.02 + R() * 0.025);
      const st = `M${f(x - r)},${f(y)} C${f(x - r)},${f(y - r * 0.8)} ${f(x + r)},${f(y - r * 0.9)} ${f(x + r)},${f(y)} C${f(x + r)},${f(y + r * 0.7)} ${f(x - r)},${f(y + r * 0.8)} ${f(x - r)},${f(y)} Z`;
      wash(SL, st, 'c-stone', 0, 0); ink(SL, st, 'b-fine');
      ink(SL, `M${f(x - r * 0.4)},${f(y + r * 0.2)} l${f(r * 0.6)},${f(r * 0.3)}`, 'b-hair');
    }
    // regnorm i muldlaget
    if (soil !== 'sand' || plate) {
      const wy = lerp(muld, 0, 0.35), wx = lerp(fx0, fx1, 0.62);
      const wp = []; for (let i = 0; i <= 14; i++) wp.push([wx - H * 0.12 + i * H * 0.017, wy + Math.sin(i * 0.7) * H * 0.02]);
      const wt = tube(wp, t => H * 0.022 * (0.6 + 0.4 * Math.sin(Math.PI * t)));
      const WG = el('g', { class: 'worm' }, SG), WL = { wash: WG, ink: WG };
      el('path', { d: wt.outline, class: 'c-worm' }, WG); ink(WL, wt.outline, 'b-fine');
      for (let i = 2; i < 13; i += 1.5) { const p = wp[Math.floor(i)]; ink(WL, `M${f(p[0])},${f(p[1] - H * 0.009)} l0,${f(H * 0.018)}`, 'b-hair'); }
    }
    // rødder ned i jorden
    const RG = el('g', { class: 'roots' }, SG), RL = { wash: RG, ink: RG };
    const depth = Math.min(-2, top + D * (0.45 + 0.4 * (rootF - 0.9)));
    for (let k = 0; k < (plate ? 22 : 14); k++) {
      const x0 = lerp(fx0 + 4, fx1 - 4, (k + R() * 0.6) / (plate ? 22 : 14));
      const pts = [[x0, top]]; let x = x0, y = top, a = (R() - 0.5) * 0.4;
      while (y < depth) { a += (R() - 0.5) * 0.45; a = Math.max(-0.6, Math.min(0.6, a)); x += Math.sin(a) * H * 0.04; y += H * 0.04 * (0.7 + R() * 0.5); pts.push([Math.max(fx0 + 1, Math.min(fx1 - 1, x)), Math.min(y, depth)]); }
      ink(RL, smooth(pts), 'b-root');
    }
    ink(SL, `M${f(fx0)},${f(top)} L${f(fx0)},0 L${f(fx1)},0 L${f(fx1)},${f(top)}`, 'b-ink');
    for (const yy of [turf, muld]) ink(SL, smooth(wav(yy, yy)), 'b-fine');
    ink(L, `M${f(fx0)},${f(top)} L${f(fx0 + ox)},${f(top + oy)} L${f(fx1 + ox)},${f(top + oy)} L${f(fx1 + ox)},${f(oy)} L${f(fx1)},0 M${f(fx1)},${f(top)} L${f(fx1 + ox)},${f(top + oy)} M${f(fx0)},${f(top)} L${f(fx1)},${f(top)}`, 'b-ink');
    // græs og en tusindfryd på toppen
    const GT = layers(g);
    tuft(GT, lerp(fx0, fx1, 0.25), top, H * 0.36, 7, 0.7, R, { cls: () => (season === 'winter' ? 'c-winter' : 'c-leaf') });
    tuft(GT, lerp(fx0, fx1, 0.78) + ox * 0.4, top + oy * 0.4, H * 0.32, 6, 0.6, R, { cls: () => (season === 'winter' ? 'c-winter' : 'c-leaf') });
    if (o.kind && season !== 'winter') {
      const st = blade([lerp(fx0, fx1, 0.5), top], 0.08, H * 0.34, 1.6, -0.1, 'stem', 14);
      bladeInk(GT, st, { cls: season === 'autumn' ? 'c-straw' : 'c-leaf2', noHatch: true, noVein2: true });
      inflorescence(GT, st.tip, 0.08, H * 0.16, o.kind, season, R);
    }
    if (season !== 'winter') {
      const sc = blade([lerp(fx0, fx1, 0.1) + ox * 0.6, top + oy * 0.6], -0.25, H * 0.24, 1, 0.1, 'stem', 10);
      ink(GT, smooth(sc.C), 'b-fine');
      bellisHead(GT, sc.tip[0], sc.tip[1] - 1, H * 0.06, 0.6, -0.2, R);
    }
    if (plate) {
      const lx = fx1 + ox + 6;
      [['a.', (top + turf) / 2 + oy], ['b.', (turf + muld) / 2 + oy], ['c.', muld / 2 + oy]].forEach(([t, y]) => {
        el('text', { x: f(lx), y: f(y + 2), class: 'b-numL' }, g).textContent = t;
      });
    }
  }

  /* ------------------------------ symboler ------------------------------ */
  function emblem(g, kind) {
    const L = layers(g);
    if (kind === 'sun') {
      el('circle', { r: 6.5, class: 'c-sun' }, L.wash);
      ink(L, 'M6.5,0 A6.5,6.5 0 1,1 -6.5,0 A6.5,6.5 0 1,1 6.5,0', 'b-fine');
      for (let k = 0; k < 16; k++) {
        const a = k * Math.PI / 8, r1 = 8.6, r2 = k % 2 ? 11.5 : 14;
        if (k % 2) ink(L, `M${f(Math.cos(a) * r1)},${f(Math.sin(a) * r1)} L${f(Math.cos(a) * r2)},${f(Math.sin(a) * r2)}`, 'b-fine');
        else { const m = (r1 + r2) / 2, na = a + Math.PI / 2; ink(L, `M${f(Math.cos(a) * r1)},${f(Math.sin(a) * r1)} Q${f(Math.cos(a) * m + Math.cos(na) * 1.6)},${f(Math.sin(a) * m + Math.sin(na) * 1.6)} ${f(Math.cos(a) * r2)},${f(Math.sin(a) * r2)}`, 'b-fine'); }
      }
    } else if (kind === 'moon') {
      const d = 'M2,-10 A10,10 0 1,0 9,6 A8,8 0 1,1 2,-10 Z';
      wash(L, d, 'c-moon'); ink(L, d, 'b-fine');
      for (let k = 0; k < 6; k++) ink(L, `M${-7 + k * 1.6},${-3 + k * 2} l3,-2`, 'b-hair');
      for (const [x, y] of [[12, -9], [-12, 9], [14, 4]]) ink(L, `M${x - 1.6},${y} L${x + 1.6},${y} M${x},${y - 1.6} L${x},${y + 1.6}`, 'b-hair');
    } else if (kind === 'rain' || kind === 'cloud') {
      const bumps = [[-7, 0, 5], [-2, -3.5, 6], [4, -2.5, 5.5], [8, 0.5, 4]];
      for (const [x, y, r] of bumps) el('circle', { cx: x, cy: y, r: r + 0.5, class: 'b-fine' }, L.ink);
      for (const [x, y, r] of bumps) el('circle', { cx: x, cy: y, r, class: 'c-paper' }, L.ink);
      el('rect', { x: -12, y: 0.6, width: 24, height: 6, class: 'c-paper' }, L.ink);
      ink(L, 'M-11.5,0.8 L12,0.8', 'b-fine');
      if (kind === 'rain') for (let k = 0; k < 5; k++) ink(L, `M${-7 + k * 3.6},${4} l-1.4,5`, 'b-fine');
    } else if (kind === 'frost') {
      for (let k = 0; k < 3; k++) {
        const a = k * Math.PI / 3, c = Math.cos(a), s = Math.sin(a);
        ink(L, `M${f(-c * 11)},${f(-s * 11)} L${f(c * 11)},${f(s * 11)}`, 'b-fine');
        for (const sd of [-1, 1]) for (const q of [5.5, 8.5]) {
          const px = sd * c * q, py = sd * s * q;
          for (const b of [-0.6, 0.6]) ink(L, `M${f(px)},${f(py)} l${f(Math.cos(a + b + (sd < 0 ? Math.PI : 0)) * -2.5)},${f(Math.sin(a + b + (sd < 0 ? Math.PI : 0)) * -2.5)}`, 'b-hair');
        }
      }
    } else if (kind === 'drop') {
      const d = 'M0,-11 C3,-6 7,-1 7,3.5 A7,7 0 0 1 -7,3.5 C-7,-1 -3,-6 0,-11 Z';
      wash(L, d, 'c-water'); ink(L, d, 'b-fine');
      ink(L, 'M-3.6,2 A4,4 0 0 1 -1,-2.6', 'b-glint');
    }
  }

  return { el, rng, ensureDefs, grass, alchemilla, trifolium, bellis, emblem, mower, measure, wateringCan, soilProfile, nextId: () => 'b' + (++uid) };
})();
