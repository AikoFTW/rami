'use strict';
// Storage. Uses MongoDB when MONGODB_URI is set; otherwise a local JSON file
// (handy for trying it out). Both expose the same small interface.
//
// MongoDB collections:
//   users     { _id, name, nameLower, salt, hash, prefs, createdAt }
//   sessions  { _id: token, uid, expiresAt }            (TTL index cleans up)
//   settings  { _id: 'rules', ...houseRules }
//   games     { _id: gameNo, ...full game }             (current and past games)
const fs = require('fs');
const path = require('path');

function summary(g) {
  const opp = g.players.find(p => p !== g.winner);
  return {
    no: g.no, players: g.players, winner: g.winner, result: g.result, turns: g.turns,
    startedAt: g.startedAt, endedAt: g.endedAt, rules: g.rules,
    melds: g.melds || null, loserHand: opp ? g.hands[opp] : null,
  };
}

// state = { users:{id:user}, sessions:{token:{uid,exp}}, rules, game, history:[summary], nextGameNo }

class MongoStore {
  constructor(uri, dbName) { this.uri = uri; this.dbName = dbName; }
  async load(defaultRules) {
    let mongodb;
    try { mongodb = require('mongodb'); }
    catch { throw new Error('MONGODB_URI is set but the mongodb package is missing. Run: npm install'); }
    this.client = new mongodb.MongoClient(this.uri);
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.users = db.collection('users');
    this.sessions = db.collection('sessions');
    this.settings = db.collection('settings');
    this.games = db.collection('games');
    await Promise.all([
      this.users.createIndex({ nameLower: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.games.createIndex({ endedAt: 1 }),
    ]);

    const state = { users: {}, sessions: {}, rules: { ...defaultRules }, game: null, history: [], nextGameNo: 1 };
    for (const u of await this.users.find().toArray()) { const { _id, ...rest } = u; state.users[_id] = { id: _id, ...rest }; }
    for (const s of await this.sessions.find({ expiresAt: { $gt: new Date() } }).toArray())
      state.sessions[s._id] = { uid: s.uid, exp: s.expiresAt.getTime() };
    const rules = await this.settings.findOne({ _id: 'rules' });
    if (rules) { const { _id, ...r } = rules; state.rules = { ...state.rules, ...r }; }
    const games = await this.games.find().sort({ _id: 1 }).toArray();
    for (const doc of games) {
      const { _id, ...g } = doc;
      if (g.result) state.history.push(summary(g));
      state.nextGameNo = Math.max(state.nextGameNo, _id + 1);
    }
    const last = games[games.length - 1];
    if (last) { const { _id, ...g } = last; state.game = g; }
    return state;
  }
  async saveUser(u) { const { id, ...rest } = u; await this.users.replaceOne({ _id: id }, { ...rest, nameLower: u.name.toLowerCase() }, { upsert: true }); }
  async saveSession(token, s) { await this.sessions.replaceOne({ _id: token }, { uid: s.uid, expiresAt: new Date(s.exp) }, { upsert: true }); }
  async deleteSession(token) { await this.sessions.deleteOne({ _id: token }); }
  async deleteSessionsFor(uid) { await this.sessions.deleteMany({ uid }); }
  async saveRules(r) { await this.settings.replaceOne({ _id: 'rules' }, r, { upsert: true }); }
  async saveGame(g) { await this.games.replaceOne({ _id: g.no }, g, { upsert: true }); }
  async close() { await this.client?.close(); }
}

class FileStore {
  constructor(dir) { this.file = path.join(dir, 'db.json'); this.dir = dir; }
  async load(defaultRules) {
    const empty = { users: {}, sessions: {}, rules: { ...defaultRules }, games: {} };
    try { this.data = { ...empty, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.data = empty; }
    const d = this.data, nos = Object.keys(d.games).map(Number).sort((a, b) => a - b);
    return {
      users: d.users, sessions: d.sessions, rules: { ...defaultRules, ...d.rules },
      game: nos.length ? d.games[nos[nos.length - 1]] : null,
      history: nos.map(n => d.games[n]).filter(g => g.result).map(summary),
      nextGameNo: (nos[nos.length - 1] || 0) + 1,
    };
  }
  async flush() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  async saveUser(u) { this.data.users[u.id] = u; await this.flush(); }
  async saveSession(t, s) { this.data.sessions[t] = s; await this.flush(); }
  async deleteSession(t) { delete this.data.sessions[t]; await this.flush(); }
  async deleteSessionsFor(uid) { for (const [k, s] of Object.entries(this.data.sessions)) if (s.uid === uid) delete this.data.sessions[k]; await this.flush(); }
  async saveRules(r) { this.data.rules = r; await this.flush(); }
  async saveGame(g) { this.data.games[g.no] = g; await this.flush(); }
  async close() {}
}

// Accepts MONGODB_URI, mongoURI or MONGO_URI. The database name comes from MONGODB_DB,
// then the name in the connection string (…mongodb.net/rami), then "rami".
const mongoUri = () => process.env.MONGODB_URI || process.env.mongoURI || process.env.MONGO_URI;
function dbNameFrom(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri);
  return m ? decodeURIComponent(m[1]) : null;
}
function openStore() {
  const uri = mongoUri();
  if (uri) return new MongoStore(uri, process.env.MONGODB_DB || dbNameFrom(uri) || 'rami');
  return new FileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}

module.exports = { openStore, summary, mongoUri, dbNameFrom };
