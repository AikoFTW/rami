'use strict';
// Moroccan Rami rules engine. The server is the only place game state changes,
// so each player only ever receives their own hand.
const crypto = require('crypto');

const SUITS = ['S', 'H', 'D', 'C'];

// House rules. Every game copies these when it is dealt, so changing them
// never affects a game in progress.
const DEFAULT_RULES = {
  jokers: 4,              // 0-4 jokers in the two decks
  handSize: 14,           // cards each; the starter gets one extra
  minMeld: 3,             // smallest swivi / tirci
  requireSwivi: true,     // winning hand must contain at least one swivi
  requireTirci: true,     // ...and at least one tirci
  aceLow: true,           // A-2-3
  aceHigh: true,          // Q-K-A
  maxJokersPerMeld: 4,    // limit jokers inside one meld
  allowDiscardPickup: true,
  starter: 'alternate',   // alternate | loser | winner
};

function cleanRules(input) {
  const r = { ...DEFAULT_RULES };
  if (!input || typeof input !== 'object') return r;
  const int = (v, lo, hi, d) => (Number.isInteger(+v) && +v >= lo && +v <= hi ? +v : d);
  r.jokers = int(input.jokers, 0, 4, r.jokers);
  r.handSize = int(input.handSize, 7, 20, r.handSize);
  r.minMeld = int(input.minMeld, 3, 4, r.minMeld);
  r.maxJokersPerMeld = int(input.maxJokersPerMeld, 0, 4, r.maxJokersPerMeld);
  for (const k of ['requireSwivi', 'requireTirci', 'aceLow', 'aceHigh', 'allowDiscardPickup'])
    if (typeof input[k] === 'boolean') r[k] = input[k];
  if (['alternate', 'loser', 'winner'].includes(input.starter)) r.starter = input.starter;
  return r;
}

// Card ids: "<rank>-<suit>-<deck>" e.g. "12-H-1" (queen of hearts, 2nd deck); jokers "J-0".."J-3"
function makeDeck(jokers) {
  const deck = [];
  for (let d = 0; d < 2; d++) for (const s of SUITS) for (let r = 1; r <= 13; r++) deck.push(`${r}-${s}-${d}`);
  for (let j = 0; j < jokers; j++) deck.push(`J-${j}`);
  return shuffle(deck);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parse(id) {
  if (id[0] === 'J') return { id, joker: true };
  const [r, s] = id.split('-');
  return { id, r: +r, s };
}

// ---------- Rami check ----------
// Finds a way to split `ids` into melds that satisfies the rules,
// or returns null. Returns [{type:'swivi'|'tirci', cards:[ids]}].
function findRami(ids, rules) {
  const nat = ids.map(parse).filter(c => !c.joker)
    .sort((a, b) => a.s.localeCompare(b.s) || a.r - b.r);
  const jok = ids.filter(id => id[0] === 'J');
  const maxJ = rules.maxJokersPerMeld;

  function rec(nat, jok, hasSwivi, hasTirci) {
    if (!nat.length) {
      if (jok.length) return null;
      if (rules.requireSwivi && !hasSwivi) return null;
      if (rules.requireTirci && !hasTirci) return null;
      return [];
    }
    const c = nat[0], rest = nat.slice(1);

    // tirci: same rank, all different suits (max 4 cards)
    const bySuit = {};
    for (const x of rest) if (x.r === c.r && x.s !== c.s && !bySuit[x.s]) bySuit[x.s] = x;
    const others = Object.values(bySuit);
    for (let mask = 0; mask < (1 << others.length); mask++) {
      const pick = others.filter((_, i) => (mask >> i) & 1);
      const n = 1 + pick.length;
      for (let j = 0; j <= Math.min(jok.length, maxJ) && n + j <= 4; j++) {
        if (n + j < rules.minMeld) continue;
        const nr = rest.filter(x => !pick.includes(x));
        const r = rec(nr, jok.slice(j), hasSwivi, true);
        if (r) return [{ type: 'tirci', cards: [c.id, ...pick.map(x => x.id), ...jok.slice(0, j)] }, ...r];
      }
    }

    // swivi: same suit, consecutive. Position 1 = low ace, 14 = high ace. No wrap-around.
    const positions = [];
    if (c.r === 1) { if (rules.aceLow) positions.push(1); if (rules.aceHigh) positions.push(14); }
    else positions.push(c.r);
    const lowest = rules.aceLow ? 1 : 2, highest = rules.aceHigh ? 14 : 13;
    for (const p of positions) {
      // a high ace sits at the top, so the run can start anywhere below it
      const sMin = p === 14 ? 2 : Math.max(lowest, p - Math.min(jok.length, maxJ));
      for (let s = sMin; s <= p; s++) {
        for (let e = Math.max(p, s + rules.minMeld - 1); e <= Math.min(highest, s + 12); e++) {
          const r = fillRun(s, e, p, c, rest, jok, maxJ, (pool, used, meld) => {
            const tail = rec(pool, jok.slice(used), true, hasTirci);
            return tail ? [{ type: 'swivi', cards: meld }, ...tail] : null;
          });
          if (r) return r;
        }
      }
    }
    return null;
  }

  // Walk positions s..e; at each one use a natural card if present, or a joker.
  function fillRun(s, e, p, c, pool, jok, maxJ, done) {
    const meld = [];
    function step(q, pool, used) {
      if (q > e) {
        let k = 0;
        const cards = meld.map(x => x ?? jok[k++]);
        return done(pool, used, cards);
      }
      if (q === p) { meld.push(c.id); const r = step(q + 1, pool, used); meld.pop(); return r; }
      const rank = q === 14 ? 1 : q;
      const i = pool.findIndex(x => x.s === c.s && x.r === rank);
      if (i >= 0) {
        const np = pool.slice(); const [x] = np.splice(i, 1);
        meld.push(x.id); const r = step(q + 1, np, used); meld.pop();
        if (r) return r;
      }
      if (used < Math.min(jok.length, maxJ)) {
        meld.push(null); const r = step(q + 1, pool, used + 1); meld.pop();
        if (r) return r;
      }
      return null;
    }
    return step(s, pool, 0);
  }

  return rec(nat, jok, false, false);
}

// ---------- Game lifecycle ----------
function newGame({ no, players, starter, rules }) {
  const deck = makeDeck(rules.jokers);
  const hands = {};
  for (const p of players) hands[p] = deck.splice(0, rules.handSize + (p === starter ? 1 : 0));
  return {
    no, players, rules, starter,
    deck, discard: [], hands,
    turn: starter, phase: 'discard',   // starter has the extra card and opens by discarding
    turns: 0, log: [], lastDrawn: {},
    startedAt: Date.now(), endedAt: null,
    winner: null, result: null,
  };
}

const other = (g, id) => g.players.find(p => p !== id);

function apply(g, uid, move) {
  if (g.winner || g.result) throw new Error('This game is over.');
  if (!g.players.includes(uid)) throw new Error('You are not in this game.');
  const hand = g.hands[uid];

  if (move.type === 'reorder') {
    const order = Array.isArray(move.order) ? move.order : [];
    if (order.length !== hand.length || [...order].sort().join() !== [...hand].sort().join())
      throw new Error('Hand changed, refresh.');
    g.hands[uid] = order;
    return { quiet: true };
  }
  if (move.type === 'resign') {
    g.winner = other(g, uid); g.result = 'resign'; g.endedAt = Date.now();
    g.log.push({ by: uid, type: 'resign', at: Date.now() });
    return {};
  }
  if (g.turn !== uid) throw new Error("It's not your turn.");

  if (move.type === 'draw') {
    if (g.phase !== 'draw') throw new Error('You already drew. Discard a card.');
    let card;
    if (move.source === 'discard') {
      if (!g.rules.allowDiscardPickup) throw new Error('Picking up from the discard pile is off in your house rules.');
      if (!g.discard.length) throw new Error('The discard pile is empty.');
      card = g.discard.pop();
    } else {
      if (!g.deck.length) {
        if (g.discard.length < 2) throw new Error('No cards left to draw.');
        const top = g.discard.pop();
        g.deck = shuffle(g.discard); g.discard = [top];
        g.log.push({ by: null, type: 'reshuffle', at: Date.now() });
      }
      card = g.deck.pop();
    }
    hand.push(card);
    g.lastDrawn[uid] = card;
    g.phase = 'discard';
    g.log.push({ by: uid, type: 'draw', source: move.source === 'discard' ? 'discard' : 'deck',
      card: move.source === 'discard' ? card : undefined, at: Date.now() });
    return {};
  }

  if (move.type === 'discard' || move.type === 'declare') {
    if (g.phase !== 'discard') throw new Error('Draw a card first.');
    const i = hand.indexOf(move.card);
    if (i < 0) throw new Error('That card is not in your hand.');
    const rest = hand.filter((_, k) => k !== i);
    if (move.type === 'declare') {
      const melds = findRami(rest, g.rules);
      if (!melds) {
        const need = [g.rules.requireSwivi && 'a swivi', g.rules.requireTirci && 'a tirci'].filter(Boolean);
        throw new Error(`Not a Rami yet. Every card except your discard has to be in a meld${need.length ? `, including ${need.join(' and ')}` : ''}.`);
      }
      g.hands[uid] = rest; g.discard.push(move.card);
      g.winner = uid; g.result = 'rami'; g.endedAt = Date.now(); g.melds = melds;
      g.turns++;
      g.log.push({ by: uid, type: 'rami', card: move.card, at: Date.now() });
      return {};
    }
    g.hands[uid] = rest; g.discard.push(move.card);
    delete g.lastDrawn[uid];
    g.turn = other(g, uid); g.phase = 'draw'; g.turns++;
    g.log.push({ by: uid, type: 'discard', card: move.card, at: Date.now() });
    return {};
  }
  throw new Error('Unknown move.');
}

// What one player is allowed to see.
function view(g, uid) {
  if (!g) return null;
  const over = !!(g.winner || g.result);
  const opp = other(g, uid);
  return {
    no: g.no, players: g.players, rules: g.rules, starter: g.starter,
    turn: g.turn, phase: g.phase, turns: g.turns,
    deckCount: g.deck.length, discardTop: g.discard[g.discard.length - 1] || null,
    discardCount: g.discard.length,
    myHand: g.hands[uid] || null,
    lastDrawn: g.lastDrawn[uid] || null,
    counts: Object.fromEntries(g.players.map(p => [p, g.hands[p].length])),
    // the opponent's hand is revealed only when the game ends
    oppHand: over && opp ? g.hands[opp] : null,
    log: g.log.slice(-40).map(e => ({ ...e })),
    winner: g.winner, result: g.result, melds: over ? g.melds || null : null,
    startedAt: g.startedAt, endedAt: g.endedAt,
  };
}

module.exports = { DEFAULT_RULES, cleanRules, newGame, apply, view, findRami, parse };
