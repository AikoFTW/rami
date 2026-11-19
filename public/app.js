'use strict';
{
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK = r => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[r] || String(r);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const FELTS = ['#0d4f43', '#134a6b', '#6b1f2a', '#3b2a55', '#2f3a2a', '#5a3a1c'];
  const LANGS = ['en', 'ar', 'fr'];
  const { bestMelds, findRami } = self.RamiMelds;

  let S = null;            // last state from the server
  let sel = null;          // selected card id
  let dragId = null;
  let wasMyTurn = false;
  let reorderTimer = null;

  // ---------- language ----------
  const stored = (() => { try { return localStorage.getItem('rami-lang'); } catch { return null; } })();
  let lang = LANGS.includes(stored) ? stored : (navigator.language || 'en').slice(0, 2);
  if (!LANGS.includes(lang)) lang = 'en';
  const D = () => self.RamiI18n[lang];
  function t(key, vars = {}) {
    const s = D()[key] ?? self.RamiI18n.en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  }
  const errText = (code, fallback) => D().err[code] || fallback || D().err.generic;
  function setLang(l, save) {
    if (!LANGS.includes(l)) return;
    lang = l;
    try { localStorage.setItem('rami-lang', l); } catch {}
    document.documentElement.lang = l;
    document.documentElement.dir = D().dir;
    if (save && S) { S.me.prefs = { ...S.me.prefs, lang: l }; call('/api/prefs', { prefs: { lang: l } }).catch(() => {}); }
  }
  setLang(lang);
  const langSelect = id => `<select id="${id}" class="lang" aria-label="${esc(t('language'))}">${LANGS.map(l =>
    `<option value="${l}"${l === lang ? ' selected' : ''}>${self.RamiI18n[l].langName}</option>`).join('')}</select>`;
  const locale = () => ({ en: 'en-US', fr: 'fr-FR', ar: 'ar-MA' })[lang];

  // ---------- server ----------
  async function call(url, body) {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !['/api/login', '/api/signup'].includes(url)) { S = null; renderLogin(); throw new Error('signed out'); }
    if (!r.ok) throw new Error(errText(data.code, data.error));
    return data;
  }
  async function refresh() {
    try {
      S = await call('/api/state');
      if (S.me.prefs?.lang && S.me.prefs.lang !== lang) setLang(S.me.prefs.lang);
      applyPrefs(); render();
    } catch (e) { if (e.message !== 'signed out') toast(e.message); }
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
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove('show'), 4200);
  }

  // ---------- cards ----------
  const parse = id => id[0] === 'J' ? { joker: true } : { r: +id.split('-')[0], s: id.split('-')[1] };
  const label = id => { const c = parse(id); return c.joker ? t('joker') : RANK(c.r) + SUIT[c.s]; };
  const labelHTML = id => { const c = parse(id); return c.joker ? `<b>${esc(t('joker'))}</b>` : `<b class="s-${c.s}">${RANK(c.r)}${SUIT[c.s]}</b>`; };
  const nameOf = id => S?.users.find(u => u.id === id)?.name || '?';
  const me = () => S.me.id;

  function cardHTML(id, extra = '', tag = 'div') {
    if (!id) return `<div class="empty-slot"></div>`;
    const c = parse(id);
    if (c.joker) return `<${tag} class="card joker ${extra}" data-id="${id}" aria-label="${esc(t('joker'))}"><span class="tl">JOKER</span><span class="pip">★</span></${tag}>`;
    const face = c.r === 1 || c.r > 10;
    return `<${tag} class="card s-${c.s} ${extra}" data-id="${id}" aria-label="${esc(t('ofSuit', { rank: RANK(c.r), suit: t('suit' + c.s) }))}">` +
      `<span class="tl">${RANK(c.r)}<i>${SUIT[c.s]}</i></span><span class="pip${face ? ' face' : ''}">${face ? RANK(c.r) : SUIT[c.s]}</span></${tag}>`;
  }
  const back = () => `<div class="card back" aria-hidden="true"></div>`;

  function sortCards(cards, by) {
    const key = id => { const c = parse(id); if (c.joker) return [9, 99];
      return by === 'rank' ? [c.r, 'SHDC'.indexOf(c.s)] : ['SHDC'.indexOf(c.s), c.r]; };
    return [...cards].sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; });
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
        const at = ctx.currentTime + i * 0.14;
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.2, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
        o.start(at); o.stop(at + 0.32);
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
      <div class="login-lang">${langSelect('loginLang')}</div>
      <div class="fan">${cardHTML('12-H-0')}${cardHTML('J-0')}${cardHTML('1-S-0')}</div>
      <h1>Rami</h1>
      ${up ? `<p class="hint center-text">${esc(t('signupHint'))}</p>` : ''}
      <label>${esc(t('name'))} <input name="name" type="text" autocomplete="username" required maxlength="24"></label>
      <label>${esc(t('password'))} <input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required minlength="${up ? 6 : 1}"></label>
      <p class="err">${esc(err)}</p>
      <button class="btn primary big">${esc(up ? t('createAccount') : t('signIn'))}</button>
      ${pub.signupOpen ? `<button type="button" class="btn" id="swap">${esc(up ? t('haveAccount') : t('createAnAccount'))}</button>` : ''}
    </form></div>`;
    $('#loginLang').addEventListener('change', e => { setLang(e.target.value); renderLogin('', mode); });
    $('#swap')?.addEventListener('click', () => renderLogin('', up ? 'in' : 'up'));
    $('#lf').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await call(up ? '/api/signup' : '/api/login', { name: f.get('name'), password: f.get('password') });
        const picked = lang;
        listen(); await refresh();
        if (!S.me.prefs?.lang) { setLang(picked, true); render(); }   // remember the language picked at sign-in
      } catch (x) { renderLogin(x.message, mode); }
    });
    $('#lf input[name=name]').focus();
  }

  // ---------- shell ----------
  const route = () => (location.hash.slice(1) || 'play');
  function render() {
    if (!S) return;
    const r = route();
    const links = ['play', 'stats', 'history', 'settings']
      .map(k => `<a href="#${k}"${r === k ? ' aria-current="page"' : ''}>${esc(t(k))}</a>`).join('');
    app.innerHTML = `<header class="top">
      <a class="brand" href="#play"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M32 8l6 10 11-3-3 11 10 6-10 6 3 11-11-3-6 10-6-10-11 3 3-11-10-6 10-6-3-11 11 3z"/></svg>Rami</a>
      <nav>${links}</nav>
      <span class="who">${langSelect('topLang')} ${esc(S.me.name)} <button id="out">${esc(t('signOut'))}</button></span></header><main id="main"></main>`;
    $('#out').addEventListener('click', async () => { await call('/api/logout', {}).catch(() => {}); S = null; renderLogin(); });
    $('#topLang').addEventListener('change', e => { setLang(e.target.value, true); render(); });
    ({ play: renderPlay, stats: renderStats, history: renderHistory, settings: renderSettings }[r] || renderPlay)();

    const g = S.game, mine = !!(g && !g.result && g.turn === me());
    document.title = mine ? '● Rami' : 'Rami';
    if (mine && !wasMyTurn) chime();
    wasMyTurn = mine;
  }

  function scoreboard(g) {
    const others = S.users.filter(u => u.id !== me()).map(u => u.id);
    const a = me(), b = g ? g.players.find(p => p !== me()) : others[0];
    const st = S.stats.players;
    const live = g && !g.result;
    const dot = id => live && g.turn === id ? `<span class="turn-dot" title="${esc(t('theirTurn'))}"></span>` : '';
    return `<div class="score">
      <div class="p">${dot(a)}<span class="num">${st[a]?.wins ?? 0}</span><span>${esc(nameOf(a))} (${esc(t('you'))})</span></div>
      <span class="vs">${esc(t('wins'))}</span>
      ${b ? `<div class="p right"><span>${esc(nameOf(b))}</span><span class="num">${st[b]?.wins ?? 0}</span>${dot(b)}</div>` : '<div></div>'}</div>`;
  }

  // ---------- play ----------
  function statusText(g, oppId) {
    if (g.result) return '';
    if (g.turn !== me()) {
      const last = [...g.log].reverse().find(e => e.by === oppId && e.type !== 'reshuffle');
      const did = !last ? '' : last.type === 'discard' ? t('theyThrew', { card: labelHTML(last.card) })
        : last.type === 'draw' ? (last.source === 'discard' ? t('theyTook', { card: labelHTML(last.card) }) : t('theyDrew')) : '';
      return `${t('waitingFor', { name: esc(nameOf(oppId)) })}<span class="sub">${did}</span>`;
    }
    if (g.phase === 'draw') {
      const take = g.discardTop && g.rules.allowDiscardPickup ? t('orTake', { card: labelHTML(g.discardTop) }) : '';
      return t('yourTurnDraw', { take });
    }
    if (g.turns === 0 && g.starter === me()) return `${t('startWith', { n: g.myHand.length })}<span class="sub">${t('orDeclare')}</span>`;
    return `${t('pickThrow')}<span class="sub">${t('ifMelds')}</span>`;
  }

  function logLine(e) {
    const who = e.by ? `<b>${esc(nameOf(e.by))}</b>` : '';
    switch (e.type) {
      case 'draw': return e.source === 'discard' ? t('logTook', { who, card: labelHTML(e.card) }) : t('logDrew', { who });
      case 'discard': return t('logThrew', { who, card: labelHTML(e.card) });
      case 'rami': return t('logRami', { who });
      case 'resign': return t('logResign', { who });
      case 'reshuffle': return t('logReshuffle');
    }
    return '';
  }

  function rulesSummary(r) {
    return [t('rJokers', { n: r.jokers }), t('rCards', { n: r.handSize }), t('rMelds', { n: r.minMeld }),
      r.requireSwivi && r.requireTirci ? t('rBoth') : r.requireSwivi ? t('rSwivi') : r.requireTirci ? t('rTirci') : t('rAny'),
      r.aceLow && r.aceHigh ? t('rAceBoth') : r.aceHigh ? t('rAceHigh') : t('rAceLow')].join(' · ');
  }

  // Splits the hand into what's shown: meld groups, loose cards, and the card just drawn.
  function layoutHand(g, over) {
    const hand = g.myHand || [];
    const myTurn = !over && g.turn === me();
    const drawn = myTurn && g.phase === 'discard' && g.lastDrawn && hand.includes(g.lastDrawn) ? g.lastDrawn : null;
    const base = hand.filter(id => id !== drawn);
    const grouped = S.me.prefs?.groupMelds !== false;
    const { melds, loose } = grouped ? bestMelds(base, g.rules) : { melds: [], loose: base };
    // keep melds in a stable order: by where their first card sits in the saved hand
    melds.sort((a, b) => base.indexOf(a.cards[0]) - base.indexOf(b.cards[0]));
    return { hand, drawn, base, grouped, melds, loose };
  }
  // Card order to save after a change: melds first, then loose cards, then the new card.
  const fullOrder = (L, loose) => [...L.melds.flatMap(m => m.cards), ...loose, ...(L.drawn ? [L.drawn] : [])];

  function renderPlay() {
    const main = $('#main'); if (!main) return;
    const g = S.game;
    if (S.users.length < 2) {
      main.innerHTML = `${scoreboard(null)}<div class="panel"><h2>${esc(t('waitingPartnerTitle'))}</h2><p>${esc(t('waitingPartnerBody'))}</p></div>`;
      return;
    }
    if (!g || !g.players.includes(me())) {
      main.innerHTML = `${scoreboard(null)}<div class="table"><div class="row center"><div class="status">${esc(t('noGame'))}
        <span class="sub">${esc(rulesSummary(S.rules))}</span></div></div>
        <div class="actions"><button class="btn primary big" id="deal">${esc(t('deal'))}</button></div></div>`;
      $('#deal').addEventListener('click', deal);
      return;
    }
    const oppId = g.players.find(p => p !== me());
    const over = !!g.result;
    const myTurn = !over && g.turn === me();
    const canDraw = myTurn && g.phase === 'draw';
    const canDiscard = myTurn && g.phase === 'discard';
    const canPickup = canDraw && g.discardTop && g.rules.allowDiscardPickup;
    const L = layoutHand(g, over);
    if (sel && !L.hand.includes(sel)) sel = null;

    // Which throws would win right now?
    const winners = canDiscard ? L.hand.filter(x => findRami(L.hand.filter(y => y !== x), g.rules)) : [];
    const placed = L.melds.reduce((n, m) => n + m.cards.length, 0);
    const cls = id => `${id === sel ? 'sel' : ''} ${winners.includes(id) && sel !== id ? 'win-throw' : ''}`;

    const meldGroups = L.melds.map(m => `<div class="group meld-${m.type}"><span class="group-label">${esc(t(m.type))}</span>
      <div class="group-cards">${m.cards.map(id => cardHTML(id, cls(id), 'button')).join('')}</div></div>`).join('');
    const looseGroup = L.loose.length ? `<div class="group loose">${L.grouped ? `<span class="group-label">${esc(t('loose'))}</span>` : ''}
      <div class="group-cards">${L.loose.map(id => cardHTML(id, cls(id), 'button')).join('')}</div></div>` : '';
    const drawnSlot = L.drawn ? `<div class="group drawn"><span class="group-label">${esc(t('newCard'))}</span>
      <div class="group-cards">${cardHTML(L.drawn, cls(L.drawn), 'button')}</div></div>` : '';

    main.innerHTML = `${scoreboard(g)}<div class="layout"><div>
      <div class="table">
        <div class="row opp"><div class="opp-name">${esc(nameOf(oppId))} <span class="badge">${esc(t('cardsN', { n: g.counts[oppId] }))}</span></div>
          <div class="backs">${over ? '' : Array.from({ length: Math.min(g.counts[oppId], 16) }, back).join('')}</div></div>
        <div class="row center">
          <button class="pile ${canDraw ? 'can' : ''}" id="deck" ${canDraw ? '' : 'disabled'} aria-label="${esc(t('deck'))}">${g.deckCount ? back() : '<div class="empty-slot"></div>'}<small>${esc(t('deck'))} · ${g.deckCount}</small></button>
          <div class="status">${over ? `<b>${g.winner === me() ? esc(t('youWon')) : esc(t('xWon', { name: nameOf(g.winner) }))}</b>` : statusText(g, oppId)}</div>
          <button class="pile ${canPickup ? 'can' : ''}" id="pile" ${canPickup ? '' : 'disabled'} aria-label="${esc(t('discard'))}">${cardHTML(g.discardTop)}<small>${esc(t('discard'))} · ${g.discardCount}</small></button>
        </div>
        <div class="hand-wrap">
          ${L.grouped && !over ? `<p class="meld-summary">${esc(t('meldsSummary', { m: L.melds.length, c: placed, n: L.base.length }))}</p>` : ''}
          ${winners.length ? `<p class="rami-ready">${esc(t('haveRami'))}</p>` : ''}
          <div class="hand" id="hand">${meldGroups}${looseGroup}${drawnSlot}</div>
          ${over ? '' : `<div class="actions">
            <button class="btn" id="sortSuit">${esc(t('sortSuit'))}</button>
            <button class="btn" id="sortRank">${esc(t('sortRank'))}</button>
            <button class="btn" id="discard" ${canDiscard && sel ? '' : 'disabled'}>${esc(sel ? t('throwX', { card: label(sel) }) : t('throwCard'))}</button>
            <button class="btn primary ${winners.length ? 'pulse' : ''}" id="declare" ${canDiscard && sel ? '' : 'disabled'}>${esc(t('declare'))}</button></div>
          <p class="hint">${esc(t('hintTap'))}</p>`}
        </div>
      </div>
      ${over ? resultPanel(g, oppId) : ''}
    </div>
    <aside class="log"><h3>${esc(t('gameN', { n: g.no }))}</h3><ol>${[...g.log].reverse().map(e => `<li>${logLine(e)}</li>`).join('')}</ol>
      ${over ? '' : `<p><button class="btn danger" id="resign">${esc(t('resign'))}</button></p>`}<p class="hint">${esc(rulesSummary(g.rules))}</p></aside></div>`;

    $('#deck').addEventListener('click', () => move({ type: 'draw', source: 'deck' }));
    $('#pile').addEventListener('click', () => move({ type: 'draw', source: 'discard' }));
    if (over) { $('#again')?.addEventListener('click', deal); return; }
    $('#resign').addEventListener('click', resign);
    $('#sortSuit').addEventListener('click', () => sendOrder(fullOrder(L, sortCards(L.loose, 'suit'))));
    $('#sortRank').addEventListener('click', () => sendOrder(fullOrder(L, sortCards(L.loose, 'rank'))));
    $('#discard').addEventListener('click', () => move({ type: 'discard', card: sel }));
    $('#declare').addEventListener('click', () => move({ type: 'declare', card: sel }));
    bindHand(L);
  }

  // Any card can be selected. Loose cards can be rearranged; melds arrange themselves.
  function bindHand(L) {
    const isLoose = id => L.loose.includes(id);
    const moveTo = (id, target) => {
      const loose = L.loose.filter(x => x !== id);
      loose.splice(loose.indexOf(target), 0, id);
      sendOrder(fullOrder(L, loose));
    };
    $('#hand').querySelectorAll('.card').forEach(c => {
      const id = c.dataset.id;
      c.addEventListener('click', () => {
        if (sel && sel !== id && isLoose(sel) && isLoose(id)) { const s = sel; sel = null; moveTo(s, id); return; }
        sel = sel === id ? null : id; renderPlay();
      });
      if (!isLoose(id)) return;
      c.draggable = true;
      c.addEventListener('dragstart', e => { dragId = id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      c.addEventListener('dragend', () => { dragId = null; c.classList.remove('dragging'); });
      c.addEventListener('dragover', e => { if (dragId && dragId !== id) { e.preventDefault(); c.classList.add('drag-over'); } });
      c.addEventListener('dragleave', () => c.classList.remove('drag-over'));
      c.addEventListener('drop', e => { e.preventDefault(); c.classList.remove('drag-over'); if (dragId && dragId !== id) moveTo(dragId, id); });
    });
  }

  function resultPanel(g, oppId) {
    const iWon = g.winner === me();
    const how = g.result === 'resign' ? t('resigned', { name: nameOf(g.players.find(p => p !== g.winner)) }) : t('wonInTurns', { n: g.turns });
    const melds = (g.melds || []).map(m => `<div class="meld meld-${m.type}"><span class="meld-label">${esc(t(m.type))}</span>${m.cards.map(c => cardHTML(c, 'mini')).join('')}</div>`).join('');
    const loserHand = iWon ? g.oppHand : g.myHand;
    return `<div class="result"><h2>${esc(iWon ? t('ramiYouWin') : t('xWins', { name: nameOf(g.winner) }))}</h2><p>${esc(how)}</p>
      ${melds ? `<div class="melds">${melds}</div>` : ''}
      ${loserHand && g.result === 'rami' ? `<p><b>${esc(iWon ? t('theirHand', { name: nameOf(oppId) }) : t('yourHand'))}</b></p><div class="melds"><div class="meld">${loserHand.map(c => cardHTML(c, 'mini')).join('')}</div></div>` : ''}
      <button class="btn primary big" id="again">${esc(t('dealNext'))}</button></div>`;
  }

  async function deal() {
    try { await call('/api/game/new', {}); sel = null; await refresh(); } catch (e) { toast(e.message); }
  }
  function resign() {
    const b = $('#resign');
    if (b.dataset.confirm) return move({ type: 'resign' });
    b.dataset.confirm = '1'; b.textContent = t('tapAgain');
    setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = t('resign'); } }, 4000);
  }

  // ---------- stats ----------
  function renderStats() {
    const st = S.stats, ids = Object.keys(st.players);
    const a = me(), b = ids.find(x => x !== me());
    const wa = st.players[a]?.wins || 0, wb = b ? st.players[b].wins : 0, tot = wa + wb;
    const card = id => { const p = st.players[id]; if (!p) return '';
      return `<div class="panel"><h2>${esc(nameOf(id))}</h2><div class="big-num">${p.wins}</div><div>${esc(t('winsLabel'))}</div>
        <dl class="kv"><dt>${esc(t('winRate'))}</dt><dd>${p.games ? Math.round(p.wins / p.games * 100) + '%' : '–'}</dd>
        <dt>${esc(t('wonByRami'))}</dt><dd>${p.rami}</dd><dt>${esc(t('curStreak'))}</dt><dd>${p.streak}</dd>
        <dt>${esc(t('bestStreak'))}</dt><dd>${p.best}</dd><dt>${esc(t('fastest'))}</dt><dd>${p.fastest !== null ? esc(t('turnsN', { n: p.fastest })) : '–'}</dd></dl></div>`; };
    const games = st.totalGames === 1 ? t('gameOne') : t('gamesN', { n: st.totalGames });
    $('#main').innerHTML = `<h1 class="page-title">${esc(t('statsTitle'))}</h1>
      <div class="panel"><h2>${esc(t('headToHead'))}</h2>
        ${tot ? `<div class="bar"><span class="a" data-w="${wa / tot * 100}"></span><span class="b" data-w="${wb / tot * 100}"></span></div>` : `<p>${esc(t('noGamesYet'))}</p>`}
        <div class="bar-legend"><span>${esc(nameOf(a))} ${wa}</span><span>${esc(games)}${st.avgTurns ? ' · ' + esc(t('avgTurns', { n: st.avgTurns })) : ''}</span><span>${b ? esc(nameOf(b)) + ' ' + wb : ''}</span></div></div>
      <div class="grid2 gap-top">${card(a)}${b ? card(b) : ''}</div>`;
    document.querySelectorAll('.bar span').forEach(s => { s.style.width = s.dataset.w + '%'; });
  }

  // ---------- history ----------
  function renderHistory() {
    const rows = S.history.map(h => { const d = new Date(h.endedAt); return `<tr>
      <td class="n">${h.no}</td><td>${d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })}<br><small>${d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })}</small></td>
      <td><b>${esc(nameOf(h.winner))}</b> <span class="badge ${h.result === 'rami' ? 'rami' : ''}">${esc(h.result === 'rami' ? t('badgeRami') : t('badgeResign'))}</span></td>
      <td class="n">${h.turns}</td>
      <td><div class="hand-mini">${(h.melds || []).flatMap(m => m.cards).map(c => cardHTML(c, 'mini')).join('')}</div></td></tr>`; }).join('');
    $('#main').innerHTML = `<h1 class="page-title">${esc(t('historyTitle'))}</h1><div class="panel">${rows ? `<div class="scroll"><table class="hist">
      <thead><tr><th>#</th><th>${esc(t('colWhen'))}</th><th>${esc(t('colWinner'))}</th><th>${esc(t('colTurns'))}</th><th>${esc(t('colHand'))}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${esc(t('noHistory'))}</p>`}</div>`;
  }

  // ---------- settings ----------
  function renderSettings() {
    const r = S.rules, p = S.me.prefs || {};
    const num = (k, lo, hi) => `<input type="number" name="${k}" min="${lo}" max="${hi}" value="${r[k]}">`;
    const chk = (k, v) => `<input type="checkbox" name="${k}" ${v ? 'checked' : ''}>`;
    const opt = (name, cur, list) => `<select name="${name}">${list.map(([v, txt]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select>`;
    const field = (labelKey, subKey, control) => `<div class="field"><label>${esc(t(labelKey))}${subKey ? `<small>${esc(t(subKey))}</small>` : ''}</label>${control}</div>`;
    $('#main').innerHTML = `<h1 class="page-title">${esc(t('settingsTitle'))}</h1><div class="grid2">
      <form class="panel settings" id="rules"><h2>${esc(t('houseRules'))}</h2><p class="hint">${esc(t('sharedHint'))}</p>
        ${field('jokersL', 'jokersS', num('jokers', 0, 4))}
        ${field('dealtL', 'dealtS', num('handSize', 7, 20))}
        ${field('smallestMeld', '', opt('minMeld', String(r.minMeld), [['3', t('cards3')], ['4', t('cards4')]]))}
        ${field('mustSwivi', 'swiviS', chk('requireSwivi', r.requireSwivi))}
        ${field('mustTirci', 'tirciS', chk('requireTirci', r.requireTirci))}
        ${field('aceLowL', '', chk('aceLow', r.aceLow))}
        ${field('aceHighL', '', chk('aceHigh', r.aceHigh))}
        ${field('jokersPerMeld', '', num('maxJokersPerMeld', 0, 4))}
        ${field('takeDiscard', '', chk('allowDiscardPickup', r.allowDiscardPickup))}
        ${field('whoStarts', '', opt('starter', r.starter, [['alternate', t('takeTurns')], ['loser', t('whoLost')], ['winner', t('whoWon')]]))}
        <button class="btn primary">${esc(t('saveRules'))}</button></form>
      <form class="panel settings" id="prefs"><h2>${esc(t('yourLook'))}</h2><p class="hint">${esc(t('lookHint'))}</p>
        ${field('language', '', opt('lang', lang, LANGS.map(l => [l, self.RamiI18n[l].langName])))}
        <div class="field"><label>${esc(t('tableColour'))}</label><div class="swatches">${FELTS.map((c, i) => `<button type="button" class="swatch sw-${i}" data-c="${c}" aria-label="${esc(t('colourN', { n: i + 1 }))}" aria-pressed="${(p.felt || FELTS[0]) === c}"></button>`).join('')}<input type="color" name="felt" value="${p.felt || FELTS[0]}" aria-label="${esc(t('customColour'))}"></div></div>
        ${field('groupMelds', 'groupMeldsS', `<input type="checkbox" name="groupMelds" ${p.groupMelds !== false ? 'checked' : ''}>`)}
        ${field('suitColours', 'suitColoursS', opt('deckColors', p.deckColors || 'classic', [['classic', t('redBlack')], ['four', t('fourColours')]]))}
        ${field('cardSize', '', opt('cardSize', p.cardSize || 'm', [['s', t('small')], ['m', t('medium')], ['l', t('large')]]))}
        ${field('theme', '', opt('theme', p.theme || 'auto', [['auto', t('matchDevice')], ['light', t('light')], ['dark', t('dark')]]))}
        ${field('sound', '', `<input type="checkbox" name="sound" ${p.sound ? 'checked' : ''}>`)}
        <button class="btn primary">${esc(t('saveLook'))}</button></form></div>`;

    $('#rules').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      const rules = { jokers: +f.jokers.value, handSize: +f.handSize.value, minMeld: +f.minMeld.value, maxJokersPerMeld: +f.maxJokersPerMeld.value,
        requireSwivi: f.requireSwivi.checked, requireTirci: f.requireTirci.checked, aceLow: f.aceLow.checked, aceHigh: f.aceHigh.checked,
        allowDiscardPickup: f.allowDiscardPickup.checked, starter: f.starter.value };
      if (!rules.aceLow && !rules.aceHigh) return toast(t('aceNeeded'));
      try { await call('/api/rules', { rules }); toast(t('rulesSaved')); refresh(); } catch (x) { toast(x.message); }
    });
    const pf = $('#prefs');
    pf.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
      pf.felt.value = b.dataset.c; pf.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', x === b));
      document.documentElement.style.setProperty('--felt', b.dataset.c);
    }));
    pf.felt.addEventListener('input', () => document.documentElement.style.setProperty('--felt', pf.felt.value));
    pf.addEventListener('submit', async e => {
      e.preventDefault();
      const prefs = { lang: pf.lang.value, felt: pf.felt.value, deckColors: pf.deckColors.value, cardSize: pf.cardSize.value,
        theme: pf.theme.value, sound: pf.sound.checked, groupMelds: pf.groupMelds.checked };
      try { await call('/api/prefs', { prefs }); setLang(prefs.lang); toast(t('saved')); if (prefs.sound) chime(); refresh(); } catch (x) { toast(x.message); }
    });
  }

  // ---------- start ----------
  window.addEventListener('hashchange', () => { sel = null; render(); });
  fetch('/api/state').then(r => r.ok ? r.json() : null).then(s => {
    if (!s) return renderLogin();
    S = s;
    if (S.me.prefs?.lang) setLang(S.me.prefs.lang);
    applyPrefs(); render(); listen();
  }).catch(() => renderLogin(t('cantReach')));
}
