/* =========================================================
   UNO Online — Rules engine
   Exposes window.UnoRules
   =========================================================
   All functions are PURE w.r.t. the input state where possible.
   The host runs all rule logic; clients render the resulting state.
   ========================================================= */

(function () {
  'use strict';

  const { buildDeck, shuffle, points } = window.UnoCards;

  /* ---------------------------------------------------------
     State factory
     --------------------------------------------------------- */

  function createGame(players, options) {
    const opts = Object.assign({
      targetScore: 500,
      stacking: false,
      startingHand: 7
    }, options || {});

    return {
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        hand: [],
        totalScore: 0,
        calledUno: false,
        connected: true
      })),
      drawPile: [],
      discardPile: [],
      currentPlayer: 0,
      direction: 1,
      currentColor: null,
      pendingDraw: 0,
      status: 'playing',
      lastAction: null,
      targetScore: opts.targetScore,
      stacking: opts.stacking,
      startingHand: opts.startingHand,
      pendingChallenge: null,
      winner: null,
      roundWinner: null,
      waitingForDrawDecision: false,
      lastDrawnCardId: null,
      unoMissedBy: null
    };
  }

  /* ---------------------------------------------------------
     Round setup
     --------------------------------------------------------- */

  function startRound(state) {
    let deck = shuffle(buildDeck());
    for (const p of state.players) {
      p.hand = deck.splice(0, state.startingHand);
      p.calledUno = false;
    }
    let top = deck.pop();
    // Official: if first card is +4, reshuffle and flip again
    while (top.type === 'wild4') {
      deck.push(top);
      deck = shuffle(deck);
      top = deck.pop();
    }
    state.drawPile = deck;
    state.discardPile = [top];
    state.currentColor = top.color || 'red';
    state.direction = 1;
    state.pendingDraw = 0;
    state.pendingChallenge = null;
    state.status = 'playing';
    state.waitingForDrawDecision = false;
    state.lastDrawnCardId = null;
    state.unoMissedBy = null;
    state.currentPlayer = 0;
    state.roundWinner = null;

    // Apply initial card effects per official rules
    if (top.type === 'skip') {
      state.lastAction = { type: 'firstCardSkip', skipped: state.players[0].id };
      state.currentPlayer = nextIndex(state, 1);
    } else if (top.type === 'reverse') {
      state.direction = -1;
      state.currentPlayer = state.players.length - 1;
      state.lastAction = { type: 'firstCardReverse' };
    } else if (top.type === 'draw2') {
      drawN(state, 0, 2);
      state.lastAction = { type: 'firstCardDraw2', target: state.players[0].id };
      state.currentPlayer = nextIndex(state, 1);
    } else if (top.type === 'wild') {
      state.status = 'choosing-color';
      state.lastAction = { type: 'firstCardWild', chooser: state.players[0].id };
    }
    return state;
  }

  /* ---------------------------------------------------------
     Turn navigation
     --------------------------------------------------------- */

  function nextIndex(state, steps) {
    const n = state.players.length;
    let idx = state.currentPlayer;
    let remaining = steps;
    // Safety: cap at n*2 iterations to avoid infinite loop if all disconnected
    let safety = n * 4;
    while (remaining > 0 && safety-- > 0) {
      idx = (idx + state.direction + n) % n;
      if (state.players[idx].connected) remaining--;
    }
    return idx;
  }

  /* ---------------------------------------------------------
     Drawing
     --------------------------------------------------------- */

  function drawN(state, playerIdx, n) {
    for (let i = 0; i < n; i++) {
      ensureDrawPile(state);
      if (state.drawPile.length === 0) return;
      const card = state.drawPile.pop();
      state.players[playerIdx].hand.push(card);
    }
  }

  function ensureDrawPile(state) {
    if (state.drawPile.length > 0) return;
    if (state.discardPile.length <= 1) return;
    const top = state.discardPile.pop();
    state.drawPile = shuffle(state.discardPile);
    state.discardPile = [top];
  }

  /* ---------------------------------------------------------
     Legality
     --------------------------------------------------------- */

  function canPlay(card, topCard, currentColor, pendingDraw, stacking) {
    if (pendingDraw > 0 && stacking) {
      if (topCard.type === 'draw2' && card.type === 'draw2') return true;
      if (topCard.type === 'wild4' && card.type === 'wild4') return true;
      return false;
    }
    if (pendingDraw > 0 && !stacking) return false;
    if (card.type === 'wild') return true;
    if (card.type === 'wild4') return true;
    if (card.color === currentColor) return true;
    if (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) return true;
    if (card.type === topCard.type && card.type !== 'number') return true;
    return false;
  }

  function wasWild4Legal(playerHand, topCardBeforePlay, currentColorBeforePlay, wild4CardId) {
    for (const c of playerHand) {
      if (c.id === wild4CardId) continue;
      if (c.type === 'wild' || c.type === 'wild4') continue;
      if (c.color === currentColorBeforePlay) return false;
      if (c.type === 'number' && topCardBeforePlay.type === 'number' && c.value === topCardBeforePlay.value) return false;
      if (c.type === topCardBeforePlay.type && c.type !== 'number') return false;
    }
    return true;
  }

  /* ---------------------------------------------------------
     Actions
     --------------------------------------------------------- */

  function playCard(state, playerId, cardId, chosenColor) {
    if (state.status !== 'playing') return { ok: false, error: 'Pas en phase de jeu.' };
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx !== state.currentPlayer) return { ok: false, error: "Ce n'est pas ton tour." };
    const player = state.players[idx];
    const cardIdx = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return { ok: false, error: 'Carte introuvable.' };
    const card = player.hand[cardIdx];
    const top = state.discardPile[state.discardPile.length - 1];

    if (!canPlay(card, top, state.currentColor, state.pendingDraw, state.stacking)) {
      return { ok: false, error: 'Carte non jouable.' };
    }

    if ((card.type === 'wild' || card.type === 'wild4') && !chosenColor) {
      return { ok: false, requiresColor: true };
    }

    const topBefore = top;
    const colorBefore = state.currentColor;
    const handBefore = player.hand.slice();

    // Remove from hand & push to discard
    player.hand.splice(cardIdx, 1);
    state.discardPile.push(card);
    state.lastDrawnCardId = null;
    state.waitingForDrawDecision = false;

    // UNO miss detection
    if (player.hand.length === 1 && !player.calledUno) {
      state.unoMissedBy = player.id;
    } else {
      state.unoMissedBy = null;
    }
    if (player.hand.length !== 1) player.calledUno = false;

    // Update color
    if (card.type === 'wild' || card.type === 'wild4') {
      state.currentColor = chosenColor;
    } else {
      state.currentColor = card.color;
    }

    // Apply effects (BEFORE checking round end so going-out with +2/+4 still applies)
    let skipNext = false;
    if (card.type === 'skip') {
      skipNext = true;
    } else if (card.type === 'reverse') {
      state.direction *= -1;
      if (state.players.length === 2) skipNext = true;
    } else if (card.type === 'draw2') {
      if (state.stacking) {
        state.pendingDraw += 2;
      } else {
        const target = nextIndex(state, 1);
        drawN(state, target, 2);
        skipNext = true;
      }
    } else if (card.type === 'wild4') {
      state.pendingChallenge = {
        playerWhoPlayed: player.id,
        hadOtherPlayable: !wasWild4Legal(handBefore, topBefore, colorBefore, card.id),
        topBefore: topBefore,
        colorBefore: colorBefore
      };
      if (state.stacking) {
        state.pendingDraw += 4;
      } else if (player.hand.length === 0) {
        // Going out with +4: no challenge phase, apply directly
        const target = nextIndex(state, 1);
        drawN(state, target, 4);
        state.pendingChallenge = null;
        skipNext = true;
      } else {
        // Challenge flow
        const targetIdx = nextIndex(state, 1);
        state.pendingDraw = 4;
        state.status = 'challenge';
        state.lastAction = {
          type: 'wild4Played',
          by: player.id,
          targetIdx: targetIdx,
          targetId: state.players[targetIdx].id,
          chosenColor: chosenColor
        };
        return { ok: true, awaitingChallenge: true };
      }
    }

    // Round-end check (after effects)
    if (player.hand.length === 0) {
      return finishRound(state, player.id);
    }

    state.lastAction = {
      type: 'play',
      by: player.id,
      card,
      chosenColor: (card.type === 'wild' || card.type === 'wild4') ? chosenColor : null
    };
    state.currentPlayer = nextIndex(state, skipNext ? 2 : 1);
    return { ok: true };
  }

  function resolveChallenge(state, challenge) {
    if (state.status !== 'challenge' || !state.pendingChallenge) {
      return { ok: false, error: 'Pas de défi en cours.' };
    }
    const pc = state.pendingChallenge;
    const playerIdx = state.players.findIndex(p => p.id === pc.playerWhoPlayed);
    const targetIdx = nextIndex(state, 1);

    if (challenge) {
      if (pc.hadOtherPlayable) {
        drawN(state, playerIdx, 4);
        state.lastAction = { type: 'challengeWon', against: pc.playerWhoPlayed };
      } else {
        drawN(state, targetIdx, 6);
        state.lastAction = { type: 'challengeLost', against: state.players[targetIdx].id };
      }
    } else {
      drawN(state, targetIdx, 4);
      state.lastAction = { type: 'wild4Accepted', against: state.players[targetIdx].id };
    }
    state.pendingChallenge = null;
    state.pendingDraw = 0;
    state.status = 'playing';
    state.currentPlayer = nextIndex(state, 2);
    return { ok: true };
  }

  function drawForCurrentPlayer(state, playerId) {
    if (state.status !== 'playing') return { ok: false, error: 'Pas en phase de jeu.' };
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx !== state.currentPlayer) return { ok: false, error: "Ce n'est pas ton tour." };
    if (state.waitingForDrawDecision) return { ok: false, error: 'Tu as déjà pioché.' };

    if (state.pendingDraw > 0) {
      drawN(state, idx, state.pendingDraw);
      state.lastAction = { type: 'forcedDraw', by: playerId, n: state.pendingDraw };
      state.pendingDraw = 0;
      state.currentPlayer = nextIndex(state, 1);
      return { ok: true, drawnCard: null, playable: false, forced: true };
    }

    ensureDrawPile(state);
    if (state.drawPile.length === 0) {
      state.currentPlayer = nextIndex(state, 1);
      return { ok: true, drawnCard: null, playable: false };
    }
    const card = state.drawPile.pop();
    state.players[idx].hand.push(card);
    state.lastDrawnCardId = card.id;

    const top = state.discardPile[state.discardPile.length - 1];
    const playable = canPlay(card, top, state.currentColor, state.pendingDraw, state.stacking);

    if (playable) {
      state.waitingForDrawDecision = true;
      state.lastAction = { type: 'draw', by: playerId, canPlay: true };
      return { ok: true, drawnCard: card, playable: true };
    } else {
      state.lastAction = { type: 'draw', by: playerId, canPlay: false };
      state.currentPlayer = nextIndex(state, 1);
      return { ok: true, drawnCard: card, playable: false };
    }
  }

  function passAfterDraw(state, playerId) {
    if (!state.waitingForDrawDecision) return { ok: false, error: 'Pas de pioche à passer.' };
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx !== state.currentPlayer) return { ok: false, error: "Ce n'est pas ton tour." };
    state.waitingForDrawDecision = false;
    state.lastDrawnCardId = null;
    state.currentPlayer = nextIndex(state, 1);
    state.lastAction = { type: 'pass', by: playerId };
    return { ok: true };
  }

  function callUno(state, playerId) {
    const p = state.players.find(p => p.id === playerId);
    if (!p) return { ok: false, error: 'Joueur introuvable.' };
    p.calledUno = true;
    state.lastAction = { type: 'unoCalled', by: playerId };
    if (state.unoMissedBy === playerId) state.unoMissedBy = null;
    return { ok: true };
  }

  function catchUno(state, accusedId, accuserId) {
    if (state.unoMissedBy !== accusedId) {
      return { ok: false, error: 'Aucune omission UNO valide.' };
    }
    const idx = state.players.findIndex(p => p.id === accusedId);
    if (idx === -1) return { ok: false, error: 'Joueur introuvable.' };
    drawN(state, idx, 2);
    state.unoMissedBy = null;
    state.lastAction = { type: 'unoCaught', by: accuserId, against: accusedId };
    return { ok: true };
  }

  /* ---------------------------------------------------------
     End of round / scoring
     --------------------------------------------------------- */

  function finishRound(state, winnerId) {
    state.status = 'round-over';
    state.roundWinner = winnerId;
    let totalPoints = 0;
    for (const p of state.players) {
      for (const c of p.hand) totalPoints += points(c);
    }
    const winner = state.players.find(p => p.id === winnerId);
    winner.totalScore += totalPoints;
    state.lastAction = { type: 'roundOver', winner: winnerId, points: totalPoints };

    if (winner.totalScore >= state.targetScore) {
      state.status = 'game-over';
      state.winner = winnerId;
    }
    return { ok: true, roundOver: true, points: totalPoints };
  }

  function chooseInitialColor(state, color) {
    if (state.status !== 'choosing-color') return { ok: false };
    state.currentColor = color;
    state.status = 'playing';
    state.lastAction = { type: 'initialColorChosen', color };
    return { ok: true };
  }

  function kickPlayer(state, playerId) {
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx === -1) return { ok: false };
    state.players[idx].connected = false;
    state.drawPile = shuffle(state.drawPile.concat(state.players[idx].hand));
    state.players[idx].hand = [];
    if (state.currentPlayer === idx) {
      state.currentPlayer = nextIndex(state, 1);
    }
    return { ok: true };
  }

  /* ---------------------------------------------------------
     Export
     --------------------------------------------------------- */

  window.UnoRules = {
    createGame,
    startRound,
    canPlay,
    playCard,
    drawForCurrentPlayer,
    passAfterDraw,
    callUno,
    catchUno,
    resolveChallenge,
    chooseInitialColor,
    kickPlayer,
    finishRound,
    nextIndex,
    wasWild4Legal
  };
})();
