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
  const lat = Number(l && l.lat), lon = Number(l && l.lon);
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
  const k = dayKey(t), today = dayKey(ref), tom = dayKey(ref + 864e5);
  if (k === today) return 'i dag';
  if (k === tom) return 'i morgen';
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
  model = { blocks, cap: sim.cap };
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
}

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
      c.className = `cell st-${b.status}` + (b.dark ? ' dark' : '') + (b.end <= now ? ' past' : '') + (selected === b.start ? ' sel' : '');
      c.setAttribute('aria-label', `${hhmm(b.start)}: ${LABEL[b.status]}${b.dark ? ', mørkt' : ''}`);
      if (b.P > 0.05) { const r = document.createElement('span'); r.className = 'rain'; r.style.height = Math.min(100, 25 + b.P / 3 * 75) + '%'; c.append(r); }
      c.addEventListener('click', () => { selected = b.start; showDetail(b, now); wrap.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); c.classList.add('sel'); });
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
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(2)}&longitude=${loc.lon.toFixed(2)}&hourly=${HOURLY}&wind_speed_unit=ms&timezone=auto&past_days=2&forecast_days=4`;
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
