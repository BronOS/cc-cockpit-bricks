'use strict'
// What the host keeps for one project window's Bricks, with no ctx in it, so `test/controller.test.js` drives it
// directly; dist/host.js wires it to ctx. The game itself runs in the panel page (lib/rules.js, real time); the host
// keeps what must outlive a page:
//
// - the saved game: the page posts its game whenever it pauses, a level ends, a ball is lost, a game ends or starts,
//   and every two seconds while it runs. Hiding the panel unmounts the page, so a page that comes back (or another
//   view's page) starts from this, paused.
// - the Claude pause: a Claude tab of the window going from working to waiting while a view runs the game (lib/pause.js).
// - the chosen speed and the best score per speed.
// - which view runs the game. Every view of the window (the desktop, a web access browser) has its own page and so its
//   own copy of the game; only one runs at a time. A view starting to run makes the one running before yield: that
//   one pauses and posts its game, and the host hands it to the new view, which takes it over (paused, one more
//   Resume), so the game goes on from where it really was.
//
// Every message from a page is untrusted: reports are checked, games go through `rules.sanitize`.

const rules = require('./rules.js')
const { createReadyWatch } = require('./pause.js')

const PHASES = ['aim', 'play', 'cleared', 'over']
/** The key of a view in the maps: the app's view id, or '' when the app gave none (one view). */
const viewKey = (view) => (typeof view === 'string' ? view : '')

/** A page's report `{ level, speed, phase, running, started }`, checked; null when anything is off. */
function checkReport(r) {
  if (!r || typeof r !== 'object') return null
  if (!Number.isInteger(r.level) || r.level < 1 || r.level > 10000 || !rules.isSpeed(r.speed) || !PHASES.includes(r.phase)) return null
  if (typeof r.running !== 'boolean' || typeof r.started !== 'boolean') return null
  return { level: r.level, speed: r.speed, phase: r.phase, running: r.running, started: r.started }
}

function createController() {
  let speed = rules.DEFAULT_SPEED
  const best = {}
  /** The saved game (sanitized), or null for none yet: a new page starts a new game. */
  let saved = null
  /** The last report, from whichever view sent it: what the header shows. */
  let status = null
  /** The view that reported last, for the header's Resume. */
  let lastView = null
  /** view -> whether it runs the game. A new page (hello) runs nothing until it says so. */
  const running = new Map()
  /** view that must yield -> the view that takes its game over. */
  const handOver = new Map()
  /** The Claude tab the pause is about, `{ tabId, name }`, or null. */
  let claude = null
  const watch = createReadyWatch()

  const anyRunning = () => [...running.values()].some(Boolean)

  /** What the header shows: the game's level and speed from the last report, else the saved game, else a new one. */
  function shown() {
    if (status) return status
    if (saved) return { level: saved.level + 1, speed: saved.speed, phase: saved.phase, running: false, started: saved.started }
    return { level: 1, speed, phase: 'aim', running: false, started: false }
  }

  return {
    /** The header: `meta` text, whether a view runs the game (Pause) and whether Resume has a game to go on with. */
    header() {
      const s = shown()
      const label = (id) => rules.SPEEDS[id].label
      // The speed applies to the next game once one is started: the title bar says what comes next.
      const next = s.started && s.speed !== speed ? ` · next ${label(speed)}` : ''
      const isRunning = anyRunning()
      return {
        meta: `Level ${s.level} · ${label(s.speed)}${next}`,
        running: isRunning,
        canResume: !isRunning && s.started && s.phase !== 'over',
      }
    },

    /** A page said hello: what it starts from. A view's new page runs nothing yet, whatever its old page did. */
    hello(view) {
      const key = viewKey(view)
      running.delete(key)
      handOver.delete(key)
      return {
        speed,
        best: { ...best },
        game: saved,
        claude: claude ? { name: claude.name } : null,
      }
    },

    /**
     * A page's report. Returns `{ changed, yieldView? }`: `yieldView` is the view that ran the game until now and must
     * pause and hand it over (the host posts it `{ yield }`).
     */
    report(raw, view) {
      const r = checkReport(raw)
      if (!r) return { changed: false }
      const key = viewKey(view)
      const before = JSON.stringify([status, anyRunning()])
      let yieldView
      if (r.running) {
        for (const [other, on] of running) {
          if (other === key || !on) continue
          handOver.set(other, key)
          running.set(other, false)
          yieldView = other
        }
      }
      running.set(key, r.running)
      status = r
      lastView = key
      return { changed: before !== JSON.stringify([status, anyRunning()]), ...(yieldView !== undefined ? { yieldView } : {}) }
    },

    /**
     * A page's game. Returns `{ ok, record?, adoptView? }`: `record` `{ speed, score }` when its score beats the best
     * known (the host stores it), `adoptView` the view that takes a yielded game over. Junk is refused.
     */
    game(raw, view, why) {
      const g = rules.sanitize(raw)
      if (!g) return { ok: false }
      saved = g
      const out = { ok: true }
      const prev = best[g.speed]
      if (g.score > 0 && !(typeof prev === 'number' && g.score <= prev)) {
        best[g.speed] = g.score
        out.record = { speed: g.speed, score: g.score }
      }
      const key = viewKey(view)
      if (why === 'yield' && handOver.has(key)) {
        out.adoptView = handOver.get(key)
        handOver.delete(key)
      }
      return out
    },

    /**
     * The window's Claude tabs. A tab going from working to waiting while a view runs the game pauses it; while
     * paused, a later one only renames the cover (the latest wins). Returns whether the pause changed.
     */
    sessions(list) {
      const ready = watch.observe(list)
      if (ready.length === 0) return false
      const latest = ready[ready.length - 1]
      if (claude) {
        if (claude.tabId === latest.tabId && claude.name === latest.name) return false
        claude = latest
        return true
      }
      if (!anyRunning()) return false
      claude = latest
      for (const key of running.keys()) running.set(key, false)
      return true
    },

    /** Resume game on the Claude cover, or the header's Resume: the pause ends. Returns whether there was one. */
    endClaude() {
      if (!claude) return false
      claude = null
      return true
    },
    claude: () => (claude ? { name: claude.name } : null),
    /** The tab the pause names, for Go to the tab; null when not paused. */
    pausedTab: () => (claude ? claude.tabId : null),

    /** The header's New game: every view starts over, so the saved game and the pause go. */
    newGame() {
      saved = null
      claude = null
      status = null
      for (const key of running.keys()) running.set(key, false)
    },

    /**
     * The header's Speed: the next one. It applies now to a game nobody launched yet (that game starts again at it,
     * in the page) and to the next new game otherwise. Returns the new speed.
     */
    cycleSpeed() {
      speed = rules.nextSpeed(speed)
      if (saved && !saved.started) saved = null
      if (status && !status.started) status = { ...status, speed }
      return speed
    },
    /** A stored speed, at start; `false` for junk. */
    setSpeed(id) {
      if (!rules.isSpeed(id)) return false
      speed = id
      if (status && !status.started) status = { ...status, speed }
      return true
    },
    speed: () => speed,

    /** Best scores from storage: `{ speed: score }`; a stored value only raises what this window knows. */
    setBest(stored) {
      let changed = false
      for (const id of rules.SPEED_IDS) {
        const v = stored && stored[id]
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue
        if (typeof best[id] !== 'number' || v > best[id]) {
          best[id] = Math.floor(v)
          changed = true
        }
      }
      return changed
    },
    best: () => ({ ...best }),
    saved: () => saved,
    /** The view the header's Resume goes to: the last one that reported (undefined: every view). */
    resumeView: () => (lastView === null || lastView === '' ? undefined : lastView),
  }
}

module.exports = { createController, checkReport }
