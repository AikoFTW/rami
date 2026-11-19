'use strict';
// Rami server. Node.js 18+. Storage: MongoDB (MONGODB_URI) or a local JSON file.
//   node server.js                     start the site (PORT, default 3333)
//   node server.js add-user <name>     create a login from the command line (optional)
//   node server.js passwd <name>       change a password
//   node server.js list-users
// Reads a .env file next to this one if there is one (Node 20.12+). Real environment variables win.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch {}

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const game = require('./game');
const { openStore, summary, mongoUri } = require('./store');
const webpush = require('./webpush');

const PORT = +process.env.PORT || 3333;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_USERS = +process.env.MAX_USERS || 2;       // sign-up closes once this many accounts exist
const PUBLIC = path.join(__dirname, 'public');
const SESSION_DAYS = 60;

const store = openStore();
let db;   // in-memory state, loaded from the store at start

// Writes go through one queue so they reach the database in order.
let queue = Promise.resolve();
function persist(fn) {
  queue = queue.then(fn).catch(e => console.error('Database write failed:', e.message));
  return queue;
}

// ---------- passwords & sessions ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  const h = crypto.scryptSync(pw, user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
}
const findUser = name => Object.values(db.users).find(u => u.name.toLowerCase() === String(name).trim().toLowerCase());
const validName = n => typeof n === 'string' && /^[\p{L}\p{N}_ .-]{2,24}$/u.test(n.trim());

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req).rami_sid;
  const s = sid && db.sessions[sid];
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.uid] || null;
}
const isHttps = req => process.env.SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https';
function startSession(req, res, u) {
  const sid = crypto.randomBytes(32).toString('hex');
  const s = { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 };
  db.sessions[sid] = s;
  persist(() => store.saveSession(sid, s));
  res.setHeader('Set-Cookie', `rami_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}

// login throttle: 10 tries per 15 minutes per address
const attempts = new Map();
function throttled(ip) {
  const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(ip, list);
  return list.length >= 10;
}

// ---------- live updates (Server-Sent Events) ----------
const streams = new Set();
let version = 0;
function broadcast() {
  version++;
  for (const res of streams) res.write(`event: update\ndata: ${version}\n\n`);
}
setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25e3).unref();

// ---------- notifications ----------
let vapid = null;   // { publicKey, privateKey, subject }, kept in the database so subscriptions stay valid
async function loadVapid() {
  let keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } : await store.getSetting('vapid');
  if (!keys) { keys = webpush.generateVapidKeys(); await store.saveSetting('vapid', keys); }
  vapid = { ...keys, subject: process.env.VAPID_SUBJECT || null };
}
const PUSH_TEXT = {
  en: { turn: 'Your turn', threw: '{name} threw {card}.', newGame: 'New game', dealt: '{name} dealt a new game. You start!', dealtWait: '{name} dealt a new game.',
        lost: '{name} got Rami!', lostBody: 'Tap to see their hand.', won: 'You win!', resigned: '{name} resigned.', test: 'Notifications are on', testBody: "You'll hear from Rami when it's your turn." },
  fr: { turn: 'À vous de jouer', threw: '{name} a jeté {card}.', newGame: 'Nouvelle partie', dealt: '{name} a distribué. Vous commencez !', dealtWait: '{name} a distribué une nouvelle partie.',
        lost: '{name} a fait Rami !', lostBody: 'Touchez pour voir sa main.', won: 'Vous gagnez !', resigned: '{name} a abandonné.', test: 'Notifications activées', testBody: 'Rami vous préviendra quand ce sera votre tour.' },
  ar: { turn: 'دورك', threw: '{name} رمى {card}.', newGame: 'لعبة جديدة', dealt: '{name} وزّع لعبة جديدة. أنت تبدأ!', dealtWait: '{name} وزّع لعبة جديدة.',
        lost: '{name} أعلن رامي!', lostBody: 'اضغط لترى أوراقه.', won: 'لقد فزت!', resigned: '{name} انسحب.', test: 'الإشعارات مفعّلة', testBody: 'سيخبرك رامي عندما يحين دورك.' },
};
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const cardText = id => id[0] === 'J' ? 'Joker' : ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[id.split('-')[0]] || id.split('-')[0]) + SUIT_SYM[id.split('-')[1]];
function pushText(u, key, vars = {}) {
  const lang = PUSH_TEXT[u.prefs?.lang] ? u.prefs.lang : 'en';
  return (PUSH_TEXT[lang][key] || PUSH_TEXT.en[key]).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
// who is looking at the game right now (an open page that is in front)
const looking = new Map();   // uid -> Set of visible page ids
const isLooking = uid => (looking.get(uid)?.size || 0) > 0;
async function notify(uid, { title, body, tag = 'rami', force = false }) {
  const u = db.users[uid];
  if (!u || !vapid || !(u.pushSubs || []).length) return;
  if (!force && isLooking(uid)) return;           // they're already watching the table
  const payload = { title, body, tag, url: '/#play' };
  let changed = false;
  for (const sub of [...u.pushSubs]) {
    try {
      const subject = vapid.subject || sub.origin || 'mailto:rami@example.com';
      const r = await webpush.send(sub, payload, { ...vapid, subject }, { topic: tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) });
      if (r.status === 404 || r.status === 410) { u.pushSubs = u.pushSubs.filter(x => x.endpoint !== sub.endpoint); changed = true; }
      else if (r.status >= 400) console.error(`Push to ${new URL(sub.endpoint).host} failed: ${r.status} ${r.body}`);
    } catch (e) { console.error('Push failed:', e.message); }
  }
  if (changed) persist(() => store.saveUser(u));
}
function notifyAfterMove(g, uid, move) {
  const other = g.players.find(p => p !== uid), o = db.users[other], me = db.users[uid];
  if (!o || !me) return;
  if (g.result === 'rami') notify(other, { title: pushText(o, 'lost', { name: me.name }), body: pushText(o, 'lostBody'), tag: 'result' });
  else if (g.result === 'resign') notify(other, { title: pushText(o, 'won'), body: pushText(o, 'resigned', { name: me.name }), tag: 'result' });
  else if (move.type === 'discard') notify(other, { title: pushText(o, 'turn'), body: pushText(o, 'threw', { name: me.name, card: cardText(move.card) }), tag: 'turn' });
}

// ---------- stats ----------
function stats() {
  const out = {};
  for (const id of Object.keys(db.users)) out[id] = { wins: 0, games: 0, rami: 0, streak: 0, best: 0, fastest: null };
  let run = null, runLen = 0;
  for (const h of db.history) {
    for (const p of h.players) if (out[p]) out[p].games++;
    const w = out[h.winner]; if (!w) continue;
    w.wins++;
    if (h.result === 'rami') { w.rami++; if (w.fastest === null || h.turns < w.fastest) w.fastest = h.turns; }
    runLen = run === h.winner ? runLen + 1 : 1; run = h.winner;
    w.best = Math.max(w.best, runLen);
  }
  if (run && out[run]) out[run].streak = runLen;
  const done = db.history.filter(h => h.result === 'rami');
  return { players: out, totalGames: db.history.length,
    avgTurns: done.length ? Math.round(done.reduce((a, h) => a + h.turns, 0) / done.length) : null };
}

const publicUser = u => ({ id: u.id, name: u.name, prefs: u.prefs || {} });
function stateFor(u) {
  return {
    me: publicUser(u),
    users: Object.values(db.users).map(publicUser),
    rules: db.rules,
    game: game.view(db.game, u.id),
    stats: stats(),
    storage: mongoUri() ? 'mongodb' : 'file',
    history: db.history.slice(-100).reverse(),
    version,
  };
}

function cleanPrefs(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (/^#[0-9a-f]{6}$/i.test(p.felt)) out.felt = p.felt;
  if (['classic', 'four'].includes(p.deckColors)) out.deckColors = p.deckColors;
  if (['s', 'm', 'l'].includes(p.cardSize)) out.cardSize = p.cardSize;
  if (typeof p.sound === 'boolean') out.sound = p.sound;
  if (['auto', 'light', 'dark'].includes(p.theme)) out.theme = p.theme;
  if (['en', 'ar', 'fr'].includes(p.lang)) out.lang = p.lang;
  if (typeof p.groupMelds === 'boolean') out.groupMelds = p.groupMelds;
  if (['suit', 'rank'].includes(p.sortBy)) out.sortBy = p.sortBy;
  if (typeof p.zlayji === 'boolean') out.zlayji = p.zlayji;
  return out;
}

function createUser(name, password) {
  const id = crypto.randomBytes(6).toString('hex');
  const u = { id, name: name.trim(), ...hashPassword(password), prefs: {}, createdAt: Date.now() };
  db.users[id] = u;
  return u;
}

// ---------- HTTP ----------
function send(res, code, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isJson ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64e3) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('Bad JSON')); } });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => e2 ? send(res, 404, 'Not found') : send(res, 200, html, { 'Content-Type': TYPES['.html'] }));
    send(res, 200, data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; worker-src 'self'; manifest-src 'self'",
};

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (req.method === 'POST') {   // only accept writes from our own pages
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Bad origin.' });
  }

  if (route === 'GET /api/public') return send(res, 200, { signupOpen: Object.keys(db.users).length < MAX_USERS });
  // Quick check from anywhere: is the app saving to MongoDB? Shows no data.
  if (route === 'GET /api/health') return send(res, 200, { ok: true, storage: mongoUri() ? 'mongodb' : 'file', accounts: Object.keys(db.users).length });

  if (route === 'POST /api/signup') {
    if (Object.keys(db.users).length >= MAX_USERS) return send(res, 403, { error: 'Sign-up is closed. Both players already have accounts.', code: 'signupClosed' });
    if (throttled(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.', code: 'tooMany' });
    const { name, password } = await readBody(req);
    if (!validName(name)) return send(res, 400, { error: 'Pick a name of 2 to 24 letters or numbers.', code: 'badName' });
    if (typeof password !== 'string' || password.length < 6) return send(res, 400, { error: 'Use a password of at least 6 characters.', code: 'badPassword' });
    if (findUser(name)) return send(res, 409, { error: 'That name is taken.', code: 'nameTaken' });
    const u = createUser(name, password);
    persist(() => store.saveUser(u));
    startSession(req, res, u); broadcast();
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/login') {
    if (throttled(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.', code: 'tooMany' });
    const { name, password } = await readBody(req);
    const u = findUser(name || '');
    if (!u || typeof password !== 'string' || !checkPassword(u, password)) {
      attempts.get(ip).push(Date.now());
      return send(res, 401, { error: 'Wrong name or password.', code: 'wrongLogin' });
    }
    startSession(req, res, u);
    return send(res, 200, { ok: true });
  }

  const u = currentUser(req);
  if (!u) return send(res, 401, { error: 'Please sign in.', code: 'signIn' });

  switch (route) {
    case 'POST /api/logout': {
      const sid = parseCookies(req).rami_sid;
      delete db.sessions[sid]; persist(() => store.deleteSession(sid));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'rami_sid=; Path=/; Max-Age=0' });
    }
    case 'GET /api/state': return send(res, 200, stateFor(u));
    case 'GET /api/events': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: update\ndata: ${version}\n\n`);
      streams.add(res);
      // the page says whether it's in front; it starts out visible
      const pageId = String(url.searchParams.get('page') || crypto.randomBytes(6).toString('hex')).slice(0, 40);
      if (url.searchParams.get('visible') !== '0') { if (!looking.has(u.id)) looking.set(u.id, new Set()); looking.get(u.id).add(pageId); }
      req.on('close', () => { streams.delete(res); looking.get(u.id)?.delete(pageId); });
      return;
    }
    case 'POST /api/presence': {
      const { page, visible } = await readBody(req);
      if (typeof page === 'string' && page.length < 40) {
        if (!looking.has(u.id)) looking.set(u.id, new Set());
        if (visible) looking.get(u.id).add(page); else looking.get(u.id).delete(page);
      }
      return send(res, 200, { ok: true });
    }
    case 'GET /api/replay': {
      const no = +url.searchParams.get('no');
      const g = db.game && db.game.no === no ? db.game : await store.getGame(no);
      if (!g || !g.players.includes(u.id)) return send(res, 404, { error: 'Game not found.' });
      if (!g.result) return send(res, 409, { error: 'This game is still being played.' });
      const r = game.replay(g);
      if (!r) return send(res, 404, { error: 'This game was played before replays were recorded.', code: 'noReplay' });
      return send(res, 200, r);
    }
    case 'GET /api/push/key': return send(res, 200, { publicKey: vapid?.publicKey || null });
    case 'POST /api/push/subscribe': {
      const { subscription } = await readBody(req);
      const ok = subscription && typeof subscription.endpoint === 'string' && /^https:\/\//.test(subscription.endpoint)
        && subscription.keys && typeof subscription.keys.p256dh === 'string' && typeof subscription.keys.auth === 'string';
      if (!ok) return send(res, 400, { error: 'Bad subscription.' });
      const clean = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        origin: `https://${req.headers.host}`, addedAt: Date.now() };
      u.pushSubs = [...(u.pushSubs || []).filter(x => x.endpoint !== clean.endpoint), clean].slice(-6);
      persist(() => store.saveUser(u));
      return send(res, 200, { ok: true });
    }
    case 'POST /api/push/unsubscribe': {
      const { endpoint } = await readBody(req);
      u.pushSubs = (u.pushSubs || []).filter(x => x.endpoint !== endpoint);
      persist(() => store.saveUser(u));
      return send(res, 200, { ok: true });
    }
    case 'POST /api/push/test': {
      if (!(u.pushSubs || []).length) return send(res, 400, { error: 'This device is not subscribed yet.' });
      await notify(u.id, { title: pushText(u, 'test'), body: pushText(u, 'testBody'), tag: 'test', force: true });
      return send(res, 200, { ok: true });
    }
    case 'POST /api/prefs': {
      const { prefs } = await readBody(req);
      u.prefs = { ...(u.prefs || {}), ...cleanPrefs(prefs) };
      persist(() => store.saveUser(u));
      return send(res, 200, { prefs: u.prefs });
    }
    case 'POST /api/rules': {
      const { rules } = await readBody(req);
      db.rules = game.cleanRules(rules);
      persist(() => store.saveRules(db.rules)); broadcast();
      return send(res, 200, { rules: db.rules });
    }
    case 'POST /api/game/new': {
      const g = db.game;
      if (g && !g.result) return send(res, 409, { error: 'A game is still being played. Finish or resign it first.', code: 'gameInProgress' });
      const others = Object.values(db.users).filter(x => x.id !== u.id);
      if (!others.length) return send(res, 400, { error: 'Your partner needs to sign up first.', code: 'needPartner' });
      const body = await readBody(req);
      const opp = others.find(x => x.id === body.opponent) || others[0];
      const same = g && g.players.includes(u.id) && g.players.includes(opp.id);
      const players = same ? g.players : [u.id, opp.id];
      const rules = game.cleanRules(db.rules);
      let starter = players[0];
      if (same) {
        if (rules.starter === 'winner') starter = g.winner;
        else if (rules.starter === 'loser') starter = players.find(p => p !== g.winner);
        else starter = players.find(p => p !== g.starter);
      }
      const ng = game.newGame({ no: db.nextGameNo++, players, starter, rules });
      db.game = ng;
      persist(() => store.saveGame(ng)); broadcast();
      const o = db.users[opp.id];
      notify(opp.id, { title: pushText(o, 'newGame'), body: pushText(o, starter === opp.id ? 'dealt' : 'dealtWait', { name: u.name }), tag: 'turn' });
      return send(res, 200, { ok: true });
    }
    case 'POST /api/game/move': {
      const g = db.game;
      if (!g) return send(res, 400, { error: 'No game yet.', code: 'noGame' });
      const move = await readBody(req);
      try {
        const wasOver = !!g.result;
        const r = game.apply(g, u.id, move);
        if (!wasOver && g.result) db.history.push(summary(g));
        const snapshot = structuredClone(g);
        persist(() => store.saveGame(snapshot));
        if (!r.quiet) broadcast();
        if (!r.quiet) notifyAfterMove(g, u.id, move);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message, code: e.code }); }
    }
  }
  return send(res, 404, { error: 'Not found' });
}

// One-time update when the default win rule changes: house rules saved under the
// old 2 swivi + 2 tirci default, and the game on the table, switch to 1 + 1.
function migrateRules() {
  if ((db.rules.version || 0) >= game.DEFAULT_RULES.version) return;
  if (db.rules.minSwivi === 2 && db.rules.minTirci === 2) { db.rules.minSwivi = 1; db.rules.minTirci = 1; }
  db.rules.version = game.DEFAULT_RULES.version;
  persist(() => store.saveRules(db.rules));
  const g = db.game;
  if (g && !g.result && g.rules.minSwivi === 2 && g.rules.minTirci === 2) {
    g.rules.minSwivi = 1; g.rules.minTirci = 1;
    persist(() => store.saveGame(g));
  }
  console.log('House rules updated: a Rami needs 1 swivi + 1 tirci.');
}

async function start() {
  db = await store.load(game.DEFAULT_RULES);
  migrateRules();
  await loadVapid();
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET') serveStatic(req, res);
      else send(res, 405, 'Method not allowed');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Server error.' });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`Rami running on http://${HOST}:${PORT}`);
    if (mongoUri()) console.log(`Storage: MongoDB, database "${store.dbName}". Accounts and games survive redeploys.`);
    else console.log('WARNING: no mongoURI set. Saving to a local file, which is wiped when the container is rebuilt (every deploy).');
  });
  const stop = async () => { server.close(); await queue; await store.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

// ---------- command line ----------
function ask(q, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}
async function askPassword() {
  const pw = process.env.RAMI_PASSWORD || await ask('Password: ', true);
  if (pw.length < 6) throw new Error('Use at least 6 characters.');
  if (!process.env.RAMI_PASSWORD && pw !== await ask('Again: ', true)) throw new Error("Passwords don't match.");
  return pw;
}
async function cli([cmd, name]) {
  db = await store.load(game.DEFAULT_RULES);
  try {
    if (cmd === 'add-user') {
      if (!validName(name)) throw new Error('Usage: node server.js add-user <name>  (2-24 letters/numbers)');
      if (findUser(name)) throw new Error(`"${name}" already exists.`);
      const u = createUser(name, await askPassword());
      await store.saveUser(u); console.log(`Created ${u.name}.`);
    } else if (cmd === 'passwd') {
      const u = findUser(name || ''); if (!u) throw new Error('No such user.');
      Object.assign(u, hashPassword(await askPassword()));
      await store.saveUser(u); await store.deleteSessionsFor(u.id);
      console.log(`Password changed for ${u.name}. They'll need to sign in again.`);
    } else if (cmd === 'list-users') {
      for (const u of Object.values(db.users)) console.log(u.name);
    } else throw new Error('Commands: add-user <name> | passwd <name> | list-users');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  await store.close();
}

if (process.argv[2]) cli(process.argv.slice(2));
else start().catch(e => { console.error('Could not start:', e.message); process.exit(1); });
