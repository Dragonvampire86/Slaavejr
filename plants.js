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

  return { el, rng, ensureDefs, grass, alchemilla, trifolium, bellis, emblem, nextId: () => 'b' + (++uid) };
})();
