'use strict';
{
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK = r => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[r] || String(r);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const FELTS = ['#0d4f43', '#134a6b', '#6b1f2a', '#3b2a55', '#2f3a2a', '#5a3a1c'];
  const LANGS = ['en', 'ar', 'fr'];
  const { bestMelds, findRami, jokerOptions, jokerStandsFor, cardPotential } = self.RamiMelds;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let S = null;            // last state from the server
  let sel = null;          // selected card id
  let wasMyTurn = false;
  let lastRoute = null;
  let pins = {}, pinsGame = null;   // where the player chose to put each joker, per game

  // ---------- language ----------
  const stored = (() => { try { return localStorage.getItem('rami-lang'); } catch { return null; } })();
  let lang = LANGS.includes(stored) ? stored : (navigator.language || 'en').slice(0, 2);
  if (!LANGS.includes(lang)) lang = 'en';
  const D = () => self.RamiI18n[lang];
  function t(key, vars = {}) {
    const s = D()[key] ?? self.RamiI18n.en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  }
  const errText = (code, fallback) => {
    const msg = D().err[code];
    if (!msg) return fallback || D().err.generic;
    const r = S?.game?.rules || S?.rules || {};
    return msg.replace('{s}', r.minSwivi ?? 1).replace('{t}', r.minTirci ?? 1);
  };
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
  // One refresh at a time; if the state is identical to what's on screen, don't redraw
  // (your own move and the live update both ask for it, and a second redraw would restart animations).
  let refreshing = null, again = false, lastJSON = '';
  async function refresh() {
    if (refreshing) { again = true; return refreshing; }
    refreshing = (async () => {
      do { again = false; await refreshOnce(); } while (again);
      refreshing = null;
    })();
    return refreshing;
  }
  async function refreshOnce() {
    try {
      const next = await call('/api/state');
      const json = JSON.stringify({ ...next, version: 0 });
      if (json === lastJSON && S) return;
      lastJSON = json;
      S = next;
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

  const shortCard = x => x ? RANK(x.r) + (x.s ? SUIT[x.s] : '') : '';
  function cardHTML(id, extra = '', tag = 'div', as = '') {
    if (!id) return `<div class="empty-slot"></div>`;
    const c = parse(id);
    if (c.joker) return `<${tag} class="card joker ${extra}" data-id="${id}" aria-label="${esc(t('joker'))}${as ? ' ' + esc(as) : ''}"><span class="tl">JOKER</span><span class="pip">★</span>${as ? `<span class="as">${esc(as)}</span>` : ''}</${tag}>`;
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
  function applyPrefs() {
    const p = S?.me.prefs || {};
    const root = document.documentElement;
    root.style.setProperty('--felt', p.felt || FELTS[0]);
    if (p.theme && p.theme !== 'auto') root.dataset.theme = p.theme; else delete root.dataset.theme;
    document.body.classList.toggle('four', p.deckColors === 'four');
    document.body.classList.toggle('zlayji', !!p.zlayji);
    document.body.classList.remove('card-s', 'card-l');
    if (p.cardSize === 's') document.body.classList.add('card-s');
    if (p.cardSize === 'l') document.body.classList.add('card-l');
  }

  // ---------- sound effects (made in the browser, no files) ----------
  const soundOn = () => S?.me.prefs?.sound !== false;
  const sfx = (() => {
    let ctx = null, noise = null, master = null;
    function get() {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
        master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    // browsers only allow sound after the first tap, so wake the audio up then
    ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => get(), { once: true, passive: true }));
    // a filtered burst of noise: the swish of a card
    function swish(at, { dur = .12, from = 2600, to = 1200, q = 1.2, vol = .22, type = 'bandpass' } = {}) {
      const c = get(); if (!c) return;
      const src = c.createBufferSource(); src.buffer = noise;
      const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(from, at); f.frequency.exponentialRampToValueAtTime(to, at + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + .012); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(at, Math.random() * .5); src.stop(at + dur + .02);
    }
    function tone(at, freq, { dur = .25, vol = .14, type = 'sine' } = {}) {
      const c = get(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, at);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + .015); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(master); o.start(at); o.stop(at + dur + .02);
    }
    const now = () => (get()?.currentTime || 0) + .01;
    const play = fn => { if (!soundOn() || !get() || ctx.state !== 'running') return; try { fn(now()); } catch {} };
    return {
      tap: () => play(t0 => swish(t0, { dur: .04, from: 4200, to: 3000, vol: .07, type: 'highpass' })),
      flip: (delay = 0) => play(t0 => { const t = t0 + delay; swish(t, { dur: .09, from: 3400, to: 1800, vol: .18 }); swish(t + .07, { dur: .05, from: 5200, to: 4000, vol: .12, type: 'highpass' }); }),
      slide: (delay = 0, vol = .2) => play(t0 => swish(t0 + delay, { dur: .2, from: 1800, to: 700, q: .8, vol })),
      throw: (delay = 0) => play(t0 => { const t = t0 + delay; swish(t, { dur: .18, from: 2200, to: 900, q: .9, vol: .2 }); swish(t + .3, { dur: .07, from: 500, to: 200, q: .7, vol: .3, type: 'lowpass' }); }),
      shuffle: () => play(t0 => { for (let i = 0; i < 14; i++) swish(t0 + i * .045 + Math.random() * .02, { dur: .05, from: 3800, to: 2600, vol: .1 + Math.random() * .06 }); }),
      deal: n => play(t0 => { for (let i = 0; i < n; i++) swish(t0 + .7 + i * .055, { dur: .06, from: 3000, to: 1900, vol: .12 }); }),
      turn: () => play(t0 => { tone(t0 + .35, 660, { dur: .3, vol: .12 }); tone(t0 + .49, 880, { dur: .35, vol: .12 }); }),
      win: () => play(t0 => [523, 659, 784, 1047, 1319].forEach((f, i) => { tone(t0 + i * .09, f, { dur: .45, vol: .11, type: 'triangle' }); tone(t0 + i * .09, f * 2, { dur: .2, vol: .03 }); })),
      lose: () => play(t0 => { tone(t0, 440, { dur: .4, vol: .1, type: 'triangle' }); tone(t0 + .22, 330, { dur: .55, vol: .1, type: 'triangle' }); }),
      test: () => { get(); setTimeout(() => play(t0 => { swish(t0, { dur: .09, from: 3400, to: 1800, vol: .18 }); tone(t0 + .15, 660, { dur: .3, vol: .12 }); tone(t0 + .29, 880, { dur: .35, vol: .12 }); }), 50); },
    };
  })();

  // ---------- login ----------
  async function renderLogin(err = '', mode) {
    if (es) { es.close(); es = null; }
    shellKey = null; lastRoute = null;
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
  // Moroccan flag: red field, green five-pointed star outline
  const FLAG = '<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" rx="2.5" fill="#c1272d"/><path d="M15 5.2l2.2 6.9-5.8-4.3h7.2l-5.8 4.3z" fill="none" stroke="#006233" stroke-width="1.1" stroke-linejoin="round"/></svg>';
  function setZlayji(on) {
    // only this one switch changes; your own colours, sizes and theme stay saved underneath
    S.me.prefs = { ...S.me.prefs, zlayji: on };
    applyPrefs(); shellKey = null; render();   // header flag appears or goes
    if (on) { toast(t('zlayjiOn')); if (!reduceMotion()) celebrateFlag(); }
    call('/api/prefs', { prefs: { zlayji: on } }).catch(() => {});
  }
  function celebrateFlag() {
    const btn = (document.querySelector('#zlSwitch') || document.querySelector('.zl-flag'))?.getBoundingClientRect(); if (!btn) return;
    for (let i = 0; i < 14; i++) {
      const p = document.createElement('span');
      p.className = 'spark ' + (i % 2 ? 'zl-red' : 'zl-green'); p.textContent = '★';
      Object.assign(p.style, { left: btn.left + btn.width / 2 + 'px', top: btn.top + btn.height / 2 + 'px' });
      document.body.appendChild(p);
      const x = (Math.random() - .5) * 260, y = 60 + Math.random() * 220;
      const a = p.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 0 }, { transform: `translate(-50%,-50%) translate(${x * .6}px,${y * .4}px) scale(1.2) rotate(120deg)`, opacity: 1, offset: .4 },
        { transform: `translate(-50%,-50%) translate(${x}px,${y}px) scale(.7) rotate(260deg)`, opacity: 0 }], { duration: 1100 + Math.random() * 400, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'both' });
      a.onfinish = a.oncancel = () => p.remove();
    }
  }
  let shellKey = null, zlRevealed = false;
  function render() {
    if (!S) return;
    const r = route();
    // Rebuild the header only when something in it changes, so the table can animate between updates.
    const key = `${lang}|${r}|${S.me.name}|${!!S.me.prefs?.zlayji}`;
    if (key !== shellKey || !$('#main')) {
      shellKey = key;
      const icons = {
        play: '<path d="M7 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm12 3.5 1.6.5a2 2 0 0 1 1.3 2.5l-3 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        stats: '<path d="M5 20V11M12 20V4M19 20v-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
        history: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        settings: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      };
      const links = ['play', 'stats', 'history', 'settings']
        .map(k => `<a href="#${k}"${r === k ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[k]}</svg><span>${esc(t(k))}</span></a>`).join('');
      app.innerHTML = `<header class="top">
        <a class="brand" href="#play"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M32 8l6 10 11-3-3 11 10 6-10 6 3 11-11-3-6 10-6-10-11 3 3-11-10-6 10-6-3-11 11 3z"/></svg>Rami</a>
        <nav class="tabs">${links}</nav>
        <span class="who">${S.me.prefs?.zlayji ? `<span class="zl-flag" title="Dima Maghrib" aria-hidden="true">${FLAG}</span>` : ''}${langSelect('topLang')}<span class="me-name">${esc(S.me.name)}</span><button id="out">${esc(t('signOut'))}</button></span></header><main id="main"></main>`;
      $('#out').addEventListener('click', async () => { await call('/api/logout', {}).catch(() => {}); S = null; shellKey = null; renderLogin(); });
      $('#topLang').addEventListener('change', e => { setLang(e.target.value, true); render(); });
    }
    ({ play: renderPlay, stats: renderStats, history: renderHistory, settings: renderSettings }[r] || renderPlay)();
    if (r !== lastRoute) {
      const m = $('#main'); m.classList.remove('enter'); void m.offsetWidth; m.classList.add('enter');
      lastRoute = r;
    }

    const g = S.game, mine = !!(g && !g.result && g.turn === me());
    document.title = mine ? '● Rami' : 'Rami';
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
      t('rNeed', { s: r.minSwivi ?? 1, t: r.minTirci ?? 1 }),
      r.aceLow && r.aceHigh ? t('rAceBoth') : r.aceHigh ? t('rAceHigh') : t('rAceLow')].join(' · ');
  }

  // ---------- joker choices (remembered in this browser, per game) ----------
  function loadPins(no) {
    if (pinsGame === no) return;
    pinsGame = no;
    try { pins = JSON.parse(localStorage.getItem('rami-pins-' + no)) || {}; } catch { pins = {}; }
  }
  function savePins() { try { localStorage.setItem('rami-pins-' + pinsGame, JSON.stringify(pins)); } catch {} }

  // Splits the hand into what's shown: meld groups, loose cards, and the card just drawn.
  const sortBy = () => S.me.prefs?.sortBy === 'rank' ? 'rank' : 'suit';
  function layoutHand(g, over) {
    loadPins(g.no);
    const hand = sortCards(g.myHand || [], sortBy());
    const myTurn = !over && g.turn === me();
    const drawn = myTurn && g.phase === 'discard' && g.lastDrawn && hand.includes(g.lastDrawn) ? g.lastDrawn : null;
    const grouped = S.me.prefs?.groupMelds !== false;
    if (!grouped) return { hand, drawn, grouped, melds: [], loose: hand, pool: hand };

    // the player's own joker choices go first
    let pool = hand.slice();
    const pinned = [], kept = [];
    for (const [jid, pin] of Object.entries(pins)) {
      if (!pool.includes(jid)) continue;
      if (pin === 'loose') { pool = pool.filter(x => x !== jid); kept.push(jid); continue; }
      const cards = pin.cards.map(x => x === 'JOKER' ? jid : x);
      if (!cards.every(x => pool.includes(x))) { delete pins[jid]; continue; }
      pool = pool.filter(x => !cards.includes(x));
      pinned.push({ type: pin.type, cards, pinned: true });
    }
    const auto = bestMelds(pool, g.rules);
    // melds in the same order as the sort: by their first real card
    const firstReal = m => hand.indexOf(m.cards.find(c => !parse(c).joker) || m.cards[0]);
    auto.melds.sort((x, y) => firstReal(x) - firstReal(y));
    const looseSet = new Set([...auto.loose, ...kept]);
    return { hand, drawn, grouped, melds: [...pinned, ...auto.melds], loose: hand.filter(x => looseSet.has(x)), pool };
  }

  // What a card would do for the hand: a short sentence plus a small preview.
  function potentialHTML(title, base, card, rules, gives) {
    const p = cardPotential(base, card, rules);
    let msg, preview = '';
    const list = ids => ids.map(label).join(' ');
    const meldList = m => m.cards.map((c, i) => {
      if (!parse(c).joker) return label(c);
      const as = jokerStandsFor(m, i);
      return as ? `${t('joker')} (${m.type === 'tirci' ? RANK(as.r) : shortCard(as)})` : t('joker');
    }).join(' ');
    if (gives) msg = t('potRami');
    else if (p.meld && p.gain > 0) msg = t('potJoins', { type: t(p.meld.type), cards: meldList(p.meld) });
    else if (p.meld) msg = t('potSame', { type: t(p.meld.type) });
    else if (p.partners.length) msg = t('potPartner', { cards: list(p.partners.map(x => x.id)), type: t(p.partners[0].type) });
    else msg = t('potNothing');
    if (p.meld) preview = `<div class="meld meld-${p.meld.type}">${p.meld.cards.map(c => cardHTML(c, 'mini' + (c === card ? ' hi' : ''))).join('')}</div>`;
    else if (p.partners.length) preview = `<div class="meld">${[card, ...p.partners.map(x => x.id)].map(c => cardHTML(c, 'mini' + (c === card ? ' hi' : ''))).join('')}</div>`;
    return `<div class="potential ${gives ? 'is-rami' : p.meld ? 'is-good' : p.partners.length ? 'is-some' : 'is-none'}">
      <div class="pot-text"><b>${esc(title)}</b><span>${esc(msg)}</span></div>${preview}</div>`;
  }

  function jokerPanelHTML(L, g, jid) {
    const others = L.pool.filter(x => x !== jid && parse(x).joker !== true);
    const opts = jokerOptions(others, g.rules);
    const cur = pins[jid];
    const same = o => cur && cur !== 'loose' && cur.type === o.type && cur.cards.join() === o.cards.join();
    const chip = (key, text, cardsHTML, active) => `<button class="chip${active ? ' on' : ''}" data-pin="${key}">${esc(text)}${cardsHTML ? `<span class="chip-cards">${cardsHTML}</span>` : ''}</button>`;
    const list = opts.map((o, i) => chip(i, o.type === 'tirci' ? t('jokerTirci', { rank: RANK(o.stands.r) }) : t('jokerAs', { card: shortCard(o.stands) }),
      o.cards.map(c => cardHTML(c === 'JOKER' ? jid : c, 'mini')).join(''), same(o))).join('');
    return { html: `<details class="joker-panel"><summary>${esc(t('jokerTitle'))}</summary><div class="chips">
      ${chip('auto', t('jokerAuto'), '', !cur)}${chip('loose', t('jokerLoose'), '', cur === 'loose')}${list}</div></details>`, opts };
  }

  // ---------- card animations ----------
  // FLIP: measure where cards were, redraw, then play the difference. Only transform and
  // opacity change, so the browser can run it on the graphics chip without relayout.
  // composite:'add' layers the motion on top of a card's own CSS (like the lift when selected).
  let seen = null;   // what the last drawn table looked like
  const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const P = 'perspective(700px) ';
  function snapshot() {
    const m = new Map();
    document.querySelectorAll('#hand [data-id], #pile [data-id]').forEach(el => m.set(el.dataset.id, { r: el.getBoundingClientRect(), pile: !!el.closest('#pile') }));
    const r = q => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return b.width ? b : null; };
    return { m, deck: r('#deck .card') || r('#deck') || r('#deal'), pile: r('#pile .card') || r('#pile'), opp: r('.backs') || r('.opp-name'), sel, ...seen };
  }
  function animate(el, frames, opts) {
    try { return el.animate(frames, { composite: 'add', fill: 'backwards', ...opts }); }
    catch { return el.animate(frames, { fill: 'backwards', ...opts }); }   // very old browsers
  }
  // A card flying in face down that turns over on the way (from the deck, or from her side).
  function flyIn(el, from, delay = 0, dur = 600) {
    const a = center(from), b = center(el.getBoundingClientRect());
    const dx = a.x - b.x, dy = a.y - b.y, lift = Math.min(60, 20 + Math.abs(dx) * 0.08);
    el.classList.add('flipping'); el.style.setProperty('--flip-ms', dur + 'ms'); el.style.setProperty('--flip-delay', delay + 'ms');
    const anim = animate(el, [
      { transform: `${P}translate(${dx}px,${dy}px) rotateY(180deg) rotate(-6deg) scale(.82)`, opacity: .9 },
      { transform: `${P}translate(${dx * .35}px,${dy * .35 - lift}px) rotateY(70deg) rotate(3deg) scale(1.06)`, opacity: 1, offset: .55 },
      { transform: `${P}translate(0px,0px) rotateY(0deg) rotate(0deg) scale(1)`, opacity: 1 },
    ], { duration: dur, delay, easing: 'cubic-bezier(.33,.6,.3,1)' });
    anim.onfinish = anim.oncancel = () => el.classList.remove('flipping');
  }
  // A card that already exists moving somewhere: a hop if it goes far (to or from the pile).
  function travel(el, dx, dy, far) {
    if (far) animate(el, [
      { transform: `translate(${dx}px,${dy}px) rotate(0deg) scale(1)` },
      { transform: `translate(${dx * .45}px,${dy * .45 - 46}px) rotate(${dx > 0 ? -8 : 8}deg) scale(1.1)`, offset: .45 },
      { transform: 'translate(0px,0px) rotate(0deg) scale(.96)', offset: .82 },
      { transform: 'translate(0px,0px) rotate(0deg) scale(1)' },
    ], { duration: 600, easing: 'cubic-bezier(.25,.45,.35,1)' });
    else animate(el, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0px,0px)' }],
      { duration: 380, easing: 'cubic-bezier(.34,1.25,.64,1)' });
  }
  // A plain card back gliding across the table (her draws and pick-ups).
  function ghost(from, to, delay = 0) {
    if (!from || !to) return;
    const g = document.createElement('div');
    g.className = 'card back ghost';
    Object.assign(g.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
    document.body.appendChild(g);
    const a = center(from), b = center(to);
    const anim = g.animate([
      { transform: 'translate(0px,0px) rotate(0deg) scale(1)', opacity: 1 },
      { transform: `translate(${(b.x - a.x) * .5}px,${(b.y - a.y) * .5 - 30}px) rotate(-10deg) scale(.9)`, opacity: 1, offset: .5 },
      { transform: `translate(${b.x - a.x}px,${b.y - a.y}px) rotate(-4deg) scale(.6)`, opacity: 0 },
    ], { duration: 560, delay, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' });
    anim.onfinish = anim.oncancel = () => g.remove();
  }
  function hop(el, delay = 0) {
    if (el) animate(el, [{ transform: 'translateY(0px)' }, { transform: 'translateY(-12px)', offset: .3 }, { transform: 'translateY(0px)', offset: .6 },
      { transform: 'translateY(-5px)', offset: .8 }, { transform: 'translateY(0px)' }], { duration: 700, delay, easing: 'ease-out' });
  }
  // A short burst of suit symbols when someone wins.
  function celebrate(won) {
    const box = document.querySelector('.table')?.getBoundingClientRect(); if (!box) return;
    const zl = document.body.classList.contains('zlayji');
    const n = won ? (zl ? 36 : 28) : 10, sym = zl ? ['★', '★', '♥', '★', '♦'] : ['♠', '♥', '♦', '♣', '★'];
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      p.className = 'spark ' + (zl ? (i % 2 ? 'zl-red' : 'zl-green') : 's' + (i % 5));
      p.textContent = sym[i % 5];
      Object.assign(p.style, { left: box.left + box.width / 2 + 'px', top: box.top + box.height * .35 + 'px' });
      document.body.appendChild(p);
      const ang = (i / n) * Math.PI * 2 + Math.random() * .4, dist = 90 + Math.random() * Math.min(260, box.width * .45);
      const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist * .7;
      const anim = p.animate([
        { transform: 'translate(-50%,-50%) translate(0px,0px) scale(.4) rotate(0deg)', opacity: 0 },
        { transform: `translate(-50%,-50%) translate(${x * .7}px,${y * .7 - 30}px) scale(1.2) rotate(${x > 0 ? 90 : -90}deg)`, opacity: 1, offset: .35 },
        { transform: `translate(-50%,-50%) translate(${x}px,${y + 140}px) scale(.8) rotate(${x > 0 ? 200 : -200}deg)`, opacity: 0 },
      ], { duration: 1300 + Math.random() * 500, delay: Math.random() * 120, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'both' });
      anim.onfinish = anim.oncancel = () => p.remove();
    }
  }

  function playAnimations(before) {
    const g = S.game;
    if (!g) return;
    const oppId = g.players.find(p => p !== me());
    const now = { no: g.no, oppCount: g.counts[oppId], myCount: (g.myHand || []).length, over: !!g.result, mine: !g.result && g.turn === me(), top: g.discardTop };
    const prev = seen; seen = now;
    if (prev) {
      const same = prev.no === now.no;
      if (!same) { sfx.shuffle(); sfx.deal(Math.min(now.myCount, 15)); }
      else if (now.over && !prev.over) (g.winner === me() ? sfx.win : sfx.lose)();
      else {
        if (now.myCount > prev.myCount) sfx.flip();                                   // you drew
        if (now.top !== prev.top && now.myCount < prev.myCount) sfx.throw();          // you threw
        if (now.oppCount > prev.oppCount) sfx.slide(0, .14);                          // she drew
        if (now.top !== prev.top && now.oppCount < prev.oppCount) sfx.throw();        // she threw
        if (now.mine && !prev.mine) sfx.turn();                                       // your turn
      }
    }
    if (!before || reduceMotion() || !before.deck || !prev) return;
    const sameGame = prev.no === now.no;
    const fresh = [];
    document.querySelectorAll('#hand [data-id], #pile [data-id]').forEach(el => {
      const b = sameGame && before.m.get(el.dataset.id);
      if (!b) return fresh.push(el);
      const r = el.getBoundingClientRect();
      const dx = b.r.left - r.left, dy = b.r.top - r.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) travel(el, dx, dy, b.pile !== !!el.closest('#pile'));   // hand <-> pile gets the hop
    });
    const dealing = !sameGame;
    let k = 0;
    fresh.forEach(el => {
      if (el.closest('#pile')) flyIn(el, before.opp || before.deck, 0, 560);          // her discard lands
      else flyIn(el, before.deck, dealing ? 120 + k++ * 55 : 0, dealing ? 560 : 520); // you draw / the deal
    });
    if (dealing) for (let i = 0; i < Math.min(now.oppCount, 14); i++) ghost(before.deck, before.opp, 120 + i * 55);
    // her draws: a card back glides from the deck (or the pile, if she took the top card) to her side
    if (sameGame && now.oppCount > prev.oppCount) ghost(prev.top && prev.top !== now.top ? before.pile : before.deck, before.opp);
    // your turn: the deck gives a little hop
    if (sameGame && now.mine && !prev.mine) hop(document.querySelector('#deck .card'), 250);
    // someone just won
    if (sameGame && now.over && !prev.over) {
      celebrate(g.winner === me());
      document.querySelectorAll('.result .card').forEach((c, i) =>
        animate(c, [{ transform: 'translateY(26px) scale(.7) rotate(-8deg)', opacity: 0 }, { transform: 'translateY(0px) scale(1) rotate(0deg)', opacity: 1 }],
          { duration: 420, delay: 250 + i * 45, easing: 'cubic-bezier(.34,1.4,.64,1)' }));
    }
  }

  function renderPlay() {
    const main = $('#main'); if (!main) return;
    const before = main.querySelector('#hand') ? snapshot() : null;
    const g = S.game;
    const banner = S.storage === 'file' ? `<div class="banner">${esc(t('storageWarn'))}</div>` : '';
    if (S.users.length < 2) {
      main.innerHTML = `${banner}${scoreboard(null)}<div class="panel"><h2>${esc(t('waitingPartnerTitle'))}</h2><p>${esc(t('waitingPartnerBody'))}</p></div>`;
      return;
    }
    if (!g || !g.players.includes(me())) {
      main.innerHTML = `${banner}${scoreboard(null)}<div class="table"><div class="row center"><div class="status">${esc(t('noGame'))}
        <span class="sub">${esc(rulesSummary(S.rules))}</span></div></div>
        <div class="actions"><button class="btn primary big" id="deal">${esc(t('deal'))}</button></div><div id="hand"></div></div>`;
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
    const cls = id => `${id === sel ? 'sel' : ''} ${id === L.drawn ? 'new' : ''}`;

    // What the new card (or the card on the pile) would do for you
    let potential = '';
    if (!over && canDiscard && L.drawn)
      potential = potentialHTML(t('potTitle', { card: label(L.drawn) }), L.hand.filter(x => x !== L.drawn), L.drawn, g.rules, winners.some(x => x !== L.drawn));
    else if (!over && canPickup) {
      const withTop = [...L.hand, g.discardTop];
      const gives = L.hand.some(x => findRami(withTop.filter(y => y !== x), g.rules));
      potential = potentialHTML(t('potPreview', { card: label(g.discardTop) }), L.hand, g.discardTop, g.rules, gives);
    }

    const groupHTML = m => `<div class="group meld-${m.type}${m.pinned ? ' pinned' : ''}"><span class="group-label">${esc(t(m.type))}${m.pinned ? ` · ${esc(t('pinned'))}` : ''}</span>
      <div class="group-cards">${m.cards.map((id, i) => {
        const as = parse(id).joker ? jokerStandsFor(m, i) : null;
        return cardHTML(id, cls(id), 'button', as ? (m.type === 'tirci' ? t('anyRank', { rank: RANK(as.r) }) : shortCard(as)) : '');
      }).join('')}</div></div>`;
    const meldGroups = L.melds.map(groupHTML).join('');
    const looseGroup = L.loose.length ? `<div class="group loose">${L.grouped ? `<span class="group-label">${esc(t('loose'))}</span>` : ''}
      <div class="group-cards">${L.loose.map(id => cardHTML(id, cls(id), 'button')).join('')}</div></div>` : '';
    const jp = sel && L.grouped && !over && parse(sel).joker ? jokerPanelHTML(L, g, sel) : null;

    main.innerHTML = `${banner}${scoreboard(g)}<div class="layout"><div>
      <div class="table">
        <div class="row opp"><div class="opp-name">${esc(nameOf(oppId))} <span class="badge">${esc(t('cardsN', { n: g.counts[oppId] }))}</span></div>
          <div class="backs">${over ? '' : Array.from({ length: Math.min(g.counts[oppId], 16) }, back).join('')}</div></div>
        <div class="row center">
          <button class="pile ${canDraw ? 'can' : ''}" id="deck" ${canDraw ? '' : 'disabled'} aria-label="${esc(t('deck'))}">${g.deckCount ? back() : '<div class="empty-slot"></div>'}<small>${esc(t('deck'))} · ${g.deckCount}</small></button>
          <div class="status">${over ? `<b>${g.winner === me() ? esc(t('youWon')) : esc(t('xWon', { name: nameOf(g.winner) }))}</b>` : winners.length ? `<b class="win-now">${esc(t('haveRami'))}</b>` : statusText(g, oppId)}</div>
          <button class="pile ${canPickup ? 'can' : ''}" id="pile" ${canPickup ? '' : 'disabled'} aria-label="${esc(t('discard'))}">${cardHTML(g.discardTop)}<small>${esc(t('discard'))} · ${g.discardCount}</small></button>
        </div>
        ${potential}
        <div class="hand-wrap">
          ${L.grouped && !over ? `<p class="meld-summary">${esc(placed ? t('meldsSummary', { c: placed, n: L.hand.length }) : t('meldsNone'))}</p>` : ''}
          <div class="hand" id="hand">${meldGroups}${looseGroup}</div>
          ${jp ? jp.html : ''}
          ${over ? '' : `<div class="actions">
            <div class="seg" role="group" aria-label="${esc(t('sortLabel'))}">
              <button class="seg-btn${sortBy() === 'suit' ? ' on' : ''}" id="sortSuit" aria-pressed="${sortBy() === 'suit'}" title="${esc(t('sortSuit'))}">♠♥</button>
              <button class="seg-btn${sortBy() === 'rank' ? ' on' : ''}" id="sortRank" aria-pressed="${sortBy() === 'rank'}" title="${esc(t('sortRank'))}">A‑K</button>
            </div>
            ${winners.length ? `<button class="btn primary pulse wide" id="declare">${esc(t('declare'))}</button>` : ''}
            <button class="btn ${winners.length ? '' : 'wide'}" id="discard" ${canDiscard && sel ? '' : 'disabled'}>${esc(sel ? t('throwX', { card: label(sel) }) : t('throwCard'))}</button></div>
          ${canDiscard && !winners.length ? `<p class="hint">${esc(t('hintTap'))}</p>` : ''}`}
        </div>
      </div>
      ${over ? resultPanel(g, oppId) : ''}
    </div>
    <details class="log" ${window.innerWidth > 900 ? 'open' : ''}><summary><h3>${esc(t('gameN', { n: g.no }))} · ${esc(t('moves'))}</h3></summary><ol>${[...g.log].reverse().map(e => `<li>${logLine(e)}</li>`).join('')}</ol>
      ${over ? '' : `<p><button class="btn danger" id="resign">${esc(t('resign'))}</button></p>`}<p class="hint">${esc(rulesSummary(g.rules))}</p></details></div>`;

    playAnimations(before);
    $('#deck').addEventListener('click', () => move({ type: 'draw', source: 'deck' }));
    $('#pile').addEventListener('click', () => move({ type: 'draw', source: 'discard' }));
    if (over) { $('#again')?.addEventListener('click', deal); return; }
    $('#resign').addEventListener('click', resign);
    $('#sortSuit').addEventListener('click', () => setSort('suit'));
    $('#sortRank').addEventListener('click', () => setSort('rank'));
    $('#discard').addEventListener('click', () => move({ type: 'discard', card: sel }));
    // one tap wins: throw the card you picked if it works, otherwise the one that does
    $('#declare')?.addEventListener('click', () => move({ type: 'declare', card: winners.includes(sel) ? sel : winners[0] }));
    if (jp) main.querySelectorAll('.joker-panel .chip').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.pin;
      if (k === 'auto') delete pins[sel];
      else if (k === 'loose') pins[sel] = 'loose';
      else { const o = jp.opts[+k]; pins[sel] = { type: o.type, cards: o.cards }; }
      savePins(); sel = null; renderPlay();
    }));
    bindHand();
  }

  // Tapping a card selects it (tap again to unselect). The hand sorts itself.
  function bindHand() {
    $('#hand').querySelectorAll('.card').forEach(c => c.addEventListener('click', () => {
      sel = sel === c.dataset.id ? null : c.dataset.id; sfx.tap(); renderPlay();
    }));
  }
  function setSort(by) {
    if (sortBy() === by) return;
    S.me.prefs = { ...S.me.prefs, sortBy: by }; renderPlay();
    call('/api/prefs', { prefs: { sortBy: by } }).catch(() => {});
  }

  function resultPanel(g, oppId) {
    const iWon = g.winner === me();
    const how = g.result === 'resign' ? t('resigned', { name: nameOf(g.players.find(p => p !== g.winner)) }) : t('wonInTurns', { n: g.turns });
    // a meld box, with each joker showing the card it stands for
    const meldBox = m => `<div class="meld meld-${m.type}"><span class="meld-label">${esc(t(m.type))}</span>${m.cards.map((c, i) => {
      const as = parse(c).joker ? jokerStandsFor(m, i) : null;
      return cardHTML(c, 'mini', 'div', as ? (m.type === 'tirci' ? RANK(as.r) : shortCard(as)) : '');
    }).join('')}</div>`;
    const melds = (g.melds || []).map(meldBox).join('');
    // the loser's hand, laid out as their swivis and tircis plus the cards that didn't fit
    const loserHand = iWon ? g.oppHand : g.myHand;
    let loserHTML = '';
    if (loserHand && g.result === 'rami') {
      const lay = bestMelds(sortCards(loserHand, sortBy()), g.rules);
      const loose = lay.loose.length ? `<div class="meld meld-loose"><span class="meld-label">${esc(t('loose'))}</span>${lay.loose.map(c => cardHTML(c, 'mini')).join('')}</div>` : '';
      loserHTML = `<p class="loser-title"><b>${esc(iWon ? t('theirHand', { name: nameOf(oppId) }) : t('yourHand'))}</b></p>
        <div class="melds">${lay.melds.map(meldBox).join('')}${loose}</div>`;
    }
    return `<div class="result"><h2>${esc(iWon ? t('ramiYouWin') : t('xWins', { name: nameOf(g.winner) }))}</h2><p>${esc(how)}</p>
      ${melds ? `<div class="melds">${melds}</div>` : ''}
      ${loserHTML}
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
    const zlOpen = !!p.zlayji || zlRevealed;
    $('#main').innerHTML = `<h1 class="page-title">${esc(t('settingsTitle'))}</h1><div class="grid2">
      <form class="panel settings" id="prefs"><h2>${esc(t('yourLook'))}</h2><p class="hint">${esc(t('lookHint'))}</p>
        ${field('language', '', opt('lang', lang, LANGS.map(l => [l, self.RamiI18n[l].langName])))}
        <div class="field wide"><label>${esc(t('tableColour'))}</label><div class="swatches">${FELTS.map((c, i) => `<button type="button" class="swatch sw-${i}" data-c="${c}" aria-label="${esc(t('colourN', { n: i + 1 }))}" aria-pressed="${(p.felt || FELTS[0]) === c}"></button>`).join('')}<input type="color" name="felt" value="${p.felt || FELTS[0]}" aria-label="${esc(t('customColour'))}"></div></div>
        ${field('groupMelds', 'groupMeldsS', `<input type="checkbox" name="groupMelds" ${p.groupMelds !== false ? 'checked' : ''}>`)}
        ${field('suitColours', 'suitColoursS', opt('deckColors', p.deckColors || 'classic', [['classic', t('redBlack')], ['four', t('fourColours')]]))}
        ${field('cardSize', '', opt('cardSize', p.cardSize || 'm', [['s', t('small')], ['m', t('medium')], ['l', t('large')]]))}
        ${field('theme', '', opt('theme', p.theme || 'auto', [['auto', t('matchDevice')], ['light', t('light')], ['dark', t('dark')]]))}
        <button class="btn primary">${esc(t('saveLook'))}</button></form>
      <div class="stack-col">
        <div class="panel settings">
          <div class="field"><label for="soundSwitch">${esc(t('sound'))}<small>${esc(t('soundS'))}</small></label><input type="checkbox" class="switch" id="soundSwitch" ${p.sound !== false ? 'checked' : ''}></div>
          <div id="notifyRow"></div>
        </div>
        <details class="panel settings rules-box"><summary><h2>${esc(t('houseRules'))}</h2><span class="hint">${esc(t('sharedHint'))}</span></summary>
        <form id="rules">
        ${field('jokersL', 'jokersS', num('jokers', 0, 4))}
        ${field('dealtL', 'dealtS', num('handSize', 7, 20))}
        ${field('smallestMeld', '', opt('minMeld', String(r.minMeld), [['3', t('cards3')], ['4', t('cards4')]]))}
        ${field('needSwivi', 'swiviS', num('minSwivi', 0, 4))}
        ${field('needTirci', 'tirciS', num('minTirci', 0, 4))}
        ${field('aceLowL', '', chk('aceLow', r.aceLow))}
        ${field('aceHighL', '', chk('aceHigh', r.aceHigh))}
        ${field('jokersPerMeld', '', num('maxJokersPerMeld', 0, 4))}
        ${field('takeDiscard', '', chk('allowDiscardPickup', r.allowDiscardPickup))}
        ${field('whoStarts', '', opt('starter', r.starter, [['alternate', t('takeTurns')], ['loser', t('whoLost')], ['winner', t('whoWon')]]))}
        <button class="btn primary">${esc(t('saveRules'))}</button></form></details>
        <p class="storage ${S.storage}">${esc(t('storageL'))}: <b>${esc(S.storage === 'mongodb' ? t('storageMongo') : t('storageFile'))}</b></p>
      </div></div>
      <div class="secret">
        ${zlOpen ? `<div class="panel settings zl-panel"><div class="field"><label for="zlSwitch"><span class="zl-title">${FLAG}${esc(t('zlayji'))}</span><small>${esc(t('zlayjiS'))}</small></label>
          <input type="checkbox" class="switch" id="zlSwitch" ${p.zlayji ? 'checked' : ''}></div></div>`
        : `<button type="button" class="secret-star" id="secretStar" aria-label="★">★</button>`}
      </div>`;

    $('#soundSwitch').addEventListener('change', e => {
      S.me.prefs = { ...S.me.prefs, sound: e.target.checked };
      call('/api/prefs', { prefs: { sound: e.target.checked } }).catch(() => {});
      if (e.target.checked) sfx.test();
    });
    $('#secretStar')?.addEventListener('click', () => { zlRevealed = true; renderSettings(); });
    $('#zlSwitch')?.addEventListener('change', e => setZlayji(e.target.checked));
    renderNotifyRow();
    $('#rules').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      const rules = { jokers: +f.jokers.value, handSize: +f.handSize.value, minMeld: +f.minMeld.value, maxJokersPerMeld: +f.maxJokersPerMeld.value,
        minSwivi: +f.minSwivi.value, minTirci: +f.minTirci.value, aceLow: f.aceLow.checked, aceHigh: f.aceHigh.checked,
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
        theme: pf.theme.value, groupMelds: pf.groupMelds.checked };
      try { await call('/api/prefs', { prefs }); setLang(prefs.lang); toast(t('saved')); refresh(); } catch (x) { toast(x.message); }
    });
  }

  function renderNotifyRow() {}

  // ---------- start ----------
  window.addEventListener('hashchange', () => { sel = null; render(); });
  fetch('/api/state').then(r => r.ok ? r.json() : null).then(s => {
    if (!s) return renderLogin();
    S = s;
    if (S.me.prefs?.lang) setLang(S.me.prefs.lang);
    applyPrefs(); render(); listen();
  }).catch(() => renderLogin(t('cantReach')));
}
