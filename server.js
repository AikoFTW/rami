'use strict';
// Rami server: zero dependencies, just Node.js 18+.
//   node server.js                     start the site (PORT, default 3333)
//   node server.js add-user <name>     create a login (asks for a password)
//   node server.js passwd <name>       change a password
//   node server.js list-users
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const game = require('./game');

const PORT = +process.env.PORT || 3333;
const HOST = process.env.HOST || '127.0.0.1';      // behind a reverse proxy by default
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const SESSION_DAYS = 60;

// ---------- storage ----------
function emptyDb() {
  return { users: {}, sessions: {}, rules: { ...game.DEFAULT_RULES }, game: null, history: [], nextGameNo: 1 };
}
function load() {
  try { return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch (e) { if (e.code === 'ENOENT') return emptyDb(); throw e; }
}
let db = load();
let saveTimer = null;
function save(now = false) {
  const write = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);   // atomic: never a half-written file
  };
  clearTimeout(saveTimer);
  if (now) write(); else saveTimer = setTimeout(write, 50);
}

// ---------- passwords & sessions ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  const h = crypto.scryptSync(pw, user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
}
const findUser = name => Object.values(db.users).find(u => u.name.toLowerCase() === String(name).toLowerCase());

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
function isHttps(req) {
  return process.env.SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https';
}

// simple login throttle: 10 tries per 15 minutes per address
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
  for (const s of streams) s.res.write(`event: update\ndata: ${version}\n\n`);
}
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 25e3).unref();

// ---------- stats ----------
function stats() {
  const users = Object.keys(db.users);
  const out = {};
  for (const id of users) out[id] = { wins: 0, games: 0, rami: 0, streak: 0, best: 0, fastest: null };
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

function finishIfOver() {
  const g = db.game;
  if (g && (g.winner || g.result) && !g.archived) {
    g.archived = true;
    const opp = g.players.find(p => p !== g.winner);
    db.history.push({
      no: g.no, players: g.players, winner: g.winner, result: g.result, turns: g.turns,
      startedAt: g.startedAt, endedAt: g.endedAt, rules: g.rules,
      melds: g.melds || null, discard: g.discard[g.discard.length - 1] || null,
      loserHand: opp ? g.hands[opp] : null,
    });
  }
}

function stateFor(u) {
  return {
    me: publicUser(u),
    users: Object.values(db.users).map(publicUser),
    rules: db.rules,
    game: game.view(db.game, u.id),
    stats: stats(),
    history: db.history.slice(-100).reverse().map(h => ({ ...h, loserHand: undefined })),
    version,
  };
}
const publicUser = u => ({ id: u.id, name: u.name, prefs: u.prefs || {} });

function cleanPrefs(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (/^#[0-9a-f]{6}$/i.test(p.felt)) out.felt = p.felt;
  if (['classic', 'four'].includes(p.deckColors)) out.deckColors = p.deckColors;
  if (['s', 'm', 'l'].includes(p.cardSize)) out.cardSize = p.cardSize;
  if (typeof p.sound === 'boolean') out.sound = p.sound;
  if (['auto', 'light', 'dark'].includes(p.theme)) out.theme = p.theme;
  if (typeof p.autoSort === 'boolean') out.autoSort = p.autoSort;
  return out;
}

// ---------- HTTP ----------
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain',
    'Cache-Control': 'no-store', ...headers });
  res.end(data);
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
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
};

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (route === 'POST /api/login') {
    if (throttled(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
    const { name, password } = await readBody(req);
    const u = findUser(name || '');
    if (!u || !password || !checkPassword(u, String(password))) {
      attempts.get(ip).push(Date.now());
      return send(res, 401, { error: 'Wrong name or password.' });
    }
    const sid = crypto.randomBytes(32).toString('hex');
    db.sessions[sid] = { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 };
    for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k];
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie':
      `rami_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}` });
  }

  const u = currentUser(req);
  if (!u) return send(res, 401, { error: 'Please sign in.' });

  // Only accept writes from our own pages (blocks cross-site form posts).
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Bad origin.' });
  }

  switch (route) {
    case 'POST /api/logout': {
      delete db.sessions[parseCookies(req).rami_sid]; save();
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'rami_sid=; Path=/; Max-Age=0' });
    }
    case 'GET /api/state': return send(res, 200, stateFor(u));
    case 'GET /api/events': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: update\ndata: ${version}\n\n`);
      const s = { res, uid: u.id }; streams.add(s);
      req.on('close', () => streams.delete(s));
      return;
    }
    case 'POST /api/prefs': {
      const { prefs } = await readBody(req);
      u.prefs = { ...(u.prefs || {}), ...cleanPrefs(prefs) }; save();
      return send(res, 200, { prefs: u.prefs });
    }
    case 'POST /api/rules': {
      const { rules } = await readBody(req);
      db.rules = game.cleanRules(rules); save(); broadcast();
      return send(res, 200, { rules: db.rules });
    }
    case 'POST /api/game/new': {
      const g = db.game;
      if (g && !g.winner && !g.result) return send(res, 409, { error: 'A game is still being played. Finish or resign it first.' });
      const others = Object.values(db.users).filter(x => x.id !== u.id);
      if (!others.length) return send(res, 400, { error: 'Create a second login first: node server.js add-user <name>' });
      const body = await readBody(req);
      const opp = others.find(x => x.id === body.opponent) || others[0];
      const players = g && g.players.includes(u.id) && g.players.includes(opp.id) ? g.players : [u.id, opp.id];
      const rules = game.cleanRules(db.rules);
      let starter = players[0];
      if (g && g.players.includes(opp.id)) {
        if (rules.starter === 'winner') starter = g.winner;
        else if (rules.starter === 'loser') starter = players.find(p => p !== g.winner);
        else starter = players.find(p => p !== g.starter);
      }
      db.game = game.newGame({ no: db.nextGameNo++, players, starter, rules });
      save(); broadcast();
      return send(res, 200, { ok: true });
    }
    case 'POST /api/game/move': {
      if (!db.game) return send(res, 400, { error: 'No game yet.' });
      const move = await readBody(req);
      try {
        const r = game.apply(db.game, u.id, move);
        finishIfOver(); save();
        if (!r.quiet) broadcast();
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
  }
  return send(res, 404, { error: 'Not found' });
}

function start() {
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
    if (Object.keys(db.users).length < 2) console.log('Tip: create logins with  node server.js add-user <name>');
  });
  const stop = () => { save(true); process.exit(0); };
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
  if (pw.length < 6) { console.error('Use at least 6 characters.'); process.exit(1); }
  if (!process.env.RAMI_PASSWORD && pw !== await ask('Again: ', true)) { console.error("Passwords don't match."); process.exit(1); }
  return pw;
}

async function cli([cmd, name]) {
  if (cmd === 'add-user') {
    if (!name || !/^[\p{L}\p{N}_ .-]{2,24}$/u.test(name)) return console.error('Usage: node server.js add-user <name>  (2-24 letters/numbers)');
    if (findUser(name)) return console.error(`"${name}" already exists.`);
    const id = crypto.randomBytes(6).toString('hex');
    db.users[id] = { id, name, ...hashPassword(await askPassword()), prefs: {}, createdAt: Date.now() };
    save(true); console.log(`Created ${name}.`);
  } else if (cmd === 'passwd') {
    const u = findUser(name || ''); if (!u) return console.error('No such user.');
    Object.assign(u, hashPassword(await askPassword()));
    for (const [k, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[k];
    save(true); console.log(`Password changed for ${u.name}. They'll need to sign in again.`);
  } else if (cmd === 'list-users') {
    for (const u of Object.values(db.users)) console.log(u.name);
  } else {
    console.error('Commands: add-user <name> | passwd <name> | list-users');
  }
}

if (process.argv[2]) cli(process.argv.slice(2)); else start();
