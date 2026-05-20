/* =========================================================
   UNO Online — UI rendering & screen management
   Exposes window.UnoUI
   ========================================================= */

(function () {
  'use strict';

  const { label: cardLabel, canPlay } = (function () {
    return {
      label: window.UnoCards.label,
      canPlay: window.UnoRules.canPlay
    };
  })();

  /* ---------------------------------------------------------
     Screen management
     --------------------------------------------------------- */
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById('screen-' + id);
    if (el) el.classList.add('active');
  }

  /* ---------------------------------------------------------
     Toast
     --------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg, duration) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), duration || 2400);
  }

  /* ---------------------------------------------------------
     Card DOM builders
     --------------------------------------------------------- */
  function buildCardEl(card, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'card';
    const color = card.color || 'wild';
    el.classList.add(color);
    el.dataset.cardId = card.id;
    el.dataset.type = card.type;
    el.dataset.color = card.color || '';
    el.dataset.value = card.value !== null && card.value !== undefined ? card.value : '';

    const tl = document.createElement('div'); tl.className = 'corner-tl';
    const ctr = document.createElement('div'); ctr.className = 'center';
    const br = document.createElement('div'); br.className = 'corner-br';

    if (card.type === 'number') {
      tl.textContent = card.value;
      ctr.textContent = card.value;
      br.textContent = card.value;
    }
    // For other types, CSS ::after will render the icon

    el.appendChild(tl);
    el.appendChild(ctr);
    el.appendChild(br);

    if (opts.unplayable) el.classList.add('unplayable');
    if (opts.slideIn)   el.classList.add('slide-in');
    if (opts.drawAnim)  el.classList.add('draw-anim');

    return el;
  }

  function buildCardBack() {
    const el = document.createElement('div');
    el.className = 'card card-back';
    return el;
  }

  /* ---------------------------------------------------------
     Lobby rendering
     --------------------------------------------------------- */
  function renderLobby(state, opts) {
    const { players, hostId, myId, roomName, roomCode } = state;
    const isHost = (hostId === myId);

    document.getElementById('lobby-room-name').textContent = roomName || 'Salon';
    document.getElementById('lobby-player-count').textContent = players.length;

    const codeEl = document.getElementById('lobby-room-code');
    codeEl.dataset.code = roomCode;
    if (codeEl.classList.contains('hidden-code')) {
      codeEl.textContent = '••••••••';
    } else {
      codeEl.textContent = roomCode;
    }

    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      if (p.ready)        li.classList.add('ready');
      if (p.id === hostId) li.classList.add('host');

      const name = document.createElement('span');
      name.textContent = p.name;

      const tags = document.createElement('div');
      tags.className = 'player-tags';
      if (p.id === myId)  tags.appendChild(makeTag('Toi', 'tag-you'));
      if (p.id === hostId) tags.appendChild(makeTag('Hôte', 'tag-host'));
      if (p.ready)         tags.appendChild(makeTag('Prêt', 'tag-ready'));

      if (isHost && p.id !== myId) {
        const k = document.createElement('button');
        k.className = 'kick-btn'; k.textContent = 'Exclure';
        k.dataset.targetId = p.id;
        k.addEventListener('click', () => opts.onKick(p.id));
        tags.appendChild(k);
      }

      li.appendChild(name);
      li.appendChild(tags);
      list.appendChild(li);
    }

    // Show "Start" button only for host
    const startBtn = document.getElementById('btn-start-host');
    if (isHost) startBtn.classList.remove('hidden');
    else        startBtn.classList.add('hidden');

    // Disable start if <2 players
    startBtn.disabled = players.length < 2;
  }

  function makeTag(text, cls) {
    const t = document.createElement('span');
    t.className = 'tag ' + (cls || '');
    t.textContent = text;
    return t;
  }

  /* ---------------------------------------------------------
     Game board rendering
     --------------------------------------------------------- */
  function renderGame(view, opts) {
    /*
      view: {
        players: [{ id, name, handCount, calledUno, totalScore, isCurrent, connected }],
        myId, myHand, hostId,
        topCard, currentColor,
        direction (+1/-1),
        drawPileCount, discardPileCount,
        currentPlayerId,
        status,           // 'playing' | 'choosing-color' | 'challenge' | 'round-over' | 'game-over'
        waitingForDrawDecision,
        roomCode,
        pendingDraw,
        unoMissedBy
      }
    */
    document.getElementById('game-room-code').textContent = view.roomCode || '';

    // Direction indicator
    const dirEl = document.getElementById('game-direction');
    dirEl.textContent = view.direction === 1 ? '⤵ Sens horaire' : '⤴ Sens anti-horaire';

    // Current color
    const colorEl = document.getElementById('game-current-color');
    colorEl.className = 'current-color ' + (view.currentColor || '');

    // Opponents (everyone except me)
    const oppRoot = document.getElementById('opponents');
    oppRoot.innerHTML = '';
    for (const p of view.players) {
      if (p.id === view.myId) continue;
      const opp = document.createElement('div');
      opp.className = 'opponent';
      if (p.id === view.currentPlayerId) opp.classList.add('active');
      if (p.calledUno || p.handCount === 1) opp.classList.add('uno');

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = p.name + (!p.connected ? ' (déco)' : '');

      const metaEl = document.createElement('div');
      metaEl.className = 'meta';
      metaEl.textContent = `${p.handCount} carte${p.handCount > 1 ? 's' : ''} · ${p.totalScore} pts`;

      const cards = document.createElement('div');
      cards.className = 'opp-cards';
      const max = Math.min(p.handCount, 7);
      for (let i = 0; i < max; i++) {
        const c = document.createElement('div');
        c.className = 'mini-card';
        cards.appendChild(c);
      }

      // Click to "catch" UNO miss
      if (view.unoMissedBy === p.id) {
        opp.style.cursor = 'pointer';
        opp.title = 'Cliquer pour signaler l\'oubli du UNO';
        opp.addEventListener('click', () => opts.onCatchUno(p.id));
      }

      opp.appendChild(nameEl);
      opp.appendChild(metaEl);
      opp.appendChild(cards);
      oppRoot.appendChild(opp);
    }

    // Discard pile (top card)
    const discard = document.getElementById('discard-pile');
    discard.innerHTML = '';
    if (view.topCard) {
      const c = buildCardEl(view.topCard, { slideIn: true });
      discard.appendChild(c);
    }

    // Draw pile count
    document.getElementById('draw-count').textContent = view.drawPileCount + ' cartes';

    // Turn indicator
    const turnEl = document.getElementById('turn-indicator');
    const cur = view.players.find(p => p.id === view.currentPlayerId);
    if (view.status === 'choosing-color' && view.players[0]?.id === view.myId) {
      turnEl.textContent = 'Choisis la couleur de départ';
    } else if (view.status === 'challenge') {
      turnEl.textContent = view.players.find(p => p.id === view.lastAction?.targetId)?.id === view.myId
        ? 'On te défie au +4. Contester ?'
        : `${cur?.name || ''} doit décider du défi`;
    } else if (cur && cur.id === view.myId) {
      turnEl.textContent = '— À toi de jouer —';
    } else {
      turnEl.textContent = cur ? `Tour de ${cur.name}` : '';
    }

    // My hand
    const handEl = document.getElementById('my-hand');
    handEl.innerHTML = '';
    const isMyTurn = (view.currentPlayerId === view.myId) && view.status === 'playing';
    const top = view.topCard;
    for (const c of view.myHand) {
      const playable = isMyTurn && top && canPlay(c, top, view.currentColor, view.pendingDraw, view.stacking);
      const el = buildCardEl(c, { unplayable: !playable });
      el.addEventListener('click', () => {
        if (!playable) {
          toast('Tu ne peux pas jouer cette carte.');
          return;
        }
        opts.onPlayCard(c);
      });
      handEl.appendChild(el);
    }

    // Pass button only if waiting for draw decision
    const passBtn = document.getElementById('btn-pass');
    if (view.waitingForDrawDecision && view.currentPlayerId === view.myId) {
      passBtn.classList.remove('hidden');
    } else {
      passBtn.classList.add('hidden');
    }

    // UNO button visible if I have 2 cards (about to play) or 1 card (validation)
    const unoBtn = document.getElementById('btn-uno');
    const myPlayer = view.players.find(p => p.id === view.myId);
    if (myPlayer && (myPlayer.handCount === 2 || myPlayer.handCount === 1)) {
      unoBtn.classList.remove('hidden');
    } else {
      unoBtn.classList.add('hidden');
    }
  }

  /* ---------------------------------------------------------
     Color picker modal
     --------------------------------------------------------- */
  function showColorPicker() {
    return new Promise((resolve) => {
      const modal = document.getElementById('color-picker');
      modal.classList.remove('hidden');
      const buttons = modal.querySelectorAll('.color-btn');
      const handler = (e) => {
        const c = e.currentTarget.dataset.color;
        buttons.forEach(b => b.removeEventListener('click', handler));
        modal.classList.add('hidden');
        resolve(c);
      };
      buttons.forEach(b => b.addEventListener('click', handler));
    });
  }

  /* ---------------------------------------------------------
     Challenge modal
     --------------------------------------------------------- */
  function showChallengeModal() {
    return new Promise((resolve) => {
      const modal = document.getElementById('challenge-modal');
      modal.classList.remove('hidden');
      const yes = document.getElementById('btn-challenge-yes');
      const no  = document.getElementById('btn-challenge-no');
      const cleanup = (ans) => {
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        modal.classList.add('hidden');
        resolve(ans);
      };
      const onYes = () => cleanup(true);
      const onNo  = () => cleanup(false);
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
    });
  }

  /* ---------------------------------------------------------
     Public rooms list
     --------------------------------------------------------- */
  function renderPublicRooms(rooms, onJoin) {
    const root = document.getElementById('public-rooms-list');
    root.innerHTML = '';
    if (!rooms || rooms.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'Aucun salon public pour le moment.';
      root.appendChild(p);
      return;
    }
    for (const r of rooms) {
      const div = document.createElement('div');
      div.className = 'room-entry';
      div.innerHTML = `
        <div class="room-entry-info">
          <span class="room-entry-name"></span>
          <span class="room-entry-meta"></span>
        </div>
        <button class="btn btn-secondary">Rejoindre</button>
      `;
      div.querySelector('.room-entry-name').textContent = r.name || 'Salon';
      div.querySelector('.room-entry-meta').textContent =
        `Code : ${r.code} · ${r.players}/${r.max} joueurs`;
      div.querySelector('button').addEventListener('click', () => onJoin(r.code));
      root.appendChild(div);
    }
  }

  /* ---------------------------------------------------------
     Game-over screen
     --------------------------------------------------------- */
  function renderGameOver(view) {
    const ol = document.getElementById('gameover-scores');
    ol.innerHTML = '';
    const sorted = view.players.slice().sort((a, b) => b.totalScore - a.totalScore);
    for (const p of sorted) {
      const li = document.createElement('li');
      li.textContent = `${p.name} — ${p.totalScore} pts`;
      ol.appendChild(li);
    }
    document.getElementById('gameover-title').textContent =
      view.winner ? `🏆 ${view.winner.name} gagne la partie !` : 'Partie terminée';
  }

  /* ---------------------------------------------------------
     EXPORT
     --------------------------------------------------------- */
  window.UnoUI = {
    showScreen,
    toast,
    buildCardEl,
    buildCardBack,
    renderLobby,
    renderGame,
    showColorPicker,
    showChallengeModal,
    renderPublicRooms,
    renderGameOver
  };
})();
