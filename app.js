/* =========================================================
   UNO Online — App orchestration
   ========================================================= */

(function () {
  'use strict';

  const { generateRoomCode, label: cardLabel } = window.UnoCards;
  const Rules = window.UnoRules;
  const UI    = window.UnoUI;
  const Net   = window.UnoNet;

  /* ---------------------------------------------------------
     Persisted nickname
     --------------------------------------------------------- */
  const NICK_KEY = 'unofr.nickname';
  function loadNickname() { try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; } }
  function saveNickname(v) { try { localStorage.setItem(NICK_KEY, v); } catch {} }

  /* ---------------------------------------------------------
     Global app state
     --------------------------------------------------------- */
  const App = {
    role: null,            // 'host' | 'client'
    myNickname: '',

    // HOST state:
    hostNet: null,
    directory: null,
    isPublic: false,
    roomCode: null,
    roomName: '',
    targetScore: 500,
    stacking: false,
    lobby: {
      players: [],   // [{ id, peerId, name, ready, connected }] - host included as id 'self'
      hostId: 'self',
      status: 'lobby',  // 'lobby' | 'playing' | 'round-over' | 'game-over'
    },
    game: null,    // UnoRules game state when started

    // CLIENT state:
    clientNet: null,
    clientLastView: null,
    clientLastLobby: null,
    clientMyId: null,
    clientHostId: null,
  };

  /* =========================================================
     UTILITIES
     ========================================================= */
  function $(id) { return document.getElementById(id); }

  function clearStatus(elId) {
    const el = $(elId);
    if (el) { el.textContent = ''; el.className = 'status-line'; }
  }
  function setStatus(elId, msg, kind) {
    const el = $(elId);
    if (!el) return;
    el.textContent = msg;
    el.className = 'status-line ' + (kind || '');
  }

  /* =========================================================
     HOME SCREEN
     ========================================================= */
  function initHome() {
    const nickInput = $('input-nickname');
    if (!nickInput) {
      console.error("Élément 'input-nickname' introuvable. Vérifie que index.html est complet.");
      return;
    }
    nickInput.value = loadNickname();
    App.myNickname = (nickInput.value || '').trim();

    nickInput.addEventListener('input', () => {
      App.myNickname = nickInput.value.trim();
      saveNickname(App.myNickname);
    });
    // Some mobile keyboards don't fire 'input' reliably; also bind change/blur
    nickInput.addEventListener('change', () => {
      App.myNickname = nickInput.value.trim();
      saveNickname(App.myNickname);
    });

    // Helper: refresh nickname from input right before navigating
    function refreshNick() {
      App.myNickname = nickInput.value.trim();
      saveNickname(App.myNickname);
    }

    $('btn-goto-create').addEventListener('click', () => {
      refreshNick();
      if (!ensureNickname()) return;
      UI.showScreen('create');
    });
    $('btn-goto-join').addEventListener('click', () => {
      refreshNick();
      if (!ensureNickname()) return;
      UI.showScreen('join');
    });
    $('btn-goto-public').addEventListener('click', () => {
      refreshNick();
      if (!ensureNickname()) return;
      UI.showScreen('public');
      loadPublicRooms();
    });

    // Back buttons
    document.querySelectorAll('.btn-back').forEach(b => {
      b.addEventListener('click', () => {
        const target = b.dataset.back || 'home';
        // Clean up any open networking on leaving game/lobby
        cleanupNetworking();
        UI.showScreen(target);
      });
    });
  }

  function ensureNickname() {
    if (!App.myNickname || App.myNickname.length < 2) {
      UI.toast('Choisis un pseudo (2 caractères min).');
      $('input-nickname').focus();
      return false;
    }
    return true;
  }

  function cleanupNetworking() {
    if (App.hostNet) { try { App.hostNet.close(); } catch {} App.hostNet = null; }
    if (App.directory) { try { App.directory.close(); } catch {} App.directory = null; }
    if (App.clientNet) { try { App.clientNet.close(); } catch {} App.clientNet = null; }
    App.role = null;
    App.game = null;
    App.lobby = { players: [], hostId: 'self', status: 'lobby' };
  }

  /* =========================================================
     PUBLIC ROOMS BROWSER
     ========================================================= */
  async function loadPublicRooms() {
    const root = $('public-rooms-list');
    root.innerHTML = '<p class="empty-state">Recherche…</p>';
    const dir = new Net.Directory();
    try {
      const role = await dir.claimOrConnect();
      if (role === null) {
        UI.renderPublicRooms([], () => {});
        dir.close();
        return;
      }
      const rooms = await dir.fetchList(4000);
      UI.renderPublicRooms(rooms, (code) => {
        dir.close();
        joinRoomByCode(code);
      });
      // Cleanup after a short delay (in case user clicks)
      setTimeout(() => { try { dir.close(); } catch {} }, 30000);
    } catch (err) {
      console.warn('Directory error:', err);
      UI.renderPublicRooms([], () => {});
      try { dir.close(); } catch {}
    }
  }

  /* =========================================================
     CREATE ROOM (HOST)
     ========================================================= */
  function initCreate() {
    $('btn-create-room').addEventListener('click', async () => {
      const name = $('input-room-name').value.trim() || `Salon de ${App.myNickname}`;
      const isPublic = $('input-room-public').checked;
      const targetScore = parseInt($('input-target-score').value, 10) || 500;
      const stacking = $('input-stacking').checked;

      App.roomName = name;
      App.isPublic = isPublic;
      App.targetScore = targetScore;
      App.stacking = stacking;
      App.role = 'host';

      // Try a few times in case of code collision
      setStatus('create-status', 'Création du salon…');
      let success = false;
      for (let attempt = 0; attempt < 5 && !success; attempt++) {
        const code = generateRoomCode();
        App.roomCode = code;
        try {
          App.hostNet = new Net.Host(code);
          await App.hostNet.start();
          success = true;
        } catch (err) {
          console.warn('Host start error:', err);
          if (attempt === 4) {
            setStatus('create-status', 'Impossible de créer le salon : ' + err.message, 'error');
            App.hostNet = null;
            return;
          }
          // Try a new code
          App.hostNet = null;
        }
      }
      // Setup host event handlers
      setupHostEvents();

      // Initialize lobby with host as first player
      App.lobby = {
        players: [{
          id: 'self',
          peerId: 'self',
          name: App.myNickname,
          ready: false,
          connected: true
        }],
        hostId: 'self',
        status: 'lobby'
      };

      // Register with directory if public
      if (isPublic) {
        App.directory = new Net.Directory();
        try {
          await App.directory.claimOrConnect();
          App.directory.registerRoom({
            code: App.roomCode,
            name: App.roomName,
            players: App.lobby.players.length,
            max: 8
          });
        } catch (err) {
          console.warn('Directory registration failed:', err);
        }
      }

      UI.showScreen('lobby');
      renderHostLobby();
    });
  }

  function setupHostEvents() {
    App.hostNet.addEventListener('client-connected', (e) => {
      const peerId = e.detail.peerId;
      // Wait for their 'join' message
    });
    App.hostNet.addEventListener('client-disconnected', (e) => {
      const peerId = e.detail.peerId;
      // Remove from lobby OR mark disconnected if mid-game
      if (App.lobby.status === 'lobby') {
        App.lobby.players = App.lobby.players.filter(p => p.peerId !== peerId);
        renderHostLobby();
        updateDirectory();
      } else {
        const p = App.lobby.players.find(p => p.peerId === peerId);
        if (p) {
          p.connected = false;
          if (App.game) {
            const gp = App.game.players.find(g => g.id === p.id);
            if (gp) gp.connected = false;
          }
          broadcastState();
        }
      }
    });
    App.hostNet.addEventListener('message', (e) => {
      onHostMessage(e.detail.peerId, e.detail.message);
    });
    App.hostNet.addEventListener('network-error', (e) => {
      console.warn('Network error:', e.detail);
    });
  }

  /* =========================================================
     HOST: HANDLE INCOMING MESSAGES
     ========================================================= */
  function onHostMessage(peerId, msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'join': {
        if (App.lobby.status !== 'lobby') {
          App.hostNet.sendTo(peerId, { type: 'error', message: 'Partie déjà en cours.' });
          App.hostNet.kick(peerId, 'in-progress');
          return;
        }
        if (App.lobby.players.length >= 8) {
          App.hostNet.sendTo(peerId, { type: 'error', message: 'Salon plein.' });
          App.hostNet.kick(peerId, 'full');
          return;
        }
        const name = String(msg.name || 'Anonyme').slice(0, 16);
        const id = peerId; // use peerId as player id
        App.lobby.players.push({
          id, peerId, name, ready: false, connected: true
        });
        App.hostNet.sendTo(peerId, {
          type: 'welcome',
          yourId: id,
          hostId: App.lobby.hostId,
          lobby: serializeLobby()
        });
        broadcastLobby();
        updateDirectory();
        break;
      }
      case 'set-ready': {
        const p = App.lobby.players.find(p => p.peerId === peerId);
        if (p) { p.ready = !!msg.ready; broadcastLobby(); }
        break;
      }
      case 'action-play': {
        const player = App.lobby.players.find(p => p.peerId === peerId);
        if (!player) return;
        applyAction(player.id, msg);
        break;
      }
      case 'action-draw':
      case 'action-pass':
      case 'action-uno':
      case 'action-catch-uno':
      case 'action-challenge':
      case 'action-choose-color': {
        const player = App.lobby.players.find(p => p.peerId === peerId);
        if (!player) return;
        applyAction(player.id, msg);
        break;
      }
      case 'rematch': {
        const p = App.lobby.players.find(p => p.peerId === peerId);
        if (p && p.id === App.lobby.hostId) doRematch();
        break;
      }
    }
  }

  function serializeLobby() {
    return {
      roomName: App.roomName,
      roomCode: App.roomCode,
      hostId: App.lobby.hostId,
      players: App.lobby.players.map(p => ({
        id: p.id, name: p.name, ready: p.ready, connected: p.connected
      }))
    };
  }

  function broadcastLobby() {
    const lobby = serializeLobby();
    if (App.hostNet) {
      App.hostNet.broadcast({ type: 'lobby', lobby });
    }
    renderHostLobby();
    updateDirectory();
    // Auto-start if all players ready and ≥2
    const allReady = App.lobby.players.length >= 2 &&
                     App.lobby.players.every(p => p.id === App.lobby.hostId || p.ready);
    // Host also needs to be ready
    const hostPlayer = App.lobby.players.find(p => p.id === App.lobby.hostId);
    if (allReady && hostPlayer && hostPlayer.ready) {
      hostStartGame();
    }
  }

  function updateDirectory() {
    if (App.directory && App.isPublic) {
      App.directory.updateRoom({
        code: App.roomCode,
        name: App.roomName,
        players: App.lobby.players.length,
        max: 8
      });
    }
  }

  /* =========================================================
     HOST: LOBBY UI
     ========================================================= */
  function renderHostLobby() {
    UI.renderLobby({
      players: App.lobby.players,
      hostId: App.lobby.hostId,
      myId: 'self',
      roomName: App.roomName,
      roomCode: App.roomCode
    }, {
      onKick: (targetId) => {
        const target = App.lobby.players.find(p => p.id === targetId);
        if (!target || target.id === 'self') return;
        App.hostNet.kick(target.peerId, 'kicked');
        App.lobby.players = App.lobby.players.filter(p => p.id !== targetId);
        broadcastLobby();
      }
    });
  }

  /* =========================================================
     HOST: START GAME
     ========================================================= */
  function hostStartGame() {
    if (App.lobby.players.length < 2) {
      UI.toast('Au moins 2 joueurs requis.');
      return;
    }
    App.lobby.status = 'playing';
    App.game = Rules.createGame(
      App.lobby.players.map(p => ({ id: p.id, name: p.name })),
      { targetScore: App.targetScore, stacking: App.stacking }
    );
    Rules.startRound(App.game);
    // Unregister room from public directory once playing
    if (App.directory && App.isPublic) {
      App.directory.updateRoom({
        code: App.roomCode,
        name: App.roomName + ' (en cours)',
        players: App.lobby.players.length,
        max: 8
      });
    }
    App.hostNet.broadcast({ type: 'game-start' });
    UI.showScreen('game');
    broadcastState();
  }

  /* =========================================================
     HOST: ACTION DISPATCH
     ========================================================= */
  function applyAction(playerId, msg) {
    if (!App.game) return;
    let result;
    switch (msg.type) {
      case 'action-play':
        result = Rules.playCard(App.game, playerId, msg.cardId, msg.chosenColor);
        if (!result.ok) {
          sendErrorTo(playerId, result.error || "Action invalide.");
          return;
        }
        if (result.requiresColor) {
          sendErrorTo(playerId, "Une couleur est requise pour cette carte.");
          return;
        }
        broadcastState();
        if (result.awaitingChallenge) {
          // Inform target client to show challenge modal
          const target = App.game.players[Rules.nextIndex(App.game, 1)]; // index after the play
          // After the play that triggered challenge, currentPlayer hasn't moved yet
          // because we don't advance until challenge resolves. The "target" is
          // already encoded in lastAction.targetId.
          const targetId = App.game.lastAction?.targetId;
          if (targetId) {
            const targetPeer = peerIdFor(targetId);
            if (targetPeer === 'self') {
              promptChallengeLocal();
            } else if (targetPeer) {
              App.hostNet.sendTo(targetPeer, { type: 'prompt-challenge' });
            }
          }
        }
        if (App.game.status === 'round-over' || App.game.status === 'game-over') {
          handleRoundOver();
        }
        break;

      case 'action-draw':
        result = Rules.drawForCurrentPlayer(App.game, playerId);
        if (!result.ok) sendErrorTo(playerId, result.error);
        broadcastState();
        break;

      case 'action-pass':
        result = Rules.passAfterDraw(App.game, playerId);
        if (!result.ok) sendErrorTo(playerId, result.error);
        broadcastState();
        break;

      case 'action-uno':
        Rules.callUno(App.game, playerId);
        broadcastState();
        break;

      case 'action-catch-uno':
        Rules.catchUno(App.game, msg.accusedId, playerId);
        broadcastState();
        break;

      case 'action-challenge':
        result = Rules.resolveChallenge(App.game, !!msg.challenge);
        if (!result.ok) sendErrorTo(playerId, result.error);
        broadcastState();
        if (App.game.status === 'round-over' || App.game.status === 'game-over') {
          handleRoundOver();
        }
        break;

      case 'action-choose-color':
        Rules.chooseInitialColor(App.game, msg.color);
        broadcastState();
        break;
    }
  }

  function sendErrorTo(playerId, message) {
    const peer = peerIdFor(playerId);
    if (peer === 'self') {
      UI.toast(message);
    } else if (peer) {
      App.hostNet.sendTo(peer, { type: 'notify', message });
    }
  }

  function peerIdFor(playerId) {
    if (playerId === 'self') return 'self';
    const p = App.lobby.players.find(p => p.id === playerId);
    return p ? p.peerId : null;
  }

  function handleRoundOver() {
    // Auto-start next round after a short delay if not game-over
    setTimeout(() => {
      if (App.game.status === 'round-over') {
        // Continue with same players
        const activePlayers = App.game.players.map(p => ({ id: p.id, name: p.name }));
        const scores = {};
        for (const p of App.game.players) scores[p.id] = p.totalScore;
        App.game = Rules.createGame(activePlayers, { targetScore: App.targetScore, stacking: App.stacking });
        for (const p of App.game.players) p.totalScore = scores[p.id] || 0;
        Rules.startRound(App.game);
        broadcastState();
      } else if (App.game.status === 'game-over') {
        showGameOver();
      }
    }, 4000);
  }

  function showGameOver() {
    const view = {
      players: App.game.players.map(p => ({
        id: p.id, name: p.name, totalScore: p.totalScore
      })),
      winner: App.game.players.find(p => p.id === App.game.winner)
    };
    if (App.role === 'host') {
      App.hostNet.broadcast({ type: 'game-over', view });
    }
    UI.renderGameOver(view);
    UI.showScreen('gameover');
  }

  /* =========================================================
     HOST: BROADCAST GAME STATE
     ========================================================= */
  function buildView(gameState, forPlayerId) {
    const me = gameState.players.find(p => p.id === forPlayerId);
    return {
      roomCode: App.roomCode,
      players: gameState.players.map(p => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        calledUno: p.calledUno,
        totalScore: p.totalScore,
        connected: p.connected
      })),
      myId: forPlayerId,
      myHand: me ? me.hand.slice() : [],
      hostId: App.lobby.hostId,
      topCard: gameState.discardPile[gameState.discardPile.length - 1] || null,
      currentColor: gameState.currentColor,
      direction: gameState.direction,
      drawPileCount: gameState.drawPile.length,
      currentPlayerId: gameState.players[gameState.currentPlayer]?.id,
      status: gameState.status,
      waitingForDrawDecision: gameState.waitingForDrawDecision,
      pendingDraw: gameState.pendingDraw,
      stacking: gameState.stacking,
      unoMissedBy: gameState.unoMissedBy,
      lastAction: gameState.lastAction,
      winnerId: gameState.winner,
      roundWinner: gameState.roundWinner
    };
  }

  function broadcastState() {
    if (!App.game) return;
    for (const p of App.lobby.players) {
      const view = buildView(App.game, p.id);
      if (p.peerId === 'self') {
        renderHostGameView(view);
      } else {
        App.hostNet.sendTo(p.peerId, { type: 'state', view });
      }
    }
    // If round is over, show a toast on host
    if (App.game.status === 'round-over') {
      const winner = App.game.players.find(p => p.id === App.game.roundWinner);
      UI.toast(`Manche gagnée par ${winner.name} — prochaine manche dans 4s`);
    } else if (App.game.status === 'game-over') {
      const winner = App.game.players.find(p => p.id === App.game.winner);
      UI.toast(`${winner.name} gagne la partie !`);
    }
  }

  /* =========================================================
     HOST: HOST'S OWN GAME UI HANDLING
     ========================================================= */
  function renderHostGameView(view) {
    App.clientLastView = view; // reuse for re-render
    UI.renderGame(view, makeGameHandlers('host'));
    // Handle host's own special prompts
    if (view.status === 'choosing-color' && view.players[0]?.id === 'self') {
      promptInitialColorLocal();
    }
  }

  async function promptInitialColorLocal() {
    const c = await UI.showColorPicker();
    applyAction('self', { type: 'action-choose-color', color: c });
  }

  async function promptChallengeLocal() {
    const ans = await UI.showChallengeModal();
    applyAction('self', { type: 'action-challenge', challenge: ans });
  }

  function doRematch() {
    // Restart with same players & scores reset to zero
    App.lobby.status = 'lobby';
    for (const p of App.lobby.players) p.ready = false;
    App.game = null;
    broadcastLobby();
    UI.showScreen('lobby');
  }

  /* =========================================================
     CLIENT: JOIN ROOM
     ========================================================= */
  function initJoin() {
    $('btn-join-room').addEventListener('click', () => {
      const code = $('input-room-code').value.trim().toUpperCase();
      if (code.length !== 8) {
        setStatus('join-status', 'Le code doit faire 8 caractères.', 'error');
        return;
      }
      joinRoomByCode(code);
    });

    // Auto-uppercase
    $('input-room-code').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase();
    });
  }

  async function joinRoomByCode(code) {
    if (!ensureNickname()) return;
    App.role = 'client';
    App.roomCode = code;
    setStatus('join-status', 'Connexion au salon…');
    App.clientNet = new Net.Client();
    setupClientEvents();
    try {
      await App.clientNet.connect(code);
      App.clientNet.send({ type: 'join', name: App.myNickname });
      // We expect 'welcome' followed by 'lobby' or 'game-start'
      UI.showScreen('lobby');
    } catch (err) {
      setStatus('join-status', err.message || 'Connexion échouée.', 'error');
      try { App.clientNet.close(); } catch {}
      App.clientNet = null;
    }
  }

  function setupClientEvents() {
    App.clientNet.addEventListener('message', (e) => onClientMessage(e.detail));
    App.clientNet.addEventListener('disconnected', () => {
      UI.toast("Connexion perdue avec l'hôte.");
      setTimeout(() => {
        cleanupNetworking();
        UI.showScreen('home');
      }, 1500);
    });
  }

  function onClientMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'welcome':
        App.clientMyId = msg.yourId;
        App.clientHostId = msg.hostId;
        App.clientLastLobby = msg.lobby;
        UI.showScreen('lobby');
        renderClientLobby(msg.lobby);
        break;
      case 'lobby':
        App.clientLastLobby = msg.lobby;
        renderClientLobby(msg.lobby);
        break;
      case 'game-start':
        UI.showScreen('game');
        break;
      case 'state':
        App.clientLastView = msg.view;
        UI.renderGame(msg.view, makeGameHandlers('client'));
        if (msg.view.status === 'choosing-color' && msg.view.players[0]?.id === App.clientMyId) {
          promptInitialColorClient();
        }
        if (msg.view.status === 'round-over') {
          const winner = msg.view.players.find(p => p.id === msg.view.roundWinner);
          if (winner) UI.toast(`Manche gagnée par ${winner.name}`);
        }
        break;
      case 'prompt-challenge':
        promptChallengeClient();
        break;
      case 'game-over':
        UI.renderGameOver(msg.view);
        UI.showScreen('gameover');
        break;
      case 'kicked':
        UI.toast("Tu as été exclu du salon.");
        setTimeout(() => {
          cleanupNetworking();
          UI.showScreen('home');
        }, 1500);
        break;
      case 'notify':
        UI.toast(msg.message);
        break;
      case 'error':
        UI.toast('Erreur: ' + msg.message);
        break;
    }
  }

  function renderClientLobby(lobby) {
    UI.renderLobby({
      players: lobby.players,
      hostId: lobby.hostId,
      myId: App.clientMyId,
      roomName: lobby.roomName,
      roomCode: lobby.roomCode
    }, {
      onKick: () => { /* clients can't kick */ }
    });
  }

  async function promptInitialColorClient() {
    const c = await UI.showColorPicker();
    App.clientNet.send({ type: 'action-choose-color', color: c });
  }

  async function promptChallengeClient() {
    const ans = await UI.showChallengeModal();
    App.clientNet.send({ type: 'action-challenge', challenge: ans });
  }

  /* =========================================================
     GAME HANDLERS (shared between host/client)
     ========================================================= */
  function makeGameHandlers(role) {
    return {
      onPlayCard: async (card) => {
        let chosenColor = null;
        if (card.type === 'wild' || card.type === 'wild4') {
          chosenColor = await UI.showColorPicker();
        }
        if (role === 'host') {
          applyAction('self', { type: 'action-play', cardId: card.id, chosenColor });
        } else {
          App.clientNet.send({ type: 'action-play', cardId: card.id, chosenColor });
        }
      },
      onCatchUno: (accusedId) => {
        if (role === 'host') {
          applyAction('self', { type: 'action-catch-uno', accusedId });
        } else {
          App.clientNet.send({ type: 'action-catch-uno', accusedId });
        }
      }
    };
  }

  /* =========================================================
     LOBBY UI HOOKUPS
     ========================================================= */
  function initLobbyControls() {
    $('btn-ready').addEventListener('click', () => {
      if (App.role === 'host') {
        const me = App.lobby.players.find(p => p.id === 'self');
        if (me) {
          me.ready = !me.ready;
          $('btn-ready').textContent = me.ready ? '✓ Prêt' : 'Je suis prêt';
          broadcastLobby();
        }
      } else if (App.role === 'client') {
        // Toggle local readiness based on last known state
        const lobby = App.clientLastLobby;
        if (!lobby) return;
        const me = lobby.players.find(p => p.id === App.clientMyId);
        if (me) {
          const ready = !me.ready;
          App.clientNet.send({ type: 'set-ready', ready });
          $('btn-ready').textContent = ready ? '✓ Prêt' : 'Je suis prêt';
        }
      }
    });

    $('btn-start-host').addEventListener('click', () => {
      if (App.role === 'host') hostStartGame();
    });

    // Show / hide code
    $('btn-toggle-code').addEventListener('click', () => {
      const codeEl = $('lobby-room-code');
      if (codeEl.classList.contains('hidden-code')) {
        codeEl.classList.remove('hidden-code');
        codeEl.textContent = App.roomCode || App.clientLastLobby?.roomCode || '';
      } else {
        codeEl.classList.add('hidden-code');
        codeEl.textContent = '••••••••';
      }
    });

    $('btn-copy-code').addEventListener('click', async () => {
      const code = App.roomCode || App.clientLastLobby?.roomCode || '';
      try {
        await navigator.clipboard.writeText(code);
        UI.toast('Code copié dans le presse-papier');
      } catch {
        UI.toast('Code : ' + code);
      }
    });
  }

  /* =========================================================
     GAME SCREEN INTERACTIONS
     ========================================================= */
  function initGameControls() {
    // Draw pile click
    $('draw-pile').addEventListener('click', () => {
      if (App.role === 'host') {
        applyAction('self', { type: 'action-draw' });
      } else if (App.role === 'client') {
        App.clientNet.send({ type: 'action-draw' });
      }
    });

    // Pass button
    $('btn-pass').addEventListener('click', () => {
      if (App.role === 'host') {
        applyAction('self', { type: 'action-pass' });
      } else if (App.role === 'client') {
        App.clientNet.send({ type: 'action-pass' });
      }
    });

    // UNO button
    $('btn-uno').addEventListener('click', () => {
      if (App.role === 'host') {
        applyAction('self', { type: 'action-uno' });
      } else if (App.role === 'client') {
        App.clientNet.send({ type: 'action-uno' });
      }
    });

    // Leave game
    $('btn-leave-game').addEventListener('click', () => {
      if (confirm('Quitter la partie ?')) {
        cleanupNetworking();
        UI.showScreen('home');
      }
    });
  }

  function initGameOverControls() {
    $('btn-back-home').addEventListener('click', () => {
      cleanupNetworking();
      UI.showScreen('home');
    });
    $('btn-rematch').addEventListener('click', () => {
      if (App.role === 'host') {
        doRematch();
      } else if (App.role === 'client' && App.clientNet) {
        App.clientNet.send({ type: 'rematch' });
        UI.toast("Demande de revanche envoyée à l'hôte…");
      }
    });
  }

  function initPublicRoomsControls() {
    $('btn-refresh-public').addEventListener('click', loadPublicRooms);
  }

  /* =========================================================
     BOOTSTRAP
     ========================================================= */
  document.addEventListener('DOMContentLoaded', () => {
    initHome();
    initCreate();
    initJoin();
    initLobbyControls();
    initGameControls();
    initGameOverControls();
    initPublicRoomsControls();
  });

  /* =========================================================
     PAGE UNLOAD CLEANUP
     ========================================================= */
  window.addEventListener('beforeunload', () => {
    if (App.directory && App.roomCode) {
      try { App.directory.unregisterRoom(App.roomCode); } catch {}
    }
    cleanupNetworking();
  });
})();
