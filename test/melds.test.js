const assert = require('assert');
const { bestMelds, findRami } = require('../public/melds.js');
const { DEFAULT_RULES: R, newGame } = require('../game.js');
const t = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message); process.exitCode = 1; } };
const covered = r => r.melds.flatMap(m => m.cards).length;

t('finds a swivi and leaves the rest loose, in order', () => {
  const r = bestMelds(['2-D-0', '7-H-0', '13-S-0', '8-H-0', '9-H-0'], R);
  assert.equal(r.melds.length, 1); assert.equal(r.melds[0].type, 'swivi');
  assert.deepEqual(r.melds[0].cards, ['7-H-0', '8-H-0', '9-H-0']);
  assert.deepEqual(r.loose, ['2-D-0', '13-S-0']);
});
t('finds a tirci', () => {
  const r = bestMelds(['5-H-0', '5-S-0', '5-C-0', '9-D-0'], R);
  assert.equal(r.melds[0].type, 'tirci'); assert.deepEqual(r.loose, ['9-D-0']);
});
t('does not spend a joker unless it completes a meld', () => {
  const r = bestMelds(['7-H-0', '8-H-0', '9-H-0', 'J-0', '2-C-0'], R);
  assert.deepEqual(r.loose.sort(), ['2-C-0', 'J-0']);
});
t('uses a joker to complete a meld', () => {
  const r = bestMelds(['7-H-0', '9-H-0', 'J-0'], R);
  assert.equal(r.melds.length, 1); assert.deepEqual(r.melds[0].cards, ['7-H-0', 'J-0', '9-H-0']);
});
t('prefers covering more cards', () => {
  // 5♥6♥7♥ + 7♠7♦ : best is swivi 5-6-7♥ OR tirci 7♥7♠7♦ (3 cards each); never both with one 7♥
  const r = bestMelds(['5-H-0', '6-H-0', '7-H-0', '7-S-0', '7-D-0'], R);
  assert.equal(covered(r), 3);
});
t('a full Rami is fully covered', () => {
  const hand = ['7-H-0','8-H-0','9-H-0','13-S-0','13-D-0','13-C-0','3-C-0','4-C-0','5-C-0','6-C-0','12-H-0','12-S-0','12-D-0'];
  const r = bestMelds(hand, R); assert.equal(r.loose.length, 0); assert(findRami(hand, R));
});
t('high ace swivi', () => {
  const r = bestMelds(['12-S-0', '1-S-0', '13-S-0'], R); assert.equal(r.loose.length, 0);
});

let worst = 0, t0 = Date.now();
for (let i = 0; i < 2000; i++) {
  const g = newGame({ no: 1, players: ['a', 'b'], starter: 'a', rules: R });
  const hand = g.hands.a;
  if (i % 4 === 0) hand.splice(0, 4, 'J-0', 'J-1', 'J-2', 'J-3');   // worst case: all four jokers
  const s = Date.now(); bestMelds(hand, R); worst = Math.max(worst, Date.now() - s);
}
console.log(`speed: 2000 hands of 15 in ${Date.now() - t0}ms, slowest ${worst}ms`);

const { jokerOptions, jokerStandsFor, cardPotential } = require('../public/melds.js');
t('joker options: gap, both ends, tirci', () => {
  const o = jokerOptions(['7-S-0', '9-S-0', 'Q-H-0'.replace('Q', '12'), '12-S-0', 'J-0'], R);
  const sw = o.filter(x => x.type === 'swivi').map(x => x.stands.r).sort((a, b) => a - b);
  assert.deepEqual(sw, [8]);                              // only the gap makes 3 cards
  assert(o.some(x => x.type === 'tirci' && x.stands.r === 12));
  const o2 = jokerOptions(['7-S-0', '8-S-0'], R).map(x => x.stands.r).sort((a, b) => a - b);
  assert.deepEqual(o2, [6, 9]);                           // either end of a pair
});
t('joker options: ace high end', () => {
  const o = jokerOptions(['12-H-0', '13-H-0'], R).map(x => x.stands.r).sort((a, b) => a - b);
  assert.deepEqual(o, [1, 11]);                           // as A♥ (high) or J♥
});
t('joker options: none when jokers banned', () => assert.equal(jokerOptions(['7-S-0', '8-S-0'], { ...R, maxJokersPerMeld: 0 }).length, 0));
t('joker stands for the right card', () => {
  assert.deepEqual(jokerStandsFor({ type: 'swivi', cards: ['7-S-0', 'J-0', '9-S-0'] }, 1), { r: 8, s: 'S' });
  assert.deepEqual(jokerStandsFor({ type: 'swivi', cards: ['12-S-0', '13-S-0', 'J-0'] }, 2), { r: 1, s: 'S' });
  assert.deepEqual(jokerStandsFor({ type: 'swivi', cards: ['J-0', '2-S-0', '3-S-0'] }, 0), { r: 1, s: 'S' });
  assert.deepEqual(jokerStandsFor({ type: 'tirci', cards: ['5-S-0', '5-H-0', 'J-0'] }, 2), { r: 5 });
});
t('card potential: completes a swivi', () => {
  const p = cardPotential(['7-H-0', '9-H-0', '2-C-0'], '8-H-0', R);
  assert.equal(p.meld.type, 'swivi'); assert.equal(p.gain, 3);
});
t('card potential: pairs toward a tirci', () => {
  const p = cardPotential(['5-H-0', '9-C-0'], '5-S-0', R);
  assert.equal(p.meld, null); assert.deepEqual(p.partners, [{ type: 'tirci', id: '5-H-0' }]);
});
t('card potential: useless card', () => {
  const p = cardPotential(['5-H-0', '9-C-0'], '13-D-0', R);
  assert.equal(p.meld, null); assert.equal(p.partners.length, 0); assert.equal(p.gain, 0);
});
