// Runs the MongoDB store against an in-memory stand-in for the `mongodb` driver.
const Module = require('module');
const data = {};
class Col {
  constructor(n) { this.d = data[n] = data[n] || new Map(); }
  async createIndex() {}
  find(q = {}) { let a = [...this.d.entries()].map(([k, v]) => ({ _id: k, ...structuredClone(v) }));
    if (q.expiresAt) a = a.filter(x => x.expiresAt > q.expiresAt.$gt);
    const c = { sort: s => { a.sort((x, y) => (x._id - y._id) * s._id); return c; }, toArray: async () => a }; return c; }
  async findOne(q) { const v = this.d.get(q._id); return v ? { _id: q._id, ...structuredClone(v) } : null; }
  async replaceOne(q, doc) { const { _id, ...rest } = doc; this.d.set(q._id, structuredClone(rest)); }
  async deleteOne(q) { this.d.delete(q._id); }
  async deleteMany(q) { for (const [k, v] of this.d) if (v.uid === q.uid) this.d.delete(k); }
}
const fake = { MongoClient: class { async connect() {} db() { return { collection: n => new Col(n) }; } async close() {} } };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'mongodb' ? fake : orig.call(this, r, ...a); };

process.env.MONGODB_URI = 'mongodb://fake';
const assert = require('assert');
const { openStore } = require('../store');
const game = require('../game');
(async () => {
  const s1 = openStore();
  let st = await s1.load(game.DEFAULT_RULES);
  assert.equal(st.nextGameNo, 1);
  await s1.saveUser({ id: 'a', name: 'Aiko', salt: 's', hash: 'h', prefs: {} });
  await s1.saveUser({ id: 'b', name: 'Wife', salt: 's', hash: 'h', prefs: {} });
  await s1.saveSession('tok', { uid: 'a', exp: Date.now() + 1e6 });
  await s1.saveSession('old', { uid: 'a', exp: Date.now() - 1e6 });
  await s1.saveRules({ ...game.DEFAULT_RULES, jokers: 2 });
  const g1 = game.newGame({ no: 1, players: ['a', 'b'], starter: 'a', rules: game.DEFAULT_RULES });
  game.apply(g1, 'b', { type: 'resign' }); await s1.saveGame(g1);
  const g2 = game.newGame({ no: 2, players: ['a', 'b'], starter: 'b', rules: game.DEFAULT_RULES }); await s1.saveGame(g2);

  st = await openStore().load(game.DEFAULT_RULES);
  assert.deepEqual(Object.keys(st.users).sort(), ['a', 'b']);
  assert.equal(st.users.a.name, 'Aiko');
  assert.deepEqual(Object.keys(st.sessions), ['tok']);
  assert.equal(st.rules.jokers, 2);
  assert.equal(st.history.length, 1); assert.equal(st.history[0].winner, 'a');
  assert.equal(st.game.no, 2); assert.equal(st.nextGameNo, 3);
  assert.equal(st.game.hands.b.length, 15);
  console.log('ok   mongo store round-trip');

  // deck reshuffle
  const g = game.newGame({ no: 9, players: ['a', 'b'], starter: 'a', rules: game.DEFAULT_RULES });
  let p = 'a'; game.apply(g, p, { type: 'discard', card: g.hands[p][0] }); p = 'b';
  for (let i = 0; i < 300; i++) { game.apply(g, p, { type: 'draw', source: 'deck' }); game.apply(g, p, { type: 'discard', card: g.hands[p][0] }); p = p === 'a' ? 'b' : 'a'; }
  const total = g.deck.length + g.discard.length + g.hands.a.length + g.hands.b.length;
  assert.equal(total, 108); assert(g.log.some(e => e.type === 'reshuffle'));
  console.log('ok   deck reshuffles and no card is ever lost (108 total)');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
