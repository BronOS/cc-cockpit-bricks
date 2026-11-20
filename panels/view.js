'use strict'
// Pure helpers of the Bricks page: what a cover says, which key does what, where a pointer is on the board, what the
// page reports to the host, where a strong brick's notches go. No DOM and no ccPanel, so `test/view.test.js` runs them
// under node; the page loads this file as a classic script after lib/rules.js (the CSP allows only the plugin's own
// files) and reads `BricksView`.
;(function (root) {
  /** A pause the person (or the page) made: why, in the cover's second line. */
  const REASONS = Object.freeze({
    key: 'Space or P resumes.',
    pointer: 'The pointer left the board.',
    blur: 'The panel lost focus.',
    hidden: 'The panel was hidden.',
    header: 'Paused from the title bar.',
    restored: 'Your game waited for you here.',
    yielded: 'You went on playing in another view.',
    adopted: 'Picked up from your other view.',
  })

  /**
   * The cover over the board, or null for none: `{ kind, dot?, title, text?, buttons: [{ act, label, primary }] }`.
   * `hold` is the page's pause: null, `{ kind: 'paused', reason }` or `{ kind: 'claude', name }`. The Claude pause
   * wins over everything, then game over, then level cleared, then a plain pause. `best` is the best score known for
   * the game's speed (this game's score included once posted), for the "new best" on game over.
   */
  function coverFor(game, hold, best) {
    if (!game) return null
    if (hold && hold.kind === 'claude') {
      return {
        kind: 'claude',
        dot: true,
        title: 'Claude is ready',
        text: `“${hold.name}” is waiting for you.`,
        buttons: [
          { act: 'resume', label: 'Resume game', primary: true },
          { act: 'goto', label: 'Go to the tab', primary: false },
        ],
      }
    }
    if (game.phase === 'over') {
      const record = game.score > 0 && typeof best === 'number' && game.score >= best
      return {
        kind: 'over',
        title: `Game over · ${game.score}`,
        text: record ? 'A new best for this speed.' : `Reached level ${game.level + 1}`,
        buttons: [{ act: 'new', label: 'New game', primary: true }],
      }
    }
    if (game.phase === 'cleared') {
      return {
        kind: 'cleared',
        title: `Level ${game.level} cleared`,
        text: game.level % 5 === 0 ? `+100 · the levels start again, a little faster` : '+100',
        buttons: [{ act: 'next', label: 'Next level', primary: true }],
      }
    }
    if (hold && hold.kind === 'paused') {
      return {
        kind: 'paused',
        title: 'Paused',
        text: REASONS[hold.reason] || '',
        buttons: [
          { act: 'resume', label: 'Resume', primary: true },
          { act: 'new', label: 'New game', primary: false },
        ],
      }
    }
    return null
  }

  const KEYS = {
    ArrowLeft: 'left',
    a: 'left',
    A: 'left',
    ArrowRight: 'right',
    d: 'right',
    D: 'right',
    ' ': 'space',
    p: 'pause',
    P: 'pause',
    n: 'new',
    N: 'new',
  }
  /** What a key on the board does: `left`, `right` (held), `space` (launch or pause), `pause` (P), `new`; else null. */
  const keyOf = (key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(KEYS, key) ? KEYS[key] : null)

  /** A pointer's x on the board in game units, from its client x and the canvas's box; null for junk. */
  function boardX(clientX, left, width, W) {
    if (![clientX, left, width, W].every(Number.isFinite) || width <= 0) return null
    return ((clientX - left) / width) * W
  }

  /** Whether the game moves: in `aim` or `play` and under no pause. */
  const isRunning = (game, hold) => !!game && !hold && (game.phase === 'aim' || game.phase === 'play')

  /** The report the host keeps for the title bar and the Claude pause. `level` is 1-based. */
  const reportOf = (game, hold) => ({
    level: game.level + 1,
    speed: game.speed,
    phase: game.phase,
    running: isRunning(game, hold),
    started: game.started,
  })

  /** Whether a Claude pause takes this game: one launched at least once and not over. */
  const claudeTakes = (game) => !!game && game.started && game.phase !== 'over'

  /** The pause a saved game comes back under: a started game in aim or play waits; a new one or a cover needs none. */
  const restoredHold = (game) =>
    game && game.started && (game.phase === 'aim' || game.phase === 'play') ? { kind: 'paused', reason: 'restored' } : null

  /**
   * The notches of a brick that takes more than one hit: one per hit left, 5 by 4 units, centred, 2 apart. The count is
   * the strength, so it never rests on telling two greys apart.
   */
  function notches(k) {
    if (!k || k.max <= 1 || k.hp <= 0) return []
    const out = []
    const w = 5
    const gap = 2
    const total = k.hp * w + (k.hp - 1) * gap
    for (let i = 0; i < k.hp; i++) out.push({ x: k.x + k.w / 2 - total / 2 + i * (w + gap), y: k.y + k.h / 2 - 2, w, h: 4 })
    return out
  }

  /** A brick that was just hit shows white for a tenth of a second, unless the person asked for reduced motion. */
  const flashes = (k, t, reduced) => !reduced && k.hitAt >= 0 && t - k.hitAt < 0.1

  /** The foot's right side: the level, and a capsule's effect with the whole seconds it has left. */
  function footInfo(game) {
    if (!game) return ''
    const parts = [`Level ${game.level + 1}`]
    if (game.t < game.wideUntil) parts.push(`Wide ${Math.ceil(game.wideUntil - game.t)}s`)
    if (game.t < game.slowUntil) parts.push(`Slow ${Math.ceil(game.slowUntil - game.t)}s`)
    return parts.join(' · ')
  }

  /** The balls-left line for a screen reader and the tooltip. */
  const livesLabel = (n) => `${n} ${n === 1 ? 'ball' : 'balls'} left`

  /** The hint on the board while a ball waits on the paddle and nothing covers it. */
  const hint = (game, hold) => (game && !hold && game.phase === 'aim' ? 'Space or click to launch' : '')

  const api = { REASONS, coverFor, keyOf, boardX, isRunning, reportOf, claudeTakes, restoredHold, notches, flashes, footInfo, livesLabel, hint }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.BricksView = api
})(globalThis)
