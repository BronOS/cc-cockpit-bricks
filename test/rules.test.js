'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../lib/rules.js')

/** An rng that answers `values` in turn, then `rest` forever. */
function seq(values, rest = 0.5) {
  let i = 0
  return () => (i < values.length ? values[i++] : rest)
}
/** No capsules (every draw is over the chance), launches straight up (0.5 is no wobble). */
const plain = () => 0.5

/**
 * A game with one brick to play with (`brick` fields over a 1-hit one in the middle) and a 3-hit one in the top left
 * corner that nothing hits, so breaking the first does not clear the level; its ball moving with `ball`.
 */
function oneBrick(brick = {}, ball = {}) {
  const g = R.newGame('normal', plain)
  g.bricks = [
    { x: 130, y: 100, w: 40, h: 14, hp: 1, max: 1, kind: 'a', cap: null, hitAt: -1, ...brick },
    { x: 0, y: 0, w: 10, h: 10, hp: 3, max: 3, kind: '3', cap: null, hitAt: -1 },
  ]
  g.phase = 'play'
  g.started = true
  g.balls = [{ x: 150, y: 200, vx: 0, vy: -R.ballSpeed(g), stuck: false, ...ball }]
  return g
}

/** Steps until `done(game, events)` or `max` steps; returns every event seen. */
function run(g, done, max = 20000, input = {}) {
  const all = []
  for (let i = 0; i < max; i++) {
    const ev = R.step(g, input, plain)
    all.push(...ev)
    if (done(g, ev)) break
  }
  return all
}

test('a new game: level 1 laid out, 3 balls, one on the paddle, aiming, not started; junk speed is Normal', () => {
  const g = R.newGame('calm', plain)
  assert.equal(g.speed, 'calm')
  assert.equal(g.level, 0)
  assert.equal(g.lives, 3)
  assert.equal(g.score, 0)
  assert.equal(g.phase, 'aim')
  assert.equal(g.started, false)
  assert.equal(g.bricks.length, 50, 'level 1: five full rows under an empty one')
  assert.equal(g.balls.length, 1)
  assert.equal(g.balls[0].stuck, true)
  assert.equal(g.paddle.x, R.W / 2)
  assert.equal(R.newGame('warp', plain).speed, 'normal')
  assert.equal(R.newGame('__proto__', plain).speed, 'normal')
  assert.deepEqual(JSON.parse(JSON.stringify(g)), g, 'a game is plain JSON')
})

test('levels: 2- and 3-hit bricks from the layout, capsules only in 1-hit ones', () => {
  const g = R.newGame('normal', plain)
  R.loadLevel(g, 4, seq([], 0)) // rng 0: every 1-hit brick gets a capsule, the first kind (W)
  const strong = g.bricks.filter((k) => k.max > 1)
  assert.ok(strong.some((k) => k.max === 2 && k.hp === 2 && k.kind === '2'))
  assert.ok(strong.some((k) => k.max === 3 && k.hp === 3 && k.kind === '3'))
  assert.ok(strong.every((k) => k.cap === null))
  assert.ok(g.bricks.filter((k) => k.max === 1).every((k) => k.cap === 'W'))
  assert.ok(R.bricksOf(0, plain).every((k) => k.cap === null), 'rng over the chance: no capsules')
  // The pick of a capsule kind is clamped: an rng of 0.9999999 is still the last kind.
  let draw = 0
  const k = R.bricksOf(0, () => (draw++ % 2 === 0 ? 0 : 0.9999999))[0]
  assert.equal(k.cap, '♥')
})

test('launch: only when aiming; straight up at the speed, then playing and started', () => {
  const g = R.newGame('normal', plain)
  assert.equal(R.launch(g, plain), true)
  const b = g.balls[0]
  assert.equal(b.stuck, false)
  assert.ok(Math.abs(b.vx) < 1e-9)
  assert.ok(Math.abs(b.vy + R.SPEEDS.normal.v) < 1e-9)
  assert.equal(g.phase, 'play')
  assert.equal(g.started, true)
  assert.equal(R.launch(g, plain), false, 'not again while playing')
  // The wobble: rng 0 and 1 are the two extremes, 0.3 rad either side.
  const w = R.newGame('normal', plain)
  R.launch(w, () => 0)
  assert.ok(Math.abs(Math.atan2(w.balls[0].vy, w.balls[0].vx) - (-Math.PI / 2 - 0.3)) < 1e-9)
})

test('a ball on the paddle follows it; the paddle stays on the board', () => {
  const g = R.newGame('normal', plain)
  R.movePaddleTo(g, 10)
  assert.equal(g.paddle.x, R.PADDLE_W / 2)
  R.movePaddleTo(g, 1000)
  assert.equal(g.paddle.x, R.W - R.PADDLE_W / 2)
  R.movePaddleTo(g, NaN)
  assert.equal(g.paddle.x, R.W - R.PADDLE_W / 2, 'junk is ignored')
  R.step(g, {}, plain)
  assert.equal(g.balls[0].x, g.paddle.x)
  // Keys: PADDLE_SPEED a second.
  R.movePaddleTo(g, 150)
  for (let i = 0; i < 24; i++) R.step(g, { left: true }, plain)
  assert.ok(Math.abs(g.paddle.x - (150 - R.PADDLE_SPEED * 0.1)) < 1e-6)
  g.phase = 'over'
  R.movePaddleTo(g, 30)
  assert.ok(Math.abs(g.paddle.x - (150 - R.PADDLE_SPEED * 0.1)) < 1e-6, 'not under a cover')
})

test('paddle angle: straight up at the centre, wider toward the edges, at most 60 degrees, mirrored', () => {
  assert.equal(R.bounceAngle(0, 56), -Math.PI / 2)
  assert.ok(Math.abs(R.bounceAngle(28, 56) - (-Math.PI / 2 + R.MAX_ANGLE)) < 1e-12)
  assert.ok(Math.abs(R.bounceAngle(-28, 56) - (-Math.PI / 2 - R.MAX_ANGLE)) < 1e-12)
  assert.equal(R.bounceAngle(100, 56), R.bounceAngle(28, 56), 'past the edge is the edge')
  assert.ok(Math.abs(R.bounceAngle(14, 56) - (-Math.PI / 2 + R.MAX_ANGLE / 2)) < 1e-12)
  assert.ok(R.MAX_ANGLE <= Math.PI / 3 + 0.01)

  // In play: a ball coming down on the right half leaves up and to the right, at the same speed.
  const g = oneBrick({ y: 20 }, { x: 150 + 14, y: R.PADDLE_Y - 20, vy: R.ballSpeed(R.newGame('normal', plain)) })
  g.paddle.x = 150
  run(g, (gg) => gg.balls[0].vy < 0)
  const b = g.balls[0]
  assert.ok(b.vx > 0, 'to the right')
  assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - R.ballSpeed(g)) < 1e-6)
  const angle = Math.atan2(b.vy, b.vx)
  assert.ok(angle > -Math.PI / 2 && angle < -Math.PI / 2 + R.MAX_ANGLE)
})

test('walls and ceiling turn the ball back; a ball missing the paddle is lost', () => {
  const g = oneBrick({ y: 20, x: 0, w: 10 }, { x: 290, y: 300, vx: 200, vy: -100 })
  run(g, (gg) => gg.balls[0].vx < 0)
  assert.ok(g.balls[0].x <= R.W - R.BALL_R)
  const c = oneBrick({ y: 300, x: 0, w: 10 }, { x: 150, y: 20, vx: 0, vy: -200 })
  run(c, (gg) => gg.balls[0].vy > 0)
  assert.ok(c.balls[0].y >= R.BALL_R)
  const l = oneBrick({ y: 300, x: 0, w: 10 }, { x: 5, y: 200, vx: -200, vy: 1 })
  run(l, (gg) => gg.balls[0].vx > 0)
  assert.ok(l.balls[0].x >= R.BALL_R)
})

test('bricks: from below the ball turns down, from the side it turns sideways; one hit breaks a 1-hit brick', () => {
  const g = oneBrick()
  const ev = run(g, (gg) => gg.balls[0].vy > 0)
  assert.deepEqual(ev.filter((e) => e === 'break'), ['break'])
  assert.equal(g.bricks[0].hp, 0)
  assert.equal(g.score, R.POINTS.brickPerHit)
  assert.ok(g.balls[0].y >= 114 + R.BALL_R - 1e-9, 'pushed out below it')

  const s = oneBrick({ x: 200, y: 180 }, { x: 150, y: 187, vx: R.ballSpeed(g), vy: 0 })
  run(s, (gg) => gg.balls[0].vx < 0)
  assert.equal(s.bricks[0].hp, 0)
  assert.ok(s.balls[0].x <= 200 - R.BALL_R + 1e-9, 'pushed out to the left')
  assert.equal(s.balls[0].vy, 0, 'a side hit keeps the vertical speed')
})

test('a hit only ever turns the ball away from the brick, so it cannot hit it twice on one pass', () => {
  // A 2-hit brick, the ball arriving from below: one hit, then the ball goes down, not back into it.
  const g = oneBrick({ hp: 2, max: 2, kind: '2' })
  const ev = run(g, (gg) => gg.balls[0].y > 300)
  assert.deepEqual(ev.filter((e) => e === 'hit' || e === 'break'), ['hit'])
  assert.equal(g.bricks[0].hp, 1)
})

test('multi-hit bricks: 2 points a hit, then 10 a hit point when it breaks; hitAt marks the last hit', () => {
  const g = oneBrick({ hp: 3, max: 3, kind: '3' })
  const k = g.bricks[0]
  // Hit it three times from below, sending the ball back up after each.
  const events = []
  for (let n = 0; n < 3; n++) {
    g.balls = [{ x: 150, y: 200, vx: 0, vy: -R.ballSpeed(g), stuck: false }]
    events.push(...run(g, (gg) => gg.balls[0].vy > 0))
    if (n === 0) assert.ok(k.hitAt > 0 && k.hitAt === g.t)
  }
  assert.deepEqual(events.filter((e) => e === 'hit' || e === 'break'), ['hit', 'hit', 'break'])
  assert.equal(k.hp, 0)
  assert.equal(g.score, 2 * R.POINTS.hit + 3 * R.POINTS.brickPerHit)
})

test('capsules: a broken brick drops its capsule, which falls and is caught by the paddle (5 points)', () => {
  for (const [t, check] of [
    ['W', (g, at) => g.wideUntil === at + R.WIDE_FOR],
    ['S', (g, at) => g.slowUntil === at + R.SLOW_FOR],
    ['♥', (g) => g.lives === 4],
    ['+', (g) => g.balls.length === 2],
  ]) {
    const g = oneBrick({ cap: t })
    let caughtAt = null
    let fell = false
    run(g, (gg, ev) => {
      if (ev.includes('capsule')) {
        caughtAt = gg.t
        return true
      }
      if (gg.caps[0]) fell = true
      // Once the brick is gone, the ball waits high up out of the way and the paddle goes under the capsule.
      if (gg.bricks[0].hp === 0) gg.balls = [{ x: 200, y: 60, vx: 0, vy: 0.001, stuck: false }]
      if (gg.caps[0]) gg.paddle.x = gg.caps[0].x
      return false
    })
    assert.ok(fell && caughtAt !== null, `${t} fell and was caught`)
    assert.equal(g.caps.length, 0)
    assert.ok(check(g, caughtAt), `${t} took effect`)
    assert.equal(g.score, R.POINTS.brickPerHit + R.POINTS.capsule, t)
  }
  // A capsule the paddle misses falls off the board.
  const m = oneBrick()
  m.caps = [{ x: 20, y: 380, t: 'W' }]
  m.paddle.x = 250
  run(m, (gg) => gg.caps.length === 0, 2000)
  assert.equal(m.wideUntil, 0)
})

test('capsule effects: wider paddle and slower ball for a while in game time; lives and balls capped', () => {
  const g = oneBrick()
  R.applyCapsule(g, 'W')
  R.applyCapsule(g, 'S')
  const s = R.ballSpeed(g)
  assert.ok(Math.abs(s - R.SPEEDS.normal.v * R.SLOW_BY) < 1e-9)
  for (let i = 0; i < 240; i++) R.step(g, {}, plain)
  assert.ok(g.paddle.w > R.PADDLE_W + 20, 'the paddle eased wider')
  g.t = g.wideUntil + 0.01
  for (let i = 0; i < 480; i++) R.step(g, {}, plain)
  assert.ok(g.paddle.w < R.PADDLE_W + 0.5, 'and back')
  assert.equal(R.ballSpeed(g), R.SPEEDS.normal.v, 'the slow ran out too')
  for (let i = 0; i < 10; i++) R.applyCapsule(g, '♥')
  assert.equal(g.lives, R.MAX_LIVES)
  for (let i = 0; i < 10; i++) R.applyCapsule(g, '+')
  assert.equal(g.balls.length, R.MAX_BALLS)
  // A '+' mirrors a moving ball.
  const m = oneBrick({}, { vx: 50, vy: -100 })
  R.applyCapsule(m, '+')
  assert.equal(m.balls[1].vx, -50)
  assert.equal(m.balls[1].vy, -100)
})

test('lives: a lost ball takes one and puts a new ball on the paddle; the last one ends the game', () => {
  const g = oneBrick({}, { x: 10, y: 380, vx: 0, vy: 200 })
  g.paddle.x = 250
  let ev = run(g, (gg, e) => e.includes('lost'))
  assert.ok(ev.includes('lost'))
  assert.equal(g.lives, 2)
  assert.equal(g.phase, 'aim')
  assert.equal(g.balls.length, 1)
  assert.equal(g.balls[0].stuck, true)
  // Two balls in play: losing one is no life.
  g.phase = 'play'
  g.balls = [
    { x: 10, y: 380, vx: 0, vy: 200, stuck: false },
    { x: 150, y: 50, vx: 0, vy: -1, stuck: false },
  ]
  ev = run(g, (gg) => gg.balls.length === 1, 200)
  assert.equal(g.lives, 2)
  assert.equal(ev.includes('lost'), false)
  g.lives = 1
  g.balls = [{ x: 10, y: 380, vx: 0, vy: 200, stuck: false }]
  ev = run(g, (gg, e) => e.includes('over'))
  assert.deepEqual(ev.slice(-2), ['lost', 'over'])
  assert.equal(g.lives, 0)
  assert.equal(g.phase, 'over')
  const t = g.t
  assert.deepEqual(R.step(g, {}, plain), [], 'nothing moves after the game')
  assert.equal(g.t, t)
})

test('level cleared: 100 points, the next layout waits under the cover; after five the layouts repeat faster', () => {
  const g = oneBrick()
  g.bricks.pop()
  const ev = run(g, (gg, e) => e.includes('cleared'))
  assert.ok(ev.includes('cleared'))
  assert.equal(g.phase, 'cleared')
  assert.equal(g.level, 1)
  assert.equal(g.score, R.POINTS.brickPerHit + R.POINTS.level)
  assert.ok(g.bricks.some((k) => k.kind === '2'), 'level 2 laid out')
  assert.equal(g.balls[0].stuck, true)
  const t = g.t
  assert.deepEqual(R.step(g, {}, plain), [], 'the cover holds the game')
  assert.equal(g.t, t)
  assert.equal(R.nextLevel(g), true)
  assert.equal(g.phase, 'aim')
  assert.equal(R.nextLevel(g), false)

  assert.equal(R.roundSpeedup(0), 1)
  assert.equal(R.roundSpeedup(4), 1)
  assert.ok(Math.abs(R.roundSpeedup(5) - 1.12) < 1e-12)
  assert.ok(Math.abs(R.roundSpeedup(10) - 1.24) < 1e-12)
  assert.equal(R.roundSpeedup(500), 1.6, 'capped')
  const six = R.newGame('fast', plain)
  R.loadLevel(six, 5, plain)
  assert.deepEqual(
    six.bricks.map((k) => k.kind),
    R.newGame('fast', plain).bricks.map((k) => k.kind),
    'level 6 is level 1 again',
  )
  assert.ok(Math.abs(R.ballSpeed(six) - R.SPEEDS.fast.v * 1.12) < 1e-9)
  // The fastest ball still moves less than its radius in one step, so it cannot pass through a brick.
  assert.ok(R.SPEEDS.fast.v * 1.6 * R.STEP < R.BALL_R)
})

test('speeds: Calm < Normal < Fast; cycling goes round; junk cycles from Normal', () => {
  assert.deepEqual(R.SPEED_IDS, ['calm', 'normal', 'fast'])
  assert.ok(R.SPEEDS.calm.v < R.SPEEDS.normal.v && R.SPEEDS.normal.v < R.SPEEDS.fast.v)
  assert.equal(R.nextSpeed('calm'), 'normal')
  assert.equal(R.nextSpeed('normal'), 'fast')
  assert.equal(R.nextSpeed('fast'), 'calm')
  assert.equal(R.nextSpeed('nope'), 'fast')
  assert.equal(R.isSpeed('toString'), false)
})

test('fixed timestep: the same steps a second at 30, 60, 144 or uneven frames; a long frame is cut', () => {
  const stepsIn = (frames) => {
    const t = R.createTicker()
    return frames.reduce((n, dt) => n + t.steps(dt), 0)
  }
  const second = (fps) => Array(fps).fill(1 / fps)
  for (const fps of [30, 60, 75, 144, 240]) {
    const n = stepsIn(second(fps))
    assert.ok(Math.abs(n - 240) <= 1, `${fps} fps: ${n} steps`)
  }
  const uneven = []
  for (let i = 0, sum = 0; sum < 1; i++) {
    const dt = [0.007, 0.016, 0.033, 0.011][i % 4]
    uneven.push(Math.min(dt, 1 - sum))
    sum += dt
  }
  assert.ok(Math.abs(stepsIn(uneven) - 240) <= 1)
  assert.equal(stepsIn([5]), Math.floor(R.MAX_FRAME / R.STEP + 1e-9), 'a stalled frame counts as MAX_FRAME')
  assert.equal(stepsIn([0, -1, NaN, Infinity]), 0)
  const t = R.createTicker()
  t.steps(R.STEP * 0.9)
  t.reset()
  assert.equal(t.steps(R.STEP * 0.5), 0, 'reset drops the carried time')

  // The game itself: one second of play moves a ball the same distance whatever the frame rate.
  const travel = (fps) => {
    const g = oneBrick({ y: 10, x: 0, w: 5 }, { x: 150, y: 350, vx: 0, vy: -100 })
    const tick = R.createTicker()
    for (const dt of second(fps)) for (let n = tick.steps(dt); n > 0; n--) R.step(g, {}, plain)
    return g.t
  }
  assert.ok(Math.abs(travel(30) - travel(144)) <= R.STEP + 1e-9)
})

test('sanitize: a game round-trips; junk, wrong shapes and out-of-range values are refused', () => {
  const g = R.newGame('fast', seq([], 0.05))
  R.launch(g, plain)
  for (let i = 0; i < 100; i++) R.step(g, {}, plain)
  const copy = R.sanitize(JSON.parse(JSON.stringify(g)))
  assert.deepEqual(copy, g)
  assert.notEqual(copy, g)
  const extra = { ...JSON.parse(JSON.stringify(g)), evil: '<script>' }
  assert.equal('evil' in R.sanitize(extra), false, 'unknown fields are dropped')

  const bad = [
    null,
    'x',
    5,
    [],
    {},
    { ...g, v: 2 },
    { ...g, id: -1 },
    { ...g, speed: 'warp' },
    { ...g, level: 1.5 },
    { ...g, score: -1 },
    { ...g, score: Infinity },
    { ...g, lives: 9 },
    { ...g, phase: 'won' },
    { ...g, started: 'yes' },
    { ...g, t: NaN },
    { ...g, paddle: null },
    { ...g, paddle: { x: 150, w: 500 } },
    { ...g, bricks: 'x' },
    { ...g, bricks: Array(61).fill(g.bricks[0]) },
    { ...g, bricks: [{ ...g.bricks[0], hp: 4 }] },
    { ...g, bricks: [{ ...g.bricks[0], kind: 'z' }] },
    { ...g, bricks: [{ ...g.bricks[0], kind: 'ab' }] },
    { ...g, bricks: [{ ...g.bricks[0], cap: 'X' }] },
    { ...g, bricks: [null] },
    { ...g, balls: [] },
    { ...g, balls: Array(5).fill(g.balls[0]) },
    { ...g, balls: [{ ...g.balls[0], vx: 1e9 }] },
    { ...g, balls: [{ ...g.balls[0], stuck: 1 }] },
    { ...g, caps: [{ x: 1, y: 1, t: 'Z' }] },
  ]
  bad.forEach((b, i) => assert.equal(R.sanitize(b), null, `bad #${i}`))
  assert.ok(R.sanitize({ ...JSON.parse(JSON.stringify(g)), phase: 'over', balls: [] }), 'a game over may have no ball')
})
