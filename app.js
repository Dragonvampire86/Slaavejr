'use strict';
// MODEL START
const SIGMA = 5.670e-8, LAMBDA = 2.45e6, RHO_CP = 1.2 * 1013;
const SITE = {
  sun:   { sw: 1.00, sky: 1.00 },   // andel af solindstråling, andel af fri himmel (udstråling)
  half:  { sw: 0.60, sky: 0.85 },
  shade: { sw: 0.35, sky: 0.65 },
};
const GRASS = {                     // græslængde nu
  short:  { cap: 0.35, dry: 1.15 }, // mm vand stråene kan holde, relativ tørrehastighed
  normal: { cap: 0.50, dry: 1.00 },
  long:   { cap: 0.80, dry: 0.75 },
};
const GRASS_TYPES = {               // peak = vækst i mm/døgn under gode forhold; root = rodzonens dybde relativt
  rye:    { name: 'Almindelig rajgræs', latin: 'Lolium perenne L.', peak: 4.5, root: 0.9, head: 'spike', short: 'rajgræs' },
  poa:    { name: 'Eng-rapgræs', latin: 'Poa pratensis L.', peak: 3.5, root: 1.0, head: 'panicle', short: 'engrapgræs' },
  fescue: { name: 'Rød svingel', latin: 'Festuca rubra L.', peak: 2.5, root: 1.15, head: 'fescue', short: 'rødsvingel' },
  tall:   { name: 'Strand-svingel', latin: 'Festuca arundinacea Schreb.', peak: 3.5, root: 1.5, head: 'tall', short: 'strandsvingel' },
  mix:    { name: 'Græsplæne, blandet', latin: 'Gramineae', peak: 4.0, root: 1.0, head: 'spike', short: 'blandet græs' },
};
const SOILS = {                     // aw = plantetilgængeligt vand i rodzonen (mm); drain = afdræning af overfladevand pr. time; soft = grænse for blød jord (mm)
  sand: { short: 'sand', name: 'sandet jord', aw: 35, drain: 0.93, soft: 10 },
  loam: { short: 'muld', name: 'muldjord', aw: 70, drain: 0.96, soft: 6 },
  clay: { short: 'ler', name: 'lerjord', aw: 90, drain: 0.98, soft: 4 },
};
const FERT = { high: 1.25, some: 1.0, none: 0.75 };
const DRY_MM = 0.02, DAMP_MM = 0.10, FROST_C = 0.3;
// Om natten er en tæt plæne koldere end luften og fanget i sit eget fugtige luftlag. Den tørrer derfor
// næsten ikke, og den bliver våd af fugt fra den lune jord (destillation), af dråber, planten selv presser
// ud af bladspidserne (guttation), og af dug lavt i græsset. Det fanger big-leaf-ligningen med 2 m-data ikke.
// Derfor: fra 80 % luftfugtighed regnes der med fugt fra jord og plante (mm/time ved 100 %), og om natten
// fordamper der kun fra stråene, når luften er tør.
const CANOPY_MM = 0.04, CANOPY_RH = 80, FOG_MM = 0.03;

function num(v, fb) { return (v === null || v === undefined || v === '' || Number.isNaN(+v)) ? fb : +v; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function satVP(T) { return 0.6108 * Math.exp(17.27 * T / (T + 237.3)); }
// Græssets temperaturrespons: ingen vækst under 3 °C, fuld vækst 14–22 °C, aftagende til 32 °C.
function growthT(T) { if (T <= 3 || T >= 32) return 0; if (T < 14) return (T - 3) / 11; if (T <= 22) return 1; return (32 - T) / 10; }

// Kør vandbalance, jordvand og vækst time for time. h = Open-Meteo "hourly"-objekt.
function simulate(h, elevation, opts) {
  const site = SITE[opts.site] || SITE.sun;
  const grass = GRASS[opts.grass] || GRASS.normal;
  const type = GRASS_TYPES[opts.type] || GRASS_TYPES.mix;
  const soil = SOILS[opts.soil] || SOILS.loam;
  const fert = FERT[opts.fert] || 1;
  const n = h.time.length;
  const wetk = clamp(num(opts.wetk, 1), 0.5, 2);   // din haves personlige faktor: >1 = vådere end standard
  const lay = h.cloud_cover_low, mid = h.cloud_cover_mid, high = h.cloud_cover_high, vis = h.visibility;
  // dine egne meldinger ("vådt"/"tørt") lægges ind i den time, hvor de blev givet
  const nudge = new Map();
  const t0 = n ? Date.parse(h.time[0] + ':00Z') : 0;
  for (const o of opts.obs || []) { const k = Math.floor((o.t - t0) / 36e5); if (k >= 0 && k < n) nudge.set(k, !!o.wet); }
  const Patm = 101.3 * Math.pow((293 - 0.0065 * (elevation || 0)) / 293, 5.26);
  const gamma = 0.000665 * Patm;
  const C = soil.aw * type.root;
  const st = new Array(n);
  let W = 0, S = 0, source = null, AW = C, Gc = 0, rsSum = 0;
  const rsBuf = [];
  for (let i = 0; i < n; i++) {
    const T = num(h.temperature_2m[i], 10);
    const RH = clamp(num(h.relative_humidity_2m[i], 85), 1, 100);
    const u10 = Math.max(0, num(h.wind_speed_10m[i], 2));
    const u2 = Math.max(0.3, u10 * 0.748);
    const Rs = Math.max(0, num(h.shortwave_radiation[i], 0)) * site.sw;
    const cc = clamp(num(h.cloud_cover[i], 50), 0, 100) / 100;
    const P = Math.max(0, num(h.precipitation[i], 0));
    const et0 = Math.max(0, num(h.et0_fao_evapotranspiration && h.et0_fao_evapotranspiration[i], 0));
    const isDay = num(h.is_day && h.is_day[i], Rs > 5 ? 1 : 0) === 1;

    const es = satVP(T), ea = es * RH / 100;
    const delta = 4098 * es / Math.pow(T + 237.3, 2);
    const Tk = T + 273.15;
    const L0 = SIGMA * Math.pow(Tk, 4) * Math.max(0.05, 0.34 - 0.14 * Math.sqrt(ea));
    // effektivt skydække for udstrålingen: lave skyer lukker næsten helt af, tynde høje skyer kun lidt
    let ccEff = cc;
    const cl = num(lay && lay[i], null), cm = num(mid && mid[i], null), ch = num(high && high[i], null);
    if (cl !== null && cm !== null && ch !== null) ccEff = Math.min(cc, 1 - (1 - clamp(cl, 0, 100) / 100) * (1 - 0.7 * clamp(cm, 0, 100) / 100) * (1 - 0.3 * clamp(ch, 0, 100) / 100));
    const Rnl = L0 * Math.max(0.05, 1 - 0.85 * ccEff) * site.sky; // netto langbølget udstråling (W/m²)
    const Rn = 0.77 * Rs - Rnl;                                   // nettostråling, albedo 0,23
    const G = Rn > 0 ? 0.1 * Rn : 0.5 * Rn;                       // jordvarmestrøm (FAO-56, timebasis)
    const ra = 208 / u2;                                          // aerodynamisk modstand (s/m)
    const lamE = (delta * (Rn - G) + RHO_CP * (es - ea) / ra) / (delta + gamma);
    const Epot = lamE / LAMBDA * 3600;                            // mm/time; negativ = dug
    const Ts = Rn < 0 ? T + (Rn - G) / (7 + 4 * u2) : T;         // skønnet græsoverflade-temperatur

    // tåge: sigtbarhed under 1 km, eller næsten mættet luft
    const v = num(vis && vis[i], null);
    const fog = Math.max(v === null ? 0 : clamp((1000 - v) / 800, 0, 1), clamp((RH - 97) / 3, 0, 1));
    // vand på stråene
    const before = W;
    if (P > 0) { W = Math.min(grass.cap, W + P); if (P >= 0.05) source = 'rain'; }
    let gain = Math.max(0, -Epot);                                // dug fra luften
    const lowSun = !isDay || Rs < 50;                             // aften, nat og lav sol: græsset køler af
    if (lowSun && RH > CANOPY_RH) {                               // fugt fra jord og plante
      const fWind = clamp(1.15 - u2 / 10, 0.6, 1), fSoil = clamp(AW / (0.5 * C), 0.3, 1);
      gain += CANOPY_MM * (RH - CANOPY_RH) / (100 - CANOPY_RH) * fWind * fSoil;
    }
    gain += FOG_MM * fog;                                         // tågedråber, der sætter sig på stråene
    if (gain > 0) W = Math.min(grass.cap, W + gain * wetk);
    if (Epot > 0) {
      // i næsten mættet luft og tåge tørrer tætte græstæpper langt langsommere end ligningen siger
      const fSat = clamp((100 - RH) / 10, 0.15, 1) * (1 - 0.7 * fog);
      const fNight = lowSun ? clamp((CANOPY_RH - RH) / 15, 0, 1) : 1;    // om aftenen og natten kun i tør luft
      W = Math.max(0, W - Epot * grass.dry * (Ts <= 0 ? 0.3 : 1) * fSat * fNight / wetk);
    }
    if (before <= DRY_MM && W > DRY_MM && P < 0.05) source = 'dew';
    if (nudge.has(i)) {
      if (nudge.get(i)) { if (W < grass.cap * 0.8) { W = grass.cap * 0.8; source = 'obs'; } }
      else { W = 0; source = null; }
    }
    if (W <= DRY_MM) source = null;
    // overfladevand (blød jord) og jordvand i rodzonen
    S = Math.max(0, S * soil.drain + P - 0.8 * et0);
    AW = Math.min(C, AW + P);
    const fW = clamp(AW / (0.45 * C), 0, 1);
    AW = Math.max(0, AW - et0 * 0.85 * clamp(AW / (0.5 * C), 0, 1));
    // vækst (kumulativ, mm)
    rsBuf.push(Rs); rsSum += Rs; if (rsBuf.length > 24) rsSum -= rsBuf.shift();
    const fL = clamp(rsSum / rsBuf.length / 110, 0.3, 1);
    Gc += type.peak / 24 * growthT(T) * fL * fW * fert;

    st[i] = {
      t: Date.parse(h.time[i] + ':00Z'), T, RH, u10, P, Rs, cc, isDay, Epot, Ts, W, S, AW, G: Gc, source, fog,
      prob: h.precipitation_probability ? num(h.precipitation_probability[i], null) : null,
    };
  }
  return { st, cap: grass.cap, C, soft: soil.soft };
}

// Timeblokke [t_k, t_k+1): status gælder hele timen.
function toBlocks(st, softMM = 6) {
  const blocks = [];
  for (let k = 0; k < st.length - 1; k++) {
    const a = st[k], b = st[k + 1];
    const wmax = Math.max(a.W, b.W);
    const rain = b.P >= 0.1;
    const frost = a.Ts <= FROST_C || b.Ts <= FROST_C;
    const dark = !(a.isDay && b.isDay);
    let status;
    if (rain) status = 'rain';
    else if (frost) status = 'frost';
    else if (wmax > DAMP_MM) status = 'wet';
    else if (wmax > DRY_MM) status = 'damp';
    else if (b.S > softMM) status = 'soft';
    else status = 'dry';
    blocks.push({
      start: a.t, end: b.t, status, dark, mowable: !dark && (status === 'dry' || status === 'soft'),
      W: wmax, Wend: b.W, S: b.S, T: (a.T + b.T) / 2, RH: b.RH, u10: b.u10, P: b.P, prob: b.prob,
      source: b.source || a.source, Ts: Math.min(a.Ts, b.Ts),
    });
  }
  return blocks;
}

// Sammenhængende tørre vinduer fra blok i0, mindst minMin minutter (målt fra nowT i den løbende blok).
function findWindows(blocks, i0, nowT, minMin) {
  const wins = [];
  let k = i0;
  while (k < blocks.length) {
    if (!blocks[k].mowable) { k++; continue; }
    let j = k;
    while (j + 1 < blocks.length && blocks[j + 1].mowable) j++;
    const start = Math.max(blocks[k].start, k === i0 ? nowT : blocks[k].start);
    const end = blocks[j].end;
    let maxProb = 0, soft = false;
    for (let q = k; q <= j; q++) { maxProb = Math.max(maxProb, num(blocks[q].prob, 0)); soft = soft || blocks[q].status === 'soft'; }
    if ((end - start) / 60000 >= minMin) wins.push({ k, j, start, end, maxProb, soft });
    k = j + 1;
  }
  return wins;
}

// Regnhændelser: timer med regn, slået sammen når pausen er højst 2 timer. Regn ved tidsstempel t faldt i timen før t.
function rainEvents(st, minTotal = 0.2) {
  const ev = [];
  let cur = null;
  for (const s of st) {
    if (s.P < 0.1) continue;
    if (cur && s.t - cur.lastT <= 3 * 36e5) {
      cur.lastT = s.t; cur.end = s.t; cur.total += s.P; cur.maxP = Math.max(cur.maxP, s.P);
      cur.maxProb = Math.max(cur.maxProb, num(s.prob, 0));
    } else {
      if (cur) ev.push(cur);
      cur = { start: s.t - 36e5, end: s.t, lastT: s.t, total: s.P, maxP: s.P, maxProb: num(s.prob, 0) };
    }
  }
  if (cur) ev.push(cur);
  return ev.filter(e => e.total >= minTotal);
}
function lastAndNextRain(st, now) {
  const ev = rainEvents(st);
  let last = null, next = null, ongoing = null;
  for (const e of ev) {
    if (e.start <= now && now < e.end) ongoing = e;
    else if (e.end <= now) last = e;
    else if (e.start > now && !next) next = e;
  }
  let soFar = 0;
  if (ongoing) for (const s of st) if (s.t > ongoing.start && s.t <= now + 36e5 && s.t <= ongoing.end) soFar += s.P;
  return { last, next, ongoing, soFar, coverFrom: st.length ? st[0].t : now };
}

function seasonMonth(now, lat) { const m = new Date(now).getUTCMonth(); return lat < 0 ? (m + 6) % 12 : m; }
function meanTemp(st, now) {
  let sumT = 0, nT = 0;
  for (const s of st) if (s.t >= now - 3 * 864e5 && s.t <= now + 2 * 864e5) { sumT += s.T; nT++; }
  return nT ? sumT / nT : 10;
}

// Anbefalet klippehøjde ud fra årstid, temperatur, tørke, skygge og græslængde.
function cutAdvice(st, now, opts, lat) {
  const m = seasonMonth(now, lat);
  let maxT = -99, rain7 = 0, minTs = 99;
  for (const s of st) {
    if (s.t > now && s.t <= now + 2 * 864e5) maxT = Math.max(maxT, s.T);
    if (s.t > now && s.t <= now + 864e5) minTs = Math.min(minTs, s.Ts);
    if (s.t <= now && s.t > now - 7 * 864e5) rain7 += s.P;
  }
  const meanT = meanTemp(st, now);
  if (maxT === -99) maxT = meanT;
  const shade = opts.site === 'shade' ? 1 : opts.site === 'half' ? 0.5 : 0;
  const why = [];
  let lo = 4, hi = 5, mode = 'mow', title;
  if (m === 11 || m <= 1) {
    if (meanT >= 8) { lo = 5; hi = 6; title = 'Mildt vintervejr'; why.push('Græsset kan gro lidt i mildt vejr. Slå kun, hvis det er over ca. 7 cm, og hold det højt.'); }
    else { mode = 'rest'; lo = 5; hi = 6; title = 'Vinter'; why.push('Om vinteren gror græsset næsten ikke, så der er ikke brug for at slå det.'); }
  } else if (m <= 3) {
    lo = 5; hi = 6; title = 'Forår';
    why.push('De første klipninger efter vinteren skal være høje, så græsset kommer sig. Sænk gradvist til normal højde.');
  } else if (m <= 8) {
    title = m >= 6 ? 'Sommer' : 'Vækstsæson';
    const drought = rain7 < 5 && maxT >= 22;
    if (maxT >= 25 || drought) {
      lo = 6; hi = 7;
      why.push(maxT >= 25 ? `Varmt vejr (op til ${Math.round(maxT)} °C). Højere græs klarer varme og tørke bedre og skygger for jorden.`
                          : `Kun ${String(Math.round(rain7 * 10) / 10).replace('.', ',')} mm regn den seneste uge. Højere græs klarer tørke bedre.`);
    } else why.push('Normal vækst. Klip aldrig under 4 cm.');
  } else {
    title = 'Efterår';
    why.push('Sidste klipning ligger typisk i slutningen af oktober. Klip ikke for kort, så plænen går godt ind i vinteren.');
  }
  if (mode === 'mow' && meanT < 5) { mode = 'rest'; why.unshift(`Det er koldt (gennemsnit ca. ${Math.round(meanT)} °C), og græsset gror næsten ikke. Der er ikke brug for at slå det nu.`); }
  if (shade) { lo += shade; hi += shade; why.push('I skygge skal græsset stå lidt højere, så det kan fange mere lys.'); }
  if (minTs <= 0) why.push('Der er frost i prognosen. Slå aldrig frosset græs, og gå helst ikke på det.');
  why.push(opts.grass === 'long'
    ? 'Dit græs er langt. Fjern højst en tredjedel ad gangen, og tag resten om et par dage.'
    : 'Fjern højst en tredjedel af længden ad gangen.');
  return { lo, hi, mode, title, why, meanT, maxT, rain7 };
}

// Kumulativ vækst ved tidspunkt t (lineær interpolation mellem timer).
function growthAt(st, t) {
  if (t <= st[0].t) return st[0].G;
  if (t >= st[st.length - 1].t) return st[st.length - 1].G;
  let lo = 0, hi = st.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (st[mid].t <= t) lo = mid; else hi = mid; }
  const a = st[lo], b = st[hi], f = (t - a.t) / (b.t - a.t);
  return a.G + (b.G - a.G) * f;
}

// Klippeplan: hvor hurtigt græsset vokser, hvor ofte det skal slås, og hvornår næste gang er (1/3-reglen).
function mowPlan(st, blocks, now, cutCm, lastMow, durMin) {
  const need = cutCm * 10 * 0.5;                       // mm vækst før græsset er 1,5 × klippehøjden
  const tEnd = st[st.length - 1].t;
  const h3 = Math.min(tEnd, now + 3 * 864e5);
  const rate = h3 > now ? (growthAt(st, h3) - growthAt(st, now)) / ((h3 - now) / 864e5) : 0;   // mm/døgn
  const p = { need, rate, weekCm: rate * 7 / 10, interval: rate >= 0.3 ? need / rate : Infinity, cutCm, mowAtCm: cutCm * 1.5 };
  if (lastMow !== null && lastMow !== undefined) {
    const from = Math.max(lastMow, st[0].t);
    const grown = Math.max(0, growthAt(st, now) - growthAt(st, from));
    p.grown = grown; p.lengthCm = cutCm + grown / 10; p.lastMow = lastMow;
    let due = null;
    if (grown >= need) due = now;
    else {
      const base = growthAt(st, from);
      for (const s of st) if (s.t > now && s.G - base >= need) { due = s.t; break; }
      if (due === null && rate >= 0.3) { due = now + (need - grown) / rate * 864e5; p.dueEstimated = true; }
    }
    p.due = due;
    if (due !== null && due <= tEnd) {
      const after = Math.max(now, due - 864e5);
      const i0 = blocks.findIndex(b => b.end > after);
      if (i0 >= 0) p.window = findWindows(blocks, i0, Math.max(after, blocks[i0].start), durMin)[0] || null;
    }
  }
  return p;
}
function freqText(p) {
  if (!isFinite(p.interval)) return 'Ikke nødvendigt lige nu';
  const d = p.interval;
  if (d < 2) return 'Hver eller hver anden dag';
  if (d < 6) return `Hver ${Math.floor(d)}.–${Math.floor(d) + 1}. dag`;
  if (d < 8.5) return 'Ca. en gang om ugen';
  if (d < 12) return 'Ca. hver 10. dag';
  if (d < 18) return 'Ca. hver anden uge';
  return 'Sjældnere end hver anden uge';
}

// Vandingsråd ud fra jordvand, regn i prognosen og årstid.
function waterAdvice(st, now, C, meanT, month) {
  const sNow = st.find(s => s.t >= now) || st[st.length - 1];
  const AW = sNow.AW;
  let minAW = AW, rain48 = 0;
  for (const s of st) {
    if (s.t > now && s.t <= now + 72 * 36e5) minAW = Math.min(minAW, s.AW);
    if (s.t > now && s.t <= now + 48 * 36e5) rain48 += s.P;
  }
  const cold = meanT < 6 || month >= 10 || month <= 1;
  let mode, amount = 0;
  if (cold) mode = 'cold';
  else if (minAW / C < 0.45 && rain48 < 5) { mode = 'water'; amount = clamp(Math.round((0.8 * C - AW) / 5) * 5, 10, 25); }
  else if (AW / C < 0.6 && rain48 >= 5) mode = 'wait';
  else mode = 'ok';
  return { mode, amount, AW, pct: AW / C, C, rain48, minPct: minAW / C };
}

// Syntetiske oktoberdata til demo og test (ikke en rigtig prognose).
function sampleData(startUTCms) {
  const n = 6 * 24 + 1, time = [], T = [], RH = [], W = [], R = [], C = [], P = [], PP = [], D = [], E = [];
  const clouds = [15, 85, 55, 10, 35, 90];
  for (let i = 0; i < n; i++) {
    const t = new Date(startUTCms + i * 3600e3);
    time.push(t.toISOString().slice(0, 16));
    const hr = t.getUTCHours(), d = Math.min(5, Math.floor(i / 24));
    const day = hr >= 8 && hr <= 18;
    const sun = day ? Math.sin(Math.PI * (hr - 7.5) / 11) : 0;
    let cc = clouds[d] + (day ? 0 : -10);
    let p = 0;
    if (d === 1 && hr >= 13 && hr <= 17) p = 1.4;
    if (d === 4 && hr >= 5 && hr <= 7) p = 0.3;
    if (d === 5 && hr >= 10 && hr <= 15) p = 0.8;
    if (p > 0) cc = 100;
    cc = clamp(cc, 0, 100);
    const temp = 8.5 + 4.5 * Math.sin(2 * Math.PI * (hr - 9) / 24) - (d === 3 ? 2.5 : 0);
    T.push(+temp.toFixed(1));
    RH.push(Math.round(clamp(p > 0 ? 97 : 93 - 22 * sun, 40, 100)));
    W.push(+(d === 3 ? 1.2 + 1.5 * sun : 2.2 + 2.5 * sun).toFixed(1));
    const rs = 290 * sun * (1 - 0.72 * Math.pow(cc / 100, 1.6));
    R.push(Math.round(rs));
    C.push(cc); P.push(p); PP.push(p > 0 ? 70 : Math.round(cc / 6));
    D.push(hr >= 8 && hr <= 18 ? 1 : 0);
    E.push(+(rs * 0.0016).toFixed(2));
  }
  return { elevation: 20, utc_offset_seconds: 0, timezone: 'Eksempel',
    hourly: { time, temperature_2m: T, relative_humidity_2m: RH, wind_speed_10m: W, shortwave_radiation: R,
      cloud_cover: C, precipitation: P, precipitation_probability: PP, is_day: D, et0_fao_evapotranspiration: E } };
}
// MODEL END

/* ---------- side ---------- */
const DAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
const DAYS_FULL = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_FULL = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const LABEL = { dry: 'Tørt', soft: 'Tørt, men blød jord', damp: 'Lidt fugtigt', wet: 'Vådt', rain: 'Regn', frost: 'Frost på græsset' };
const $ = id => document.getElementById(id);
const store = {
  get(k, fb) { try { const v = localStorage.getItem('slaavejr.' + k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
  set(k, v) { try { localStorage.setItem('slaavejr.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};
const DEFAULT_LOC = { name: 'København', lat: 55.68, lon: 12.57 };
// Positionen afrundes til 2 decimaler (ca. 1 km). Prognosens gitter er alligevel grovere, og det præcise sted forlader aldrig telefonen.
function cleanLoc(l) {
  if (!l || typeof l !== 'object' || l.lat === null || l.lon === null || l.lat === '' || l.lon === '') return null;
  const lat = Number(l.lat), lon = Number(l.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: String(l.name || 'Valgt sted').slice(0, 60), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}
let loc = cleanLoc(store.get('loc', null)) || DEFAULT_LOC;
const savedOpts = store.get('opts', {}) || {};
const pick = (obj, v, fb) => (typeof v === 'string' && Object.hasOwn(obj, v)) ? v : fb;
let opts = {
  site: pick(SITE, savedOpts.site, 'sun'),
  grass: pick(GRASS, savedOpts.grass, 'normal'),
  type: pick(GRASS_TYPES, savedOpts.type, 'mix'),
  soil: pick(SOILS, savedOpts.soil, 'loam'),
  fert: pick(FERT, savedOpts.fert, 'some'),
  dur: [30, 60, 90, 120].includes(savedOpts.dur) ? savedOpts.dur : 60,
};
function loadMows() {
  const a = store.get('mows', []);
  const lo = Date.now() - 400 * 864e5, hi = Date.now() + 864e5;
  return Array.isArray(a) ? a.filter(x => Number.isFinite(x) && x > lo && x < hi).sort((p, q) => p - q).slice(-30) : [];
}
let mows = loadMows();
// dine egne meldinger om vådt/tørt græs og den tilpasning, de har givet (kun i browseren)
function loadObs() {
  const a = store.get('obs', []);
  const lo = Date.now() - 35 * 864e5, hi = Date.now() + 36e5;
  return Array.isArray(a) ? a.filter(o => o && Number.isFinite(o.t) && o.t > lo && o.t < hi && typeof o.wet === 'boolean')
    .map(o => ({ t: o.t, wet: o.wet, adj: clamp(num(o.adj, 1), 0.5, 2) })).sort((p, q) => p.t - q.t).slice(-40) : [];
}
let obs = loadObs();
let wetk = clamp(num(store.get('wetk', 1), 1), 0.5, 2);
let data = null, isSample = false, selected = null, model = null, staleFrom = null, wheelState = null;

const pad = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const mm = (v, dec = 2) => v.toFixed(dec).replace('.', ',');
const cmTxt = v => `${mm(v, Math.round(v * 10) % 10 ? 1 : 0)} cm`;
function offsetMs() { return data ? data.utc_offset_seconds * 1000 : 0; }
function nowLocal() { return Date.now() + offsetMs(); }
function dayName(t, ref) {
  const k = dayKey(t), today = dayKey(ref), tom = dayKey(ref + 864e5), yest = dayKey(ref - 864e5);
  if (k === today) return 'i dag';
  if (k === tom) return 'i morgen';
  if (k === yest) return 'i går';
  const d = new Date(t);
  return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + '.';
}
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
function dateTxt(t, ref) {
  if (Math.abs(t - ref) <= 6 * 864e5) return dayName(t, ref);
  const d = new Date(t);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
}
function span(w, ref) {
  const sameDay = dayKey(w.start) === dayKey(w.end - 1);
  const endTxt = hhmm(w.end) === '00:00' ? '24:00' : hhmm(w.end);
  return sameDay ? `${dayName(w.start, ref)} ${hhmm(w.start)}–${endTxt}`
                 : `${dayName(w.start, ref)} ${hhmm(w.start)} – ${dayName(w.end, ref)} ${endTxt}`;
}
function hoursTxt(ms) {
  const h = Math.round(ms / 36e5 * 2) / 2;
  return (h === 1 ? '1 time' : mm(h, h % 1 ? 1 : 0) + ' timer');
}
function roman(n) {
  const m = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s;
}
function seasonOf(m) { return m >= 2 && m <= 4 ? 'spring' : m >= 5 && m <= 7 ? 'summer' : m >= 8 && m <= 10 ? 'autumn' : 'winter'; }
function setSeason(now) { document.documentElement.dataset.season = seasonOf(seasonMonth(now, isSample ? 55.7 : loc.lat)); }
setSeason(Date.now());

function reasonFor(b) {
  const water = `${mm(b.W)} mm vand på stråene`;
  switch (b.status) {
    case 'rain': return `Der falder ${mm(b.P, 1)} mm regn i denne time.`;
    case 'frost': return `Græssets overflade er skønnet til ${mm(b.Ts, 1)} °C. Frosne strå knækker og bliver brune, hvis de slås.`;
    case 'wet': return b.source === 'obs' ? `Du har meldt vådt græs. Beregningen regner videre fra ca. ${water}.`
      : b.source === 'dew' ? `Dug og fugt fra natten: ca. ${water}.` : `Vådt efter regn: ca. ${water}.`;
    case 'damp': return `Næsten tørt, men stadig ca. ${water}. Afklippet klumper.`;
    case 'soft': return `Stråene er tørre, men jorden er blød efter regn. Undgå hjulspor.`;
    default: return b.dark ? 'Stråene er tørre, men det er mørkt.' : 'Ingen dug eller regn på stråene.';
  }
}

function run() {
  if (!data) return;
  const sim = simulate(data.hourly, data.elevation, Object.assign({}, opts, { wetk, obs: isSample ? [] : obs.map(o => ({ t: o.t + offsetMs(), wet: o.wet })) }));
  const blocks = toBlocks(sim.st, sim.soft);
  model = { blocks, cap: sim.cap, st: sim.st, C: sim.C };
  render();
}

function currentNow() {
  const { blocks } = model;
  return isSample ? blocks[Math.min(blocks.length - 1, 2 * 24 + 10)].start + 20 * 60000 : nowLocal();
}

function render() {
  const { blocks, cap, st } = model;
  const now = currentNow();
  model.now = now;
  setSeason(now);
  let ci = blocks.findIndex(b => b.start <= now && now < b.end);
  if (ci < 0) ci = now < blocks[0].start ? 0 : blocks.length - 1;
  const cur = blocks[ci];
  const d = new Date(now);
  $('plateCaption').textContent = `${loc.name}, ${DAYS_FULL[d.getUTCDay()].toLowerCase()} den ${d.getUTCDate()}. ${MONTHS_FULL[d.getUTCMonth()]}, kl. ${hhmm(now)}`;
  $('locLine').textContent = loc.name;
  const doy = Math.floor((now - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  $('plateNo').textContent = `Tab. ${roman(doy)}`;
  const type = GRASS_TYPES[opts.type];
  $('capLatin').textContent = type.latin;
  $('capDanish').textContent = type.name;

  const wins = findWindows(blocks, ci, now, opts.dur);
  const curWin = cur.mowable ? findWindows(blocks, ci, now, 0)[0] : null;
  let head, dotColor, reason;
  if (curWin && (curWin.end - now) / 60000 >= opts.dur) {
    head = 'Tørt – slå græsset nu'; dotColor = cur.status === 'soft' ? 'var(--st-soft)' : 'var(--st-dry)';
    reason = `Tørt til ca. ${hhmm(curWin.end)} (${hoursTxt(curWin.end - now)}).` + (curWin.soft ? ' Jorden er blød efter regn, så undgå hjulspor.' : '') +
      (curWin.maxProb >= 40 ? ` Regnrisiko op til ${curWin.maxProb} %.` : '');
  } else if (curWin) {
    head = 'Tørt nu, men ikke længe'; dotColor = 'var(--st-damp)';
    reason = `Tørt til ca. ${hhmm(curWin.end)}, kun ${hoursTxt(curWin.end - now)}. Det er kortere end den tid, du har valgt.`;
  }
  const f = (now - cur.start) / (cur.end - cur.start);
  const Wnow = (ci > 0 ? blocks[ci - 1].Wend : cur.Wend) * (1 - f) + cur.Wend * f;
  if (!curWin) {
    const heads = { rain: 'Det regner', frost: 'Frost på græsset', wet: 'Græsset er vådt', damp: 'Næsten tørt', soft: 'Tørt, men det er mørkt', dry: 'Tørt, men det er mørkt' };
    head = heads[cur.status]; dotColor = `var(--st-${cur.status})`;
    reason = reasonFor(Object.assign({}, cur, { W: Math.max(Wnow, cur.status === 'wet' ? DAMP_MM + 0.01 : 0) }));
  }
  $('headline').textContent = '';
  const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = dotColor;
  $('headline').append(dot, document.createTextNode(head));
  $('reason').textContent = reason;
  $('film').hidden = false;
  $('filmFill').style.width = Math.min(100, Wnow / cap * 100) + '%';
  $('filmVal').textContent = `${mm(Wnow)} / ${mm(cap)} mm`;
  renderObs();

  const nextW = wins.find(w => !(curWin && w.k === curWin.k));
  $('next').hidden = false;
  $('nextLbl').textContent = curWin && (curWin.end - now) / 60000 >= opts.dur ? 'Næste tørre vindue derefter' : 'Næste tørre vindue';
  if (nextW) {
    $('nextWhen').textContent = cap1(span(nextW, now));
    $('nextMeta').textContent = hoursTxt(nextW.end - nextW.start) + (nextW.maxProb >= 20 ? ` · regnrisiko op til ${nextW.maxProb} %` : '') + (nextW.soft ? ' · blød jord' : '');
  } else {
    $('nextWhen').textContent = 'Intet i prognosen';
    $('nextMeta').textContent = `Ingen tørre perioder på mindst ${opts.dur} min frem til ${dayName(blocks[blocks.length - 1].end - 1, now)}`;
  }

  const adv = cutAdvice(st, now, opts, isSample ? 55.7 : loc.lat);
  model.cur = cur; model.Wnow = Wnow;
  const microPlan = renderPlan(st, blocks, now, adv);
  const rain = renderRain(st, now);
  const water = renderWater(st, now, adv);
  renderCut(adv);
  // hjulets midte og felter
  const longNow = curWin && (curWin.end - now) / 60000 >= opts.dur;
  const words = { dry: 'Tørt', soft: 'Tørt', damp: 'Fugtigt', wet: 'Vådt', rain: 'Regn', frost: 'Frost' };
  const ccNow = (st.find(x => x.t >= now) || st[st.length - 1]).cc;
  const emblem = cur.status === 'rain' ? 'rain' : cur.status === 'frost' ? 'frost' : cur.dark ? 'moon' : (cur.status === 'wet' || cur.status === 'damp') ? 'drop' : ccNow > 0.7 ? 'cloud' : 'sun';
  const shortWin = w => `${dayName(w.start, now)} ${hhmm(w.start).slice(0, 2)}–${(hhmm(w.end) === '00:00' ? '24' : hhmm(w.end).slice(0, 2))}`;
  let sub;
  if (longNow) sub = `slå nu · til kl. ${hhmm(curWin.end)}`;
  else if (cur.dark && (cur.status === 'dry' || cur.status === 'soft')) sub = 'men det er mørkt';
  else if (nextW) sub = `tørt ${shortWin(nextW)}`;
  else sub = 'intet tørt vindue';
  let microVand;
  if (water.mode === 'water') microVand = `vand ca. ${water.amount} mm`;
  else if (rain.ongoing) microVand = 'det regner nu';
  else if (rain.next) microVand = `regn ${dayName(rain.next.start, now)} kl. ${hhmm(rain.next.start).slice(0, 2)}`;
  else microVand = 'ingen regn i sigte';
  const wetness = cur.status === 'rain' ? 1 : clamp(Wnow / cap, 0, 1);
  const season = document.documentElement.dataset.season;
  wheelState = {
    season, kind: GRASS_TYPES[opts.type].head, soil: opts.soil, root: GRASS_TYPES[opts.type].root, rain: cur.status === 'rain',
    wet: wetness > 0.05 ? wetness : 0, frost: cur.status === 'frost',
    word: words[cur.status], sub, emblem, color: `var(--st-${cur.status})`,
    micro: { slaa: cur.status === 'frost' ? 'rim på græsset' : cur.status === 'rain' ? 'regn på stråene' : Wnow > DRY_MM ? `${mm(Wnow)} mm vand på stråene` : cur.dark ? 'tørre strå, mørkt' : 'tørre strå', plan: microPlan, vand: microVand, plaene: `${GRASS_TYPES[opts.type].short} · ${SOILS[opts.soil].short}` },
  };
  drawWheel(wheelState);
  drawFigures(wheelState, cur);
  renderDays(blocks, now, ci);
  $('tl').hidden = false;
  drawChart();
}

/* ---------- klippeplan, regn, vanding, klippehøjde ---------- */
function agoTxt(ms) {
  const h = ms / 36e5;
  if (h < 1) return 'under en time siden';
  if (h < 48) return `for ${Math.round(h)} ${Math.round(h) === 1 ? 'time' : 'timer'} siden`;
  return `for ${Math.round(h / 24)} døgn siden`;
}
function untilTxt(ms) {
  const h = ms / 36e5;
  if (h < 1) return 'inden for en time';
  if (h < 48) return `om ca. ${Math.round(h)} ${Math.round(h) === 1 ? 'time' : 'timer'}`;
  return `om ca. ${Math.round(h / 24)} døgn`;
}
function renderPlan(st, blocks, now, adv) {
  const cut = (adv.lo + adv.hi) / 2;
  const lastEpoch = mows.length ? mows[mows.length - 1] : null;
  const last = lastEpoch === null ? null : lastEpoch + (isSample ? 0 : offsetMs());
  const p = mowPlan(st, blocks, now, cut, last, opts.dur);
  const type = GRASS_TYPES[opts.type], soil = SOILS[opts.soil];
  const growTxt = p.rate < 0.3 ? 'Græsset gror næsten ikke lige nu' : `Græsset vokser ca. ${mm(p.weekCm, 1)} cm om ugen lige nu`;
  const ctx = `${type.name.toLowerCase()}, ${soil.name}`;
  let big, sub;
  if (last === null) {
    big = freqText(p);
    sub = `${growTxt} (${ctx}). Klip ved ca. ${cmTxt(cut)}, når det er nået ${cmTxt(p.mowAtCm)}. Tryk på knappen, når du har slået, så regner jeg næste gang ud.`;
    $('growGauge').hidden = true;
    $('planLog').textContent = '';
  } else {
    if (adv.mode === 'rest' && p.rate < 0.3) big = 'Ingen klipning nu';
    else if (p.due !== null && p.due <= now) big = p.grown >= p.need * 2 ? 'Klar – tag det i to omgange' : 'Klar til at blive slået';
    else if (p.window) big = 'Næste gang: ' + span(p.window, now);
    else if (p.due !== null) big = `Næste gang ${p.dueEstimated ? 'ca. ' : ''}${dateTxt(p.due, now)}${p.dueEstimated ? ` (${untilTxt(p.due - now)})` : ''}`;
    else big = 'Ingen klipning nu';
    sub = `${growTxt} (${ctx}). ${freqText(p)}.` + (p.due !== null && p.due <= now && p.grown >= p.need * 2 ? ' Det er vokset meget, så klip først en tredjedel og resten om et par dage.' : '');
    $('growGauge').hidden = false;
    $('growFrom').textContent = cmTxt(cut);
    $('growTo').textContent = cmTxt(p.mowAtCm);
    $('growFill').style.width = clamp(p.grown / p.need * 100, 0, 100) + '%';
    const lastLocal = last;
    const when = dayKey(lastLocal) === dayKey(now) ? `i dag kl. ${hhmm(lastLocal)}` : dateTxt(lastLocal, now);
    $('planLog').textContent = `Sidst slået ${when} · græsset er nu ca. ${cmTxt(Math.round(p.lengthCm * 10) / 10)}`;
  }
  $('planBig').textContent = big;
  $('planSub').textContent = sub;
  $('mowUndo').hidden = mows.length === 0;
  $('plan').hidden = false;
  if (adv.mode === 'rest' && p.rate < 0.3) return 'hvile';
  if (last === null) return freqText(p).toLowerCase();
  if (p.due !== null && p.due <= now) return 'klar til at blive slået';
  if (p.window) return 'næste gang ' + dayName(p.window.start, now);
  if (p.due !== null) return `om ca. ${Math.max(1, Math.round((p.due - now) / 864e5))} dage`;
  return freqText(p).toLowerCase();
}
function renderRain(st, now) {
  const r = lastAndNextRain(st, now);
  if (r.ongoing) {
    $('lastRainLbl').textContent = 'Regn';
    $('lastRainVal').textContent = 'Det regner nu';
    $('lastRainSub').textContent = `Siden ${dayName(r.ongoing.start, now)} ${hhmm(r.ongoing.start)} · ca. ${mm(Math.max(r.soFar, 0.1), 1)} mm indtil nu`;
  } else if (r.last) {
    $('lastRainLbl').textContent = 'Sidste regn';
    $('lastRainVal').textContent = cap1(span(r.last, now));
    $('lastRainSub').textContent = `${mm(r.last.total, 1)} mm · ${agoTxt(now - r.last.end)}`;
  } else {
    const days = Math.max(1, Math.floor((now - r.coverFrom) / 864e5));
    $('lastRainLbl').textContent = 'Sidste regn';
    $('lastRainVal').textContent = `Over ${days} døgn siden`;
    $('lastRainSub').textContent = `Ingen regn i de ${days} døgn, vejrmodellen dækker`;
  }
  if (r.next) {
    $('nextRainVal').textContent = cap1(span(r.next, now));
    $('nextRainSub').textContent = `ca. ${mm(r.next.total, 1)} mm · ${untilTxt(r.next.start - now)}` + (r.next.maxProb ? ` · risiko ${r.next.maxProb} %` : '');
  } else {
    $('nextRainVal').textContent = 'Ingen i prognosen';
    $('nextRainSub').textContent = `Tørvejr frem til ${dayName(st[st.length - 1].t - 1, now)}`;
  }
  $('facts').hidden = false;
  return r;
}
function renderWater(st, now, adv) {
  const m = seasonMonth(now, isSample ? 55.7 : loc.lat);
  const w = waterAdvice(st, now, model.C, adv.meanT, m);
  const hr = new Date(now).getUTCHours();
  const when = hr < 8 ? 'nu i morges' : 'i morgen tidlig';
  let big, sub;
  if (w.mode === 'water') { big = `Vand ca. ${w.amount} mm ${when}`; sub = `Det svarer til ${w.amount} liter pr. m². Vand grundigt én gang frem for lidt hver dag, så rødderne går i dybden. Vand helst efter du har slået, ikke før.`; }
  else if (w.mode === 'wait') { big = 'Vent på regnen'; sub = `Jorden er ved at blive tør, men der kommer ca. ${mm(w.rain48, 0)} mm regn de næste to døgn.`; }
  else if (w.mode === 'cold') { big = 'Ikke nødvendigt'; sub = 'I den kolde tid fordamper der så lidt, at plænen klarer sig uden vanding.'; }
  else { big = 'Ikke nødvendigt'; sub = `Jorden har vand nok${w.minPct < 0.6 ? ', men hold øje, hvis det bliver ved med at være tørt' : ''}.`; }
  $('waterBig').textContent = big;
  $('waterSub').textContent = sub;
  $('soilFill').style.width = clamp(w.pct * 100, 0, 100) + '%';
  $('soilVal').textContent = `${Math.round(w.pct * 100)} %`;
  $('water').hidden = false;
  return w;
}
function renderCut(a) {
  const range = a.lo === a.hi ? cmTxt(a.lo) : `${mm(a.lo, a.lo % 1 ? 1 : 0)}–${cmTxt(a.hi)}`;
  $('cutSeason').textContent = a.title.toLowerCase();
  const v = $('cutVal'); v.textContent = '';
  if (a.mode === 'rest') {
    v.append(document.createTextNode('Slå ikke nu'));
    const s = document.createElement('small'); s.textContent = `ellers ${range}`; v.append(s);
  } else v.textContent = range;
  const ul = $('cutWhy'); ul.textContent = '';
  for (const w of a.why.slice(0, 4)) { const li = document.createElement('li'); li.textContent = w; ul.append(li); }
  drawRuler(a);
  $('cut').hidden = false;
}

/* ---------- tegning ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
function el(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== '') e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
}
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const f1 = v => v.toFixed(1);
function bladePath(x, base, w, h, lean) {
  const tx = x + lean, ty = base - h;
  return `M${f1(x - w / 2)},${base} C${f1(x - w / 2)},${f1(base - h * 0.5)} ${f1(x + lean * 0.6 - 1)},${f1(base - h * 0.82)} ${f1(tx)},${f1(ty)} ` +
         `C${f1(x + lean * 0.6 + 1)},${f1(base - h * 0.82)} ${f1(x + w / 2)},${f1(base - h * 0.5)} ${f1(x + w / 2)},${base} Z`;
}
function drawRuler(a) {
  const svg = $('ruler'); svg.textContent = '';
  const base = 166, cm = 14, x0 = 26;
  const yOf = c => base - c * cm;
  el('path', { d: `M${x0},${yOf(11)} L${x0},${base}`, class: 'tick', 'stroke-width': 1 }, svg);
  for (let c = 0; c <= 11; c++) {
    const long = c % 2 === 0;
    el('path', { d: `M${x0},${yOf(c)} l${long ? 8 : 4},0`, class: 'tick', 'stroke-width': .8 }, svg);
    if (long) { const t = el('text', { x: x0 - 5, y: yOf(c) + 3.5, 'text-anchor': 'end' }, svg); t.textContent = String(c); }
  }
  const tcm = el('text', { x: x0 - 5, y: yOf(11) - 3, 'text-anchor': 'end' }, svg); tcm.textContent = 'cm';
  const len = { short: 4.2, normal: 7.5, long: 11 }[opts.grass] || 7.5;
  const cut = Math.min((a.lo + a.hi) / 2, len);
  const cutY = yOf(cut);
  const defs = el('defs', {}, svg);
  const cb = el('clipPath', { id: 'clipBelow' }, defs); el('rect', { x: 0, y: cutY, width: 128, height: base - cutY + 10 }, cb);
  const ca = el('clipPath', { id: 'clipAbove' }, defs); el('rect', { x: 0, y: 0, width: 128, height: cutY }, ca);
  const R = rng(3), blades = [];
  for (let i = 0; i < 10; i++) blades.push(bladePath(46 + i * 7.6 + R() * 2, base, 5 + R() * 2, len * cm * (0.86 + R() * 0.2), (R() - 0.5) * 10));
  const above = el('g', { 'clip-path': 'url(#clipAbove)', class: 'blade-top' }, svg);
  const below = el('g', { 'clip-path': 'url(#clipBelow)' }, svg);
  for (const d of blades) for (const g of [above, below]) { el('path', { d, class: 'blade-wash' }, g); el('path', { d, class: 'blade-ink' }, g); }
  el('path', { d: `M${x0},${f1(cutY)} L126,${f1(cutY)}`, class: 'cutline', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }, svg);
  const lab = el('text', { x: 126, y: cutY - 5, 'text-anchor': 'end', class: 'cutlabel' }, svg);
  lab.textContent = a.mode === 'rest' ? 'hvile' : 'klip her';
}

function drawChart() {
  if (!model || model.now === undefined) return;
  const { blocks, st, cap, now } = model;
  const svg = $('chart'); svg.textContent = '';
  const W = Math.max(280, Math.round($('chartWrap').clientWidth || 680)), H = 190;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const L = 34, Rm = 6, T = 26, B = H - 34, stripY = H - 26;
  const t0 = Date.parse(dayKey(now) + 'T00:00:00Z');
  const t1 = Math.min(blocks[blocks.length - 1].end, t0 + 4 * 864e5);
  const X = t => L + (t - t0) / (t1 - t0) * (W - L - Rm);
  const Y = w => B - clamp(w / cap, 0, 1) * (B - T);
  const pxH = (W - L - Rm) / ((t1 - t0) / 36e5);
  const inRange = blocks.filter(b => b.start >= t0 && b.end <= t1);
  let ns = null;
  inRange.forEach((b, i) => {
    if (b.dark && ns === null) ns = b.start;
    const endRun = ns !== null && (!b.dark || i === inRange.length - 1);
    if (endRun) { const e = b.dark ? b.end : b.start; el('rect', { x: f1(X(ns)), y: T - 8, width: f1(X(e) - X(ns)), height: B - T + 8, class: 'night' }, svg); ns = null; }
  });
  el('path', { d: `M${L},${B} L${W - Rm},${B}`, class: 'grid' }, svg);
  el('path', { d: `M${L},${T} L${W - Rm},${T}`, class: 'grid', 'stroke-dasharray': '2 4' }, svg);
  const y0 = el('text', { x: L - 6, y: B + 4, 'text-anchor': 'end' }, svg); y0.textContent = '0';
  const y1 = el('text', { x: L - 6, y: T + 4, 'text-anchor': 'end' }, svg); y1.textContent = mm(cap, 1);
  const yu = el('text', { x: L - 6, y: T - 10, 'text-anchor': 'end' }, svg); yu.textContent = 'mm';
  const pxDay = pxH * 24;
  for (let d = t0; d < t1; d += 864e5) {
    if (d > t0) el('path', { d: `M${f1(X(d))},${T - 12} L${f1(X(d))},${stripY + 6}`, class: 'grid' }, svg);
    const nm = dayName(d, now), dd = new Date(d);
    const txt = pxDay < 95 ? (nm === 'i dag' ? 'I dag' : cap1(DAYS[dd.getUTCDay()])) : cap1(nm);
    const t = el('text', { x: X(d) + 4, y: T - 13, class: 'daylbl' }, svg); t.textContent = txt;
    for (const hh of pxDay >= 150 ? [6, 12, 18] : [12]) { const ht = el('text', { x: X(d + hh * 36e5), y: H - 6, 'text-anchor': 'middle' }, svg); ht.textContent = pad(hh); }
  }
  for (const s of st) {
    if (s.t <= t0 || s.t > t1 || s.P < 0.05) continue;
    const hgt = Math.min(1, s.P / 3) * (B - T) * 0.6 + 2;
    el('rect', { x: f1(X(s.t - 36e5) + 0.5), y: T, width: f1(Math.max(1, pxH - 1)), height: f1(hgt), class: 'rainbar', rx: 1 }, svg);
  }
  const pts = st.filter(s => s.t >= t0 && s.t <= t1);
  if (pts.length > 1) {
    let d = `M${f1(X(pts[0].t))},${B} `;
    for (const s of pts) d += `L${f1(X(s.t))},${f1(Y(s.W))} `;
    d += `L${f1(X(pts[pts.length - 1].t))},${B} Z`;
    el('path', { d, class: 'water', 'stroke-linejoin': 'round' }, svg);
  }
  for (const b of inRange) if (b.mowable) el('rect', { x: f1(X(b.start)), y: stripY, width: f1(Math.max(1, X(b.end) - X(b.start) + 0.3)), height: 7, class: 'drywin' }, svg);
  for (const b of inRange) if (b.status === 'frost' && !b.dark) el('rect', { x: f1(X(b.start)), y: stripY, width: f1(Math.max(1, X(b.end) - X(b.start) + 0.3)), height: 7, class: 'frostwin' }, svg);
  if (now >= t0 && now <= t1) {
    el('path', { d: `M${f1(X(now))},${T - 4} L${f1(X(now))},${stripY + 7}`, class: 'nowline' }, svg);
    const nl = el('text', { x: X(now) + 4, y: T + 10, class: 'nowlbl' }, svg); nl.textContent = 'nu';
  }
  const cursor = el('path', { d: 'M0,0', class: 'cursor', visibility: 'hidden' }, svg);
  const place = b => { const x = f1(X(b.start + 18e5)); cursor.setAttribute('d', `M${x},${T - 4} L${x},${stripY + 7}`); cursor.setAttribute('visibility', 'visible'); };
  const pickAt = ev => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * W;
    const t = t0 + (x - L) / (W - L - Rm) * (t1 - t0);
    const b = inRange.find(q => q.start <= t && t < q.end);
    if (!b) return;
    place(b); selectBlock(b);
  };
  svg.onpointerdown = ev => { svg._down = true; pickAt(ev); };
  svg.onpointermove = ev => { if (svg._down || ev.pointerType === 'mouse') pickAt(ev); };
  svg.onpointerup = svg.onpointercancel = svg.onpointerleave = () => { svg._down = false; };
  if (selected !== null) { const b = inRange.find(q => q.start === selected); if (b) place(b); }
}
function selectBlock(b) {
  if (selected === b.start) return;
  selected = b.start;
  showDetail(b, model.now);
  document.querySelectorAll('.cell.sel').forEach(x => x.classList.remove('sel'));
  const c = document.querySelector(`.cell[data-t="${b.start}"]`); if (c) c.classList.add('sel');
}

function renderDays(blocks, now, ci) {
  const wrap = $('days'); wrap.textContent = '';
  const todayKey = dayKey(now), lastKey = dayKey(Date.parse(todayKey + 'T00:00:00Z') + 3 * 864e5);
  const byDay = new Map();
  blocks.forEach((b, i) => { const k = dayKey(b.start); if (k < todayKey || k > lastKey) return; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(i); });
  for (const [k, idxs] of byDay) {
    if (idxs.length < 12) continue;
    const row = document.createElement('div'); row.className = 'day';
    const t0 = blocks[idxs[0]].start, dd = new Date(t0);
    const lbl = document.createElement('div'); lbl.className = 'day-lbl';
    const nm = dayName(t0, now), rel = nm === 'i dag' || nm === 'i morgen';
    const small = document.createElement('small');
    small.textContent = `${rel ? DAYS[dd.getUTCDay()] + ' ' : ''}${dd.getUTCDate()}. ${MONTHS[dd.getUTCMonth()]}`;
    lbl.append(document.createTextNode(rel ? cap1(nm) : DAYS_FULL[dd.getUTCDay()]), small);
    const strip = document.createElement('div'); strip.className = 'strip';
    const first = new Date(t0).getUTCHours();
    for (let e = 0; e < first; e++) strip.append(document.createElement('span'));
    for (const i of idxs) {
      const b = blocks[i];
      const c = document.createElement('button');
      c.type = 'button';
      c.dataset.t = String(b.start);
      c.className = `cell st-${b.status}` + (b.dark ? ' dark' : '') + (b.end <= now ? ' past' : '') + (selected === b.start ? ' sel' : '');
      c.setAttribute('aria-label', `${hhmm(b.start)}: ${LABEL[b.status]}${b.dark ? ', mørkt' : ''}`);
      if (b.P > 0.05) { const r = document.createElement('span'); r.className = 'rain'; r.style.height = Math.min(100, 25 + b.P / 3 * 75) + '%'; c.append(r); }
      c.addEventListener('click', () => { selectBlock(b); drawChart(); });
      strip.append(c);
    }
    if (k === todayKey) {
      const mk = document.createElement('div'); mk.className = 'now';
      mk.style.left = `calc(${(now - Date.parse(k + 'T00:00:00Z')) / 864e5 * 100}% - 1px)`;
      strip.append(mk);
    }
    const winTxt = document.createElement('p'); winTxt.className = 'day-win';
    const wins = findWindows(blocks.slice(idxs[0], idxs[idxs.length - 1] + 1), 0, 0, opts.dur)
      .map(w => ({ ...w, start: Math.max(w.start, k === todayKey ? Math.min(w.end, now) : w.start) }))
      .filter(w => (w.end - w.start) / 60000 >= opts.dur);
    if (wins.length) {
      winTxt.append(document.createTextNode('Tørt '));
      wins.forEach((w, i) => {
        if (i) winTxt.append(document.createTextNode(', '));
        const bb = document.createElement('b'); bb.textContent = `${hhmm(w.start)}–${hhmm(w.end) === '00:00' ? '24:00' : hhmm(w.end)}`; winTxt.append(bb);
      });
    } else winTxt.textContent = k === todayKey ? 'Ikke flere tørre vinduer i dag' : 'Intet tørt vindue';
    row.append(lbl, strip, winTxt);
    wrap.append(row);
  }
  if (selected === null && blocks[ci]) showDetail(blocks[ci], now);
  else { const b = blocks.find(x => x.start === selected); if (b) showDetail(b, now); }
}

function showDetail(b, now) {
  const end = hhmm(b.end) === '00:00' ? '24' : hhmm(b.end).slice(0, 2);
  const box = $('detail'); box.textContent = '';
  const top = document.createElement('div');
  const bt = document.createElement('b'); bt.textContent = `${cap1(dayName(b.start, now))} kl. ${hhmm(b.start).slice(0, 2)}–${end}`;
  top.append(bt, document.createTextNode(` · ${LABEL[b.status]}${b.dark ? ' (mørkt)' : ''}`));
  const why = document.createElement('div'); why.textContent = reasonFor(b);
  const facts = document.createElement('div'); facts.className = 'num';
  facts.textContent = `vand ${mm(b.W)} mm · ${mm(b.T, 1)} °C · fugt ${Math.round(b.RH)} % · vind ${mm(b.u10, 1)} m/s · regn ${mm(b.P, 1)} mm` + (b.prob !== null && b.prob !== undefined ? ` (${b.prob} %)` : '');
  box.append(top, why, facts);
}


/* ---------- hjulet ---------- */
const SECTIONS = {
  slaa:   { title: 'Slå nu', kicker: 'Er græsset tørt?' },
  plan:   { title: 'Klippeplan', kicker: 'Hvornår skal du slå?' },
  vand:   { title: 'Regn & vand', kicker: 'Regn og vanding' },
  plaene: { title: 'Din plæne', kicker: 'Indstillinger' },
};
let openSec = null, pushedSec = false;
const WCX = 200, WCY = 200;
const wpt = (r, deg) => [WCX + r * Math.cos(deg * Math.PI / 180), WCY + r * Math.sin(deg * Math.PI / 180)];
const P2 = p => `${f1(p[0])},${f1(p[1])}`;
function arcPath(r, a0, a1, sweep) { return `M${P2(wpt(r, a0))} A${r},${r} 0 0 ${sweep} ${P2(wpt(r, a1))}`; }
function sectorPath(r0, r1, a0, a1) {
  const start = r0 > 0 ? `M${P2(wpt(r0, a0))} L${P2(wpt(r1, a0))}` : `M${WCX},${WCY} L${P2(wpt(r1, a0))}`;
  const back = r0 > 0 ? ` L${P2(wpt(r0, a1))} A${r0},${r0} 0 0 0 ${P2(wpt(r0, a0))}` : ' Z';
  return `${start} A${r1},${r1} 0 0 1 ${P2(wpt(r1, a1))}${back}${r0 > 0 ? ' Z' : ''}`;
}
function fleuron(svg, p) {
  const g = el('g', { transform: `translate(${f1(p[0])} ${f1(p[1])})` }, svg);
  for (let k = 0; k < 4; k++) {
    const a = k * 90;
    el('ellipse', { cx: 0, cy: -3.2, rx: 1.7, ry: 3, transform: `rotate(${a})`, class: 'medal' }, g);
    el('ellipse', { cx: 0, cy: -3.2, rx: 1.7, ry: 3, transform: `rotate(${a})`, class: 'ring', 'stroke-width': .5 }, g);
  }
  el('circle', { r: 1.3, class: 'ring', 'stroke-width': .6 }, g);
}
const QUADS = [
  { key: 'slaa', a0: 180, a1: 270, base: [136, 152], flip: true, lab: ['Slå nu', 188, 262, 1] },
  { key: 'plan', a0: 270, a1: 360, base: [276, 172], lab: ['Klippeplan', 278, 352, 1] },
  { key: 'vand', a0: 0, a1: 90, base: [224, 298], lab: ['Regn & vand', 82, 8, 0] },
  { key: 'plaene', a0: 90, a1: 180, base: [118, 308], lab: ['Din plæne', 172, 98, 0] },
];
let wheelSig = '';
function drawWheel(s) {
  const svg = $('wheel');
  const sig = JSON.stringify([s.season, s.kind, s.soil, s.root, s.rain, Math.round(s.wet * 10), s.frost, s.word, s.sub, s.emblem, s.micro]);
  if (sig === wheelSig) { markActive(); return; }
  wheelSig = sig;
  svg.textContent = '';
  Botany.ensureDefs(svg);
  const defs = svg.querySelector('defs');
  for (const q of QUADS) el('path', { d: sectorPath(72, 192, q.a0, q.a1), class: 'sector sec-' + q.key }, svg);
  for (const q of QUADS) {
    const id = 'clip-' + q.key;
    const cp = el('clipPath', { id }, defs);
    el('path', { d: sectorPath(0, 160, q.a0 + 1.4, q.a1 - 1.4) }, cp);
    const g = el('g', { 'clip-path': `url(#${id})`, class: 'vig vig-' + q.key }, svg);
    // klipperen spejles, så skaftet peger ind mod midten, og den kører ud mod kanten
    const inner = el('g', { transform: `translate(${q.base[0]} ${q.base[1]})${q.flip ? ' scale(-1 1)' : ''}` }, g);
    if (q.key === 'slaa') Botany.mower(inner, { season: s.season, wet: s.wet, frost: s.frost, rain: s.rain, height: 70, seed: 31 });
    if (q.key === 'plan') Botany.measure(inner, { season: s.season, kind: s.kind, height: 76, seed: 21, frost: s.frost });
    if (q.key === 'vand') Botany.wateringCan(inner, { season: s.season, height: 72, seed: 41, compact: true });
    if (q.key === 'plaene') Botany.soilProfile(inner, { season: s.season, soil: s.soil, kind: s.kind, root: s.root, height: 60, seed: 51 });
  }
  el('circle', { cx: WCX, cy: WCY, r: 196.5, class: 'ring', 'stroke-width': 1.4 }, svg);
  el('circle', { cx: WCX, cy: WCY, r: 192, class: 'ring', 'stroke-width': .5 }, svg);
  el('circle', { cx: WCX, cy: WCY, r: 164, class: 'ring', 'stroke-width': .5 }, svg);
  for (const a of [0, 90, 180, 270]) for (const off of [-1.7, 1.7]) {
    const nx = Math.cos((a + 90) * Math.PI / 180) * off, ny = Math.sin((a + 90) * Math.PI / 180) * off;
    const p0 = wpt(72, a), p1 = wpt(164, a);
    el('path', { d: `M${f1(p0[0] + nx)},${f1(p0[1] + ny)} L${f1(p1[0] + nx)},${f1(p1[1] + ny)}`, class: 'ring', 'stroke-width': .5 }, svg);
  }
  for (const a of [0, 90, 180, 270]) fleuron(svg, wpt(178, a));
  for (const q of QUADS) {
    const [text, a0, a1, sw] = q.lab;
    const lid = 'lp-' + q.key, mid = 'mp-' + q.key;
    el('path', { id: lid, d: arcPath(sw ? 172 : 183, a0, a1, sw), fill: 'none' }, defs);
    el('path', { id: mid, d: arcPath(sw ? 151 : 160, a0 + (sw ? 3 : -3), a1 + (sw ? -3 : 3), sw), fill: 'none' }, defs);
    const t = el('text', { class: 'lab' }, svg);
    el('textPath', { href: '#' + lid, startOffset: '50%', 'text-anchor': 'middle' }, t).textContent = text;
    const m = el('text', { class: 'micro' }, svg);
    el('textPath', { href: '#' + mid, startOffset: '50%', 'text-anchor': 'middle' }, m).textContent = s.micro[q.key] || '';
  }
  el('circle', { cx: WCX, cy: WCY, r: 72, class: 'medal' }, svg);
  el('circle', { cx: WCX, cy: WCY, r: 72, class: 'ring', 'stroke-width': 1.2 }, svg);
  el('circle', { cx: WCX, cy: WCY, r: 67.5, class: 'ring', 'stroke-width': .45 }, svg);
  Botany.emblem(el('g', { transform: `translate(${WCX} ${WCY - 33}) scale(1.2)` }, svg), s.emblem);
  el('text', { x: WCX, y: WCY + 12, 'text-anchor': 'middle', class: 'word' }, svg).textContent = s.word;
  const bar = el('rect', { x: WCX - 15, y: WCY + 20, width: 30, height: 2.4, rx: 1.2 }, svg);
  bar.style.fill = s.color;
  el('text', { x: WCX, y: WCY + 38, 'text-anchor': 'middle', class: 'subw' }, svg).textContent = s.sub;
  markActive();
}
function markActive() {
  document.querySelectorAll('#wheel .sector').forEach(e => e.classList.toggle('active', !!openSec && e.classList.contains('sec-' + openSec)));
  document.querySelectorAll('#wheel .vig').forEach(e => e.classList.toggle('active', !!openSec && e.classList.contains('vig-' + openSec)));
}

/* ---------- planchernes store tegninger ---------- */
const figSig = {};
function drawFig(id, sig, fn) {
  if (figSig[id] === sig) return;
  figSig[id] = sig;
  const svg = $(id); svg.textContent = '';
  Botany.ensureDefs(svg);
  const pos = { 'fig-vand': [80, 200], 'fig-plaene': [112, 204], 'fig-slaa': [140, 200] }[id] || [118, 184];
  fn(el('g', { class: 'plantbox' }, el('g', { transform: `translate(${pos[0]} ${pos[1]})` }, svg)));
}
function drawFigures(s, cur) {
  const wetBucket = Math.round(s.wet * 4);
  drawFig('fig-slaa', [s.season, wetBucket, s.frost, s.rain].join(), g => Botany.mower(g, { season: s.season, wet: s.wet, frost: s.frost, rain: s.rain, detail: 'plate', height: 150, seed: 32 }));
  drawFig('fig-plan', [s.season, s.kind, s.frost].join(), g => Botany.measure(g, { season: s.season, kind: s.kind, detail: 'plate', height: 150, seed: 22, frost: s.frost }));
  drawFig('fig-vand', [s.season].join(), g => Botany.wateringCan(g, { season: s.season, detail: 'plate', height: 132, seed: 42 }));
  drawFig('fig-plaene', [s.season, s.soil, s.kind, s.root].join(), g => Botany.soilProfile(g, { season: s.season, soil: s.soil, kind: s.kind, root: s.root, detail: 'plate', height: 138, seed: 52 }));
  $('fignote-slaa').textContent = s.frost ? 'Rim på stråene' : cur.status === 'rain' ? 'Regn på stråene' : s.wet > 0.05 ? 'Dug på stråene' : 'Tørre strå, klar til slåning';
  const lower = { sand: 'sand', loam: 'muldjord', clay: 'ler' }[s.soil];
  $('fignote-plaene').textContent = `a. græstørv · b. muldlag · c. ${lower}`;
}

/* ---------- navigation mellem felterne ---------- */
const QUAD_OF = { slaa: 'tl', plan: 'tr', vand: 'br', plaene: 'bl' };
let animToken = 0, firstApply = true;
const motionOK = () => typeof Element.prototype.animate === 'function' && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function applyHash() {
  const key = location.hash.replace('#', '');
  showSection(Object.hasOwn(SECTIONS, key) ? key : null, firstApply);
  firstApply = false;
}
function setState(key) {
  openSec = key;
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.sec !== key;
  $('plate').classList.toggle('compact', !!key);
  $('secHead').hidden = !key;
  if (key) { $('secTitle').textContent = SECTIONS[key].title; $('secKicker').textContent = SECTIONS[key].kicker; }
  markActive();
  if (key === 'slaa' && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => drawChart());
}
function showSection(key, instant) {
  const prev = openSec;
  if (prev === key) return;
  const token = ++animToken;
  if (instant || !motionOK()) { setState(key); return; }
  if (!prev && key) {
    // åbning: planchen vokser ud af det felt, man trykkede på
    const q = document.querySelector('.q-' + QUAD_OF[key]);
    const from = q ? q.getBoundingClientRect() : null;
    setState(key);
    openFX(key, from, token);
  } else if (prev && !key) {
    closeFX(prev, token);
  } else {
    setState(key);
    openFX(key, null, token);
  }
}
function revealPanel(panel, delay) {
  [...panel.children].forEach((c, i) => {
    if (c.classList.contains('fig')) return;
    c.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: delay + i * 70, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
  });
}
// kobberstikket "trykkes": blækstreger tegnes, så kommer farven
function inkDraw(svg, delay) {
  let i = 0;
  for (const p of svg.querySelectorAll('path.b-ink, path.b-fine, path.b-root')) {
    p.setAttribute('pathLength', '1');
    p.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }],
      { duration: 650 + (i % 7) * 70, delay: delay + (i % 60) * 8, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'backwards' });
    i++;
  }
  for (const e of svg.querySelectorAll('.bw, .dew, .bloom, path.b-hair, circle, ellipse, text, rect, path[class^="c-"], path.b-pinktip, path.b-pinkline, path.b-glint, path.b-rime, path.b-rimeline, path.b-stolon')) {
    if (e.closest('.bw') && !e.classList.contains('bw')) continue;
    if (e.closest('.dew, .bloom') && !e.matches('.dew, .bloom')) continue;
    e.animate([{ opacity: 0 }], { duration: 650, delay: delay + 480, easing: 'ease-out', fill: 'backwards' });
  }
}
function fillFrom0(id, delay) {
  const e = $(id); if (!e || !e.style.width) return;
  e.animate([{ width: '0%' }, { width: e.style.width }], { duration: 1000, delay, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' });
}
function openFX(key, from, token) {
  const panel = document.querySelector(`.panel[data-sec="${key}"]`);
  const fig = panel.querySelector('.fig'), svg = fig.querySelector('svg');
  const to = fig.getBoundingClientRect();
  if (from && to.width) {
    const s0 = Math.min(from.width / to.width, from.height / to.height);
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2), dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    fig.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${s0})`, clipPath: 'circle(34% at 50% 50%)', opacity: .5 },
      { transform: 'none', clipPath: 'circle(75% at 50% 50%)', opacity: 1 },
    ], { duration: 620, easing: 'cubic-bezier(.2,.75,.15,1)' });
  } else {
    fig.animate([{ clipPath: 'circle(8% at 50% 60%)', opacity: .4 }, { clipPath: 'circle(75% at 50% 60%)', opacity: 1 }], { duration: 560, easing: 'cubic-bezier(.3,.7,.2,1)' });
  }
  inkDraw(svg, 260);
  revealPanel(panel, 380);
  const top = $('plate').getBoundingClientRect().top + window.scrollY - 10;
  if (window.scrollY > top && window.scrollTo) window.scrollTo({ top, behavior: 'smooth' });
  if (key === 'slaa') {
    // klipperen ruller ind mod græsset med hjulene drejende, afklippet sprøjter fra knivene,
    // duggen lægger sig, og grafen tegnes ind
    const roll = { duration: 1300, delay: 420, easing: 'cubic-bezier(.25,.6,.3,1)', fill: 'backwards' };
    const mw = svg.querySelector('.mower');
    if (mw) mw.animate([{ transform: 'translateX(-52px)' }, { transform: 'none' }], roll);
    svg.querySelectorAll('.wheelspin').forEach(w => w.animate([{ transform: 'rotate(-105deg)' }, { transform: 'none' }], roll));
    svg.querySelectorAll('.clip').forEach((c, i) => c.animate([
      { transform: 'translate(-16px,16px) scale(.3)', opacity: 0 }, { opacity: 1, offset: .25 }, { transform: 'none', opacity: 1 },
    ], { duration: 650, delay: 1050 + i * 80, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' }));
    svg.querySelectorAll('.dew').forEach((d, i) => d.animate([
      { transform: 'translateY(-18px) scale(.6)', opacity: 0 }, { transform: 'translateY(1.5px) scale(1.05)', opacity: 1, offset: .7 }, { transform: 'none', opacity: 1 },
    ], { duration: 700, delay: 1200 + i * 110, easing: 'ease-out', fill: 'backwards' }));
    fillFrom0('filmFill', 700);
    requestAnimationFrame(() => {
      if (token !== animToken) return;
      $('chart').animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 1500, delay: 600, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'backwards' });
      document.querySelectorAll('#days .day').forEach((r, i) => r.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 450, delay: 900 + i * 110, easing: 'ease-out', fill: 'backwards' }));
    });
  } else if (key === 'plan') {
    // græsset vokser op, klippelinjen tegnes, og spidserne over den falder af
    const gg = svg.querySelector('.growgrass');
    if (gg) gg.animate([{ transform: 'scaleY(.5)' }, { transform: 'scaleY(1.03)', offset: .8 }, { transform: 'none' }], { duration: 1400, delay: 200, easing: 'cubic-bezier(.25,.8,.25,1)', fill: 'backwards' });
    svg.querySelectorAll('.b-cut').forEach(c => { c.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 600, delay: 1400, easing: 'ease-out', fill: 'backwards' }); });
    svg.querySelectorAll('.clip').forEach((c, i) => c.animate([
      { transform: 'translate(0,-22px) rotate(0deg)', opacity: 0 }, { opacity: 1, offset: .2 }, { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
    ], { duration: 900, delay: 1700 + i * 90, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'backwards' }));
    const top2 = document.querySelector('#ruler .blade-top');
    if (top2) top2.animate([{ opacity: 1 }, { opacity: 1, offset: .55 }, { opacity: .3 }], { duration: 1600, delay: 900, easing: 'ease-in-out', fill: 'backwards' });
    const cl = document.querySelector('#ruler .cutline');
    if (cl) { cl.setAttribute('pathLength', '1'); cl.animate([{ strokeDashoffset: 1, strokeDasharray: '1 1' }, { strokeDashoffset: 0, strokeDasharray: '1 1' }], { duration: 700, delay: 1300, easing: 'ease-out', fill: 'backwards' }); }
    fillFrom0('growFill', 900);
  } else if (key === 'vand') {
    // vandstrålen løber fra bruseren, en byge falder fra skyen, og jordens vand stiger
    svg.querySelectorAll('.spray path').forEach((p, i) => {
      p.setAttribute('pathLength', '1');
      p.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 700, delay: 1000 + i * 45, easing: 'cubic-bezier(.5,0,.8,.6)', fill: 'backwards' });
    });
    svg.querySelectorAll('.spray circle').forEach((c, i) => c.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 1650 + i * 45, fill: 'backwards' }));
    svg.querySelectorAll('.skyrain path').forEach((p, i) => p.animate([{ transform: 'translateY(-10px)', opacity: 0 }, { opacity: 1, offset: .3 }, { transform: 'translateY(6px)', opacity: 1 }], { duration: 800, delay: 700 + i * 70, easing: 'ease-in', fill: 'backwards' }));
    fillFrom0('soilFill', 1300);
  } else if (key === 'plaene') {
    // snittet afdækkes lag for lag, rødderne vokser ned, og regnormen kryber
    const sf = svg.querySelector('.soilfront');
    if (sf) sf.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 1300, delay: 450, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'backwards' });
    const wm = svg.querySelector('.worm');
    if (wm) wm.animate([{ transform: 'translateX(-6px) scaleX(.9)' }, { transform: 'translateX(2px) scaleX(1.05)' }, { transform: 'none' }], { duration: 1600, delay: 1500, easing: 'ease-in-out' });
    svg.querySelectorAll('.bloom').forEach((b2, i) => b2.animate([
      { transform: 'scale(.12) rotate(-70deg)', opacity: 0 }, { transform: 'scale(1.08) rotate(6deg)', opacity: 1, offset: .75 }, { transform: 'none', opacity: 1 },
    ], { duration: 900, delay: 1300 + i * 170, easing: 'ease-out', fill: 'backwards' }));
    panel.querySelectorAll('.field').forEach((f, i) => f.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 380, delay: 500 + i * 60, easing: 'ease-out', fill: 'backwards' }));
  }
}
function closeFX(prev, token) {
  const panel = document.querySelector(`.panel[data-sec="${prev}"]`);
  const a = panel.animate([{ opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0)' }, { opacity: 0, transform: 'translateY(-18px) scale(.98)', clipPath: 'inset(0 0 100% 0)' }],
    { duration: 300, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
  let ran = false;
  const done = () => {
    if (ran) return; ran = true;
    a.cancel();
    if (token !== animToken) return;
    setState(null);
    // hjulet ruller tilbage på plads, og feltet man kom fra lyser kort op
    $('wheelWrap').animate([{ transform: 'rotate(-30deg) scale(.9)' }, { transform: 'rotate(3deg)', offset: .75 }, { transform: 'none' }], { duration: 820, easing: 'cubic-bezier(.2,.8,.25,1)' });
    const sec = document.querySelector('#wheel .sec-' + prev);
    if (sec) sec.animate([{ opacity: .42 }, { opacity: 0 }], { duration: 1500, delay: 450, easing: 'ease-out', fill: 'backwards' });
    const vig = document.querySelector('#wheel .vig-' + prev);
    if (vig) vig.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)', offset: .4 }, { transform: 'scale(1)' }], { duration: 900, delay: 500, easing: 'ease-in-out' });
    $('plateCaption').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 500, fill: 'backwards' });
  };
  a.onfinish = done;
  setTimeout(() => { if (openSec === prev && token === animToken) done(); }, 450);
}
function goSection(key) {
  if (openSec === key) return;
  if (key && motionOK()) {
    // lille tryk-respons i feltet, før det åbner
    const sec = document.querySelector('#wheel .sec-' + key);
    if (sec) sec.animate([{ opacity: .35 }, { opacity: 0 }], { duration: 500, easing: 'ease-out' });
  }
  if (key && openSec) location.replace('#' + key);          // skift mellem felter uden at fylde historikken
  else if (key) { pushedSec = true; location.hash = key; }
  else if (pushedSec) { pushedSec = false; history.back(); }
  else { history.replaceState(null, '', location.pathname + location.search); applyHash(); }
}
document.querySelectorAll('.qbtn').forEach(b => b.addEventListener('click', () => goSection(b.dataset.sec)));
$('backBtn').addEventListener('click', () => goSection(null));
$('homeLink').addEventListener('click', e => { e.preventDefault(); goSection(null); });
window.addEventListener('hashchange', applyHash);
$('locBtn2').addEventListener('click', () => {
  $('locPanel').hidden = false; $('locBtn').setAttribute('aria-expanded', 'true');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('searchInput').focus({ preventScroll: true });
});
applyHash();

/* ---------- data ---------- */
const HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,is_day,et0_fao_evapotranspiration';
function validForecast(j) { return j && j.hourly && Array.isArray(j.hourly.time) && j.hourly.time.length > 48 && Number.isFinite(+j.utc_offset_seconds); }
// DMI's HARMONIE-model (2 km, de første 2,5 døgn) dækker Nord- og Centraleuropa. Open-Meteo forlænger den med ECMWF.
const inDMI = l => l.lat >= 44 && l.lat <= 72 && l.lon >= -30 && l.lon <= 42;
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function fetchForecast(l) {
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${l.lat.toFixed(2)}&longitude=${l.lon.toFixed(2)}&wind_speed_unit=ms&timezone=auto`;
  const main = `${base}&hourly=${HOURLY}&past_days=30&forecast_days=7`;
  const probP = getJSON(`${base}&hourly=precipitation_probability&forecast_days=7`).catch(() => null);
  let j = null, source = 'Open-Meteo';
  if (inDMI(l)) {
    try { j = await getJSON(main + '&models=dmi_seamless'); if (validForecast(j)) source = 'dmi'; else j = null; } catch (e) { j = null; }
  }
  if (!j) j = await getJSON(main);
  if (!validForecast(j)) throw new Error('uventet svar fra vejrtjenesten');
  // regnrisiko findes ikke i DMI-modellen; den hentes fra Open-Meteos ensemble og lægges på samme timer
  const pj = await probP;
  const pm = new Map();
  if (pj && pj.hourly && Array.isArray(pj.hourly.time)) pj.hourly.time.forEach((t, i) => pm.set(t, pj.hourly.precipitation_probability[i]));
  j.hourly.precipitation_probability = j.hourly.time.map(t => (pm.has(t) ? pm.get(t) : null));
  j._source = source;
  return j;
}
function showSource() {
  $('sourceTxt').textContent = data && data._source === 'dmi'
    ? "Vejrdata: DMI's HARMONIE-model via "
    : 'Vejrdata: ';
}
async function load() {
  $('banner').hidden = true;
  $('locName').textContent = loc.name;
  $('plateCaption').textContent = `Henter vejrudsigt for ${loc.name}…`;
  let j;
  try {
    j = await fetchForecast(loc);
  } catch (e) {
    const saved = store.get('forecast', null);
    if (saved && validForecast(saved.json) && saved.lat === loc.lat && saved.lon === loc.lon && Date.now() - saved.at < 3 * 864e5) {
      data = saved.json; isSample = false; selected = null; staleFrom = saved.at; showSource();
      const age = new Date(saved.at + data.utc_offset_seconds * 1000);
      $('bannerText').textContent = `Ingen forbindelse til vejrtjenesten. Du ser den gemte prognose fra ${dayName(age.getTime(), nowLocal())} kl. ${hhmm(age.getTime())}.`;
      $('banner').hidden = false;
      $('updated').textContent = '';
      run();
      return;
    }
    const t0 = new Date(); t0.setUTCHours(0, 0, 0, 0);
    data = sampleData(t0.getTime() - 2 * 864e5); isSample = true; selected = null;
    const opened = location.protocol === 'https:' || location.protocol === 'http:' ? location.host : location.protocol.replace(':', '');
    $('bannerText').textContent = `Vejrudsigten kunne ikke hentes, så du ser eksempeldata, ikke din plæne (${e.message || e}; åbnet fra ${opened || 'ukendt'}). Tjek netforbindelsen, eller åbn siden fra en webadresse.`;
    $('banner').hidden = false;
    $('updated').textContent = '';
    run();
    return;
  }
  data = j; data._fetched = Date.now(); isSample = false; selected = null; staleFrom = null;
  store.set('forecast', { lat: loc.lat, lon: loc.lon, at: Date.now(), json: j });
  $('updated').textContent = `Prognose hentet ${hhmm(nowLocal())}.`;
  showSource();
  run();
}

/* ---------- sted ---------- */
$('locBtn').addEventListener('click', () => {
  const open = $('locPanel').hidden;
  $('locPanel').hidden = !open; $('locBtn').setAttribute('aria-expanded', String(open));
  if (open) $('searchInput').focus();
});
$('searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('searchInput').value.trim(); if (!q) return;
  $('locHint').textContent = 'Søger…'; $('results').textContent = '';
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=da&format=json`);
    const j = await r.json();
    const res = Array.isArray(j.results) ? j.results : [];
    $('locHint').textContent = res.length ? '' : `Fandt ingen steder, der hedder “${q}”. Prøv byens navn.`;
    for (const p of res) {
      const li = document.createElement('li'); const b = document.createElement('button'); b.type = 'button';
      // Svar udefra indsættes kun som tekst, aldrig som HTML.
      const sm = document.createElement('small');
      sm.textContent = [p.admin1, p.country].filter(Boolean).join(', ');
      b.append(document.createTextNode(String(p.name) + ' '), sm);
      b.addEventListener('click', () => setLoc({ name: p.name, lat: p.latitude, lon: p.longitude }));
      li.append(b); $('results').append(li);
    }
  } catch (err) { $('locHint').textContent = 'Søgningen virker ikke lige nu. Tjek netforbindelsen.'; }
});
$('geoBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { $('locHint').textContent = 'Din browser kan ikke give din position. Søg efter din by i stedet.'; return; }
  $('locHint').textContent = 'Finder din position…';
  navigator.geolocation.getCurrentPosition(
    p => setLoc({ name: 'Din position', lat: p.coords.latitude, lon: p.coords.longitude }),
    () => { $('locHint').textContent = 'Browseren gav ikke adgang til din position her. Søg efter din by i stedet.'; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
});
function setLoc(l) {
  const c = cleanLoc(l); if (!c) return;
  loc = c; store.set('loc', c);
  $('locPanel').hidden = true; $('locBtn').setAttribute('aria-expanded', 'false');
  $('results').textContent = ''; $('locHint').textContent = ''; $('searchInput').value = '';
  load();
}
$('retryBtn').addEventListener('click', load);

/* ---------- klippelog ---------- */
function logMow(epoch) {
  mows = mows.filter(x => Math.abs(x - epoch) > 6 * 36e5).concat([epoch]).sort((a, b) => a - b).slice(-30);
  store.set('mows', mows);
  if (model) render();
}
$('mowToday').addEventListener('click', () => logMow(Date.now()));
$('mowYesterday').addEventListener('click', () => logMow(Date.now() - 864e5));
$('mowUndo').addEventListener('click', () => { mows = mows.slice(0, -1); store.set('mows', mows); if (model) render(); });

/* ---------- dine meldinger: vådt eller tørt græs ---------- */
function renderObs() {
  $('obs').hidden = isSample;
  const last = obs.length ? obs[obs.length - 1] : null;
  const age = last ? Date.now() - last.t : Infinity;
  if (last && age < 12 * 36e5) {
    $('obsNote').hidden = false;
    $('obsNote').textContent = `Du meldte ${last.wet ? 'vådt' : 'tørt'} græs kl. ${hhmm(last.t + offsetMs())}.` +
      (age < 10 * 60000 && last.adj > 1.01 ? ' Din have regnes fremover lidt vådere.' : age < 10 * 60000 && last.adj < 0.99 ? ' Din have regnes fremover lidt tørrere.' : '');
  } else $('obsNote').hidden = true;
  const pct = Math.round(Math.abs(wetk - 1) * 100);
  $('tuneField').hidden = pct < 3 && !obs.length;
  $('tuneTxt').textContent = pct < 3 ? `${obs.length} ${obs.length === 1 ? 'melding' : 'meldinger'}, ingen justering endnu`
    : `Græsset regnes ca. ${pct} % ${wetk > 1 ? 'vådere' : 'tørrere'} end standard (${obs.length} ${obs.length === 1 ? 'melding' : 'meldinger'})`;
}
function reportGrass(wet) {
  if (!model || isSample) return;
  const t = Date.now();
  // en ny melding inden for en time erstatter den forrige (fx hvis man trykkede forkert)
  const prev = obs.length ? obs[obs.length - 1] : null;
  if (prev && t - prev.t < 36e5) { wetk = clamp(wetk / prev.adj, 0.5, 2); obs.pop(); run(); }
  // sammenlign med det, beregningen selv mente; lær højst én gang pr. 6 timer
  const Wm = model.Wnow, st = model.cur.status;
  const recent = obs.length && t - obs[obs.length - 1].t < 6 * 36e5;
  let adj = 1;
  if (!recent && st !== 'rain' && st !== 'frost') {
    if (wet) adj = Wm <= DRY_MM ? 1.2 : Wm <= DAMP_MM ? 1.08 : 1;
    else adj = Wm > DAMP_MM ? 1 / 1.2 : Wm > DRY_MM ? 1 / 1.08 : 1;
  }
  const k2 = clamp(wetk * adj, 0.5, 2);
  adj = k2 / wetk; wetk = k2;
  obs = obs.concat([{ t, wet, adj }]).slice(-40);
  store.set('obs', obs); store.set('wetk', wetk);
  run();
}
$('obsWet').addEventListener('click', () => reportGrass(true));
$('obsDry').addEventListener('click', () => reportGrass(false));
$('tuneReset').addEventListener('click', () => { obs = []; wetk = 1; store.set('obs', obs); store.set('wetk', wetk); run(); });

/* ---------- indstillinger ---------- */
for (const name of ['type', 'soil', 'fert', 'site', 'grass', 'dur']) {
  const el2 = document.querySelector(`input[name="${name}"][value="${String(opts[name])}"]`); if (el2) el2.checked = true;
  document.querySelectorAll(`input[name="${name}"]`).forEach(inp => inp.addEventListener('change', () => {
    opts[name] = name === 'dur' ? +inp.value : inp.value; store.set('opts', opts); run();
  }));
}

/* ---------- app ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
$('installBtn').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch (e) {}
  installEvt = null; $('installBtn').hidden = true;
});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (window.ResizeObserver) {
  let lastW = 0; new ResizeObserver(es => { const w = Math.round(es[0].contentRect.width); if (w && w !== lastW) { lastW = w; drawChart(); } }).observe($('chartWrap')); }

load();
setInterval(() => { if (model && !isSample) render(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data && !isSample && Date.now() - (data._fetched || staleFrom || 0) > 3 * 36e5) load(); });
