'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const V = require('../panels/view.js')
const R = require('../lib/rules.js')

const plain = () => 0.5
const game = (extra = {}) => ({ ...R.newGame('normal', plain), ...extra })
const acts = (c) => c.buttons.map((b) => [b.act, b.label, b.primary])

test('covers: Claude is ready names the tab, Resume game (primary) and Go to the tab; it wins over all', () => {
  const c = V.coverFor(game({ phase: 'play', started: true }), { kind: 'claude', name: 'fix the scroll test' })
  assert.equal(c.kind, 'claude')
  assert.equal(c.dot, true)
  assert.equal(c.title, 'Claude is ready')
  assert.equal(c.text, '“fix the scroll test” is waiting for you.')
  assert.deepEqual(acts(c), [
    ['resume', 'Resume game', true],
    ['goto', 'Go to the tab', false],
  ])
  assert.equal(V.coverFor(game({ phase: 'over' }), { kind: 'claude', name: 'x' }).kind, 'claude')
  assert.equal(V.coverFor(game({ phase: 'cleared' }), { kind: 'claude', name: 'x' }).kind, 'claude')
})

test('covers: paused says why and offers Resume (primary) and New game', () => {
  const c = V.coverFor(game({ phase: 'play' }), { kind: 'paused', reason: 'pointer' })
  assert.equal(c.title, 'Paused')
  assert.equal(c.text, 'The pointer left the board.')
  assert.deepEqual(acts(c), [
    ['resume', 'Resume', true],
    ['new', 'New game', false],
  ])
  for (const reason of Object.keys(V.REASONS)) assert.ok(V.coverFor(game(), { kind: 'paused', reason }).text.length > 0, reason)
  assert.equal(V.coverFor(game(), { kind: 'paused', reason: 'nope' }).text, '')
})

test('covers: level cleared offers Next level; the sixth says the levels start again, faster', () => {
  const c = V.coverFor(game({ phase: 'cleared', level: 1 }), null)
  assert.equal(c.title, 'Level 1 cleared')
  assert.equal(c.text, '+100')
  assert.deepEqual(acts(c), [['next', 'Next level', true]])
  assert.match(V.coverFor(game({ phase: 'cleared', level: 5 }), null).text, /start again/)
  // Under a plain pause too (the cleared cover is itself a pause).
  assert.equal(V.coverFor(game({ phase: 'cleared', level: 2 }), { kind: 'paused', reason: 'blur' }).kind, 'cleared')
})

test('covers: game over shows the score, a new best when it is one, and New game', () => {
  const c = V.coverFor(game({ phase: 'over', score: 420, level: 2 }), null, 420)
  assert.equal(c.title, 'Game over · 420')
  assert.equal(c.text, 'A new best for this speed.')
  assert.deepEqual(acts(c), [['new', 'New game', true]])
  assert.equal(V.coverFor(game({ phase: 'over', score: 420, level: 2 }), null, 900).text, 'Reached level 3')
  assert.equal(V.coverFor(game({ phase: 'over', score: 0 }), null, 0).text, 'Reached level 1', 'no best for nothing')
  assert.equal(V.coverFor(game({ phase: 'play' }), null), null)
  assert.equal(V.coverFor(game({ phase: 'aim' }), null), null)
  assert.equal(V.coverFor(null, null), null)
})

test('keys: arrows and A D move, Space, P and N; anything else is nothing', () => {
  assert.deepEqual(
    ['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'D', ' ', 'p', 'P', 'n', 'N'].map(V.keyOf),
    ['left', 'left', 'left', 'right', 'right', 'right', 'space', 'pause', 'pause', 'new', 'new'],
  )
  for (const k of ['ArrowUp', 'w', 's', 'Enter', 'Escape', 'toString', '__proto__', undefined, 3]) assert.equal(V.keyOf(k), null)
})

test('pointer: client x to board units across any canvas width; junk is null', () => {
  assert.equal(V.boardX(100, 100, 300, 300), 0)
  assert.equal(V.boardX(250, 100, 300, 300), 150)
  assert.equal(V.boardX(160, 10, 600, 300), 75, 'a wide panel')
  assert.equal(V.boardX(60, 10, 100, 300), 150, 'a narrow one')
  assert.equal(V.boardX(NaN, 0, 100, 300), null)
  assert.equal(V.boardX(5, 0, 0, 300), null)
})

test('running, the report and the Claude pause: only aim and play under no pause run', () => {
  assert.equal(V.isRunning(game({ phase: 'aim' }), null), true)
  assert.equal(V.isRunning(game({ phase: 'play' }), null), true)
  assert.equal(V.isRunning(game({ phase: 'play' }), { kind: 'paused', reason: 'key' }), false)
  assert.equal(V.isRunning(game({ phase: 'cleared' }), null), false)
  assert.equal(V.isRunning(game({ phase: 'over' }), null), false)
  assert.equal(V.isRunning(null, null), false)
  assert.deepEqual(V.reportOf(game({ phase: 'play', level: 4, started: true }), null), {
    level: 5,
    speed: 'normal',
    phase: 'play',
    running: true,
    started: true,
  })
  assert.equal(V.claudeTakes(game({ started: false })), false, 'an untouched game is not paused')
  assert.equal(V.claudeTakes(game({ started: true, phase: 'aim' })), true)
  assert.equal(V.claudeTakes(game({ started: true, phase: 'over' })), false)
})

test('a saved game comes back paused when it was started and in play; a new one or a cover needs none', () => {
  assert.deepEqual(V.restoredHold(game({ started: true, phase: 'play' })), { kind: 'paused', reason: 'restored' })
  assert.deepEqual(V.restoredHold(game({ started: true, phase: 'aim' })), { kind: 'paused', reason: 'restored' })
  assert.equal(V.restoredHold(game({ started: false })), null)
  assert.equal(V.restoredHold(game({ started: true, phase: 'over' })), null)
  assert.equal(V.restoredHold(game({ started: true, phase: 'cleared' })), null)
})

test('notches: one per hit left, centred on the brick; none on a 1-hit or broken brick', () => {
  const k = { x: 10, y: 20, w: 40, h: 14, hp: 3, max: 3 }
  const n = V.notches(k)
  assert.equal(n.length, 3)
  const left = n[0].x
  const right = n[2].x + n[2].w
  assert.ok(Math.abs((left + right) / 2 - (k.x + k.w / 2)) < 1e-9, 'centred')
  assert.ok(n.every((r) => r.x >= k.x && r.x + r.w <= k.x + k.w && r.y >= k.y && r.y + r.h <= k.y + k.h), 'inside the brick')
  assert.equal(V.notches({ ...k, hp: 1 }).length, 1, 'a 3-hit brick hit twice shows one')
  assert.equal(V.notches({ ...k, hp: 1, max: 1 }).length, 0)
  assert.equal(V.notches({ ...k, hp: 0 }).length, 0)
  assert.deepEqual(V.notches(null), [])
})

test('flash: a tenth of a second after a hit, never under reduced motion', () => {
  const k = { hitAt: 2 }
  assert.equal(V.flashes(k, 2.05, false), true)
  assert.equal(V.flashes(k, 2.2, false), false)
  assert.equal(V.flashes(k, 2.05, true), false)
  assert.equal(V.flashes({ hitAt: -1 }, 0.01, false), false)
})

test('foot, lives and the launch hint', () => {
  assert.equal(V.footInfo(game({ level: 2 })), 'Level 3')
  assert.equal(V.footInfo(game({ t: 10, wideUntil: 14.2, slowUntil: 11 })), 'Level 1 · Wide 5s · Slow 1s')
  assert.equal(V.footInfo(null), '')
  assert.equal(V.livesLabel(3), '3 balls left')
  assert.equal(V.livesLabel(1), '1 ball left')
  assert.equal(V.hint(game({ phase: 'aim' }), null), 'Space or click to launch')
  assert.equal(V.hint(game({ phase: 'aim' }), { kind: 'paused', reason: 'key' }), '')
  assert.equal(V.hint(game({ phase: 'play' }), null), '')
})
