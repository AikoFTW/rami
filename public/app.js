'use strict';
{
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK = r => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[r] || String(r);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const FELTS = ['#0d4f43', '#134a6b', '#6b1f2a', '#3b2a55', '#2f3a2a', '#5a3a1c'];

  let S = null;            // last state from the server
  let sel = null;          // selected card id
  let dragId = null;
  let wasMyTurn = false;
  let reorderTimer = null;

  // ---------- server ----------
  async function call(url, body) {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !['/api/login', '/api/signup'].includes(url)) { S = null; renderLogin(); throw new Error('signed out'); }
    if (!r.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }
  async function refresh() {
    try { S = await call('/api/state'); applyPrefs(); render(); } catch (e) { if (e.message !== 'signed out') toast(e.message); }
  }
  async function move(m) {
    try { await call('/api/game/move', m); if (m.type !== 'reorder') { sel = null; await refresh(); } }
    catch (e) { toast(e.message); }
  }
  let es = null;
  function listen() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('update', refresh);
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3800);
  }

  // ---------- helpers ----------
  const parse = id => id[0] === 'J' ? { joker: true } : { r: +id.split('-')[0], s: id.split('-')[1] };
  const label = id => { const c = parse(id); return c.joker ? 'Joker' : RANK(c.r) + SUIT[c.s]; };
  const labelHTML = id => { const c = parse(id); return c.joker ? '<b>Joker</b>' : `<b class="s-${c.s}">${RANK(c.r)}${SUIT[c.s]}</b>`; };
  const nameOf = id => S?.users.find(u => u.id === id)?.name || 'Someone';
  const me = () => S.me.id;

  function cardHTML(id, extra = '', tag = 'div') {
    if (!id) return `<div class="empty-slot"></div>`;
    const c = parse(id);
    if (c.joker) return `<${tag} class="card joker ${extra}" data-id="${id}" aria-label="Joker"><span class="tl">JOKER</span><span class="pip">★</span></${tag}>`;
    const face = c.r === 1 || c.r > 10;
    return `<${tag} class="card s-${c.s} ${extra}" data-id="${id}" aria-label="${RANK(c.r)} of ${({ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' })[c.s]}">` +
      `<span class="tl">${RANK(c.r)}<i>${SUIT[c.s]}</i></span><span class="pip${face ? ' face' : ''}">${face ? RANK(c.r) : SUIT[c.s]}</span></${tag}>`;
  }
  const back = (extra = '') => `<div class="card back ${extra}" aria-hidden="true"></div>`;

  function sortHand(hand, by) {
    const key = id => { const c = parse(id); if (c.joker) return [9, 99];
      return by === 'rank' ? [c.r, 'SHDC'.indexOf(c.s)] : ['SHDC'.indexOf(c.s), c.r]; };
    return [...hand].sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; });
  }
  function sendOrder(order) {
    S.game.myHand = order; renderPlay();
    clearTimeout(reorderTimer);
    reorderTimer = setTimeout(() => move({ type: 'reorder', order }), 400);
  }

  function applyPrefs() {
    const p = S?.me.prefs || {};
    const root = document.documentElement;
    root.style.setProperty('--felt', p.felt || FELTS[0]);
    if (p.theme && p.theme !== 'auto') root.dataset.theme = p.theme; else delete root.dataset.theme;
    document.body.classList.toggle('four', p.deckColors === 'four');
    document.body.classList.remove('card-s', 'card-l');
    if (p.cardSize === 's') document.body.classList.add('card-s');
    if (p.cardSize === 'l') document.body.classList.add('card-l');
  }

  function chime() {
    if (!S?.me.prefs?.sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [660, 880].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        const t = ctx.currentTime + i * 0.14;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.start(t); o.stop(t + 0.32);
      });
    } catch {}
  }

  // ---------- login ----------
  async function renderLogin(err = '', mode) {
    if (es) { es.close(); es = null; }
    const pub = await fetch('/api/public').then(r => r.json()).catch(() => ({}));
    if (!pub.signupOpen) mode = 'in';
    mode = mode || 'in';
    const up = mode === 'up';
    app.innerHTML = `<div class="login"><form id="lf">
      <div class="fan">${cardHTML('12-H-0')}${cardHTML('J-0')}${cardHTML('1-S-0')}</div>
      <h1>Rami</h1>
      ${up ? '<p class="hint center-text">Create your account. Sign-up closes once both players have one.</p>' : ''}
      <label>Name <input name="name" type="text" autocomplete="username" required maxlength="24"></label>
      <label>Password <input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required minlength="${up ? 6 : 1}"></label>
      <p class="err">${esc(err)}</p>
      <button class="btn primary big">${up ? 'Create account' : 'Sign in'}</button>
      ${pub.signupOpen ? `<button type="button" class="btn" id="swap">${up ? 'I already have an account' : 'Create an account'}</button>` : ''}
    </form></div>`;
    $('#swap')?.addEventListener('click', () => renderLogin('', up ? 'in' : 'up'));
    $('#lf').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await call(up ? '/api/signup' : '/api/login', { name: f.get('name'), password: f.get('password') }); listen(); await refresh(); }
      catch (x) { renderLogin(x.message, mode); }
    });
    $('#lf input').focus();
  }

  // ---------- shell ----------
  const route = () => (location.hash.slice(1) || 'play');
  function render() {
    if (!S) return;
    const r = route();
    const links = [['play', 'Play'], ['stats', 'Stats'], ['history', 'History'], ['settings', 'Settings']]
      .map(([k, t]) => `<a href="#${k}"${r === k ? ' aria-current="page"' : ''}>${t}</a>`).join('');
    app.innerHTML = `<header class="top">
      <a class="brand" href="#play"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M32 8l6 10 11-3-3 11 10 6-10 6 3 11-11-3-6 10-6-10-11 3 3-11-10-6 10-6-3-11 11 3z"/></svg>Rami</a>
      <nav>${links}</nav>
      <span class="who">${esc(S.me.name)} <button id="out">Sign out</button></span></header><main id="main"></main>`;
    $('#out').addEventListener('click', async () => { await call('/api/logout', {}).catch(() => {}); S = null; renderLogin(); });
    ({ play: renderPlay, stats: renderStats, history: renderHistory, settings: renderSettings }[r] || renderPlay)();

    const g = S.game, mine = !!(g && !g.winner && !g.result && g.turn === me());
    document.title = mine ? '● Your turn · Rami' : 'Rami';
    if (mine && !wasMyTurn) chime();
    wasMyTurn = mine;
  }

  function scoreboard(g) {
    const ids = g ? g.players : [me(), ...S.users.filter(u => u.id !== me()).map(u => u.id)].slice(0, 2);
    const [a, b] = [ids.includes(me()) ? me() : ids[0], ids.find(x => x !== (ids.includes(me()) ? me() : ids[0]))];
    const st = S.stats.players;
    const live = g && !g.winner && !g.result;
    const p = (id, right) => id ? `<div class="p${right ? ' right' : ''}">${!right && live && g.turn === id ? '<span class="turn-dot" title="Their turn"></span>' : ''}
      ${right ? `<span>${esc(nameOf(id))}</span><span class="num">${st[id]?.wins ?? 0}</span>` : `<span class="num">${st[id]?.wins ?? 0}</span><span>${esc(nameOf(id))}${id === me() ? ' (you)' : ''}</span>`}
      ${right && live && g.turn === id ? '<span class="turn-dot" title="Their turn"></span>' : ''}</div>` : '<div></div>';
    return `<div class="score">${p(a)}<span class="vs">wins</span>${p(b, true)}</div>`;
  }

  // ---------- play ----------
  function statusText(g, oppId) {
    if (g.winner || g.result) return '';
    const last = [...g.log].reverse().find(e => e.by === oppId && e.type !== 'reshuffle');
    if (g.turn !== me()) {
      const did = last ? (last.type === 'discard' ? `They threw away ${labelHTML(last.card)}.` :
        last.type === 'draw' ? (last.source === 'discard' ? `They took ${labelHTML(last.card)} from the pile.` : 'They drew from the deck.') : '') : '';
      return `Waiting for ${esc(nameOf(oppId))}…<span class="sub">${did}</span>`;
    }
    if (g.phase === 'draw') {
      const top = g.discardTop ? ` or take ${labelHTML(g.discardTop)}` : '';
      return `Your turn. Draw from the deck${g.rules.allowDiscardPickup ? top : ''}.`;
    }
    if (g.turns === 0 && g.starter === me()) return `You start with ${g.myHand.length} cards. Throw one away.<span class="sub">Or declare Rami if you already have it.</span>`;
    return `Pick a card to throw away.<span class="sub">If everything else forms melds, declare Rami.</span>`;
  }

  function logLine(e) {
    const who = e.by ? `<b>${esc(nameOf(e.by))}</b>` : '';
    switch (e.type) {
      case 'draw': return e.source === 'discard' ? `${who} took ${labelHTML(e.card)}` : `${who} drew from the deck`;
      case 'discard': return `${who} threw ${labelHTML(e.card)}`;
      case 'rami': return `${who} declared <b>Rami!</b>`;
      case 'resign': return `${who} resigned`;
      case 'reshuffle': return 'Deck ran out: discard pile reshuffled';
    }
    return '';
  }

  function rulesSummary(r) {
    return [`${r.jokers} joker${r.jokers === 1 ? '' : 's'}`, `${r.handSize} cards`, `melds of ${r.minMeld}+`,
      r.requireSwivi && r.requireTirci ? 'needs a swivi and a tirci' : r.requireSwivi ? 'needs a swivi' : r.requireTirci ? 'needs a tirci' : 'any melds',
      r.aceLow && r.aceHigh ? 'ace low or high' : r.aceHigh ? 'ace high only' : 'ace low only'].join(' · ');
  }

  function renderPlay() {
    const main = $('#main'); if (!main) return;
    const g = S.game;
    if (S.users.length < 2) {
      main.innerHTML = `${scoreboard(null)}<div class="panel"><h2>Waiting for your partner</h2>
        <p>Send them this page's address. They can tap <b>Create an account</b> on the sign-in screen, and the game will be ready once they do.</p></div>`;
      return;
    }
    if (!g || (!g.players.includes(me()))) {
      main.innerHTML = `${scoreboard(null)}<div class="table"><div class="row center"><div class="status">No game on the table yet.
        <span class="sub">${esc(rulesSummary(S.rules))}</span></div></div>
        <div class="actions"><button class="btn primary big" id="deal">Deal a new game</button></div></div>`;
      $('#deal').addEventListener('click', deal);
      return;
    }
    const oppId = g.players.find(p => p !== me());
    const over = !!(g.winner || g.result);
    const myTurn = !over && g.turn === me();
    const canDraw = myTurn && g.phase === 'draw';
    const canDiscard = myTurn && g.phase === 'discard';
    const hand = g.myHand || [];

    main.innerHTML = `${scoreboard(g)}<div class="layout"><div>
      <div class="table">
        <div class="row opp"><div class="opp-name">${esc(nameOf(oppId))} <span class="badge">${g.counts[oppId]} cards</span></div>
          <div class="backs">${over ? '' : Array.from({ length: Math.min(g.counts[oppId], 16) }, () => back()).join('')}</div></div>
        <div class="row center">
          <button class="pile ${canDraw ? 'can' : ''}" id="deck" ${canDraw ? '' : 'disabled'} aria-label="Draw from the deck">${g.deckCount ? back() : '<div class="empty-slot"></div>'}<small>Deck · ${g.deckCount}</small></button>
          <div class="status">${over ? (g.winner === me() ? '<b>You won!</b>' : `<b>${esc(nameOf(g.winner))} won.</b>`) : statusText(g, oppId)}</div>
          <button class="pile ${canDraw && g.discardTop && g.rules.allowDiscardPickup ? 'can' : ''}" id="pile" ${canDraw && g.discardTop && g.rules.allowDiscardPickup ? '' : 'disabled'} aria-label="Take the top discard">${cardHTML(g.discardTop)}<small>Discard · ${g.discardCount}</small></button>
        </div>
        <div class="hand-wrap">
          <div class="hand" id="hand">${hand.map(id => cardHTML(id, `${id === sel ? 'sel' : ''} ${id === g.lastDrawn && !over ? 'new' : ''}`, 'button')).join('')}</div>
          ${over ? '' : `<div class="actions">
            <button class="btn" id="sortSuit">Sort by suit</button>
            <button class="btn" id="sortRank">Sort by rank</button>
            <button class="btn" id="discard" ${canDiscard && sel ? '' : 'disabled'}>Throw ${sel ? esc(label(sel)) : 'card'}</button>
            <button class="btn primary" id="declare" ${canDiscard && sel ? '' : 'disabled'}>Declare Rami</button></div>
          <p class="hint">Tap a card to select it. Tap another card to move it there, or drag on a computer.</p>`}
        </div>
      </div>
      ${over ? resultPanel(g, oppId) : ''}
    </div>
    <aside class="log"><h3>Game ${g.no}</h3><ol>${[...g.log].reverse().map(e => `<li>${logLine(e)}</li>`).join('')}</ol>
      ${over ? '' : `<p><button class="btn danger" id="resign">Resign game</button></p>`}<p class="hint">${esc(rulesSummary(g.rules))}</p></aside></div>`;

    $('#deck').addEventListener('click', () => move({ type: 'draw', source: 'deck' }));
    $('#pile').addEventListener('click', () => move({ type: 'draw', source: 'discard' }));
    if (over) { $('#again')?.addEventListener('click', deal); return; }
    $('#resign').addEventListener('click', resign);
    $('#sortSuit').addEventListener('click', () => sendOrder(sortHand(hand, 'suit')));
    $('#sortRank').addEventListener('click', () => sendOrder(sortHand(hand, 'rank')));
    $('#discard').addEventListener('click', () => move({ type: 'discard', card: sel }));
    $('#declare').addEventListener('click', () => move({ type: 'declare', card: sel }));
    bindHand(hand);
  }

  function bindHand(hand) {
    const el = $('#hand');
    el.querySelectorAll('.card').forEach(c => {
      const id = c.dataset.id;
      c.draggable = true;
      c.addEventListener('click', () => {
        if (sel && sel !== id) {         // move selected card to this spot
          const order = hand.filter(x => x !== sel); order.splice(order.indexOf(id), 0, sel);
          sel = null; sendOrder(order); return;
        }
        sel = sel === id ? null : id; renderPlay();
      });
      c.addEventListener('dragstart', e => { dragId = id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      c.addEventListener('dragend', () => { dragId = null; c.classList.remove('dragging'); });
      c.addEventListener('dragover', e => { if (dragId && dragId !== id) { e.preventDefault(); c.classList.add('drag-over'); } });
      c.addEventListener('dragleave', () => c.classList.remove('drag-over'));
      c.addEventListener('drop', e => {
        e.preventDefault(); c.classList.remove('drag-over');
        if (!dragId || dragId === id) return;
        const order = hand.filter(x => x !== dragId); order.splice(order.indexOf(id), 0, dragId);
        sendOrder(order);
      });
    });
  }

  function resultPanel(g, oppId) {
    const iWon = g.winner === me();
    const how = g.result === 'resign' ? `${esc(nameOf(g.players.find(p => p !== g.winner)))} resigned.` : `Won in ${g.turns} turns with this Rami:`;
    const melds = (g.melds || []).map(m => `<div class="meld"><span class="meld-label">${m.type === 'swivi' ? 'Swivi' : 'Tirci'}</span>${m.cards.map(c => cardHTML(c, 'mini')).join('')}</div>`).join('');
    const loserHand = iWon ? g.oppHand : g.myHand;
    return `<div class="result"><h2>${iWon ? 'Rami! You win.' : `${esc(nameOf(g.winner))} wins.`}</h2><p>${how}</p>
      ${melds ? `<div class="melds">${melds}</div>` : ''}
      ${loserHand && g.result === 'rami' ? `<p><b>${iWon ? esc(nameOf(oppId)) + "'s" : 'Your'} hand:</b></p><div class="melds"><div class="meld">${loserHand.map(c => cardHTML(c, 'mini')).join('')}</div></div>` : ''}
      <button class="btn primary big" id="again">Deal next game</button></div>`;
  }

  async function deal() {
    try { await call('/api/game/new', {}); sel = null; await refresh(); } catch (e) { toast(e.message); }
  }
  function resign() {
    const b = $('#resign');
    if (b.dataset.confirm) return move({ type: 'resign' });
    b.dataset.confirm = '1'; b.textContent = 'Tap again to resign';
    setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = 'Resign game'; } }, 4000);
  }

  // ---------- stats ----------
  function renderStats() {
    const st = S.stats, ids = Object.keys(st.players);
    const [a, b] = [me(), ids.find(x => x !== me())];
    const wa = st.players[a]?.wins || 0, wb = b ? st.players[b].wins : 0, tot = wa + wb;
    const card = id => { const p = st.players[id]; if (!p) return '';
      return `<div class="panel"><h2>${esc(nameOf(id))}</h2><div class="big-num">${p.wins}</div><div>wins</div>
        <dl class="kv"><dt>Win rate</dt><dd>${p.games ? Math.round(p.wins / p.games * 100) + '%' : '–'}</dd>
        <dt>Won by Rami</dt><dd>${p.rami}</dd><dt>Current streak</dt><dd>${p.streak}</dd>
        <dt>Best streak</dt><dd>${p.best}</dd><dt>Fastest Rami</dt><dd>${p.fastest !== null ? p.fastest + ' turns' : '–'}</dd></dl></div>`; };
    $('#main').innerHTML = `<h1 class="page-title">Stats</h1>
      <div class="panel"><h2>Head to head</h2>
        ${tot ? `<div class="bar"><span class="a" data-w="${wa / tot * 100}"></span><span class="b" data-w="${wb / tot * 100}"></span></div>` : '<p>No games finished yet.</p>'}
        <div class="bar-legend"><span>${esc(nameOf(a))} ${wa}</span><span>${st.totalGames} game${st.totalGames === 1 ? '' : 's'}${st.avgTurns ? ` · ${st.avgTurns} turns on average` : ''}</span><span>${b ? esc(nameOf(b)) + ' ' + wb : ''}</span></div></div>
      <div class="grid2">${card(a)}${b ? card(b) : ''}</div>`;
    document.querySelectorAll('.bar span').forEach(s => { s.style.width = s.dataset.w + '%'; });
    $('#main .grid2').style.marginTop = '16px';
  }

  // ---------- history ----------
  function renderHistory() {
    const rows = S.history.map(h => `<tr>
      <td class="n">${h.no}</td><td>${new Date(h.endedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}<br><small>${new Date(h.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></td>
      <td><b>${esc(nameOf(h.winner))}</b> <span class="badge ${h.result === 'rami' ? 'rami' : ''}">${h.result === 'rami' ? 'Rami' : 'Resign'}</span></td>
      <td class="n">${h.turns}</td>
      <td><div class="hand-mini">${(h.melds || []).flatMap(m => m.cards).map(c => cardHTML(c, 'mini')).join('')}</div></td></tr>`).join('');
    $('#main').innerHTML = `<h1 class="page-title">History</h1><div class="panel">${rows ? `<div class="scroll"><table class="hist">
      <thead><tr><th>#</th><th>When</th><th>Winner</th><th>Turns</th><th>Winning hand</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No finished games yet. Your first one will show up here.</p>'}</div>`;
  }

  // ---------- settings ----------
  function renderSettings() {
    const r = S.rules, p = S.me.prefs || {};
    const num = (k, lo, hi) => `<input type="number" name="${k}" min="${lo}" max="${hi}" value="${r[k]}">`;
    const chk = (k, v) => `<input type="checkbox" name="${k}" ${v ? 'checked' : ''}>`;
    const opt = (name, cur, list) => `<select name="${name}">${list.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
    $('#main').innerHTML = `<h1 class="page-title">Settings</h1><div class="grid2">
      <form class="panel settings" id="rules"><h2>House rules</h2><p class="hint">Shared by both of you. Changes apply from the next deal.</p>
        <div class="field"><label>Jokers<small>How many jokers are in the two decks</small></label>${num('jokers', 0, 4)}</div>
        <div class="field"><label>Cards dealt<small>The starting player gets one extra</small></label>${num('handSize', 7, 20)}</div>
        <div class="field"><label>Smallest meld</label>${opt('minMeld', String(r.minMeld), [['3', '3 cards'], ['4', '4 cards']])}</div>
        <div class="field"><label>Must have a swivi<small>Same suit, numbers in a row</small></label>${chk('requireSwivi', r.requireSwivi)}</div>
        <div class="field"><label>Must have a tirci<small>Same number, different suits</small></label>${chk('requireTirci', r.requireTirci)}</div>
        <div class="field"><label>Ace low<small>A-2-3</small></label>${chk('aceLow', r.aceLow)}</div>
        <div class="field"><label>Ace high<small>Q-K-A</small></label>${chk('aceHigh', r.aceHigh)}</div>
        <div class="field"><label>Jokers allowed in one meld</label>${num('maxJokersPerMeld', 0, 4)}</div>
        <div class="field"><label>Take from the discard pile</label>${chk('allowDiscardPickup', r.allowDiscardPickup)}</div>
        <div class="field"><label>Who starts the next game</label>${opt('starter', r.starter, [['alternate', 'Take turns'], ['loser', 'Whoever lost'], ['winner', 'Whoever won']])}</div>
        <button class="btn primary">Save house rules</button></form>
      <form class="panel settings" id="prefs"><h2>Your look</h2><p class="hint">Only changes what you see.</p>
        <div class="field"><label>Table colour</label><div class="swatches">${FELTS.map((c, i) => `<button type="button" class="swatch sw-${i}" data-c="${c}" aria-label="Colour ${i + 1}" aria-pressed="${(p.felt || FELTS[0]) === c}"></button>`).join('')}<input type="color" name="felt" value="${p.felt || FELTS[0]}" aria-label="Custom colour"></div></div>
        <div class="field"><label>Suit colours<small>Four colours make diamonds and clubs easier to tell apart</small></label>${opt('deckColors', p.deckColors || 'classic', [['classic', 'Red and black'], ['four', 'Four colours']])}</div>
        <div class="field"><label>Card size</label>${opt('cardSize', p.cardSize || 'm', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']])}</div>
        <div class="field"><label>Theme</label>${opt('theme', p.theme || 'auto', [['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']])}</div>
        <div class="field"><label>Sound on your turn</label><input type="checkbox" name="sound" ${p.sound ? 'checked' : ''}></div>
        <button class="btn primary">Save my look</button></form></div>`;

    $('#rules').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      const rules = { jokers: +f.jokers.value, handSize: +f.handSize.value, minMeld: +f.minMeld.value, maxJokersPerMeld: +f.maxJokersPerMeld.value,
        requireSwivi: f.requireSwivi.checked, requireTirci: f.requireTirci.checked, aceLow: f.aceLow.checked, aceHigh: f.aceHigh.checked,
        allowDiscardPickup: f.allowDiscardPickup.checked, starter: f.starter.value };
      if (!rules.aceLow && !rules.aceHigh) return toast('Ace has to count as low, high, or both.');
      try { await call('/api/rules', { rules }); toast('House rules saved. They apply from the next deal.'); refresh(); } catch (x) { toast(x.message); }
    });
    const pf = $('#prefs');
    pf.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
      pf.felt.value = b.dataset.c; pf.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', x === b));
      document.documentElement.style.setProperty('--felt', b.dataset.c);
    }));
    pf.felt.addEventListener('input', () => document.documentElement.style.setProperty('--felt', pf.felt.value));
    pf.addEventListener('submit', async e => {
      e.preventDefault();
      const prefs = { felt: pf.felt.value, deckColors: pf.deckColors.value, cardSize: pf.cardSize.value, theme: pf.theme.value, sound: pf.sound.checked };
      try { await call('/api/prefs', { prefs }); toast('Saved.'); if (prefs.sound) chime(); refresh(); } catch (x) { toast(x.message); }
    });
  }

  // ---------- start ----------
  window.addEventListener('hashchange', () => { sel = null; render(); });
  fetch('/api/state').then(r => r.ok ? r.json() : null).then(s => {
    if (!s) return renderLogin();
    S = s; applyPrefs(); render(); listen();
  }).catch(() => renderLogin('Could not reach the server.'));
}
