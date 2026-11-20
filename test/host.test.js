'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fakeCtx } = require('./fake-ctx.js')
const R = require('../lib/rules.js')

const root = path.join(__dirname, '..')
const host = require('../dist/host.js')

const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: '/proj', notes: [], files: [], ...extra })
const settle = () => new Promise((resolve) => setImmediate(resolve))
const plain = () => 0.5
const rep = (extra = {}) => ({ level: 1, speed: 'normal', phase: 'play', running: true, started: true, ...extra })
function played(score = 40, extra = {}) {
  const g = R.newGame(extra.speed || 'normal', plain)
  R.launch(g, plain)
  g.score = score
  return JSON.parse(JSON.stringify({ ...g, ...extra }))
}

test.afterEach(() => host.deactivate())

async function started(opts) {
  const f = fakeCtx(opts)
  host.activate(f.ctx)
  await settle()
  return f
}
/** The last message posted with key `key`, with its options. */
function lastWith(f, key) {
  for (let i = f.posts.length - 1; i >= 0; i--) if (key in f.posts[i].message) return f.posts[i]
  return undefined
}

test('hello is answered with what the page starts from, to the view that asked only', async () => {
  const f = await started()
  await f.send({ hello: 1 }, 'web:3')
  const last = f.posts.at(-1)
  assert.deepEqual(last.options, { view: 'web:3' })
  assert.deepEqual(last.message, { init: { speed: 'normal', best: {}, game: null, claude: null } })
})

test('header: New game, Pause or Resume, Speed; Level and speed as its text; Resume greyed out with no game', async () => {
  const f = await started()
  let h = f.headers.at(-1)
  assert.equal(h.meta, 'Level 1 · Normal')
  assert.deepEqual(h.actions.map((a) => a.id), ['new', 'resume', 'speed'])
  assert.equal(h.actions[0].icon, 'refresh')
  for (const a of h.actions.slice(1)) assert.ok(fs.existsSync(path.join(root, a.icon)), `${a.id}: the icon is a file of the plugin`)
  assert.equal(h.actions[1].disabled, true)
  assert.equal(h.actions[2].title, 'Speed: Normal (Calm, Normal, Fast)')

  await f.send({ report: rep({ level: 2 }) })
  h = f.headers.at(-1)
  assert.equal(h.meta, 'Level 2 · Normal')
  assert.deepEqual(h.actions[1], { id: 'pause', icon: 'icons/pause.svg', title: 'Pause (P)' })
  assert.ok(fs.existsSync(path.join(root, h.actions[1].icon)))

  await f.click('pause')
  assert.deepEqual(f.posts.at(-1), { panelId: 'bricks', message: { pause: true }, options: undefined }, 'Pause goes to every view')
  await f.send({ report: rep({ level: 2, running: false }) })
  h = f.headers.at(-1)
  assert.equal(h.actions[1].id, 'resume')
  assert.equal(h.actions[1].disabled, false)
  await f.click('resume')
  assert.deepEqual(f.posts.at(-1), { panelId: 'bricks', message: { resume: true }, options: { view: 'desktop' } }, 'Resume goes to the view that played')

  const n = f.headers.length
  await f.send({ report: rep({ level: 2, running: false }) })
  assert.equal(f.headers.length, n, 'an unchanged header is not set again')
})

test('Speed cycles and is stored app-wide; a started game keeps its own and the title bar says what comes next', async () => {
  const f = await started()
  await f.send({ report: rep() })
  await f.click('speed')
  assert.deepEqual(f.posts.at(-1).message, { speed: 'fast' })
  assert.equal(await f.ctx.appStorage.get('speed'), 'fast')
  assert.equal(f.headers.at(-1).meta, 'Level 1 · Normal · next Fast')
  assert.equal(f.headers.at(-1).actions[2].title, 'Speed: Fast (Calm, Normal, Fast)')
  await f.click('speed')
  await f.click('speed')
  assert.equal(f.headers.at(-1).meta, 'Level 1 · Normal')
  host.deactivate()

  const g = fakeCtx()
  await g.ctx.appStorage.set('speed', 'calm')
  host.activate(g.ctx)
  await g.send({ hello: 1 })
  assert.equal(lastWith(g, 'init').message.init.speed, 'calm', 'the stored speed comes back')
  assert.equal(g.headers.at(-1).meta, 'Level 1 · Calm')
})

test('New game from the title bar goes to every view and drops the saved game', async () => {
  const f = await started()
  await f.send({ game: played(), why: 'pause' })
  await f.click('new')
  assert.ok(f.posts.some((p) => p.message.newGame === true && p.message.speed === 'normal' && p.options === undefined))
  await f.send({ hello: 1 })
  assert.equal(lastWith(f, 'init').message.init.game, null)
})

test('a saved game comes back to the next page; a junk one is refused and changes nothing', async () => {
  const f = await started()
  const g = played(120)
  await f.send({ game: g, why: 'hide' })
  await f.send({ game: { ...g, score: -5 }, why: 'pause' })
  await f.send({ game: g, why: 'because' })
  await f.send({ hello: 1 }, 'web:1')
  assert.deepEqual(lastWith(f, 'init').message.init.game, R.sanitize(g))
})

test('pause: a working tab turning waiting while a view plays pauses every view and names it; Go to the tab focuses it', async () => {
  const f = await started({ sessions: [tab('t1', 'working', { title: 'Fix the scroll test' })] })
  await f.send({ report: rep() })
  f.setSessions([tab('t1', 'waiting', { title: 'Fix the scroll test' })])
  const p = lastWith(f, 'claude')
  assert.deepEqual(p.message, { claude: { name: 'Fix the scroll test' } })
  assert.equal(p.options, undefined)
  assert.equal(f.headers.at(-1).actions[1].id, 'resume')

  await f.send({ act: 'goto' }, 'web:1')
  assert.deepEqual(f.focused, ['t1'])
  const n = f.posts.length
  await f.send({ hello: 1 }, 'web:2')
  assert.deepEqual(f.posts.at(-1).message.init.claude, { name: 'Fix the scroll test' }, 'a page opened now shows the pause')
  assert.equal(f.posts.length, n + 1)

  await f.send({ act: 'resume' })
  assert.deepEqual(f.posts.at(-1).message, { claude: null }, 'every view learns the pause ended')
  const m = f.posts.length
  await f.send({ act: 'resume' })
  assert.equal(f.posts.length, m, 'a second resume posts nothing')
})

test('the header Resume ends a Claude pause too', async () => {
  const f = await started({ sessions: [tab('t1', 'working')] })
  await f.send({ report: rep() })
  f.setSessions([tab('t1', 'waiting')])
  await f.send({ report: rep({ running: false }) })
  await f.click('resume')
  const tail = f.posts.slice(-2).map((p) => p.message)
  assert.deepEqual(tail, [{ claude: null }, { resume: true }])
})

test('no pause while no view plays; Go to the tab on a closed tab tells only that view', async () => {
  const f = await started({ sessions: [tab('t1', 'working')] })
  f.setSessions([tab('t1', 'waiting')])
  assert.equal(lastWith(f, 'claude'), undefined)

  await f.send({ report: rep() })
  f.setSessions([tab('t1', 'working')])
  f.setSessions([tab('t1', 'waiting')])
  assert.ok(lastWith(f, 'claude').message.claude)
  f.setSessions([])
  await f.send({ act: 'goto' }, 'web:2')
  assert.deepEqual(f.posts.at(-1), { panelId: 'bricks', message: { notice: 'That Claude tab is closed.' }, options: { view: 'web:2' } })
})

test('the start list counts: a tab working before activation pauses when it turns waiting', async () => {
  const f = await started({ sessions: [tab('t1', 'working', { name: 'Docs' })] })
  await f.send({ report: rep() })
  f.setSessions([tab('t1', 'waiting', { name: 'Docs' })])
  assert.deepEqual(lastWith(f, 'claude').message, { claude: { name: 'Docs' } })
})

test('two views: the second one starting makes the first yield; its game goes to the second', async () => {
  const f = await started()
  await f.send({ report: rep() }, 'desktop')
  await f.send({ report: rep() }, 'web:1')
  assert.deepEqual(f.posts.at(-1), { panelId: 'bricks', message: { yield: true }, options: { view: 'desktop' } })
  const g = played(300)
  await f.send({ game: g, why: 'yield' }, 'desktop')
  const adopt = lastWith(f, 'adopt')
  assert.deepEqual(adopt.options, { view: 'web:1' })
  assert.deepEqual(adopt.message.adopt, R.sanitize(g))
})

test('best scores are kept app-wide per speed, the higher one wins, and every view hears them', async () => {
  const f = await started()
  await f.send({ game: played(80), why: 'tick' })
  await settle()
  assert.equal(await f.ctx.appStorage.get('best:normal'), 80, 'a record is stored')
  assert.deepEqual(lastWith(f, 'best').message, { best: { normal: 80 } })
  host.deactivate()

  const g = fakeCtx()
  await g.ctx.appStorage.set('best:normal', 500)
  await g.ctx.appStorage.set('best:fast', 99)
  host.activate(g.ctx)
  await g.send({ hello: 1 })
  assert.deepEqual(lastWith(g, 'init').message.init.best, { normal: 500, fast: 99 })
  await g.send({ game: played(120), why: 'over' })
  await settle()
  assert.equal(await g.ctx.appStorage.get('best:normal'), 500, 'a lower score never replaces a stored best')
})

test('a better best stored by another window meanwhile is kept and shown', async () => {
  const f = await started()
  await f.ctx.appStorage.set('best:normal', 300)
  await f.send({ game: played(100), why: 'tick' })
  await settle()
  assert.equal(await f.ctx.appStorage.get('best:normal'), 300)
  assert.deepEqual(lastWith(f, 'best').message.best, { normal: 300 })
})

test('a run of records is stored in order, ending with the highest', async () => {
  const f = await started()
  const sets = []
  const set = f.ctx.appStorage.set
  f.ctx.appStorage.set = async (key, value) => {
    if (key.startsWith('best:')) sets.push(value)
    await settle()
    return set(key, value)
  }
  await Promise.all([10, 20, 30, 25, 40].map((s) => f.send({ game: played(s), why: 'tick' })))
  for (let k = 0; k < 10; k++) await settle()
  assert.equal(await f.ctx.appStorage.get('best:normal'), 40)
  assert.deepEqual(sets, [...sets].sort((a, b) => a - b), 'never a lower one after a higher one')
})

test('without ctx.appStorage the records and the speed go to ctx.storage', async () => {
  const f = await started({ appStorage: false })
  await f.click('speed')
  assert.equal(await f.ctx.storage.get('speed'), 'fast')
  await f.send({ game: played(60), why: 'tick' })
  await settle()
  assert.equal(await f.ctx.storage.get('best:normal'), 60)
})

test('junk from the page is ignored', async () => {
  const f = await started()
  const n = f.posts.length
  const h = f.headers.length
  for (const m of [
    null,
    'x',
    5,
    {},
    { report: null },
    { report: { level: 'one' } },
    { game: null, why: 'tick' },
    { game: { v: 1 }, why: 'tick' },
    { game: played(), why: 'toString' },
    { act: 'goto' },
    { act: 'resume' },
    { act: 'launch' },
    { pause: true },
  ]) {
    await f.send(m)
  }
  assert.equal(f.posts.length, n)
  assert.equal(f.headers.length, h)
  await f.click('nope')
  assert.equal(f.posts.length, n)
})

test('the plugin is harmless: no exec, network, secrets, overlays or session writes in its code', () => {
  const files = ['dist/host.js', 'lib/rules.js', 'lib/pause.js', 'lib/controller.js', 'panels/bricks.js', 'panels/view.js']
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const bad of [
      'ctx.exec',
      'ctx.processes',
      'ctx.secrets',
      'ctx.oauth',
      'ctx.overlay',
      'ctx.openExternal',
      'sessions.send',
      'sessions.open',
      'sessions.close',
      'sessions.rename',
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      "require('node:child_process')",
      "require('child_process')",
      'localStorage',
      'alert(',
      'innerHTML',
      'eval(',
      'new Function',
    ]) {
      assert.equal(text.includes(bad), false, `${file} uses ${bad}`)
    }
  }
})

test('the manifest: id, one right-zone panel with an svg icon, files present, no cli, skills or access', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'))
  assert.equal(m.id, 'bronos.bricks')
  assert.equal(m.name, 'Bricks')
  assert.equal(m.api, 1)
  assert.match(m.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(m.contributes), ['panels'])
  assert.equal(m.access, undefined)
  assert.equal(m.services, undefined)
  const [p] = m.contributes.panels
  assert.equal(p.id, 'bricks')
  assert.equal(p.title, 'Bricks')
  assert.equal(p.defaultZone, 'right')
  assert.match(p.icon, /\.svg$/)
  for (const file of [m.main, p.entry, p.icon]) assert.ok(fs.existsSync(path.join(root, file)), file)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, m.version)
  // Its own icon, not a sibling's.
  for (const sibling of ['cc-cockpit-mines/icons/mines.svg', 'cc-cockpit-tiles/icons/tiles.svg']) {
    const other = path.join(root, '..', sibling)
    if (fs.existsSync(other)) assert.notEqual(fs.readFileSync(path.join(root, p.icon), 'utf8'), fs.readFileSync(other, 'utf8'))
  }
})

test('the page: no inline script or handlers, relative URLs only, the SDK first, the rules before the page', () => {
  const html = fs.readFileSync(path.join(root, 'panels/bricks.html'), 'utf8')
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /src="/, 'every script has a src')
    assert.equal(m[2].trim(), '', 'no inline script')
  }
  assert.equal(/\son[a-z]+=/i.test(html), false, 'no inline event handlers')
  assert.equal(/(src|href)="\//.test(html), false, 'no root-absolute URL')
  const order = ['src="../__sdk/panel.js"', 'src="../lib/rules.js"', 'src="view.js"', 'src="bricks.js"']
  for (let i = 1; i < order.length; i++) assert.ok(html.indexOf(order[i - 1]) < html.indexOf(order[i]), `${order[i - 1]} before ${order[i]}`)
  assert.equal(/<form\b/i.test(html), false)
  // Plugin pages have no reset: without this a class with a display shows a hidden element (Mines' empty menu).
  const css = fs.readFileSync(path.join(root, 'panels/bricks.css'), 'utf8')
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/)
  // Every palette colour the page reads has a probe rule.
  const keys = [...html.matchAll(/<i data-k="([^"]+)"><\/i>/g)].map((m) => m[1])
  assert.ok(keys.length >= 15)
  for (const k of keys) assert.match(css, new RegExp(`\\.palette i\\[data-k='${k.replace(/[-]/g, '\\$&')}'\\]`), k)
  for (const kind of 'abcde23') assert.ok(keys.includes(kind), `a colour for brick kind ${kind}`)
})
