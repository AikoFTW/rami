// Meld logic shared by the server (require) and the browser (window.RamiMelds).
(function (root) {
'use strict';

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

  const needS = rules.minSwivi ?? 0, needT = rules.minTirci ?? 0;
  function rec(nat, jok, nS, nT) {
    if (!nat.length) {
      if (jok.length) return null;
      if (nS < needS || nT < needT) return null;
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
        const r = rec(nr, jok.slice(j), nS, nT + 1);
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
            const tail = rec(pool, jok.slice(used), nS + 1, nT);
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

  return rec(nat, jok, 0, 0);
}


// ---------- Best melds so far (for highlighting a hand) ----------
// Finds the melds that cover the most real cards, using as few jokers as
// possible. Doesn't require a swivi or tirci: it shows progress, not a win.
// Returns { melds: [{type, cards}], loose: [ids in their original order] }.
function bestMelds(ids, rules) {
  const nat = ids.map(parse).filter(c => !c.joker)
    .sort((a, b) => a.s.localeCompare(b.s) || a.r - b.r);
  const jokers = ids.filter(id => id[0] === 'J');
  const maxJ = rules.maxJokersPerMeld;
  const lowest = rules.aceLow ? 1 : 2, highest = rules.aceHigh ? 14 : 13;
  const memo = new Map();

  function rec(nat, jn) {
    if (!nat.length) return { score: 0, jUsed: 0, melds: [] };
    const key = nat.map(c => c.id).join(',') + '|' + jn;
    if (memo.has(key)) return memo.get(key);
    const c = nat[0], rest = nat.slice(1);
    let best = rec(rest, jn);   // option: this card stays loose
    const consider = (type, cards, natUsed, j, pool) => {
      const sub = rec(pool, jn - j);
      const score = sub.score + natUsed, jUsed = sub.jUsed + j;
      if (score > best.score || (score === best.score && jUsed < best.jUsed))
        best = { score, jUsed, melds: [{ type, cards }, ...sub.melds] };
    };
    const jMax = Math.min(jn, maxJ);

    // tirci
    const bySuit = {};
    for (const x of rest) if (x.r === c.r && x.s !== c.s && !bySuit[x.s]) bySuit[x.s] = x;
    const others = Object.values(bySuit);
    for (let mask = 0; mask < (1 << others.length); mask++) {
      const pick = others.filter((_, i) => (mask >> i) & 1);
      const n = 1 + pick.length;
      for (let j = 0; j <= jMax && n + j <= 4; j++) {
        if (n + j < rules.minMeld) continue;
        consider('tirci', [c.id, ...pick.map(x => x.id), ...Array(j).fill(null)], n, j, rest.filter(x => !pick.includes(x)));
      }
    }

    // swivi
    const positions = c.r === 1 ? [rules.aceLow && 1, rules.aceHigh && 14].filter(Boolean) : [c.r];
    for (const p of positions) {
      const sMin = p === 14 ? 2 : Math.max(lowest, p - jMax);
      for (let s = sMin; s <= p; s++) {
        for (let e = Math.max(p, s + rules.minMeld - 1); e <= Math.min(highest, s + 12); e++) {
          const meld = [];
          (function step(q, pool, j, natUsed) {
            if (q > e) return consider('swivi', meld.slice(), natUsed, j, pool);
            if (q === p) { meld.push(c.id); step(q + 1, pool, j, natUsed + 1); meld.pop(); return; }
            const rank = q === 14 ? 1 : q;
            const i = pool.findIndex(x => x.s === c.s && x.r === rank);
            if (i >= 0) { const np = pool.slice(); const [x] = np.splice(i, 1); meld.push(x.id); step(q + 1, np, j, natUsed + 1); meld.pop(); }
            if (j < jMax) { meld.push(null); step(q + 1, pool, j + 1, natUsed); meld.pop(); }
          })(s, rest, 0, 0);
        }
      }
    }
    memo.set(key, best);
    return best;
  }

  const r = rec(nat, jokers.length);
  let k = 0;
  const melds = r.melds.map(m => ({ type: m.type, cards: m.cards.map(x => x === null ? jokers[k++] : x) }));
  const used = new Set(melds.flatMap(m => m.cards));
  return { melds, loose: ids.filter(id => !used.has(id)) };
}

// ---------- What a joker stands for inside a meld ----------
// Returns {r, s} for a swivi slot, {r} for a tirci, or null.
function jokerStandsFor(meld, index) {
  const cards = meld.cards.map(parse);
  if (meld.type === 'tirci') { const n = cards.find(c => !c.joker); return n ? { r: n.r } : null; }
  // pick a natural card to anchor positions; prefer a non-ace
  let anchor = cards.findIndex(c => !c.joker && c.r !== 1);
  let start;
  if (anchor >= 0) start = cards[anchor].r - anchor;
  else { anchor = cards.findIndex(c => !c.joker); if (anchor < 0) return null; start = (anchor === 0 ? 1 : 14) - anchor; }
  if (start + cards.length - 1 > 14) return null;
  const pos = start + index;
  const suit = cards.find(c => !c.joker).s;
  return { r: pos === 14 ? 1 : pos, s: suit };
}

// ---------- Where could a joker go? ----------
// Options built from the natural cards in `ids`: fill a gap or extend a run,
// or join a tirci. Each option is a ready meld with 'JOKER' marking the joker's spot.
function jokerOptions(ids, rules) {
  if (rules.maxJokersPerMeld < 1) return [];
  const nat = ids.map(parse).filter(c => !c.joker);
  const out = [];
  // tirci: same rank, distinct suits
  const byRank = {};
  for (const c of nat) { byRank[c.r] = byRank[c.r] || {}; if (!byRank[c.r][c.s]) byRank[c.r][c.s] = c.id; }
  for (const [r, suits] of Object.entries(byRank)) {
    const k = Object.keys(suits).length;
    if (k + 1 >= rules.minMeld && k + 1 <= 4) out.push({ type: 'tirci', cards: [...Object.values(suits), 'JOKER'], stands: { r: +r } });
  }
  // swivi: a missing slot next to a run of naturals
  const lowest = rules.aceLow ? 1 : 2, highest = rules.aceHigh ? 14 : 13;
  for (const s of ['S', 'H', 'D', 'C']) {
    const at = {};
    for (const c of nat) if (c.s === s) {
      if (c.r === 1) { if (rules.aceLow && !at[1]) at[1] = c.id; if (rules.aceHigh && !at[14]) at[14] = c.id; }
      else if (!at[c.r]) at[c.r] = c.id;
    }
    for (let m = lowest; m <= highest; m++) {
      if (at[m] || !(at[m - 1] || at[m + 1])) continue;
      let L = m, R = m;
      while (L - 1 >= lowest && at[L - 1]) L--;
      while (R + 1 <= highest && at[R + 1]) R++;
      if (R - L + 1 > 13) { if (m === L) R--; else L++; }      // an ace can't sit at both ends
      if (R - L + 1 < rules.minMeld) continue;
      const cards = [];
      for (let q = L; q <= R; q++) cards.push(q === m ? 'JOKER' : at[q]);
      if (new Set(cards).size !== cards.length) continue;      // same ace used twice
      out.push({ type: 'swivi', cards, stands: { r: m === 14 ? 1 : m, s } });
    }
  }
  return out;
}

// ---------- What would one card do for this hand? ----------
function cardPotential(base, card, rules) {
  const placed = r => r.melds.reduce((n, m) => n + m.cards.length, 0);
  const before = bestMelds(base, rules), after = bestMelds([...base, card], rules);
  const meld = after.melds.find(m => m.cards.includes(card)) || null;
  const gain = placed(after) - placed(before);
  const partners = [];
  const c = parse(card);
  if (!meld && !c.joker) {
    const pos = x => x.r === 1 ? [1, 14] : [x.r];
    for (const id of after.loose) {
      if (id === card) continue;
      const o = parse(id); if (o.joker) continue;
      if (o.r === c.r && o.s !== c.s) partners.push({ type: 'tirci', id });
      else if (o.s === c.s && pos(o).some(a => pos(c).some(b => Math.abs(a - b) <= 2 && a !== b))) partners.push({ type: 'swivi', id });
    }
  }
  return { meld, gain, partners };
}

const api = { parse, findRami, bestMelds, jokerOptions, jokerStandsFor, cardPotential };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.RamiMelds = api;
})(typeof self !== 'undefined' ? self : this);
