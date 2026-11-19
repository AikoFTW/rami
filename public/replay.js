// Rebuilds a finished game move by move and works out its stats.
// Shared by the browser (self.RamiReplay) and the tests (require).
(function (root) {
'use strict';
const M = typeof module !== 'undefined' && module.exports ? require('./melds.js') : root.RamiMelds;
const { bestMelds, findRami, parse } = M;

const isJoker = id => id[0] === 'J';
const face = id => isJoker(id) ? 'J' : id.split('-').slice(0, 2).join('-');   // ignores which deck it came from
const placed = (hand, rules) => bestMelds(hand, rules).melds.reduce((n, m) => n + m.cards.length, 0);
// with this hand plus `card`, is there a throw that leaves a Rami?
const winsWith = (hand, card, rules) => { const all = [...hand, card]; return all.some(x => x !== card && findRami(all.filter(y => y !== x), rules)); };

// ---------- frames: the table after the deal and after every move ----------
function buildFrames(r) {
  const hands = {}; for (const p of r.players) hands[p] = r.initial.hands[p].slice();
  let pile = [], deck = r.initial.deck, turn = 0;
  const snap = ev => ({ hands: { [r.players[0]]: hands[r.players[0]].slice(), [r.players[1]]: hands[r.players[1]].slice() }, pile: pile.slice(), deck, turn, ev });
  const frames = [snap({ type: 'deal', by: r.starter })];
  for (const e of r.log) {
    if (e.type === 'draw') {
      if (e.source === 'discard') pile.pop(); else deck--;
      hands[e.by].push(e.card);
    } else if (e.type === 'discard' || e.type === 'rami') {
      const i = hands[e.by].indexOf(e.card); if (i >= 0) hands[e.by].splice(i, 1);
      pile.push(e.card);
      if (e.type === 'discard') turn++;
    } else if (e.type === 'reshuffle') {
      deck += pile.length - 1; pile = pile.slice(-1);
    }
    frames.push(snap(e));
  }
  return frames;
}

// ---------- stats ----------
function analyse(r, frames) {
  const rules = r.rules, [A, B] = r.players, other = p => (p === A ? B : A);
  const st = {}, progress = { [A]: [], [B]: [] }, moments = [];
  for (const p of r.players) st[p] = { deckDraws: 0, pileDraws: 0, throws: 0, jokers: r.initial.hands[p].filter(isJoker).length,
    best: 0, oneAway: 0, missedRami: 0, missedHelp: 0, heldFromDeal: 0, held: [] };

  // progress: how many cards were in melds after each of a player's turns (and at the deal)
  for (const p of r.players) {
    const v = placed(r.initial.hands[p], rules);
    progress[p].push({ i: 0, v }); st[p].best = v;
  }
  frames.forEach((f, i) => {
    const e = f.ev;
    if (e.type === 'draw') {
      if (e.source === 'deck') st[e.by].deckDraws++; else st[e.by].pileDraws++;
      if (isJoker(e.card)) { st[e.by].jokers++; moments.push({ i, kind: 'joker', by: e.by }); }
    }
    if (e.type === 'discard') {
      const p = e.by, hand = f.hands[p];
      st[p].throws++;
      const v = placed(hand, rules); progress[p].push({ i, v }); st[p].best = Math.max(st[p].best, v);
      // one card from Rami: everything but one card already sits in melds
      if (bestMelds(hand, rules).loose.length <= 1) st[p].oneAway++;
      // did the other player pass up this card?
      const q = other(p), next = frames[i + 1]?.ev;
      if (next && next.by === q && next.type === 'draw') {
        const took = next.source === 'discard';
        const qHand = f.hands[q];
        if (!took && winsWith(qHand, e.card, rules)) { st[q].missedRami++; moments.push({ i, kind: 'missedRami', by: p, to: q, card: e.card }); }
        else if (!took && placed([...qHand, e.card], rules) - placed(qHand, rules) >= 3) st[q].missedHelp++;
        if (took && r.result === 'rami' && r.winner === q && frames.slice(i + 1).every(fr => fr.ev.type !== 'discard' || fr.ev.by !== q)) {
          moments.push({ i: i + 1, kind: 'gaveWin', by: p, to: q, card: e.card });   // the thrown card won the game
        }
      }
    }
  });

  // cards held from the deal to the end
  for (const p of r.players) {
    const thrown = new Set(r.log.filter(e => e.by === p && (e.type === 'discard' || e.type === 'rami')).map(e => e.card));
    const kept = r.finalHands[p].filter(c => r.initial.hands[p].includes(c) && !thrown.has(c));
    st[p].heldFromDeal = kept.length; st[p].held = kept;
  }

  // "you had the 8♥ the whole time": cards the loser needed that the winner sat on all game
  if (r.result === 'rami') {
    const w = r.winner, l = other(w), lHand = r.finalHands[l];
    const wanted = new Set();
    for (const c of st[w].held) if (!isJoker(c) && winsWith(lHand, c, rules)) wanted.add(c);
    for (const c of wanted) moments.push({ i: frames.length - 1, kind: 'satOn', by: w, to: l, card: c });
  }

  // how the game ended
  const last = frames[frames.length - 1].ev;
  if (r.result === 'rami') {
    const lastDraw = [...r.log].reverse().find(e => e.by === r.winner && e.type === 'draw');
    moments.push({ i: frames.length - 1, kind: 'win', by: r.winner, card: lastDraw?.card, source: lastDraw?.source, turns: r.turns });
  } else if (r.result === 'resign') moments.push({ i: frames.length - 1, kind: 'resign', by: last.by });

  moments.sort((a, b) => a.i - b.i);
  return { stats: st, progress, moments };
}

const api = { buildFrames, analyse, face };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RamiReplay = api;
})(typeof self !== 'undefined' ? self : this);
