'use strict';

// ---------- Config ----------

const MODES = {
  walk: { radius: 300, minLength: 2500, refreshMeters: 80, cooldownAfterNo: 30e3, cooldownAfterStory: 20e3 },
  drive: { radius: 10000, minLength: 8000, refreshMeters: 1500, cooldownAfterNo: 90e3, cooldownAfterStory: 60e3 },
};
const DRIVE_SPEED_KMH = 20;
const REFRESH_MAX_AGE = 60e3;
const SEEN_TTL_DAYS = 30;
const CHUNK_CHARS = 700;

// Sections that are lists of links, not content.
const SKIP_SECTIONS = /^(see also|references|external links|notes|further reading|bibliography|sources|gallery|citations|footnotes|siehe auch|einzelnachweise|weblinks|literatur|anmerkungen|quellen|galerie|belege)$/i;
// Wikidata descriptions that are rarely worth interrupting someone for.
const BORING = /\b(station|stop|street|road|avenue|square|school|hotel|company|bank|shop|store|supermarket|restaurant|office|bahnhof|haltestelle|straße|strasse|platz|schule|unternehmen|geschäft)\b/i;

const T = {
  en: {
    locale: 'en-US',
    lookingAround: 'Looking around…',
    nothing: 'Nothing notable right here yet. I will keep looking.',
    ask: (where, name, desc) => `${where}: ${name}${desc ? ', ' + desc : ''}. Want to hear about it?`,
    more: 'Want more detail?',
    end: "That's all I have on this one.",
    hello: 'Wayside is on. I will tell you when there is something interesting nearby.',
    paused: 'Paused',
    resume: 'Resume',
    pause: 'Pause',
    ahead: 'ahead', left: 'on your left', right: 'on your right', behind: 'behind you',
    m: (n) => `${n} metres`, km: (n) => `${n} kilometres`,
    nearbyAt: (d, dir) => dir ? `About ${d} ${dir}` : `About ${d} away`,
    yes: /\b(yes|yeah|yep|yup|sure|ok|okay|please|go( on| ahead)?|more|tell me|why not)\b/i,
    no: /\b(no|nope|nah|skip|next|enough|stop|not now|later)\b/i,
    noGps: 'Location is not available. Please allow location access for this site.',
  },
  de: {
    locale: 'de-DE',
    lookingAround: 'Ich schaue mich um…',
    nothing: 'Hier gibt es gerade nichts Besonderes. Ich suche weiter.',
    ask: (where, name, desc) => `${where}: ${name}${desc ? ', ' + desc : ''}. Möchtest du mehr darüber hören?`,
    more: 'Möchtest du mehr Details?',
    end: 'Mehr habe ich dazu nicht.',
    hello: 'Wayside ist aktiv. Ich sage Bescheid, wenn es in der Nähe etwas Interessantes gibt.',
    paused: 'Pausiert',
    resume: 'Weiter',
    pause: 'Pause',
    ahead: 'vor dir', left: 'links von dir', right: 'rechts von dir', behind: 'hinter dir',
    m: (n) => `${n} Meter`, km: (n) => `${n} Kilometer`,
    nearbyAt: (d, dir) => dir ? `Etwa ${d} ${dir}` : `Etwa ${d} entfernt`,
    yes: /\b(ja|jawohl|gerne|gern|klar|okay|ok|los|mehr|erzähl|bitte|jo|sicher)\b/i,
    no: /\b(nein|nee|nö|nicht|weiter|nächste|genug|stopp|stop|später)\b/i,
    noGps: 'Standort nicht verfügbar. Bitte erlaube den Standortzugriff für diese Seite.',
  },
};

// ---------- State ----------

const state = {
  lang: load('lang', 'en'),
  voiceIn: load('voiceIn', true),
  running: false,
  paused: false,
  busy: false,            // asking or telling
  pos: null,              // {lat, lon, accuracy, speedKmh, heading, t}
  fixes: [],
  candidates: [],
  lastFetch: null,        // {lat, lon, t, mode}
  fetching: false,
  nextPromptAt: 0,
  seen: load('seen', {}), // pageid -> timestamp
  answer: null,           // resolver for the pending yes/no
  wakeLock: null,
  sim: parseSim(),
};
const t = () => T[state.lang];

// ---------- Helpers ----------

function load(key, fallback) {
  try { const v = localStorage.getItem('wayside.' + key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem('wayside.' + key, JSON.stringify(value)); } catch { /* private mode */ }
}
const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle('hidden', !on);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rad = (d) => d * Math.PI / 180;

function distance(a, b) {
  const R = 6371000;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Signed angle from heading to target, -180..180.
const relAngle = (heading, target) => ((target - heading + 540) % 360) - 180;

function mode() {
  return state.pos && state.pos.speedKmh >= DRIVE_SPEED_KMH ? 'drive' : 'walk';
}
function directionWord(c) {
  if (state.pos?.heading == null) return '';
  const a = relAngle(state.pos.heading, c.bearing);
  if (Math.abs(a) <= 35) return t().ahead;
  if (Math.abs(a) >= 135) return t().behind;
  return a < 0 ? t().left : t().right;
}
function distanceWords(m) {
  if (m < 1000) return t().m(Math.max(10, Math.round(m / 10) * 10));
  return t().km(m < 10000 ? (Math.round(m / 500) / 2).toLocaleString(t().locale) : Math.round(m / 1000));
}
function sentences(text) {
  return (text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)(?:\s+|$)/g) || [text]).map((s) => s.trim()).filter(Boolean);
}
function parseSim() {
  // ?sim=lat,lon[,headingDeg,speedKmh] for testing at a desk.
  const p = new URLSearchParams(location.search).get('sim');
  if (!p) return null;
  const [lat, lon, heading = 0, speed = 0] = p.split(',').map(Number);
  return { lat, lon, heading, speed };
}

// ---------- Wikipedia ----------

const api = (params) => {
  const url = `https://${state.lang}.wikipedia.org/w/api.php?` +
    new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  return fetch(url).then((r) => { if (!r.ok) throw new Error('Wikipedia ' + r.status); return r.json(); });
};

async function fetchCandidates() {
  const m = mode();
  const here = state.pos;
  const data = await api({
    action: 'query',
    generator: 'geosearch',
    ggscoord: `${here.lat}|${here.lon}`,
    ggsradius: String(MODES[m].radius),
    ggslimit: '50',
    prop: 'info|description|pageimages|coordinates',
    piprop: 'thumbnail',
    pithumbsize: '640',
    pilimit: '50',
    colimit: 'max',
  });
  const pages = data.query?.pages || [];
  state.candidates = pages
    .filter((p) => p.coordinates?.length)
    .map((p) => ({
      id: p.pageid,
      title: p.title,
      desc: p.description || '',
      length: p.length || 0,
      thumb: p.thumbnail?.source || null,
      lat: p.coordinates[0].lat,
      lon: p.coordinates[0].lon,
    }));
  state.lastFetch = { lat: here.lat, lon: here.lon, t: Date.now(), mode: m };
}

// Splits an article into speakable levels: a teaser, the rest of the intro, then each content section.
async function fetchStory(title) {
  const data = await api({
    action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title,
  });
  const text = data.query?.pages?.[0]?.extract || '';
  const parts = text.split(/\n*^==+\s*(.+?)\s*==+\s*$\n*/m);
  const intro = sentences(parts[0].replace(/\s+/g, ' '));
  const levels = [];
  levels.push(intro.slice(0, 2).join(' '));
  if (intro.length > 2) levels.push(intro.slice(2).join(' '));
  for (let i = 1; i < parts.length; i += 2) {
    if (SKIP_SECTIONS.test(parts[i])) continue;
    const body = (parts[i + 1] || '').trim();
    if (body.length < 80) continue;
    let chunk = '';
    for (const para of body.split(/\n+/)) {
      if (chunk && chunk.length + para.length > CHUNK_CHARS) { levels.push(chunk); chunk = ''; }
      chunk += (chunk ? ' ' : '') + para;
    }
    if (chunk) levels.push(chunk);
  }
  return levels.filter((l) => l.trim().length > 0);
}

// ---------- Ranking ----------

function scored() {
  const m = mode();
  const here = state.pos;
  const now = Date.now();
  const ttl = SEEN_TTL_DAYS * 864e5;
  return state.candidates
    .map((c) => {
      const d = distance(here, c);
      const b = bearing(here, c);
      let score = Math.log10(Math.max(c.length, 1)) * 2;
      if (BORING.test(c.desc)) score -= 3;
      if (m === 'walk') {
        score -= d / 100;
      } else {
        score -= d / 4000;
        if (here.heading != null) {
          const a = Math.abs(relAngle(here.heading, b));
          if (a < 60) score += 1.5;
          else if (a > 120) score -= 4; // already passed it
        }
      }
      const seen = state.seen[c.id] && now - state.seen[c.id] < ttl;
      return { ...c, distance: d, bearing: b, score, seen };
    })
    .sort((a, b) => b.score - a.score);
}

function pickNext(force) {
  const min = MODES[mode()].minLength;
  return scored().find((c) => !c.seen && (force || c.length >= min)) || null;
}

// ---------- Speech ----------

let voices = [];
function loadVoices() { voices = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function pickVoice() {
  const loc = t().locale, base = state.lang;
  return voices.find((v) => v.lang === loc && /enhanced|premium|natural|google/i.test(v.name)) ||
    voices.find((v) => v.lang === loc) || voices.find((v) => v.lang.startsWith(base)) || null;
}

let speechToken = 0;
// Speaks sentence by sentence: long utterances get cut off in some browsers, and it lets Pause stop quickly.
async function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const token = ++speechToken;
  for (const s of sentences(text)) {
    if (token !== speechToken) return;
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(s);
      u.lang = t().locale;
      const v = pickVoice();
      if (v) u.voice = v;
      // Some browsers occasionally never fire onend; don't let that freeze the app.
      const guard = setTimeout(resolve, 4000 + s.length * 90);
      u.onend = u.onerror = () => { clearTimeout(guard); resolve(); };
      speechSynthesis.speak(u);
    });
  }
}
function stopSpeaking() {
  speechToken++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;

function listen(ms = 7000) {
  if (!state.voiceIn || !Recognition) return null;
  return new Promise((resolve) => {
    const r = new Recognition();
    recognizer = r;
    r.lang = t().locale;
    r.interimResults = false;
    r.maxAlternatives = 3;
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); show($('listening'), false); try { r.stop(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish(null), ms);
    r.onresult = (e) => {
      const heard = Array.from(e.results[0]).map((a) => a.transcript).join(' ');
      if (t().no.test(heard)) finish('no');
      else if (t().yes.test(heard)) finish('yes');
      else finish(null);
    };
    r.onerror = r.onend = () => finish(null);
    show($('listening'), true);
    try { r.start(); } catch { finish(null); }
  });
}

// Resolves with 'yes' | 'no' | null from whichever comes first: a button tap or a spoken answer.
async function waitForAnswer(buttonsId) {
  show($(buttonsId), true);
  const tap = new Promise((resolve) => { state.answer = resolve; });
  const voice = listen();
  const timeout = sleep(voice ? 20000 : 15000).then(() => null);
  const result = await Promise.race([tap, voice ? voice.then((v) => v || tap) : tap, timeout]);
  state.answer = null;
  if (recognizer) { try { recognizer.abort(); } catch {} recognizer = null; }
  show($('listening'), false);
  show($(buttonsId), false);
  return result;
}

function answer(value) {
  if (state.answer) state.answer(value);
}

// ---------- Flow ----------

async function offer(c) {
  state.busy = true;
  state.seen[c.id] = Date.now();
  save('seen', state.seen);
  const dir = directionWord(c);
  const where = t().nearbyAt(distanceWords(c.distance), dir);
  const question = t().ask(where, c.title, c.desc);
  $('prompt-title').textContent = c.title;
  $('prompt-sub').textContent = [c.desc, where].filter(Boolean).join(' · ');
  $('text').textContent = '';
  $('thumb').src = c.thumb || '';
  show($('thumb'), !!c.thumb);
  renderNearby();

  await speak(question);
  if (!state.running || state.paused) return endOffer('no');
  const first = await waitForAnswer('buttons');
  logAnswer(c, 'offer', first);
  if (first !== 'yes') return endOffer('no');

  let levels;
  try { levels = await fetchStory(c.title); } catch { levels = []; }
  if (!levels.length) levels = [c.desc || c.title];

  for (let i = 0; i < levels.length; i++) {
    if (!state.running || state.paused) break;
    $('text').textContent += (i ? '\n\n' : '') + levels[i];
    await speak(levels[i]);
    if (i === levels.length - 1) { await speak(t().end); break; }
    if (!state.running || state.paused) break;
    await speak(t().more);
    const more = await waitForAnswer('more-buttons');
    logAnswer(c, 'more' + (i + 1), more);
    if (more !== 'yes') break;
  }
  endOffer('story');
}

function endOffer(kind) {
  const cfg = MODES[mode()];
  state.nextPromptAt = Date.now() + (kind === 'story' ? cfg.cooldownAfterStory : cfg.cooldownAfterNo);
  state.busy = false;
  // Keep a finished story on screen to read; clear a declined offer.
  if (kind !== 'story' && state.running && !state.paused) {
    $('prompt-title').textContent = t().lookingAround;
    $('prompt-sub').textContent = '';
    $('text').textContent = '';
    show($('thumb'), false);
  }
}

// Kept locally for now; this is the signal that later personalises what gets offered.
function logAnswer(c, step, value) {
  const log = load('log', []);
  log.push({ id: c.id, title: c.title, desc: c.desc, step, value, mode: mode(), t: Date.now() });
  save('log', log.slice(-500));
}

async function tick(force = false) {
  if (!state.running || state.paused || state.busy || !state.pos) return;
  const m = mode();
  const lf = state.lastFetch;
  const stale = !lf || lf.mode !== m || Date.now() - lf.t > REFRESH_MAX_AGE ||
    distance(lf, state.pos) > MODES[m].refreshMeters;
  if ((stale || force) && !state.fetching) {
    state.fetching = true;
    try { await fetchCandidates(); renderNearby(); } catch (e) { console.warn(e); }
    finally { state.fetching = false; }
  }
  if (!force && Date.now() < state.nextPromptAt) return;
  const next = pickNext(force);
  if (next) offer(next);
  else if (force) { $('prompt-title').textContent = t().nothing; speak(t().nothing); }
}

// ---------- Location ----------

function onFix(lat, lon, accuracy, rawSpeed, rawHeading) {
  const now = Date.now();
  const prev = state.fixes[state.fixes.length - 1];
  state.fixes.push({ lat, lon, t: now });
  state.fixes = state.fixes.filter((f) => now - f.t < 30e3);

  // Prefer the device's speed and heading; fall back to the last ~30 s of fixes.
  let speedKmh = rawSpeed != null && !Number.isNaN(rawSpeed) ? rawSpeed * 3.6 : null;
  let heading = rawHeading != null && !Number.isNaN(rawHeading) ? rawHeading : null;
  const oldest = state.fixes[0];
  if (oldest && now - oldest.t > 3000) {
    const d = distance(oldest, { lat, lon });
    if (speedKmh == null) speedKmh = d / ((now - oldest.t) / 1000) * 3.6;
    if (heading == null && d > 15) heading = bearing(oldest, { lat, lon });
  }
  if (heading == null && state.pos && speedKmh > 2) heading = state.pos.heading;

  state.pos = { lat, lon, accuracy, speedKmh: speedKmh || 0, heading, t: now };
  $('gps').textContent = `±${Math.round(accuracy)} m · ${Math.round(state.pos.speedKmh)} km/h`;
  $('mode').textContent = mode() === 'drive' ? '🚗 Drive' : '🚶 Walk';
  if (!prev) tick();
}

let watchId = null;
function startLocation() {
  if (state.sim) {
    const s = { ...state.sim };
    const step = () => {
      if (s.speed) {
        const d = s.speed / 3.6 * 2; // metres per 2 s
        s.lat += (d * Math.cos(rad(s.heading))) / 111320;
        s.lon += (d * Math.sin(rad(s.heading))) / (111320 * Math.cos(rad(s.lat)));
      }
      onFix(s.lat, s.lon, 5, s.speed / 3.6, s.speed ? s.heading : null);
    };
    step();
    watchId = setInterval(step, 2000);
    return;
  }
  if (!('geolocation' in navigator)) { $('prompt-title').textContent = t().noGps; return; }
  watchId = navigator.geolocation.watchPosition(
    (p) => onFix(p.coords.latitude, p.coords.longitude, p.coords.accuracy, p.coords.speed, p.coords.heading),
    () => { $('prompt-title').textContent = t().noGps; $('gps').textContent = 'no GPS'; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
}

async function keepAwake() {
  try { if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not critical */ }
}

// ---------- UI ----------

function renderNearby() {
  if (!state.pos || !state.candidates.length) return;
  show($('nearby-wrap'), true);
  $('nearby').innerHTML = '';
  for (const c of scored().slice(0, 8)) {
    const li = document.createElement('li');
    if (c.seen) li.className = 'told';
    const a = document.createElement('a');
    a.href = `https://${state.lang}.wikipedia.org/wiki/${encodeURIComponent(c.title.replace(/ /g, '_'))}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = c.title;
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = ` · ${distanceWords(c.distance)}${c.desc ? ' · ' + c.desc : ''}`;
    li.append(a, d);
    $('nearby').append(li);
  }
}

$('lang').value = state.lang;
$('voice-in').checked = state.voiceIn;
if (!Recognition) { $('voice-in').checked = false; $('voice-in').disabled = true; state.voiceIn = false; }

$('start').onclick = () => {
  state.lang = $('lang').value;
  state.voiceIn = $('voice-in').checked;
  save('lang', state.lang);
  save('voiceIn', state.voiceIn);
  document.documentElement.lang = state.lang;
  show($('start-screen'), false);
  show($('live'), true);
  $('prompt-title').textContent = t().lookingAround;
  $('stop').textContent = t().pause;
  state.running = true;
  speak(t().hello); // also unlocks audio on iOS, which needs a tap before the first utterance
  keepAwake();
  startLocation();
  setInterval(tick, 5000);
};
$('yes').onclick = () => answer('yes');
$('no').onclick = () => answer('no');
$('more').onclick = () => answer('yes');
$('done').onclick = () => answer('no');
$('ask-now').onclick = () => {
  if (state.paused) togglePause();
  if (state.busy) return;
  tick(true);
};
$('stop').onclick = togglePause;

function togglePause() {
  state.paused = !state.paused;
  $('stop').textContent = state.paused ? t().resume : t().pause;
  if (state.paused) {
    stopSpeaking();
    answer('no');
    $('prompt-title').textContent = t().paused;
  } else {
    $('prompt-title').textContent = t().lookingAround;
    state.nextPromptAt = 0;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) keepAwake();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
