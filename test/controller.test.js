'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createController, checkReport } = require('../lib/controller.js')
const { createReadyWatch, tabName } = require('../lib/pause.js')
const R = require('../lib/rules.js')

const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: '/p', notes: [], files: [], ...extra })
const plain = () => 0.5
const rep = (extra = {}) => ({ level: 1, speed: 'normal', phase: 'play', running: true, started: true, ...extra })
/** A started game with `score`, as a page posts it. */
function played(score = 40, extra = {}) {
  const g = R.newGame(extra.speed || 'normal', plain)
  R.launch(g, plain)
  g.score = score
  return JSON.parse(JSON.stringify({ ...g, ...extra }))
}

test('ready watch: only working -> waiting counts, in list order; first sight and other moves do not', () => {
  const w = createReadyWatch()
  assert.deepEqual(w.observe([tab('a', 'waiting'), tab('b', 'working')]), [], 'first sight is no transition')
  assert.deepEqual(w.observe([tab('a', 'working'), tab('b', 'needs-permission')]), [])
  assert.deepEqual(w.observe([tab('a', 'waiting', { title: 'Fix the scroll test' }), tab('b', 'working')]), [
    { tabId: 'a', name: 'Fix the scroll test' },
  ])
  assert.deepEqual(w.observe([tab('a', 'waiting'), tab('b', 'idle')]), [], 'working -> idle is not ready')
  assert.deepEqual(w.observe([tab('b', 'working')]), [])
  assert.deepEqual(w.observe([tab('a', 'waiting'), tab('b', 'waiting')]), [{ tabId: 'b', name: 'A Claude tab' }], 'a gone tab is forgotten')
  assert.deepEqual(w.observe(null), [])
  assert.deepEqual(w.observe([null, { tabId: 3 }, tab('c', 'working')]), [])
})

test("tab name: the person's name first, then Claude's title, then a plain phrase", () => {
  assert.equal(tabName({ name: 'mine', title: 'theirs' }), 'mine')
  assert.equal(tabName({ name: '  ', title: 'theirs' }), 'theirs')
  assert.equal(tabName({}), 'A Claude tab')
  assert.equal(tabName({ title: 'x'.repeat(500) }).length, 120)
})

test('reports are checked: junk is refused, only the known fields are kept', () => {
  assert.deepEqual(checkReport({ ...rep(), evil: 1 }), rep())
  for (const bad of [null, 'x', {}, rep({ level: 0 }), rep({ level: 1.5 }), rep({ speed: 'warp' }), rep({ phase: 'won' }), rep({ running: 1 }), rep({ started: 'no' })]) {
    assert.equal(checkReport(bad), null)
  }
})

test('header: level and speed from the last report, else the saved game, else a new one; Resume needs a game', () => {
  const c = createController()
  assert.deepEqual(c.header(), { meta: 'Level 1 · Normal', running: false, canResume: false })
  c.game(played(10, { level: 2, speed: 'calm' }), 'desktop', 'pause')
  assert.deepEqual(c.header(), { meta: 'Level 3 · Calm · next Normal', running: false, canResume: true })
  c.report(rep({ level: 4, speed: 'fast' }), 'desktop')
  assert.deepEqual(c.header(), { meta: 'Level 4 · Fast · next Normal', running: true, canResume: false })
  c.report(rep({ level: 4, speed: 'fast', running: false, phase: 'over' }), 'desktop')
  assert.equal(c.header().canResume, false, 'nothing to resume after game over')
})

test('speed: cycles Calm, Normal, Fast; applies now to a game nobody launched, else to the next game', () => {
  const c = createController()
  c.report(rep({ running: true, started: false, phase: 'aim' }), 'desktop')
  assert.equal(c.cycleSpeed(), 'fast')
  assert.equal(c.header().meta, 'Level 1 · Fast', 'an untouched game takes it now')
  c.report(rep({ speed: 'fast', started: true }), 'desktop')
  assert.equal(c.cycleSpeed(), 'calm')
  assert.equal(c.header().meta, 'Level 1 · Fast · next Calm')
  // An untouched saved game is dropped (a new page starts a new game at the new speed); a started one is kept.
  const d = createController()
  const fresh = R.newGame('normal', plain)
  d.game(JSON.parse(JSON.stringify(fresh)), 'desktop', 'new')
  d.cycleSpeed()
  assert.equal(d.saved(), null)
  d.game(played(), 'desktop', 'pause')
  d.cycleSpeed()
  assert.ok(d.saved())
  assert.equal(d.setSpeed('warp'), false)
  assert.equal(d.setSpeed('calm'), true)
  assert.equal(d.speed(), 'calm')
})

test('the saved game: only a sanitized game is kept, handed to the next page with the speed, best and pause', () => {
  const c = createController()
  assert.deepEqual(c.game({ v: 1, junk: true }, 'desktop', 'pause'), { ok: false })
  assert.equal(c.saved(), null)
  const g = played(70)
  const r = c.game({ ...g, evil: '<b>' }, 'desktop', 'pause')
  assert.equal(r.ok, true)
  assert.deepEqual(r.record, { speed: 'normal', score: 70 })
  assert.equal('evil' in c.saved(), false)
  const hello = c.hello('web:1')
  assert.deepEqual(hello.game, c.saved())
  assert.equal(hello.speed, 'normal')
  assert.deepEqual(hello.best, { normal: 70 })
  assert.equal(hello.claude, null)
})

test('best per speed: a higher score is a record, a lower one or zero is not; stored values only raise it', () => {
  const c = createController()
  assert.equal(c.game(played(0), 'v', 'tick').record, undefined)
  assert.ok(c.game(played(50), 'v', 'tick').record)
  assert.equal(c.game(played(50), 'v', 'tick').record, undefined, 'equal is no record')
  assert.equal(c.game(played(30), 'v', 'tick').record, undefined)
  assert.deepEqual(c.game(played(20, { speed: 'fast' }), 'v', 'tick').record, { speed: 'fast', score: 20 }, 'per speed')
  assert.equal(c.setBest({ normal: 40, fast: 90, calm: 'x', warp: 1000 }), true)
  assert.deepEqual(c.best(), { normal: 50, fast: 90 })
  assert.equal(c.setBest({ normal: -1, fast: NaN }), false)
})

test('the Claude pause: only while a view runs the game; later tabs rename it; it ends on Resume', () => {
  const c = createController()
  c.sessions([tab('t1', 'working'), tab('t2', 'working')])
  c.sessions([tab('t1', 'waiting'), tab('t2', 'working')])
  assert.equal(c.claude(), null, 'no view runs a game: no pause')

  c.report(rep(), 'desktop')
  c.sessions([tab('t1', 'working'), tab('t2', 'working')])
  assert.equal(c.sessions([tab('t1', 'waiting', { name: 'Docs' }), tab('t2', 'working')]), true)
  assert.deepEqual(c.claude(), { name: 'Docs' })
  assert.equal(c.pausedTab(), 't1')
  assert.equal(c.header().running, false, 'the pause stops every view')
  assert.equal(c.sessions([tab('t1', 'waiting', { name: 'Docs' }), tab('t2', 'waiting', { title: 'Tests' })]), true)
  assert.deepEqual(c.claude(), { name: 'Tests' }, 'the latest names the cover')
  assert.equal(c.pausedTab(), 't2')
  assert.deepEqual(c.hello('web:2').claude, { name: 'Tests' }, 'a page opened now shows it')
  assert.equal(c.endClaude(), true)
  assert.equal(c.claude(), null)
  assert.equal(c.endClaude(), false)
})

test('the Claude pause does not take a game that is paused, over or untouched', () => {
  const c = createController()
  c.sessions([tab('t1', 'working')])
  c.report(rep({ running: false }), 'desktop')
  assert.equal(c.sessions([tab('t1', 'waiting')]), false)
  c.sessions([tab('t1', 'working')])
  c.report(rep({ running: false, phase: 'over' }), 'desktop')
  assert.equal(c.sessions([tab('t1', 'waiting')]), false)
})

test('a page saying hello runs nothing yet: a panel hidden while it ran no longer counts as running', () => {
  const c = createController()
  c.report(rep(), 'desktop')
  assert.equal(c.header().running, true)
  c.hello('desktop')
  assert.equal(c.header().running, false)
  // Another view's hello leaves the running view alone.
  c.report(rep(), 'desktop')
  c.hello('web:1')
  assert.equal(c.header().running, true)
})

test('one view runs the game: a second view starting makes the first yield and hands its game over', () => {
  const c = createController()
  assert.equal(c.report(rep(), 'desktop').yieldView, undefined)
  const r = c.report(rep(), 'web:1')
  assert.equal(r.yieldView, 'desktop')
  // The desktop page pauses and posts its game; the host hands it to web:1.
  const g = played(90)
  const y = c.game(g, 'desktop', 'yield')
  assert.equal(y.adoptView, 'web:1')
  assert.equal(c.game(g, 'desktop', 'yield').adoptView, undefined, 'once')
  assert.equal(c.game(g, 'web:1', 'yield').adoptView, undefined, 'only from the view that was asked')
  // A view starting again after a pause asks nobody to yield.
  c.report(rep({ running: false }), 'web:1')
  assert.equal(c.report(rep(), 'web:1').yieldView, undefined)
  assert.equal(c.resumeView(), 'web:1')
})

test('New game from the title bar: the saved game, the report and the pause go', () => {
  const c = createController()
  c.report(rep(), 'desktop')
  c.game(played(), 'desktop', 'tick')
  c.sessions([tab('t1', 'working')])
  c.sessions([tab('t1', 'waiting')])
  assert.ok(c.claude())
  c.newGame()
  assert.equal(c.saved(), null)
  assert.equal(c.claude(), null)
  assert.deepEqual(c.header(), { meta: 'Level 1 · Normal', running: false, canResume: false })
})
