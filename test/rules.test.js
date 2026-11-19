const assert = require('assert');
const { findRami, DEFAULT_RULES } = require('../game.js');
const R = { ...DEFAULT_RULES, minSwivi: 1, minTirci: 1 };   // older one-of-each rule for the classic cases
const ok = (ids, rules = R) => !!findRami(ids, rules);
const t = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message); process.exitCode = 1; } };

// example winning 13 (after discard): runs + sets
const win = ['7-H-0','8-H-0','9-H-0','13-S-0','13-D-0','13-C-0','3-C-0','4-C-0','5-C-0','6-C-0','12-H-0','12-S-0','12-D-0'];
t('basic rami', () => assert(ok(win)));
t('needs a tirci', () => assert(!ok(['1-H-0','2-H-0','3-H-0','5-S-0','6-S-0','7-S-0'])));
t('needs a swivi', () => assert(!ok(['5-H-0','5-S-0','5-D-0','9-H-0','9-S-0','9-C-0'])));
t('swivi+tirci ok', () => assert(ok(['1-H-0','2-H-0','3-H-0','9-H-0','9-S-0','9-C-0'])));
t('ace high', () => assert(ok(['12-S-0','13-S-0','1-S-0','4-H-0','4-S-0','4-D-0'])));
t('no wrap-around', () => assert(!ok(['13-S-0','1-S-0','2-S-0','4-H-0','4-S-0','4-D-0'])));
t('joker in middle', () => assert(ok(['7-H-0','J-0','9-H-0','4-H-0','4-S-0','4-D-0'])));
t('joker in tirci', () => assert(ok(['7-H-0','8-H-0','9-H-0','4-H-0','4-S-0','J-1'])));
t('tirci needs different suits', () => assert(!ok(['7-H-0','8-H-0','9-H-0','4-H-0','4-H-1','4-S-0'])));
t('leftover card fails', () => assert(!ok([...win, '2-D-0'].slice(1))));
t('two-deck duplicate: card used in run, its twin in set', () => assert(ok(['5-H-0','6-H-0','7-H-0','5-H-1','5-S-0','5-C-0'])));
t('joker substitutes even when natural exists', () => assert(ok(['4-H-0','J-0','6-H-0','5-S-0','5-H-0','5-D-0'])));
t('no-joker rule', () => assert(!ok(['7-H-0','J-0','9-H-0','4-H-0','4-S-0','4-D-0'], { ...R, maxJokersPerMeld: 0 })));
t('long run 13', () => assert(ok(['1-S-0','2-S-0','3-S-0','4-S-0','5-S-0','6-S-0','7-S-0','8-S-0','9-S-0','10-S-0','11-S-0','12-S-0','13-S-0','4-H-0','4-D-0','4-C-0'])));
// the new default: 2 swivi + 2 tirci
const R2 = DEFAULT_RULES;
t('default needs 2 swivi + 2 tirci', () => {
  assert.equal(R2.minSwivi, 2); assert.equal(R2.minTirci, 2);
  assert(ok(win, R2));   // win = 2 swivi + 2 tirci
  assert(!ok(['7-H-0','8-H-0','9-H-0','3-C-0','4-C-0','5-C-0','6-C-0','13-S-0','13-D-0','13-C-0','2-S-0','3-S-0','4-S-0'], R2));   // 3 swivi + 1 tirci
});
t('a run of 6 can be laid as two swivis of 3', () => assert(ok(['1-S-0','2-S-0','3-S-0','4-S-0','5-S-0','6-S-0','4-H-0','4-D-0','4-C-0','9-H-0','9-D-0','9-C-0'], R2)));
// speed: random 14-card hands
const { newGame } = require('../game.js');
let t0 = Date.now(), n = 0;
for (let i = 0; i < 3000; i++) { const g = newGame({ no: 1, players: ['a','b'], starter: 'a', rules: R }); findRami(g.hands.b, R); n++; }
console.log(`speed: ${n} random hands in ${Date.now() - t0}ms`);
