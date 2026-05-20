/* =========================================================
   UNO Online — Card / Deck module
   Exposes window.UnoCards
   =========================================================
   Card schema:
     {
       id:    number    // unique id within a single game
       color: 'red' | 'blue' | 'green' | 'yellow' | null  (null = wild)
       type:  'number' | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4'
       value: number | null   // for 'number' cards: 0..9. null otherwise.
     }
   When a wild/wild4 is played, the chosen color is stored separately on the
   game state's `currentColor`, not on the card object itself (the card stays
   "wild" in the deck for reshuffle purposes).
   ========================================================= */

(function () {
  'use strict';

  const COLORS = ['red', 'blue', 'green', 'yellow'];

  /**
   * Build the standard 108-card UNO deck.
   * Distribution per official rules:
   *   - 76 number cards: each color has one 0 and two each of 1..9  (4×19 = 76)
   *   - 24 action cards: 2 Skip, 2 Reverse, 2 Draw Two per color    (4×6  = 24)
   *   -  4 Wild
   *   -  4 Wild Draw Four
   * Total: 108.
   */
  function buildDeck() {
    const deck = [];
    let id = 0;

    for (const color of COLORS) {
      // One 0 per color
      deck.push({ id: id++, color, type: 'number', value: 0 });

      // Two of each 1..9
      for (let n = 1; n <= 9; n++) {
        deck.push({ id: id++, color, type: 'number', value: n });
        deck.push({ id: id++, color, type: 'number', value: n });
      }

      // Two each of Skip, Reverse, Draw Two
      for (let i = 0; i < 2; i++) {
        deck.push({ id: id++, color, type: 'skip',    value: null });
        deck.push({ id: id++, color, type: 'reverse', value: null });
        deck.push({ id: id++, color, type: 'draw2',   value: null });
      }
    }

    // 4 Wild, 4 Wild Draw Four
    for (let i = 0; i < 4; i++) {
      deck.push({ id: id++, color: null, type: 'wild',  value: null });
      deck.push({ id: id++, color: null, type: 'wild4', value: null });
    }

    return deck;
  }

  /**
   * Fisher–Yates shuffle. Uses provided RNG for deterministic seeding (optional).
   */
  function shuffle(arr, rng) {
    const a = arr.slice();
    const random = rng || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Display label for a card (used in toasts / logs).
   */
  function label(card) {
    if (!card) return '?';
    const colorName = card.color
      ? ({ red: 'Rouge', blue: 'Bleu', green: 'Vert', yellow: 'Jaune' })[card.color]
      : '';
    switch (card.type) {
      case 'number':  return `${colorName} ${card.value}`;
      case 'skip':    return `${colorName} Passer`;
      case 'reverse': return `${colorName} Inversion`;
      case 'draw2':   return `${colorName} +2`;
      case 'wild':    return `Joker`;
      case 'wild4':   return `+4`;
      default:        return '?';
    }
  }

  /**
   * Point value of a card for end-of-round scoring.
   */
  function points(card) {
    if (card.type === 'number') return card.value;
    if (card.type === 'wild' || card.type === 'wild4') return 50;
    return 20; // skip / reverse / draw2
  }

  /**
   * Generate an 8-char random room code (A-Z, 0-9 — excluding ambiguous chars).
   */
  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  window.UnoCards = {
    COLORS,
    buildDeck,
    shuffle,
    label,
    points,
    generateRoomCode
  };
})();
