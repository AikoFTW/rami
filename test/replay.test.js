// Plays whole games through the engine, then checks the replay rebuilds them exactly.
const assert = require('assert');
const game = require('../game');
const { buildFrames, analyse } = require('../public/replay.js');
const { findRami, bestMelds } = require('../public/melds.js');
const t = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.stack.split('\n').slice(0, 2).join(' ')); process.exitCode = 1; } };
const same = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());

// a simple player: takes the pile if it helps, throws the card that fits least, declares when it can
function play(seed) {
  const R = game.DEFAULT_RULES;
  const g = game.newGame({ no: seed, players: ['a', 'b'], starter: 'a', rules: R });
  const placed = h => bestMelds(h, R).melds.reduce((n, m) => n + m.cards.length, 0);
  for (let step = 0; step < 400 && !g.result; step++) {
    const p = g.turn, hand = g.hands[p];
    if (g.phase === 'draw') {
      const top = g.discard[g.discard.length - 1];
      const take = top && placed([...hand, top]) > placed(hand);
      game.apply(g, p, { type: 'draw', source: take ? 'discard' : 'deck' });
    } else {
      const h = g.hands[p];
      const win = h.find(x => findRami(h.filter(y => y !== x), R));
      if (win) { game.apply(g, p, { type: 'declare', card: win }); break; }
      const { loose } = bestMelds(h, R);
      game.apply(g, p, { type: 'discard', card: loose.find(x => x[0] !== 'J') || h[0] });
    }
  }
  if (!g.result) game.apply(g, 'b', { type: 'resign' });
  return g;
}

let rami = 0, resign = 0, moments = 0;
for (let seed = 1; seed <= 25; seed++) {
  const g = play(seed);
  const r = game.replay(g);
  t(`game ${seed}: replay ends with the real final hands (${g.result}, ${g.turns} turns)`, () => {
    const frames = buildFrames(r);
    const last = frames[frames.length - 1];
    for (const p of g.players) same(last.hands[p], g.hands[p]);
    assert.equal(last.pile[last.pile.length - 1], g.discard[g.discard.length - 1]);
    assert.equal(last.deck, g.deck.length);
    const a = analyse(r, frames);
    for (const p of g.players) assert(a.stats[p].best <= 15 && a.progress[p].length >= 1);
    moments += a.moments.length;
  });
  g.result === 'rami' ? rami++ : resign++;
}
console.log(`games: ${rami} won by Rami, ${resign} resigned; ${moments} key moments found`);

t('during a game you never see the other player\'s deck draws', () => {
  const g = game.newGame({ no: 99, players: ['a', 'b'], starter: 'a', rules: game.DEFAULT_RULES });
  game.apply(g, 'a', { type: 'discard', card: g.hands.a[0] });
  game.apply(g, 'b', { type: 'draw', source: 'deck' });
  const seenByA = game.view(g, 'a').log.find(e => e.type === 'draw');
  const seenByB = game.view(g, 'b').log.find(e => e.type === 'draw');
  assert.equal(seenByA.card, undefined); assert(seenByB.card);
  assert.equal(game.replay(g), null);   // no replay while the game is on
});
