'use strict'
// The Bricks game itself: the board, the paddle, the balls, the bricks and their capsules, lives, levels and the
// score, advanced in fixed steps. Pure (no ctx, no clock, no DOM; `rng` injected), so `test/rules.test.js` runs every
// rule under node.
//
// Unlike Mines and Tiles, the game runs in the panel page, not in the host: a ball moves 240 times a second and that
// cannot cross to the host and back per step. The page loads this file as a classic script (the panel CSP allows the
// plugin's own files only, so the same file serves both: UMD-style, `module.exports` under node, `BricksRules` in
// the page). The host requires it too, for `sanitize`: a snapshot the page posts is untrusted until it went through.
//
// A game is one plain JSON object, mutated in place by `step` and friends. Being plain data is the point: the page
// posts it as the snapshot the host keeps, so a panel that was hidden (which unmounts the page) or opened in another
// view brings back the very same game. All times in it are game time (seconds of play), so a pause stops the capsule
// timers along with everything else.
;(function (root) {
  /** The board in game units; the canvas scales it to the panel, keeping its 3:4 shape. */
  const W = 300
  const H = 400
  /** One step of the simulation: 240 a second, so even the fastest ball moves less than its radius per step. */
  const STEP = 1 / 240
  /** A frame longer than this (a stalled tab, a debugger) is cut to it, so the game never jumps ahead. */
  const MAX_FRAME = 0.25

  const BALL_R = 5
  const PADDLE_Y = H - 26
  const PADDLE_H = 7
  const PADDLE_W = 56
  const PADDLE_WIDE = 84
  /** How fast arrow keys move the paddle, units a second. */
  const PADDLE_SPEED = 360
  /** The widest angle off vertical the paddle gives, at its very edge (60 degrees). */
  const MAX_ANGLE = 1.05
  /** The launch angle wobbles up to this much either side of straight up. */
  const LAUNCH_WOBBLE = 0.3
  const CAPSULE_FALL = 96
  const CAPSULE_CHANCE = 0.12
  const WIDE_FOR = 12
  const SLOW_FOR = 10
  const SLOW_BY = 0.7
  const LIVES = 3
  const MAX_LIVES = 5
  const MAX_BALLS = 4
  /** Each round of the five levels is this much faster, up to MAX_ROUND_SPEEDUP. */
  const ROUND_SPEEDUP = 0.12
  const MAX_ROUND_SPEEDUP = 1.6

  /** Ball speeds in units a second (the mock-up's per-frame speeds at 60 frames a second). */
  const SPEEDS = Object.freeze({
    calm: Object.freeze({ label: 'Calm', v: 192 }),
    normal: Object.freeze({ label: 'Normal', v: 252 }),
    fast: Object.freeze({ label: 'Fast', v: 324 }),
  })
  const SPEED_IDS = Object.freeze(Object.keys(SPEEDS))
  const DEFAULT_SPEED = 'normal'
  const isSpeed = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPEEDS, id)
  const nextSpeed = (id) => SPEED_IDS[(SPEED_IDS.indexOf(isSpeed(id) ? id : DEFAULT_SPEED) + 1) % SPEED_IDS.length]

  /**
   * The five layouts, ten columns each. `a`..`e` are one-hit bricks in five colours, `2` and `3` take that many hits,
   * `.` is a gap. After the fifth the first comes back, faster.
   */
  const LEVELS = Object.freeze([
    ['..........', 'aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee'],
    ['....22....', '...2222...', '..2aaaa2..', '.2bbbbbb2.', '2cccccccc2', 'dddddddddd'],
    ['3........3', '33a.aa.a33', '.bbbbbbbb.', '.c2c..c2c.', 'dddddddddd', '.e.e.e.e.e'],
    ['aaaa..aaaa', 'b2b2..b2b2', 'cccc..cccc', '..........', '3333333333', 'eeeeeeeeee'],
    ['2a2a2a2a2a', 'b3b3b3b3b3', 'cccccccccc', 'd2d2d2d2d2', '3e3e3e3e3e', 'aaaaaaaaaa'],
  ])
  const KINDS = 'abcde23'
  const COLS = 10
  const BRICK_H = 14
  const BRICK_TOP = 46
  const BRICK_GAP = 4
  /** W wider paddle, S slower ball, + one more ball, ♥ one more life. */
  const CAPSULES = Object.freeze(['W', 'S', '+', '♥'])

  const POINTS = Object.freeze({ hit: 2, brickPerHit: 10, capsule: 5, level: 100 })

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
  /** An rng answer as an index below `n`, clamped so 0.9999999 still lands inside. */
  const pick = (rng, n) => Math.min(n - 1, Math.max(0, Math.floor(rng() * n)))

  /** The bricks of level `level` (0-based; the layouts repeat), with a capsule in about one 1-hit brick in eight. */
  function bricksOf(level, rng) {
    const rows = LEVELS[level % LEVELS.length]
    const bw = (W - 12) / COLS
    const out = []
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const ch = row[c]
        if (ch === '.') continue
        const hp = ch === '2' ? 2 : ch === '3' ? 3 : 1
        const cap = hp === 1 && rng() < CAPSULE_CHANCE ? CAPSULES[pick(rng, CAPSULES.length)] : null
        out.push({ x: 6 + c * bw + 1, y: BRICK_TOP + r * (BRICK_H + BRICK_GAP), w: bw - 2, h: BRICK_H, hp, max: hp, kind: ch, cap, hitAt: -1 })
      }
    })
    return out
  }

  const stuckBall = (paddle) => ({ x: paddle.x, y: PADDLE_Y - BALL_R - 2, vx: 0, vy: 0, stuck: true })

  /** Lays out level `level` on `game`: its bricks, a centred paddle with one ball on it, no capsules or effects. */
  function loadLevel(game, level, rng) {
    game.level = level
    game.bricks = bricksOf(level, rng)
    game.paddle = { x: W / 2, w: PADDLE_W }
    game.balls = [stuckBall(game.paddle)]
    game.caps = []
    game.wideUntil = 0
    game.slowUntil = 0
  }

  /**
   * A new game at speed `speed`. `phase`: `aim` (a ball waits on the paddle for a launch), `play` (a ball is moving),
   * `cleared` (the level was just cleared: the next one is laid out and waits for Next level), `over` (no balls left).
   * `started` turns true on the first launch: a game nobody launched yet is "untouched" (a speed change restarts it,
   * a Claude tab finishing does not pause it). `lives` counts the balls left, the one in play included. `id` tells
   * one game from another.
   */
  function newGame(speed, rng = Math.random) {
    const game = {
      v: 1,
      speed: isSpeed(speed) ? speed : DEFAULT_SPEED,
      level: 0,
      score: 0,
      lives: LIVES,
      t: 0,
      phase: 'aim',
      started: false,
      bricks: [],
      paddle: null,
      balls: [],
      caps: [],
      wideUntil: 0,
      slowUntil: 0,
    }
    loadLevel(game, 0, rng)
    // Which game this is, so a view that started a new one does not take over another view's (controller.js).
    game.id = pick(rng, 1e9)
    return game
  }

  /** How much faster this round of levels is: 1 for levels 1-5, 1.12 for 6-10, ... up to 1.6. */
  const roundSpeedup = (level) => Math.min(MAX_ROUND_SPEEDUP, 1 + Math.floor(level / LEVELS.length) * ROUND_SPEEDUP)

  /** The ball speed now, units a second: the game's speed, the round's speed-up and a slow capsule while it lasts. */
  function ballSpeed(game) {
    const base = SPEEDS[isSpeed(game.speed) ? game.speed : DEFAULT_SPEED].v
    return base * roundSpeedup(game.level) * (game.t < game.slowUntil ? SLOW_BY : 1)
  }

  /** Launches every ball waiting on the paddle, up at a small random angle. Only in `aim`; returns whether it did. */
  function launch(game, rng = Math.random) {
    if (game.phase !== 'aim') return false
    const s = ballSpeed(game)
    for (const b of game.balls) {
      if (!b.stuck) continue
      const a = -Math.PI / 2 + (rng() - 0.5) * 2 * LAUNCH_WOBBLE
      b.vx = Math.cos(a) * s
      b.vy = Math.sin(a) * s
      b.stuck = false
    }
    game.phase = 'play'
    game.started = true
    return true
  }

  /** Puts the paddle's centre at `x` (a pointer over the board), kept on the board. Not while a cover is up. */
  function movePaddleTo(game, x) {
    if (!Number.isFinite(x) || (game.phase !== 'aim' && game.phase !== 'play')) return
    game.paddle.x = clamp(x, game.paddle.w / 2, W - game.paddle.w / 2)
  }

  /**
   * The angle a ball leaves the paddle at, from where it hit: straight up at the centre, up to MAX_ANGLE off vertical
   * at either edge (and past it, a ball caught by the corner). `offset` is the hit point minus the paddle's centre.
   */
  function bounceAngle(offset, paddleW) {
    const t = clamp(offset / (paddleW / 2), -1, 1)
    return -Math.PI / 2 + t * MAX_ANGLE
  }

  /**
   * A ball against one brick: the side it came in by, from where its centre is (beside the brick: a side; above or
   * below: top or bottom; off a corner: the axis it is further out along). The velocity is turned away from the brick
   * on that axis, never just negated, so a ball still overlapping on the next step cannot be turned back in.
   * Returns whether they touched.
   */
  function hitBrick(b, k) {
    const cx = clamp(b.x, k.x, k.x + k.w)
    const cy = clamp(b.y, k.y, k.y + k.h)
    const dx = b.x - cx
    const dy = b.y - cy
    if (dx * dx + dy * dy > BALL_R * BALL_R) return false
    let side
    if (dx === 0 && dy === 0) {
      // The centre is inside the brick (a very fast ball): out along the shallower overlap.
      const ox = Math.min(b.x - k.x, k.x + k.w - b.x)
      const oy = Math.min(b.y - k.y, k.y + k.h - b.y)
      side = ox < oy ? 'x' : 'y'
    } else {
      side = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (side === 'x') {
      const left = b.x < k.x + k.w / 2
      b.vx = left ? -Math.abs(b.vx) : Math.abs(b.vx)
      b.x = left ? Math.min(b.x, k.x - BALL_R) : Math.max(b.x, k.x + k.w + BALL_R)
    } else {
      const above = b.y < k.y + k.h / 2
      b.vy = above ? -Math.abs(b.vy) : Math.abs(b.vy)
      b.y = above ? Math.min(b.y, k.y - BALL_R) : Math.max(b.y, k.y + k.h + BALL_R)
    }
    return true
  }

  /** A caught capsule's effect. */
  function applyCapsule(game, t) {
    if (t === 'W') game.wideUntil = game.t + WIDE_FOR
    else if (t === 'S') game.slowUntil = game.t + SLOW_FOR
    else if (t === '♥') game.lives = Math.min(MAX_LIVES, game.lives + 1)
    else if (t === '+' && game.balls.length > 0 && game.balls.length < MAX_BALLS) {
      // The new ball mirrors a moving one, so the two split apart; with none moving it waits on the paddle too.
      const o = game.balls.find((b) => !b.stuck) || game.balls[0]
      game.balls.push({ x: o.x, y: o.y, vx: -o.vx, vy: o.vy, stuck: o.stuck })
    }
    game.score += POINTS.capsule
  }

  /**
   * One fixed step of `STEP` seconds. `input`: `{ left, right }` (arrow keys held). Runs in `aim` and `play` only,
   * so a game under any cover (`cleared`, `over`, and the page's pauses, which simply do not call it) stands still.
   * Returns what happened, in order, for the page: `hit` (a brick took a hit), `break` (a brick went), `capsule` (one
   * was caught), `lost` (the last ball fell, a life went), `cleared` (the level was cleared and the next laid out),
   * `over` (the last life went).
   */
  function step(game, input, rng = Math.random) {
    const events = []
    if (game.phase !== 'aim' && game.phase !== 'play') return events
    const dt = STEP
    game.t += dt
    const p = game.paddle
    const targetW = game.t < game.wideUntil ? PADDLE_WIDE : PADDLE_W
    p.w += (targetW - p.w) * Math.min(1, 12 * dt)
    if (input && input.left) p.x -= PADDLE_SPEED * dt
    if (input && input.right) p.x += PADDLE_SPEED * dt
    p.x = clamp(p.x, p.w / 2, W - p.w / 2)

    const s = ballSpeed(game)
    for (const b of game.balls) {
      if (b.stuck) {
        b.x = p.x
        b.y = PADDLE_Y - BALL_R - 2
        continue
      }
      // The speed is set again every step, so a slow capsule (and its end) takes hold at once.
      const m = Math.hypot(b.vx, b.vy) || 1
      b.vx *= s / m
      b.vy *= s / m
      b.x += b.vx * dt
      b.y += b.vy * dt
      if (b.x < BALL_R) {
        b.x = BALL_R
        b.vx = Math.abs(b.vx)
      } else if (b.x > W - BALL_R) {
        b.x = W - BALL_R
        b.vx = -Math.abs(b.vx)
      }
      if (b.y < BALL_R) {
        b.y = BALL_R
        b.vy = Math.abs(b.vy)
      }
      // The paddle: only a ball coming down, its bottom inside the paddle's band, within its width (and the radius).
      if (b.vy > 0 && b.y + BALL_R >= PADDLE_Y && b.y + BALL_R <= PADDLE_Y + PADDLE_H + 3 && Math.abs(b.x - p.x) <= p.w / 2 + BALL_R - 1) {
        const a = bounceAngle(b.x - p.x, p.w)
        b.vx = Math.cos(a) * s
        b.vy = Math.sin(a) * s
        b.y = PADDLE_Y - BALL_R
      }
      // One brick per ball per step: two bricks touched at once take their hits on the next steps.
      for (const k of game.bricks) {
        if (k.hp <= 0 || !hitBrick(b, k)) continue
        k.hp--
        k.hitAt = game.t
        if (k.hp === 0) {
          game.score += POINTS.brickPerHit * k.max
          events.push('break')
          if (k.cap) game.caps.push({ x: k.x + k.w / 2, y: k.y + k.h / 2, t: k.cap })
        } else {
          game.score += POINTS.hit
          events.push('hit')
        }
        break
      }
    }
    game.balls = game.balls.filter((b) => b.y - BALL_R <= H)

    for (const c of game.caps) c.y += CAPSULE_FALL * dt
    game.caps = game.caps.filter((c) => {
      if (c.y > PADDLE_Y - 6 && c.y < PADDLE_Y + 12 && Math.abs(c.x - p.x) < p.w / 2 + 8) {
        applyCapsule(game, c.t)
        events.push('capsule')
        return false
      }
      return c.y < H + 10
    })

    if (game.bricks.every((k) => k.hp <= 0)) {
      game.score += POINTS.level
      loadLevel(game, game.level + 1, rng)
      game.phase = 'cleared'
      events.push('cleared')
      return events
    }
    if (game.balls.length === 0) {
      game.lives--
      events.push('lost')
      if (game.lives <= 0) {
        game.lives = 0
        game.phase = 'over'
        events.push('over')
      } else {
        game.balls = [stuckBall(p)]
        game.phase = 'aim'
      }
    }
    return events
  }

  /** From the level-cleared cover to the next level, its ball on the paddle. Returns whether it did. */
  function nextLevel(game) {
    if (game.phase !== 'cleared') return false
    game.phase = 'aim'
    return true
  }

  /**
   * The fixed timestep: how many steps a frame of `dt` seconds runs, carrying the rest over to the next frame, so the
   * game runs at the same pace at 30, 60 or 144 frames a second and at any panel size. A frame longer than MAX_FRAME
   * counts as MAX_FRAME. `reset()` drops the carried time (after a pause, so a resume does not jump).
   */
  function createTicker(step = STEP, maxFrame = MAX_FRAME) {
    let acc = 0
    return {
      steps(dt) {
        if (!Number.isFinite(dt) || dt <= 0) return 0
        acc += Math.min(dt, maxFrame)
        // A hair of slack, so 1/60 + 1/60 + ... does not lose a step to floating point.
        const n = Math.floor(acc / step + 1e-9)
        acc = Math.max(0, acc - n * step)
        return n
      },
      reset() {
        acc = 0
      },
    }
  }

  // ---- the snapshot, checked ----

  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
  const PHASES = ['aim', 'play', 'cleared', 'over']
  const MAX_V = 2000
  const MAX_SCORE = 1e9

  /**
   * A game posted by a page, checked field by field and copied, or null when anything is off. The host keeps only
   * what passes and hands it back to a page later, so a page (any page of the panel, in any view) cannot plant
   * anything but a well-formed game; and the score in it is what Best is made of, so it has to be a number.
   */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || raw.v !== 1 || !int(raw.id, 0, 1e9)) return null
    if (!isSpeed(raw.speed) || !int(raw.level, 0, 9999) || !int(raw.score, 0, MAX_SCORE) || !int(raw.lives, 0, MAX_LIVES)) return null
    if (!num(raw.t, 0, 1e7) || !PHASES.includes(raw.phase) || typeof raw.started !== 'boolean') return null
    if (!num(raw.wideUntil, 0, 1e7) || !num(raw.slowUntil, 0, 1e7)) return null
    const p = raw.paddle
    if (!p || typeof p !== 'object' || !num(p.x, 0, W) || !num(p.w, PADDLE_W - 1, PADDLE_WIDE + 1)) return null
    if (!Array.isArray(raw.bricks) || raw.bricks.length > COLS * 6) return null
    if (!Array.isArray(raw.balls) || raw.balls.length > MAX_BALLS) return null
    if (!Array.isArray(raw.caps) || raw.caps.length > COLS * 6) return null
    const bricks = []
    for (const k of raw.bricks) {
      if (!k || typeof k !== 'object') return null
      if (!num(k.x, 0, W) || !num(k.y, 0, H) || !num(k.w, 1, W) || !num(k.h, 1, H)) return null
      if (!int(k.max, 1, 3) || !int(k.hp, 0, k.max) || typeof k.kind !== 'string' || k.kind.length !== 1 || !KINDS.includes(k.kind)) return null
      if (!(k.cap === null || CAPSULES.includes(k.cap)) || !num(k.hitAt, -1, 1e7)) return null
      bricks.push({ x: k.x, y: k.y, w: k.w, h: k.h, hp: k.hp, max: k.max, kind: k.kind, cap: k.cap, hitAt: k.hitAt })
    }
    const balls = []
    for (const b of raw.balls) {
      if (!b || typeof b !== 'object' || typeof b.stuck !== 'boolean') return null
      if (!num(b.x, -H, W + H) || !num(b.y, -H, 2 * H) || !num(b.vx, -MAX_V, MAX_V) || !num(b.vy, -MAX_V, MAX_V)) return null
      balls.push({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, stuck: b.stuck })
    }
    const caps = []
    for (const c of raw.caps) {
      if (!c || typeof c !== 'object' || !num(c.x, 0, W) || !num(c.y, -H, 2 * H) || !CAPSULES.includes(c.t)) return null
      caps.push({ x: c.x, y: c.y, t: c.t })
    }
    // A game in play has a ball; one under a cover may have none (the last ball just fell).
    if ((raw.phase === 'aim' || raw.phase === 'play') && balls.length === 0) return null
    return {
      v: 1,
      id: raw.id,
      speed: raw.speed,
      level: raw.level,
      score: raw.score,
      lives: raw.lives,
      t: raw.t,
      phase: raw.phase,
      started: raw.started,
      bricks,
      paddle: { x: p.x, w: p.w },
      balls,
      caps,
      wideUntil: raw.wideUntil,
      slowUntil: raw.slowUntil,
    }
  }

  const api = {
    W,
    H,
    STEP,
    MAX_FRAME,
    BALL_R,
    PADDLE_Y,
    PADDLE_H,
    PADDLE_W,
    PADDLE_WIDE,
    PADDLE_SPEED,
    MAX_ANGLE,
    LIVES,
    MAX_LIVES,
    MAX_BALLS,
    WIDE_FOR,
    SLOW_FOR,
    SLOW_BY,
    CAPSULE_FALL,
    SPEEDS,
    SPEED_IDS,
    DEFAULT_SPEED,
    LEVELS,
    CAPSULES,
    POINTS,
    isSpeed,
    nextSpeed,
    newGame,
    loadLevel,
    bricksOf,
    roundSpeedup,
    ballSpeed,
    launch,
    movePaddleTo,
    bounceAngle,
    hitBrick,
    applyCapsule,
    step,
    nextLevel,
    createTicker,
    sanitize,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.BricksRules = api
})(globalThis)
