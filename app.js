'use strict';
// MODEL START
const SIGMA = 5.670e-8, LAMBDA = 2.45e6, RHO_CP = 1.2 * 1013;
const SITE = {
  sun:   { sw: 1.00, sky: 1.00 },   // andel af solindstråling, andel af fri himmel (udstråling)
  half:  { sw: 0.60, sky: 0.85 },
  shade: { sw: 0.35, sky: 0.65 },
};
const GRASS = {
  short:  { cap: 0.35, dry: 1.15 }, // mm vand stråene kan holde, relativ tørrehastighed
  normal: { cap: 0.50, dry: 1.00 },
  long:   { cap: 0.80, dry: 0.75 },
};
const DRY_MM = 0.02, DAMP_MM = 0.10, SOFT_MM = 6, FROST_C = 0.3;

function num(v, fb) { return (v === null || v === undefined || Number.isNaN(+v)) ? fb : +v; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function satVP(T) { return 0.6108 * Math.exp(17.27 * T / (T + 237.3)); }

// Kør vandbalancen time for time. h = Open-Meteo "hourly"-objekt.
function simulate(h, elevation, opts) {
  const site = SITE[opts.site] || SITE.sun;
  const grass = GRASS[opts.grass] || GRASS.normal;
  const n = h.time.length;
  const Patm = 101.3 * Math.pow((293 - 0.0065 * (elevation || 0)) / 293, 5.26);
  const gamma = 0.000665 * Patm;
  const st = new Array(n);
  let W = 0, S = 0, source = null;
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

    if (P > 0) { W = Math.min(grass.cap, W + P); if (P >= 0.05) source = 'rain'; }
    if (Epot < 0) {
      const before = W;
      W = Math.min(grass.cap, W + (-Epot));
      if (before <= DRY_MM && W > DRY_MM) source = 'dew';
    } else {
      W = Math.max(0, W - Epot * grass.dry * (Ts <= 0 ? 0.3 : 1));
    }
    if (W <= DRY_MM) source = null;
    S = Math.max(0, S * 0.96 + P - 0.8 * et0);

    st[i] = {
      t: Date.parse(h.time[i] + ':00Z'), T, RH, u10, P, Rs, cc, isDay, Epot, Ts, W, S, source,
      prob: h.precipitation_probability ? h.precipitation_probability[i] : null,
    };
  }
  return { st, cap: grass.cap };
}

// Timeblokke [t_k, t_k+1): status gælder hele timen.
function toBlocks(st) {
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
    else if (b.S > SOFT_MM) status = 'soft';
    else status = 'dry';
    blocks.push({
      start: a.t, end: b.t, status, dark, mowable: !dark && (status === 'dry' || status === 'soft'),
      W: wmax, Wend: b.W, S: b.S, T: (a.T + b.T) / 2, RH: b.RH, u10: b.u10, P: b.P, prob: b.prob,
      source: b.source || a.source, Ts: Math.min(a.Ts, b.Ts),
    });
  }
  return blocks;
}

// Find sammenhængende tørre vinduer fra blok i0, mindst minMin minutter (målt fra nowT i den løbende blok).
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
  for (let i = 0; i < st.length; i++) {
    const s = st[i];
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

// Anbefalet klippehøjde ud fra årstid, temperatur, tørke, skygge og græslængde.
function cutAdvice(st, now, opts, lat) {
  const d = new Date(now);
  const m = lat < 0 ? (d.getUTCMonth() + 6) % 12 : d.getUTCMonth();
  let sumT = 0, nT = 0, maxT = -99, rain7 = 0, minTs = 99;
  for (const s of st) {
    if (s.t >= now - 3 * 864e5 && s.t <= now + 2 * 864e5) { sumT += s.T; nT++; }
    if (s.t > now && s.t <= now + 2 * 864e5) maxT = Math.max(maxT, s.T);
    if (s.t > now && s.t <= now + 864e5) minTs = Math.min(minTs, s.Ts);
    if (s.t <= now && s.t > now - 7 * 864e5) rain7 += s.P;
  }
  const meanT = nT ? sumT / nT : 10;
  if (maxT === -99) maxT = meanT;
  const shade = opts.site === 'shade' ? 1 : opts.site === 'half' ? 0.5 : 0;
  const why = [];
  let lo = 4, hi = 5, mode = 'mow', title;

  if (m === 11 || m <= 1) {
    if (meanT >= 8) { lo = 5; hi = 6; title = 'Mildt vintervejr'; why.push('Græsset kan gro lidt i mildt vejr. Slå kun, hvis det er over ca. 7 cm, og hold det højt.'); }
    else { mode = 'rest'; lo = 5; hi = 6; title = 'Plænen hviler'; why.push('Om vinteren gror græsset næsten ikke, så der er ikke brug for at slå det.'); }
  } else if (m <= 3) {
    lo = 5; hi = 6; title = 'Forår';
    why.push('De første klipninger efter vinteren skal være høje, så græsset kommer sig. Sænk gradvist til normal højde.');
  } else if (m <= 8) {
    title = m >= 6 && m <= 7 ? 'Sommer' : 'Vækstsæson';
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
  else if (mode === 'mow' && meanT < 8 && m >= 9) why.unshift(`Græsset gror langsomt ved ca. ${Math.round(meanT)} °C, så du skal slå sjældnere.`);
  if (shade) { lo += shade; hi += shade; why.push('I skygge skal græsset stå lidt højere, så det kan fange mere lys.'); }
  if (minTs <= 0) why.push('Der er frost i prognosen. Slå aldrig frosset græs, og gå helst ikke på det.');
  why.push(opts.grass === 'long'
    ? 'Dit græs er langt. Fjern højst en tredjedel ad gangen, og tag resten om et par dage.'
    : 'Fjern højst en tredjedel af længden ad gangen.');
  return { lo, hi, mode, title, why, meanT, maxT, rain7 };
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
  set(k, v) { try { localStorage.setItem('slaavejr.' + k, JSON.stringify(v)); } catch (e) {} },
};
const DEFAULT_LOC = { name: 'København', lat: 55.68, lon: 12.57 };
// Positionen afrundes til 2 decimaler (ca. 1 km). Prognosens gitter er alligevel grovere, og det præcise sted forlader aldrig telefonen.
function cleanLoc(l) {
  if (!l || typeof l !== 'object' || l.lat === null || l.lon === null || l.lat === '' || l.lon === '') return null;
  const lat = Number(l.lat), lon = Number(l.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: String((l && l.name) || 'Valgt sted').slice(0, 60), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}
let loc = cleanLoc(store.get('loc', null)) || DEFAULT_LOC;
const savedOpts = store.get('opts', {}) || {};
let opts = {
  site: Object.hasOwn(SITE, savedOpts.site) ? savedOpts.site : 'sun',
  grass: Object.hasOwn(GRASS, savedOpts.grass) ? savedOpts.grass : 'normal',
  dur: [30, 60, 90, 120].includes(savedOpts.dur) ? savedOpts.dur : 60,
};
let data = null, isSample = false, selected = null, model = null;

const pad = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const mm = (v, dec = 2) => v.toFixed(dec).replace('.', ',');
function nowLocal() { return Date.now() + (data ? data.utc_offset_seconds * 1000 : 0); }
function dayName(t, ref) {
  const k = dayKey(t), today = dayKey(ref), tom = dayKey(ref + 864e5), yest = dayKey(ref - 864e5);
  if (k === today) return 'i dag';
  if (k === tom) return 'i morgen';
  if (k === yest) return 'i går';
  const d = new Date(t);
  return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + '.';
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

function reasonFor(b, cap) {
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
  const blocks = toBlocks(sim.st);
  model = { blocks, cap: sim.cap, st: sim.st };
  render();
}

function render() {
  const { blocks, cap } = model;
  const now = isSample ? blocks[Math.min(blocks.length - 1, 2 * 24 + 10)].start + 20 * 60000 : nowLocal();
  let ci = blocks.findIndex(b => b.start <= now && now < b.end);
  if (ci < 0) ci = now < blocks[0].start ? 0 : blocks.length - 1;
  const cur = blocks[ci];
  const d = new Date(now);
  $('eyebrow').textContent = `Lige nu · ${loc.name} · ${DAYS[d.getUTCDay()]} ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${hhmm(now)}`;

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
  // vandfilm nu: interpoler i blokken
  const f = (now - cur.start) / (cur.end - cur.start);
  const Wnow = (ci > 0 ? blocks[ci - 1].Wend : cur.Wend) * (1 - f) + cur.Wend * f;
  if (!curWin) {
    const heads = { rain: 'Det regner', frost: 'Frost på græsset', wet: 'Græsset er vådt', damp: 'Næsten tørt', soft: 'Tørt, men det er mørkt', dry: 'Tørt, men det er mørkt' };
    head = heads[cur.status]; dotColor = `var(--st-${cur.status})`;
    reason = reasonFor(Object.assign({}, cur, { W: Math.max(Wnow, cur.status === 'wet' ? DAMP_MM + 0.01 : 0) }), cap);
  }
  $('headline').innerHTML = '';
  const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = dotColor;
  $('headline').append(dot, document.createTextNode(head));
  $('reason').textContent = reason;

  $('film').hidden = false;
  $('filmFill').style.width = Math.min(100, Wnow / cap * 100) + '%';
  $('filmVal').textContent = `${mm(Wnow)} / ${mm(cap)} mm`;

  drawScene(model.st, cur, Wnow, cap, now);
  renderRain(model.st, now);
  renderCut(model.st, now);

  // næste vindue
  const nextW = wins.find(w => !(curWin && w.k === curWin.k));
  $('next').hidden = false;
  $('nextLbl').textContent = curWin && (curWin.end - now) / 60000 >= opts.dur ? 'Næste tørre vindue derefter' : 'Næste tørre vindue';
  if (nextW) {
    $('nextWhen').textContent = span(nextW, now);
    $('nextMeta').textContent = hoursTxt(nextW.end - nextW.start) + (nextW.maxProb >= 20 ? ` · regnrisiko op til ${nextW.maxProb} %` : '') + (nextW.soft ? ' · blød jord' : '');
  } else {
    $('nextWhen').textContent = 'Intet i prognosen';
    $('nextMeta').textContent = `Ingen tørre perioder på mindst ${opts.dur} min frem til ${dayName(blocks[blocks.length - 1].end - 1, now)}`;
  }

  renderDays(blocks, now, ci);
  $('tl').hidden = false;
  model.now = now;
  drawChart();
}

/* ---------- regn og klippehøjde ---------- */
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
function renderRain(st, now) {
  const r = lastAndNextRain(st, now);
  if (r.ongoing) {
    $('lastRainLbl').textContent = 'Regn';
    $('lastRainVal').textContent = 'Det regner nu';
    $('lastRainSub').textContent = `Siden ${dayName(r.ongoing.start, now)} ${hhmm(r.ongoing.start)} · ca. ${mm(Math.max(r.soFar, 0.1), 1)} mm indtil nu`;
  } else if (r.last) {
    $('lastRainLbl').textContent = 'Sidste regn';
    $('lastRainVal').textContent = span(r.last, now);
    $('lastRainSub').textContent = `${mm(r.last.total, 1)} mm · ${agoTxt(now - r.last.end)}`;
  } else {
    const days = Math.max(1, Math.floor((now - r.coverFrom) / 864e5));
    $('lastRainLbl').textContent = 'Sidste regn';
    $('lastRainVal').textContent = `Over ${days} døgn siden`;
    $('lastRainSub').textContent = `Ingen regn i de ${days} døgn, vejrmodellen dækker`;
  }
  if (r.next) {
    $('nextRainVal').textContent = span(r.next, now);
    $('nextRainSub').textContent = `ca. ${mm(r.next.total, 1)} mm · ${untilTxt(r.next.start - now)}` + (r.next.maxProb ? ` · risiko ${r.next.maxProb} %` : '');
  } else {
    $('nextRainVal').textContent = 'Ingen i prognosen';
    $('nextRainSub').textContent = `Tørvejr frem til ${dayName(st[st.length - 1].t - 1, now)}`;
  }
  $('facts').hidden = false;
}
function renderCut(st, now) {
  const a = cutAdvice(st, now, opts, isSample ? 55.7 : loc.lat);
  const range = a.lo === a.hi ? `${mm(a.lo, a.lo % 1 ? 1 : 0)} cm` : `${mm(a.lo, a.lo % 1 ? 1 : 0)}–${mm(a.hi, a.hi % 1 ? 1 : 0)} cm`;
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
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
}
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function bladePath(x, base, w, h, lean) {
  const tx = x + lean, ty = base - h;
  return `M${(x - w / 2).toFixed(1)},${base} C${(x - w / 2).toFixed(1)},${(base - h * 0.5).toFixed(1)} ${(x + lean * 0.6 - 1).toFixed(1)},${(base - h * 0.82).toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)} ` +
         `C${(x + lean * 0.6 + 1).toFixed(1)},${(base - h * 0.82).toFixed(1)} ${(x + w / 2).toFixed(1)},${(base - h * 0.5).toFixed(1)} ${(x + w / 2).toFixed(1)},${base} Z`;
}
const GRASS_COL = {
  day:      ['#2e5d35', '#3d7a45', '#5e9f55'],
  overcast: ['#2e5a35', '#3b7343', '#57924f'],
  rain:     ['#2a5432', '#376c40', '#4f8a4b'],
  frost:    ['#6c877a', '#86a294', '#adc5b8'],
  dusk:     ['#22462b', '#2f5c3a', '#4b7f45'],
  night:    ['#0e1f15', '#163022', '#21422c'],
};
function drawScene(st, cur, Wnow, cap, now) {
  const svg = $('scene'); svg.textContent = '';
  const today = dayKey(now);
  const dayStamps = st.filter(s => dayKey(s.t) === today && s.isDay);
  const sunrise = dayStamps.length ? dayStamps[0].t - 18e5 : Date.parse(today + 'T07:00:00Z');
  const sunset = dayStamps.length ? dayStamps[dayStamps.length - 1].t + 18e5 : Date.parse(today + 'T18:00:00Z');
  const near = Math.min(Math.abs(now - sunrise), Math.abs(now - sunset)) < 36e5;
  const ccNow = cur ? (st.find(s => s.t >= now) || st[st.length - 1]).cc : 0.3;
  let phase;
  if (cur.dark) phase = near ? 'dusk' : 'night';
  else if (cur.status === 'rain') phase = 'rain';
  else if (cur.status === 'frost') phase = 'frost';
  else if (near) phase = 'dusk';
  else if (ccNow > 0.7) phase = 'overcast';
  else phase = 'day';
  $('hero').className = 'hero phase-' + phase;
  const R = rng(7);

  const defs = el('defs', {}, svg);
  const g = el('linearGradient', { id: 'skyGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0', class: 'sky-top' }, g);
  el('stop', { offset: '1', class: 'sky-bot' }, g);
  el('rect', { x: -200, y: -200, width: 800, height: 440, fill: 'url(#skyGrad)' }, svg);

  if (phase === 'night') {
    for (let i = 0; i < 26; i++) el('circle', { cx: (R() * 440 - 20).toFixed(1), cy: (R() * 110).toFixed(1), r: (0.5 + R() * 1.1).toFixed(2), fill: '#ffffff', class: R() > 0.5 ? 'twinkle' : '', opacity: (0.5 + R() * 0.5).toFixed(2) }, svg);
    el('path', { d: 'M318,22 A20,20 0 1,0 338,58 A16,16 0 1,1 318,22 Z', fill: '#f3efd9' }, svg);
  } else if (phase !== 'rain') {
    const f = clamp((now - sunrise) / (sunset - sunrise), 0, 1);
    const sx = 40 + f * 320, sy = 128 - Math.sin(f * Math.PI) * 92;
    const dim = phase === 'overcast' ? 0.45 : 1;
    el('circle', { cx: sx, cy: sy, r: 40, fill: '#fff3c4', opacity: (0.35 * dim).toFixed(2) }, svg);
    el('circle', { cx: sx, cy: sy, r: 19, fill: phase === 'dusk' ? '#ffc06b' : '#ffd95e', opacity: dim }, svg);
  }

  const nClouds = phase === 'rain' ? 4 : ccNow > 0.85 ? 4 : ccNow > 0.55 ? 3 : ccNow > 0.25 ? 2 : ccNow > 0.08 ? 1 : 0;
  const cloudCol = phase === 'night' ? '#3d4d63' : phase === 'rain' ? '#a9b4be' : phase === 'overcast' ? '#eef1f3' : phase === 'dusk' ? '#f4d6c0' : '#ffffff';
  const spots = [[70, 40], [250, 26], [170, 70], [345, 62]];
  for (let i = 0; i < nClouds; i++) {
    const [cx, cy] = spots[i], s = 0.8 + R() * 0.5;
    const cg = el('g', { fill: cloudCol, opacity: phase === 'rain' ? 0.95 : 0.88, transform: `translate(${cx} ${cy}) scale(${s.toFixed(2)})` }, svg);
    el('ellipse', { cx: 0, cy: 6, rx: 38, ry: 11 }, cg);
    el('circle', { cx: -14, cy: 0, r: 14 }, cg);
    el('circle', { cx: 6, cy: -6, r: 18 }, cg);
    el('circle', { cx: 24, cy: 2, r: 12 }, cg);
  }
  if (phase === 'rain') {
    const rg = el('g', { stroke: '#eef4fa', 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: 0.75 }, svg);
    for (let i = 0; i < 60; i++) {
      const x = R() * 420 - 10, y = R() * 160 - 20;
      const ln = el('line', { x1: x.toFixed(1), y1: y.toFixed(1), x2: (x - 3).toFixed(1), y2: (y + 11).toFixed(1), class: 'raindrop' }, rg);
      ln.style.animationDelay = (-R() * 0.9).toFixed(2) + 's';
      ln.style.animationDuration = (0.7 + R() * 0.4).toFixed(2) + 's';
    }
  }

  const [cGround, cBack, cFront] = GRASS_COL[phase];
  el('rect', { x: -200, y: 206, width: 800, height: 40, fill: cGround }, svg);
  const back = el('g', { class: 'sway slow', fill: cBack }, svg);
  for (let i = 0; i < 90; i++) {
    const x = -14 + i * 4.8 + R() * 3;
    el('path', { d: bladePath(x, 222, 5 + R() * 3, 34 + R() * 34, (R() - 0.5) * 22) }, back);
  }
  const front = el('g', { class: 'sway' }, svg);
  const tips = [];
  for (let i = 0; i < 70; i++) {
    const x = -10 + i * 6.1 + R() * 4, h = 40 + R() * 40, lean = (R() - 0.5) * 26;
    el('path', { d: bladePath(x, 224, 5 + R() * 3.5, h, lean), fill: cFront }, front);
    tips.push([x + lean, 224 - h]);
  }
  const wf = clamp(Wnow / cap, 0, 1);
  if (phase === 'frost') {
    for (const [tx, ty] of tips) el('path', { d: `M${(tx - 2.5).toFixed(1)},${(ty + 2).toFixed(1)} L${tx.toFixed(1)},${(ty - 1).toFixed(1)} L${(tx + 2.5).toFixed(1)},${(ty + 2).toFixed(1)}`, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: 0.9 }, front);
  } else if (Wnow > DRY_MM) {
    const n = Math.max(4, Math.round(wf * 34));
    const order = tips.map((t, i) => [rng(i + 11)(), t]).sort((a, b) => a[0] - b[0]).slice(0, n);
    for (const [, [tx, ty]] of order) {
      el('circle', { cx: tx.toFixed(1), cy: (ty + 2.6).toFixed(1), r: (1.9 + wf * 1.1).toFixed(2), fill: 'rgba(226,241,255,.92)', stroke: '#86b2dc', 'stroke-width': 0.7 }, front);
      el('circle', { cx: (tx - 0.7).toFixed(1), cy: (ty + 1.8).toFixed(1), r: 0.7, fill: '#ffffff' }, front);
    }
  }
}

function drawRuler(a) {
  const svg = $('ruler'); svg.textContent = '';
  const base = 166, cm = 14, x0 = 26;
  const yOf = c => base - c * cm;
  el('line', { x1: x0, y1: yOf(11), x2: x0, y2: base, class: 'tick', 'stroke-width': 1.2 }, svg);
  for (let c = 0; c <= 11; c++) {
    const long = c % 2 === 0;
    el('line', { x1: x0, y1: yOf(c), x2: x0 + (long ? 9 : 5), y2: yOf(c), class: 'tick', 'stroke-width': 1 }, svg);
    if (long) { const t = el('text', { x: x0 - 5, y: yOf(c) + 3.5, 'text-anchor': 'end' }, svg); t.textContent = String(c); }
  }
  const tcm = el('text', { x: x0 - 5, y: yOf(11) - 2, 'text-anchor': 'end' }, svg); tcm.textContent = 'cm';
  const len = { short: 4.2, normal: 7.5, long: 11 }[opts.grass] || 7.5;
  const cut = Math.min((a.lo + a.hi) / 2, len);
  const cutY = yOf(cut);
  const defs = el('defs', {}, svg);
  const cb = el('clipPath', { id: 'clipBelow' }, defs); el('rect', { x: 0, y: cutY, width: 128, height: base - cutY + 10 }, cb);
  const ca = el('clipPath', { id: 'clipAbove' }, defs); el('rect', { x: 0, y: 0, width: 128, height: cutY }, ca);
  const R = rng(3), blades = [];
  for (let i = 0; i < 11; i++) blades.push(bladePath(46 + i * 7 + R() * 2, base, 5 + R() * 2, len * cm * (0.86 + R() * 0.2), (R() - 0.5) * 10));
  const above = el('g', { 'clip-path': 'url(#clipAbove)', class: 'blade-top' }, svg);
  const below = el('g', { 'clip-path': 'url(#clipBelow)', class: 'blade' }, svg);
  for (const d of blades) { el('path', { d }, above); el('path', { d }, below); }
  el('line', { x1: x0, y1: cutY, x2: 126, y2: cutY, class: 'cutline', 'stroke-width': 1.4, 'stroke-dasharray': '4 3' }, svg);
  const lab = el('text', { x: 126, y: cutY - 5, 'text-anchor': 'end', class: 'cutlabel' }, svg);
  lab.textContent = a.mode === 'rest' ? 'hvile' : `klip her`;
}

function drawChart() {
  if (!model || model.now === undefined) return;
  const { blocks, st, cap, now } = model;
  const svg = $('chart'); svg.textContent = '';
  const W = Math.max(280, Math.round($('chartWrap').clientWidth || 680)), H = 190;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const L = 34, Rm = 6, T = 26, B = H - 34, stripY = H - 26;
  const t0 = Date.parse(dayKey(now) + 'T00:00:00Z');
  const t1 = blocks[blocks.length - 1].end;
  const X = t => L + (t - t0) / (t1 - t0) * (W - L - Rm);
  const Y = w => B - clamp(w / cap, 0, 1) * (B - T);
  const pxH = (W - L - Rm) / ((t1 - t0) / 36e5);

  // nat
  let ns = null;
  const inRange = blocks.filter(b => b.start >= t0);
  inRange.forEach((b, i) => {
    if (b.dark && ns === null) ns = b.start;
    const endRun = ns !== null && (!b.dark || i === inRange.length - 1);
    if (endRun) { const e = b.dark ? b.end : b.start; el('rect', { x: X(ns).toFixed(1), y: T - 8, width: (X(e) - X(ns)).toFixed(1), height: B - T + 8, class: 'night' }, svg); ns = null; }
  });
  // gitter, dage
  el('line', { x1: L, y1: B, x2: W - Rm, y2: B, class: 'grid' }, svg);
  el('line', { x1: L, y1: T, x2: W - Rm, y2: T, class: 'grid', 'stroke-dasharray': '2 4' }, svg);
  const y0 = el('text', { x: L - 6, y: B + 4, 'text-anchor': 'end' }, svg); y0.textContent = '0';
  const y1 = el('text', { x: L - 6, y: T + 4, 'text-anchor': 'end' }, svg); y1.textContent = mm(cap, 1);
  const yu = el('text', { x: L - 6, y: T - 10, 'text-anchor': 'end' }, svg); yu.textContent = 'mm';
  const pxDay = pxH * 24;
  for (let d = t0; d < t1; d += 864e5) {
    if (d > t0) el('line', { x1: X(d), y1: T - 12, x2: X(d), y2: stripY + 6, class: 'grid' }, svg);
    const nm = dayName(d, now);
    const dd = new Date(d);
    const txt = pxDay < 95 ? (nm === 'i dag' ? 'I dag' : DAYS[dd.getUTCDay()].replace(/^./, c => c.toUpperCase())) : nm.replace(/^./, c => c.toUpperCase());
    const t = el('text', { x: X(d) + 4, y: T - 13, class: 'daylbl' }, svg); t.textContent = txt;
    for (const hh of pxDay >= 150 ? [6, 12, 18] : [12]) {
      const ht = el('text', { x: X(d + hh * 36e5), y: H - 6, 'text-anchor': 'middle' }, svg); ht.textContent = pad(hh);
    }
  }
  // regn
  for (const s of st) {
    if (s.t <= t0 || s.t > t1 || s.P < 0.05) continue;
    const hgt = Math.min(1, s.P / 3) * (B - T) * 0.6 + 2;
    el('rect', { x: (X(s.t - 36e5) + 0.5).toFixed(1), y: T, width: Math.max(1, pxH - 1).toFixed(1), height: hgt.toFixed(1), class: 'rainbar', rx: 1 }, svg);
  }
  // vand
  const pts = st.filter(s => s.t >= t0 && s.t <= t1);
  if (pts.length > 1) {
    let d = `M${X(pts[0].t).toFixed(1)},${B} `;
    for (const s of pts) d += `L${X(s.t).toFixed(1)},${Y(s.W).toFixed(1)} `;
    d += `L${X(pts[pts.length - 1].t).toFixed(1)},${B} Z`;
    el('path', { d, class: 'water', 'stroke-linejoin': 'round' }, svg);
  }
  // tørre vinduer
  for (const b of inRange) if (b.mowable) el('rect', { x: X(b.start).toFixed(1), y: stripY, width: Math.max(1, X(b.end) - X(b.start) + 0.3).toFixed(1), height: 7, class: 'drywin' }, svg);
  for (const b of inRange) if (b.status === 'frost' && !b.dark) el('rect', { x: X(b.start).toFixed(1), y: stripY, width: Math.max(1, X(b.end) - X(b.start) + 0.3).toFixed(1), height: 7, class: 'frostwin' }, svg);
  // nu
  if (now >= t0 && now <= t1) {
    el('line', { x1: X(now), y1: T - 4, x2: X(now), y2: stripY + 7, class: 'nowline' }, svg);
    const nl = el('text', { x: X(now) + 4, y: T + 9, class: 'nowlbl' }, svg); nl.textContent = 'nu';
  }
  const cursor = el('line', { x1: 0, y1: T - 4, x2: 0, y2: stripY + 7, class: 'cursor', visibility: 'hidden' }, svg);
  const pick = ev => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * W;
    const t = t0 + (x - L) / (W - L - Rm) * (t1 - t0);
    const b = inRange.find(q => q.start <= t && t < q.end);
    if (!b) return;
    cursor.setAttribute('x1', X(b.start + 18e5)); cursor.setAttribute('x2', X(b.start + 18e5)); cursor.setAttribute('visibility', 'visible');
    selectBlock(b);
  };
  svg.onpointerdown = ev => { svg._down = true; pick(ev); };
  svg.onpointermove = ev => { if (svg._down || ev.pointerType === 'mouse') pick(ev); };
  svg.onpointerup = svg.onpointercancel = svg.onpointerleave = () => { svg._down = false; };
  if (selected !== null) { const b = inRange.find(q => q.start === selected); if (b) { cursor.setAttribute('x1', X(b.start + 18e5)); cursor.setAttribute('x2', X(b.start + 18e5)); cursor.setAttribute('visibility', 'visible'); } }
}
function selectBlock(b) {
  if (selected === b.start) return;
  selected = b.start;
  showDetail(b, model.now);
  document.querySelectorAll('.cell.sel').forEach(x => x.classList.remove('sel'));
  const c = document.querySelector(`.cell[data-t="${b.start}"]`); if (c) c.classList.add('sel');
}
if (window.ResizeObserver) { let lastW = 0; new ResizeObserver(es => { const w = Math.round(es[0].contentRect.width); if (w && w !== lastW) { lastW = w; drawChart(); } }).observe($('chartWrap')); }

function renderDays(blocks, now, ci) {
  const wrap = $('days'); wrap.innerHTML = '';
  const todayKey = dayKey(now);
  const byDay = new Map();
  blocks.forEach((b, i) => { const k = dayKey(b.start); if (k < todayKey) return; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(i); });
  for (const [k, idxs] of byDay) {
    if (idxs.length < 12) continue;
    const row = document.createElement('div'); row.className = 'day';
    const t0 = blocks[idxs[0]].start, dd = new Date(t0);
    const lbl = document.createElement('div'); lbl.className = 'day-lbl';
    const nm = dayName(t0, now), rel = nm === 'i dag' || nm === 'i morgen';
    const big = rel ? nm.charAt(0).toUpperCase() + nm.slice(1) : DAYS_FULL[dd.getUTCDay()];
    lbl.innerHTML = `${big}<small>${rel ? DAYS[dd.getUTCDay()] + ' ' : ''}${dd.getUTCDate()}. ${MONTHS[dd.getUTCMonth()]}</small>`;
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
      const m = document.createElement('div'); m.className = 'now';
      const dayStart = Date.parse(k + 'T00:00:00Z');
      m.style.left = `calc(${(now - dayStart) / 864e5 * 100}% - 1px)`;
      strip.append(m);
    }
    const winTxt = document.createElement('p'); winTxt.className = 'day-win';
    const dayStartIdx = idxs[0];
    const wins = findWindows(blocks.slice(dayStartIdx, idxs[idxs.length - 1] + 1), 0, 0, opts.dur)
      .map(w => ({ ...w, start: Math.max(w.start, k === todayKey ? Math.min(w.end, now) : w.start) }))
      .filter(w => (w.end - w.start) / 60000 >= opts.dur);
    winTxt.innerHTML = wins.length ? 'Tørt ' + wins.map(w => `<b>${hhmm(w.start)}–${hhmm(w.end) === '00:00' ? '24:00' : hhmm(w.end)}</b>`).join(', ')
      : (k === todayKey ? 'Ikke flere tørre vinduer i dag' : 'Intet tørt vindue');
    row.append(lbl, strip, winTxt);
    wrap.append(row);
  }
  if (selected === null && blocks[ci]) showDetail(blocks[ci], now);
  else { const b = blocks.find(x => x.start === selected); if (b) showDetail(b, now); }
}

function showDetail(b, now) {
  const end = hhmm(b.end) === '00:00' ? '24' : hhmm(b.end).slice(0, 2);
  $('detail').innerHTML = '';
  const top = document.createElement('div');
  top.innerHTML = `<b>${dayName(b.start, now).replace(/^./, c => c.toUpperCase())} kl. ${hhmm(b.start).slice(0, 2)}–${end}</b> · ${LABEL[b.status]}${b.dark ? ' (mørkt)' : ''}`;
  const facts = document.createElement('div'); facts.className = 'num';
  facts.textContent = `vand ${mm(b.W)} mm · ${mm(b.T, 1)} °C · fugt ${Math.round(b.RH)} % · vind ${mm(b.u10, 1)} m/s · regn ${mm(b.P, 1)} mm` + (b.prob !== null && b.prob !== undefined ? ` (${b.prob} %)` : '');
  const why = document.createElement('div'); why.textContent = reasonFor(b, model.cap);
  $('detail').append(top, why, facts);
}

/* ---------- data ---------- */
const HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,shortwave_radiation,cloud_cover,is_day,et0_fao_evapotranspiration';
async function load() {
  $('banner').hidden = true;
  $('locName').textContent = loc.name;
  $('eyebrow').textContent = `Henter vejrudsigt for ${loc.name}…`;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(2)}&longitude=${loc.lon.toFixed(2)}&hourly=${HOURLY}&wind_speed_unit=ms&timezone=auto&past_days=7&forecast_days=4`;
  let j;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
    if (!j.hourly || !j.hourly.time) throw new Error('uventet svar fra vejrtjenesten');
  } catch (e) {
    const t0 = new Date(); t0.setUTCHours(0, 0, 0, 0);
    data = sampleData(t0.getTime() - 2 * 864e5); isSample = true; selected = null;
    const opened = location.protocol === 'https:' || location.protocol === 'http:' ? location.host : location.protocol.replace(':', '');
    $('bannerText').textContent = `Vejrudsigten kunne ikke hentes, så du ser eksempeldata, ikke din plæne. Browseren afviste forespørgslen (${e.message || e}; siden er åbnet fra ${opened || 'ukendt'}). Telefoner tillader ofte ikke, at en lokal fil henter data fra nettet. Åbn siden fra en webadresse eller fra en computer.`;
    $('banner').hidden = false;
    $('updated').textContent = '';
    run();
    return;
  }
  data = j; data._fetched = Date.now(); isSample = false; selected = null;
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
  $('locHint').textContent = 'Søger…'; $('results').innerHTML = '';
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=da&format=json`);
    const j = await r.json();
    const res = j.results || [];
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
  $('results').innerHTML = ''; $('locHint').textContent = ''; $('searchInput').value = '';
  load();
}
$('retryBtn').addEventListener('click', load);

/* ---------- indstillinger ---------- */
for (const [name, val] of [['site', opts.site], ['grass', opts.grass], ['dur', String(opts.dur)]]) {
  const el = document.querySelector(`input[name="${name}"][value="${val}"]`); if (el) el.checked = true;
  document.querySelectorAll(`input[name="${name}"]`).forEach(inp => inp.addEventListener('change', () => {
    opts[name] = name === 'dur' ? +inp.value : inp.value; store.set('opts', opts); run();
  }));
}

load();
setInterval(() => { if (model && !isSample) render(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && data && !isSample && Date.now() - (data._fetched || 0) > 3 * 36e5) load(); });
