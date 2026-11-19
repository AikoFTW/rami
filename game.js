'use strict';
// Moroccan Rami rules engine. The server is the only place game state changes,
// so each player only ever receives their own hand.
const crypto = require('crypto');
const { parse, findRami, bestMelds } = require('./public/melds.js');

const SUITS = ['S', 'H', 'D', 'C'];

// House rules. Every game copies these when it is dealt, so changing them
// never affects a game in progress.
const DEFAULT_RULES = {
  jokers: 4,              // 0-4 jokers in the two decks
  handSize: 14,           // cards each; the starter gets one extra
  minMeld: 3,             // smallest swivi / tirci
  minSwivi: 2,            // swivis a winning hand needs (same suit, in a row)
  minTirci: 2,            // tircis a winning hand needs (same number, different suits)
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
  r.minSwivi = int(input.minSwivi, 0, 4, r.minSwivi);
  r.minTirci = int(input.minTirci, 0, 4, r.minTirci);
  for (const k of ['aceLow', 'aceHigh', 'allowDiscardPickup'])
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

// Errors carry a code so the browser can show them in the player's language.
function err(code, message) { const e = new Error(message); e.code = code; return e; }

const other = (g, id) => g.players.find(p => p !== id);

function apply(g, uid, move) {
  if (g.rules.minSwivi === undefined) { g.rules.minSwivi = g.rules.requireSwivi === false ? 0 : 1; g.rules.minTirci = g.rules.requireTirci === false ? 0 : 1; }
  if (g.winner || g.result) throw err('over', 'This game is over.');
  if (!g.players.includes(uid)) throw err('notInGame', 'You are not in this game.');
  const hand = g.hands[uid];

  if (move.type === 'reorder') {
    const order = Array.isArray(move.order) ? move.order : [];
    if (order.length !== hand.length || [...order].sort().join() !== [...hand].sort().join())
      throw err('handChanged', 'Hand changed, refresh.');
    g.hands[uid] = order;
    return { quiet: true };
  }
  if (move.type === 'resign') {
    g.winner = other(g, uid); g.result = 'resign'; g.endedAt = Date.now();
    g.log.push({ by: uid, type: 'resign', at: Date.now() });
    return {};
  }
  if (g.turn !== uid) throw err('notYourTurn', "It's not your turn.");

  if (move.type === 'draw') {
    if (g.phase !== 'draw') throw err('alreadyDrew', 'You already drew. Discard a card.');
    let card;
    if (move.source === 'discard') {
      if (!g.rules.allowDiscardPickup) throw err('noPickup', 'Picking up from the discard pile is off in your house rules.');
      if (!g.discard.length) throw err('discardEmpty', 'The discard pile is empty.');
      card = g.discard.pop();
    } else {
      if (!g.deck.length) {
        if (g.discard.length < 2) throw err('noCards', 'No cards left to draw.');
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
    if (g.phase !== 'discard') throw err('drawFirst', 'Draw a card first.');
    const i = hand.indexOf(move.card);
    if (i < 0) throw err('notInHand', 'That card is not in your hand.');
    const rest = hand.filter((_, k) => k !== i);
    if (move.type === 'declare') {
      const melds = findRami(rest, g.rules);
      if (!melds) {
        throw err('notRami', `Not a Rami yet. Every card except your discard has to be in a meld, with at least ${g.rules.minSwivi} swivi and ${g.rules.minTirci} tirci.`);
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
  throw err('unknownMove', 'Unknown move.');
}

// What one player is allowed to see.
function view(g, uid) {
  if (!g) return null;
  if (g.rules.minSwivi === undefined) { g.rules.minSwivi = g.rules.requireSwivi === false ? 0 : 1; g.rules.minTirci = g.rules.requireTirci === false ? 0 : 1; }
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

module.exports = { DEFAULT_RULES, cleanRules, newGame, apply, view, findRami, bestMelds, parse };
