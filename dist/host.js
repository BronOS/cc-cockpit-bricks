'use strict'
// Bricks for cc-cockpit: a paddle-and-ball brick game in a panel, to play while Claude works. The game runs in the
// panel page (real time: lib/rules.js on a canvas); this host keeps what has to outlive a page (lib/controller.js):
// the saved game a hidden or reopened panel comes back to, the Claude pause, the chosen speed, the best score per
// speed and the panel's title bar.
//
// Harmless by design: no exec, no network, no secrets, no overlays, and nothing is ever typed into or sent to a
// session. Its only calls on Claude tabs are reading the window's list (ctx.sessions.list / onChange) for the pause
// and `ctx.sessions.focus` for the person's own Go to the tab click.

const { createController } = require('../lib/controller.js')
const { SPEED_IDS, SPEEDS } = require('../lib/rules.js')

const PANEL = 'bricks'
const BEST_KEY = (speed) => `best:${speed}`
const SPEED_KEY = 'speed'
/** Why a page posts its game; `yield` is the one the host acts on (it hands the game to the view taking over). */
const WHY = new Set(['pause', 'tick', 'level', 'lost', 'over', 'new', 'yield', 'hide'])

let disposers = []

exports.activate = (ctx) => {
  // Best scores and the speed are app-wide (every project window plays for the same records); an app without
  // ctx.appStorage keeps them per project instead.
  const store = typeof ctx.appStorage === 'object' && ctx.appStorage !== null ? ctx.appStorage : ctx.storage
  const controller = createController()

  // The title bar: New game, Pause or Resume, and Speed as icon buttons (the header takes no dropdown, so Speed
  // cycles), the level and speed as its muted text. Resume is greyed out with no game to go on with.
  let headerKey = ''
  function header() {
    const h = controller.header()
    const label = SPEEDS[controller.speed()].label
    const toggle = h.running
      ? { id: 'pause', icon: 'icons/pause.svg', title: 'Pause (P)' }
      : { id: 'resume', icon: 'icons/play.svg', title: 'Resume (P)', disabled: !h.canResume }
    const actions = [
      { id: 'new', icon: 'refresh', title: 'New game (N)' },
      toggle,
      { id: 'speed', icon: 'icons/speed.svg', title: `Speed: ${label} (Calm, Normal, Fast)` },
    ]
    const key = JSON.stringify([h.meta, actions])
    if (key === headerKey) return
    headerKey = key
    try {
      ctx.panels.header(PANEL, { meta: h.meta, actions })
    } catch (err) {
      ctx.log.warn(`could not set the panel header: ${err && err.message}`)
    }
  }
  header()
  /** To one view, or to every view when the app gave none. */
  const to = (message, view) =>
    typeof view === 'string' ? ctx.panels.post(PANEL, message, { view }) : ctx.panels.post(PANEL, message)
  const all = (message) => ctx.panels.post(PANEL, message)

  let picked = false // the person changed the speed before the stored one was read: theirs wins
  async function load() {
    const best = {}
    for (const id of SPEED_IDS) best[id] = await store.get(BEST_KEY(id))
    controller.setBest(best)
    const speed = await store.get(SPEED_KEY)
    if (!picked && controller.setSpeed(speed)) all({ speed: controller.speed() })
    all({ best: controller.best() })
    header()
  }
  // activate's return value is ignored, so messages can come before the store answered: each waits for it.
  const loaded = load().catch((err) => ctx.log.warn(`could not read the best scores: ${err && err.message}`))

  // A record is stored once the save before it is done, and only the newest of those that piled up meanwhile: a page
  // posts its game every two seconds while it scores, and two saves in flight could land out of order.
  const pending = new Map() // speed -> the highest score not stored yet
  let saving = null
  async function saveRecords() {
    while (pending.size > 0) {
      const [speed, score] = pending.entries().next().value
      pending.delete(speed)
      try {
        // Another window may have stored a better one meanwhile: keep the higher.
        const stored = await store.get(BEST_KEY(speed))
        if (typeof stored === 'number' && stored >= score) {
          if (controller.setBest({ [speed]: stored })) all({ best: controller.best() })
          continue
        }
        await store.set(BEST_KEY(speed), score)
      } catch (err) {
        ctx.log.warn(`could not save the best score: ${err && err.message}`)
      }
    }
  }
  function saveRecord({ speed, score }) {
    if (!(pending.get(speed) >= score)) pending.set(speed, score)
    if (!saving) saving = saveRecords().finally(() => (saving = null))
    return saving
  }

  if (typeof ctx.panels.onAction === 'function') {
    disposers.push(
      ctx.panels.onAction(PANEL, async (id) => {
        await loaded
        // The click carries no view: what it changes goes to every view.
        if (id === 'new') {
          controller.newGame()
          all({ newGame: true, speed: controller.speed() })
          all({ claude: null })
        } else if (id === 'pause') {
          all({ pause: true })
        } else if (id === 'resume') {
          if (controller.endClaude()) all({ claude: null })
          to({ resume: true }, controller.resumeView())
        } else if (id === 'speed') {
          picked = true
          const speed = controller.cycleSpeed()
          store.set(SPEED_KEY, speed).catch((err) => ctx.log.warn(`could not save the speed: ${err && err.message}`))
          all({ speed })
        } else {
          return
        }
        header()
      }),
    )
  }

  disposers.push(
    ctx.panels.onMessage(PANEL, async (msg, from) => {
      await loaded
      if (!msg || typeof msg !== 'object') return
      const view = from && typeof from.view === 'string' ? from.view : undefined
      if (msg.hello) {
        to({ init: controller.hello(view) }, view)
        header()
        return
      }
      if (msg.report) {
        const r = controller.report(msg.report, view)
        // The view that ran the game until now pauses and posts it (`why: 'yield'`), handed over below.
        if (r.yieldView !== undefined) to({ yield: true }, r.yieldView === '' ? undefined : r.yieldView)
        if (r.changed) header()
        return
      }
      if (msg.game) {
        if (!WHY.has(msg.why)) return
        const r = controller.game(msg.game, view, msg.why)
        if (!r.ok) return
        if (r.adoptView !== undefined) to({ adopt: controller.saved() }, r.adoptView === '' ? undefined : r.adoptView)
        if (r.record) {
          all({ best: controller.best() })
          await saveRecord(r.record)
        }
        return
      }
      if (msg.act === 'resume') {
        if (controller.endClaude()) {
          all({ claude: null })
          header()
        }
        return
      }
      if (msg.act === 'goto') {
        // Returned (awaited) from the listener, so the focus acts in the view the click came from.
        const tabId = controller.pausedTab()
        if (!tabId) return
        const ok = await ctx.sessions.focus(tabId).catch(() => false)
        if (!ok) to({ notice: 'That Claude tab is closed.' }, view)
      }
    }),
  )

  // The pause: every change of this window's Claude tabs (statuses included) comes as the whole list. The first list
  // is read once at start so a tab already working then is known when it turns to waiting; an onChange that came
  // first is newer, so the start list is dropped then.
  let changeSeen = false
  disposers.push(
    ctx.sessions.onChange((list) => {
      changeSeen = true
      if (controller.sessions(list)) {
        all({ claude: controller.claude() })
        header()
      }
    }),
  )
  ctx.sessions
    .list()
    .then((list) => {
      if (!changeSeen) controller.sessions(list)
    })
    .catch((err) => ctx.log.warn(`could not list the Claude tabs: ${err && err.message}`))
}

exports.deactivate = () => {
  for (const dispose of disposers) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      // the host is stopping anyway
    }
  }
  disposers = []
}
