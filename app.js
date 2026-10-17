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
  rye:    { name: 'Almindelig rajgræs', latin: 'Lolium perenne L.', peak: 4.5, root: 0.9, head: 'spike' },
  poa:    { name: 'Eng-rapgræs', latin: 'Poa pratensis L.', peak: 3.5, root: 1.0, head: 'panicle' },
  fescue: { name: 'Rød svingel', latin: 'Festuca rubra L.', peak: 2.5, root: 1.15, head: 'panicle' },
  tall:   { name: 'Strand-svingel', latin: 'Festuca arundinacea Schreb.', peak: 3.5, root: 1.5, head: 'panicle' },
  mix:    { name: 'Græsplæne, blandet', latin: 'Gramineae', peak: 4.0, root: 1.0, head: 'spike' },
};
const SOILS = {                     // aw = plantetilgængeligt vand i rodzonen (mm); drain = afdræning af overfladevand pr. time; soft = grænse for blød jord (mm)
  sand: { name: 'sandet jord', aw: 35, drain: 0.93, soft: 10 },
  loam: { name: 'muldjord', aw: 70, drain: 0.96, soft: 6 },
  clay: { name: 'lerjord', aw: 90, drain: 0.98, soft: 4 },
};
const FERT = { high: 1.25, some: 1.0, none: 0.75 };
const DRY_MM = 0.02, DAMP_MM = 0.10, FROST_C = 0.3;

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
    const Rnl = L0 * Math.max(0.05, 1 - 0.85 * cc) * site.sky;   // netto langbølget udstråling (W/m²)
    const Rn = 0.77 * Rs - Rnl;                                   // nettostråling, albedo 0,23
    const G = Rn > 0 ? 0.1 * Rn : 0.5 * Rn;                       // jordvarmestrøm (FAO-56, timebasis)
    const ra = 208 / u2;                                          // aerodynamisk modstand (s/m)
    const lamE = (delta * (Rn - G) + RHO_CP * (es - ea) / ra) / (delta + gamma);
    const Epot = lamE / LAMBDA * 3600;                            // mm/time; negativ = dug
    const Ts = Rn < 0 ? T + (Rn - G) / (7 + 4 * u2) : T;         // skønnet græsoverflade-temperatur

    // vand på stråene
    if (P > 0) { W = Math.min(grass.cap, W + P); if (P >= 0.05) source = 'rain'; }
    if (Epot < 0) {
      const before = W;
      W = Math.min(grass.cap, W + (-Epot));
      if (before <= DRY_MM && W > DRY_MM) source = 'dew';
    } else {
      W = Math.max(0, W - Epot * grass.dry * (Ts <= 0 ? 0.3 : 1));
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
      t: Date.parse(h.time[i] + ':00Z'), T, RH, u10, P, Rs, cc, isDay, Epot, Ts, W, S, AW, G: Gc, source,
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
let data = null, isSample = false, selected = null, model = null, staleFrom = null;

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
    case 'wet': return b.source === 'dew' ? `Dug fra natten: ca. ${water}.` : `Vådt efter regn: ca. ${water}.`;
    case 'damp': return `Næsten tørt, men stadig ca. ${water}. Afklippet klumper.`;
    case 'soft': return `Stråene er tørre, men jorden er blød efter regn. Undgå hjulspor.`;
    default: return b.dark ? 'Stråene er tørre, men det er mørkt.' : 'Ingen dug eller regn på stråene.';
  }
}

function run() {
  if (!data) return;
  const sim = simulate(data.hourly, data.elevation, opts);
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
  $('eyebrow').textContent = `${loc.name} · ${DAYS[d.getUTCDay()]} ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${hhmm(now)}`;
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
  drawScene(st, cur, Wnow, cap, now);
  renderPlan(st, blocks, now, adv);
  renderRain(st, now);
  renderWater(st, now, adv);
  renderCut(adv);
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
function washFilter(defs, id, scale) {
  const f = el('filter', { id, x: '-15%', y: '-15%', width: '130%', height: '130%' }, defs);
  el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.045', numOctaves: '2', seed: '5', result: 'n' }, f);
  el('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: String(scale), xChannelSelector: 'R', yChannelSelector: 'G' }, f);
}
function leafShape(g, R, cls) {
  const d = 'M0,-10 C5,-7 6.5,3 0,10 C-6.5,3 -5,-7 0,-10 Z';
  el('path', { d, class: `${cls} wash`, transform: 'translate(.8 .6)' }, g);
  el('path', { d, class: 'ink' }, g);
  el('path', { d: 'M0,-9 L0,12', class: 'ink thin' }, g);
  for (const y of [-4, 0, 4]) { el('path', { d: `M0,${y} L3.6,${y - 3}`, class: 'hair' }, g); el('path', { d: `M0,${y} L-3.6,${y - 3}`, class: 'hair' }, g); }
}
function daisy(g, x, y, s) {
  const fg = el('g', { transform: `translate(${f1(x)} ${f1(y)}) scale(${s})` }, g);
  el('path', { d: 'M0,0 C1,8 0,16 1,24', class: 'ink thin' }, fg);
  for (let k = 0; k < 12; k++) {
    const a = k * 30;
    el('ellipse', { cx: 0, cy: -4.6, rx: 1.3, ry: 3.6, class: 'paperfill', transform: `rotate(${a})` }, fg);
    el('ellipse', { cx: 0, cy: -4.6, rx: 1.3, ry: 3.6, class: 'ink thin', transform: `rotate(${a})` }, fg);
  }
  el('circle', { r: 2.2, class: 'w-flower wash' }, fg);
  el('circle', { r: 2.2, class: 'ink thin' }, fg);
}
function clover(g, x, y, s) {
  const fg = el('g', { transform: `translate(${f1(x)} ${f1(y)}) scale(${s})` }, g);
  el('path', { d: 'M0,4 C-1,12 1,18 0,26', class: 'ink thin' }, fg);
  el('circle', { r: 5.5, class: 'w-clover wash' }, fg);
  for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; el('path', { d: `M${f1(Math.cos(a) * 1.5)},${f1(Math.sin(a) * 1.5)} L${f1(Math.cos(a) * 5.5)},${f1(Math.sin(a) * 5.5)}`, class: 'ink thin' }, fg); }
  for (const [dx, dy] of [[-4, 22], [4, 22], [0, 18.5]]) { el('circle', { cx: dx, cy: dy, r: 3, class: 'w-grass wash' }, fg); el('circle', { cx: dx, cy: dy, r: 3, class: 'ink thin' }, fg); }
}
function seedHead(g, x, base, h, lean, kind, dried) {
  const tipX = x + lean, tipY = base - h;
  el('path', { d: `M${f1(x)},${base} Q${f1(x + lean * 0.3)},${f1(base - h * 0.6)} ${f1(tipX)},${f1(tipY)}`, class: 'ink thin' }, g);
  const cls = dried ? 'w-grass2' : 'w-grass';
  if (kind === 'spike') {
    for (let k = 0; k < 9; k++) {
      const f = 0.62 + k * 0.042, px = x + (tipX - x) * f * f, py = base - h * f;
      const side = k % 2 ? 1 : -1;
      const sp = el('g', { transform: `translate(${f1(px)} ${f1(py)}) rotate(${side * 32})` }, g);
      el('ellipse', { cx: 0, cy: -4, rx: 1.8, ry: 4.4, class: `${cls} wash` }, sp);
      el('ellipse', { cx: 0, cy: -4, rx: 1.8, ry: 4.4, class: 'ink thin' }, sp);
    }
  } else {
    for (let k = 0; k < 7; k++) {
      const f = 0.6 + k * 0.055, px = x + (tipX - x) * f * f, py = base - h * f;
      const side = k % 2 ? 1 : -1, len = 14 - k * 1.3;
      const ex = px + side * len, ey = py - len * 0.55;
      el('path', { d: `M${f1(px)},${f1(py)} Q${f1(px + side * len * 0.5)},${f1(py - len * 0.1)} ${f1(ex)},${f1(ey)}`, class: 'hair' }, g);
      for (const q of [0.55, 1]) {
        const sx = px + (ex - px) * q, sy = py + (ey - py) * q;
        el('ellipse', { cx: f1(sx), cy: f1(sy), rx: 1.4, ry: 2.6, class: `${cls} wash`, transform: `rotate(${side * 40} ${f1(sx)} ${f1(sy)})` }, g);
        el('ellipse', { cx: f1(sx), cy: f1(sy), rx: 1.4, ry: 2.6, class: 'ink thin', transform: `rotate(${side * 40} ${f1(sx)} ${f1(sy)})` }, g);
      }
    }
  }
}
function drawScene(st, cur, Wnow, cap, now) {
  const svg = $('scene'); svg.textContent = '';
  const today = dayKey(now);
  const dayStamps = st.filter(s => dayKey(s.t) === today && s.isDay);
  const sunrise = dayStamps.length ? dayStamps[0].t - 18e5 : Date.parse(today + 'T07:00:00Z');
  const sunset = dayStamps.length ? dayStamps[dayStamps.length - 1].t + 18e5 : Date.parse(today + 'T18:00:00Z');
  const near = Math.min(Math.abs(now - sunrise), Math.abs(now - sunset)) < 36e5;
  const ccNow = (st.find(s => s.t >= now) || st[st.length - 1]).cc;
  let phase;
  if (cur.dark) phase = near ? 'dusk' : 'night';
  else if (cur.status === 'rain') phase = 'rain';
  else if (cur.status === 'frost') phase = 'frost';
  else if (near) phase = 'dusk';
  else if (ccNow > 0.7) phase = 'overcast';
  else phase = 'day';
  $('hero').className = 'plate phase-' + phase;
  const season = document.documentElement.dataset.season;
  const m = seasonMonth(now, isSample ? 55.7 : loc.lat);
  const R = rng(11);
  const ground = 200;
  // Tegningen udvides i bredden efter pladsen, så himlen aldrig beskæres.
  const vw = svg.clientWidth || 400, vh = svg.clientHeight || 210;
  const VW = Math.max(400, Math.round(210 * vw / vh)), X0 = Math.round((400 - VW) / 2);
  svg.setAttribute('viewBox', `${X0} 0 ${VW} 210`);

  const defs = el('defs', {}, svg);
  washFilter(defs, 'washF', 5);
  const sg = el('linearGradient', { id: 'skyG', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0', class: 'sky0' }, sg);
  el('stop', { offset: '1', class: 'sky1' }, sg);
  el('rect', { x: X0 - 60, y: -20, width: VW + 120, height: 175, fill: 'url(#skyG)', filter: 'url(#washF)' }, svg);

  // himmel
  if (phase === 'night') {
    for (let i = 0; i < 22; i++) {
      const x = X0 + R() * VW, y = 8 + R() * 90, s = 1.4 + R() * 1.6;
      el('path', { d: `M${f1(x - s)},${f1(y)} L${f1(x + s)},${f1(y)} M${f1(x)},${f1(y - s)} L${f1(x)},${f1(y + s)}`, class: 'ink thin' + (R() > 0.5 ? ' twinkle' : '') }, svg);
    }
    const mg = el('g', { transform: `translate(${X0 + VW - 82} 46)` }, svg);
    const md = 'M0,-17 A17,17 0 1,0 14,10 A13,13 0 1,1 0,-17 Z';
    el('path', { d: md, class: 'w-moon wash' }, mg);
    el('path', { d: md, class: 'ink' }, mg);
    for (let k = 0; k < 6; k++) el('path', { d: `M${-12 + k * 2},${-6 + k * 3} l5,-3`, class: 'hair' }, mg);
  } else if (phase !== 'rain') {
    const fr = clamp((now - sunrise) / (sunset - sunrise), 0, 1);
    const sx = X0 + 40 + fr * (VW - 80), sy = 112 - Math.sin(fr * Math.PI) * 80;
    const sgp = el('g', { transform: `translate(${f1(sx)} ${f1(sy)})`, opacity: phase === 'overcast' ? 0.5 : 1 }, svg);
    el('circle', { r: 13, class: 'w-sun wash' }, sgp);
    el('circle', { r: 13, class: 'ink' }, sgp);
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8, r1 = 17, r2 = k % 2 ? 22 : 28;
      el('path', { d: `M${f1(Math.cos(a) * r1)},${f1(Math.sin(a) * r1)} L${f1(Math.cos(a) * r2)},${f1(Math.sin(a) * r2)}`, class: 'ink thin' }, sgp);
    }
  }
  const nClouds = phase === 'rain' ? 4 : ccNow > 0.85 ? 4 : ccNow > 0.55 ? 3 : ccNow > 0.25 ? 2 : ccNow > 0.08 ? 1 : 0;
  const spots = [[X0 + VW * 0.17, 34], [X0 + VW * 0.62, 22], [X0 + VW * 0.42, 62], [X0 + VW * 0.86, 58]];
  for (let i = 0; i < nClouds; i++) {
    const [cx, cy] = spots[i], s = 0.8 + R() * 0.45;
    const cg = el('g', { transform: `translate(${f1(cx)} ${cy}) scale(${s.toFixed(2)})` }, svg);
    const bumps = [[-24, 0, 10], [-10, -7, 13], [7, -9, 14], [22, -2, 10], [31, 2, 7]];
    for (const [bx, by, br] of bumps) el('circle', { cx: bx, cy: by, r: br + 0.7, class: 'ink' }, cg);
    for (const [bx, by, br] of bumps) el('circle', { cx: bx, cy: by, r: br, class: 'paperfill' }, cg);
    el('rect', { x: -36, y: 1, width: 72, height: 14, class: 'paperfill' }, cg);
    el('path', { d: 'M-33,1 L37,1', class: 'ink' }, cg);
    for (let k = 0; k < 5; k++) el('path', { d: `M${-26 + k * 9},-1 l7,0`, class: 'hair' }, cg);
  }
  if (phase === 'rain') {
    const rg = el('g', {}, svg);
    for (let i = 0; i < 55; i++) {
      const x = X0 + R() * VW, y = R() * 150 - 10;
      const ln = el('path', { d: `M${f1(x)},${f1(y)} l-3,11`, class: 'rain raindrop' }, rg);
      ln.style.animationDelay = (-R() * 0.95).toFixed(2) + 's';
      ln.style.animationDuration = (0.75 + R() * 0.4).toFixed(2) + 's';
    }
  }
  if (season === 'autumn') {
    const lg = el('g', {}, svg);
    for (let i = 0; i < 6; i++) {
      const g = el('g', { transform: `translate(${f1(X0 + 30 + R() * (VW - 60))} ${f1(10 + R() * 60)}) scale(${(0.8 + R() * 0.5).toFixed(2)})` }, lg);
      const inner = el('g', { class: 'leaf' }, g);
      inner.style.animationDelay = (-R() * 16).toFixed(1) + 's';
      inner.style.animationDuration = (13 + R() * 6).toFixed(1) + 's';
      leafShape(inner, R, ['w-leaf1', 'w-leaf2', 'w-leaf3'][i % 3]);
    }
  }
  if (season === 'winter' && (cur.status === 'frost' || cur.T < 2)) {
    for (let i = 0; i < 14; i++) {
      const x = X0 + R() * VW, y = 10 + R() * 120, s = 2 + R() * 2;
      let d = ''; for (let k = 0; k < 3; k++) { const a = k * Math.PI / 3; d += `M${f1(x - Math.cos(a) * s)},${f1(y - Math.sin(a) * s)} L${f1(x + Math.cos(a) * s)},${f1(y + Math.sin(a) * s)} `; }
      el('path', { d, class: 'ink thin' }, svg);
    }
  }

  // jord
  el('rect', { x: X0 - 60, y: ground - 3, width: VW + 120, height: 30, class: 'w-soil wash', filter: 'url(#washF)' }, svg);
  for (let i = 0; i < Math.round(VW / 9); i++) { const x = X0 - 15 + R() * (VW + 30), y = ground + 1 + R() * 9; el('path', { d: `M${f1(x)},${f1(y)} l${f1(5 + R() * 15)},0`, class: 'hair' }, svg); }
  if (season === 'autumn') {
    for (let i = 0; i < 4; i++) {
      const g = el('g', { transform: `translate(${f1(X0 + 20 + R() * (VW - 40))} ${f1(ground + 2)}) rotate(${f1(70 + R() * 40)}) scale(.75)` }, svg);
      leafShape(g, R, ['w-leaf1', 'w-leaf2', 'w-leaf3'][i % 3]);
    }
  }

  // græs og blomster
  const sway = el('g', { class: 'sway' }, svg);
  const washG = el('g', { filter: 'url(#washF)' }, sway);
  const inkG = el('g', {}, sway);
  const tips = [];
  for (let i = 0, nb = Math.round(VW / 8.8) + 3; i < nb; i++) {
    const x = X0 - 10 + i * 8.8 + (R() - 0.5) * 6;
    const h = 52 + R() * 72, lean = (R() - 0.5) * 54, w = 4 + R() * 3.2;
    const d = bladePath(x, ground + 2, w, h, lean);
    const alt = R() < (season === 'autumn' ? 0.32 : season === 'winter' ? 0.4 : 0.18);
    el('path', { d, class: (alt ? 'w-grass2' : 'w-grass') + ' wash', transform: 'translate(1.2 .8)' }, washG);
    el('path', { d, class: 'ink' }, inkG);
    el('path', { d: `M${f1(x)},${ground + 2} Q${f1(x + lean * 0.5)},${f1(ground + 2 - h * 0.7)} ${f1(x + lean)},${f1(ground + 2 - h)}`, class: 'hair' }, inkG);
    tips.push([x + lean, ground + 2 - h]);
  }
  const heads = (m >= 5 && m <= 7) ? 3 : m === 4 ? 2 : (m >= 8 && m <= 9) ? 2 : 0;
  const kind = GRASS_TYPES[opts.type].head;
  for (let i = 0; i < heads; i++) seedHead(inkG, X0 + VW * (0.15 + i * 0.3) + R() * 30, ground + 2, 140 + R() * 28, (R() - 0.5) * 40, kind, m >= 8);
  if (season === 'spring' || season === 'summer') {
    const fg = el('g', {}, sway);
    const nD = season === 'spring' ? 6 : 3;
    for (let i = 0; i < nD; i++) daisy(fg, X0 + 25 + i * ((VW - 50) / nD) + R() * 30, ground - 20 - R() * 14, 0.85 + R() * 0.3);
    if (season === 'summer') for (let i = 0; i < 3; i++) clover(fg, X0 + VW * (0.15 + i * 0.3) + R() * 30, ground - 22 - R() * 10, 0.9);
  }
  const wf = clamp(Wnow / cap, 0, 1);
  if (cur.status === 'frost') {
    for (const [tx, ty] of tips) el('path', { d: `M${f1(tx - 2.5)},${f1(ty + 3)} L${f1(tx)},${f1(ty)} L${f1(tx + 2.5)},${f1(ty + 3)}`, class: 'rime' }, inkG);
  } else if (Wnow > DRY_MM) {
    const n = Math.max(4, Math.round(wf * 30));
    const order = tips.map((t, i) => [rng(i + 11)(), t]).sort((a, b) => a[0] - b[0]).slice(0, n);
    for (const [, [tx, ty]] of order) {
      const r = (1.8 + wf * 1.2).toFixed(2);
      el('circle', { cx: f1(tx), cy: f1(ty + 2.8), r, class: 'w-water' }, inkG);
      el('circle', { cx: f1(tx), cy: f1(ty + 2.8), r, class: 'ink thin' }, inkG);
      el('circle', { cx: f1(tx - 0.7), cy: f1(ty + 2), r: 0.6, class: 'paperfill' }, inkG);
    }
  }
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

/* ---------- data ---------- */
const HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,shortwave_radiation,cloud_cover,is_day,et0_fao_evapotranspiration';
function validForecast(j) { return j && j.hourly && Array.isArray(j.hourly.time) && j.hourly.time.length > 48 && Number.isFinite(+j.utc_offset_seconds); }
async function load() {
  $('banner').hidden = true;
  $('locName').textContent = loc.name;
  $('eyebrow').textContent = `Henter vejrudsigt for ${loc.name}…`;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(2)}&longitude=${loc.lon.toFixed(2)}&hourly=${HOURLY}&wind_speed_unit=ms&timezone=auto&past_days=30&forecast_days=7`;
  let j;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
    if (!validForecast(j)) throw new Error('uventet svar fra vejrtjenesten');
  } catch (e) {
    const saved = store.get('forecast', null);
    if (saved && validForecast(saved.json) && saved.lat === loc.lat && saved.lon === loc.lon && Date.now() - saved.at < 3 * 864e5) {
      data = saved.json; isSample = false; selected = null; staleFrom = saved.at;
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
  let lastS = 0;
  new ResizeObserver(es => { const w = Math.round(es[0].contentRect.width); if (w && w !== lastS) { lastS = w; if (model && model.cur) drawScene(model.st, model.cur, model.Wnow, model.cap, model.now); } }).observe($('scene'));
  let lastW = 0; new ResizeObserver(es => { const w = Math.round(es[0].contentRect.width); if (w && w !== lastW) { lastW = w; drawChart(); } }).observe($('chartWrap')); }

load();
setInterval(() => { if (model && !isSample) render(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data && !isSample && Date.now() - (data._fetched || staleFrom || 0) > 3 * 36e5) load(); });
