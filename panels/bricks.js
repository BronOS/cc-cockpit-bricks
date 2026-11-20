'use strict'
// The Bricks panel page: the game loop, the drawing and the input. The rules are lib/rules.js (BricksRules); the host
// keeps what must outlive this page (the saved game, the Claude pause, the speed, the best scores), so the page posts
// its game whenever it pauses, a level ends, a ball is lost, a game ends or starts, and every two seconds while it runs.
//
// The loop runs only while the game moves: requestAnimationFrame, with lib/rules.js's fixed step, so the ball keeps the
// same pace at any refresh rate and panel size. Under a cover (any pause, level cleared, game over) nothing moves and
// nothing is drawn again until something changes.
;(function () {
  const R = globalThis.BricksRules
  const V = globalThis.BricksView
  const $ = (id) => document.getElementById(id)
  const canvas = $('board')
  const g = canvas.getContext('2d')
  const cover = $('cover')

  /** How often a running game is posted to the host, so a panel hidden mid-play loses at most this much. */
  const TICK_MS = 2000

  let game = null // the game (lib/rules.js), null until the host's init
  let hold = null // the page's pause: null, { kind: 'paused', reason } or { kind: 'claude', name }
  let speed = R.DEFAULT_SPEED // the speed the next new game takes (the host's)
  let best = {} // speed -> best score, from the host
  let notice = '' // a refusal for this page (Go to the tab on a closed tab), until the cover changes
  const keys = { left: false, right: false }
  const ticker = R.createTicker()
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let lastReport = ''
  let lastTick = 0

  const post = (message) => ccPanel.post(message)

  // ---- the host ----

  function report() {
    if (!game) return
    const r = V.reportOf(game, hold)
    const key = JSON.stringify(r)
    if (key === lastReport) return
    lastReport = key
    post({ report: r })
  }
  function saveGame(why) {
    if (!game) return
    lastTick = performance.now()
    post({ game, why })
  }

  ccPanel.onMessage((m) => {
    if (!m || typeof m !== 'object') return
    if (m.init) {
      const init = m.init
      if (R.isSpeed(init.speed)) speed = init.speed
      if (init.best && typeof init.best === 'object') best = init.best
      const saved = init.game ? R.sanitize(init.game) : null
      game = saved || R.newGame(speed)
      hold = init.claude && V.claudeTakes(game) ? { kind: 'claude', name: String(init.claude.name) } : V.restoredHold(game)
      $('loading').hidden = true
      lastReport = ''
      changed()
      if (!saved) saveGame('new')
      return
    }
    if (!game) return
    if ('claude' in m) {
      if (m.claude && V.claudeTakes(game)) {
        if (V.isRunning(game, hold)) saveGame('pause')
        hold = { kind: 'claude', name: String(m.claude.name) }
      } else if (!m.claude && hold && hold.kind === 'claude') {
        // Resumed in another view (or New game from the title bar): this view stays paused, as a plain pause.
        hold = { kind: 'paused', reason: 'yielded' }
      }
      changed()
    }
    if (m.best && typeof m.best === 'object') {
      best = m.best
      drawBar()
    }
    if (R.isSpeed(m.speed)) {
      speed = m.speed
      // A game nobody launched yet starts again at the new speed; a started one keeps its own.
      if (!m.newGame && !game.started && game.speed !== speed) newGame()
    }
    if (m.newGame) newGame()
    if (m.pause) pause('header')
    if (m.resume) resume()
    if (m.yield) {
      // Another view started playing: this one pauses and hands its game over.
      if (V.isRunning(game, hold)) hold = { kind: 'paused', reason: 'yielded' }
      changed()
      saveGame('yield')
    }
    if (m.adopt) {
      const theirs = R.sanitize(m.adopt)
      // Only the same game: a view that started a new one keeps it.
      if (theirs && theirs.id === game.id) {
        game = theirs
        hold = V.restoredHold(game) ? { kind: 'paused', reason: 'adopted' } : null
        changed()
      }
    }
    if (typeof m.notice === 'string') {
      notice = m.notice
      drawCover()
    }
  })
  // Each new connection (the first one, a host restart) asks for the whole state; an app without onConnect gets one
  // ask, queued until the connection is up.
  if (typeof ccPanel.onConnect === 'function') ccPanel.onConnect(() => post({ hello: 1 }))
  else post({ hello: 1 })

  // ---- the game's moves ----

  function newGame() {
    game = R.newGame(speed)
    hold = null
    keys.left = keys.right = false
    changed()
    saveGame('new')
  }

  /** Pauses a moving game, for `reason` (a key of BricksView.REASONS). */
  function pause(reason) {
    if (!V.isRunning(game, hold)) return
    hold = { kind: 'paused', reason }
    keys.left = keys.right = false
    changed()
    saveGame(reason === 'hidden' ? 'hide' : 'pause')
  }

  function resume() {
    if (!game) return
    const wasClaude = hold && hold.kind === 'claude'
    hold = null
    notice = ''
    if (game.phase === 'cleared') R.nextLevel(game)
    if (wasClaude) post({ act: 'resume' })
    focusBoard()
    changed()
  }

  function launch() {
    if (hold || !R.launch(game)) return
    changed()
  }

  function focusBoard() {
    try {
      canvas.focus({ preventScroll: true })
    } catch {
      // nothing to focus in a page being torn down
    }
  }

  /** After any change of the game or the pause: report, redraw everything, and run the loop if the game moves. */
  function changed() {
    report()
    drawBar()
    drawCover()
    drawBoard()
    if (V.isRunning(game, hold)) startLoop()
  }

  // ---- the loop ----

  let rafId = 0
  let lastFrame = null
  function startLoop() {
    if (rafId) return
    lastFrame = null
    ticker.reset()
    rafId = requestAnimationFrame(frame)
  }
  function frame(now) {
    rafId = 0
    if (!V.isRunning(game, hold)) return
    const dt = lastFrame === null ? 0 : (now - lastFrame) / 1000
    lastFrame = now
    const n = ticker.steps(dt)
    const events = []
    for (let i = 0; i < n && V.isRunning(game, hold); i++) events.push(...R.step(game, keys))
    if (events.length) onEvents(events)
    drawBoard()
    if (V.isRunning(game, hold)) {
      if (now - lastTick > TICK_MS) saveGame('tick')
      rafId = requestAnimationFrame(frame)
    }
  }

  function onEvents(events) {
    if (events.includes('cleared')) {
      saveGame('level')
      changed()
    } else if (events.includes('over')) {
      saveGame('over')
      changed()
    } else if (events.includes('lost')) {
      saveGame('lost')
      report()
      drawBar()
    } else {
      report()
      drawBar()
    }
  }

  // ---- drawing ----

  let palette = {}
  let font = 'system-ui, sans-serif'
  /** The board's colours, read back from the probes (bricks.css), as computed colours a canvas takes. */
  function readPalette() {
    const next = {}
    for (const el of $('palette').children) next[el.dataset.k] = getComputedStyle(el).color
    palette = next
    font = getComputedStyle(document.body).fontFamily || font
  }

  let lastBar = ''
  function drawBar() {
    if (!game) return
    const shownBest = Math.max(typeof best[game.speed] === 'number' ? best[game.speed] : 0, game.score)
    const key = `${game.score}|${shownBest}|${game.lives}|${V.footInfo(game)}`
    if (key === lastBar) return
    lastBar = key
    $('score').textContent = String(game.score)
    $('best').textContent = String(shownBest)
    const lives = $('lives')
    if (lives.childElementCount !== game.lives) {
      lives.textContent = ''
      for (let i = 0; i < game.lives; i++) lives.append(document.createElement('i'))
    }
    lives.title = V.livesLabel(game.lives)
    lives.setAttribute('aria-label', V.livesLabel(game.lives))
    $('info').textContent = V.footInfo(game)
  }

  /** Sizes the canvas's pixels to its box (and the screen's pixel ratio), so lines stay sharp at any panel width. */
  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
  }

  function rounded(x, y, w, h, r) {
    g.beginPath()
    g.roundRect(x, y, w, h, r)
  }

  function drawBoard() {
    if (!game) return
    fitCanvas()
    g.setTransform(canvas.width / R.W, 0, 0, canvas.height / R.H, 0, 0)
    g.clearRect(0, 0, R.W, R.H)
    const reduced = reducedMotion.matches
    for (const k of game.bricks) {
      if (k.hp <= 0) continue
      g.fillStyle = V.flashes(k, game.t, reduced) ? palette.flash : palette[k.kind]
      rounded(k.x, k.y, k.w, k.h, 3)
      g.fill()
      g.fillStyle = palette.notch
      for (const n of V.notches(k)) {
        rounded(n.x, n.y, n.w, n.h, 1)
        g.fill()
      }
    }
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const c of game.caps) {
      g.fillStyle = palette.capBg
      rounded(c.x - 9, c.y - 6, 18, 12, 6)
      g.fill()
      g.fillStyle = palette.capFg
      g.font = `bold 9px ${font}`
      g.fillText(c.t, c.x, c.y + 0.5)
    }
    const p = game.paddle
    g.fillStyle = palette.paddle
    rounded(p.x - p.w / 2, R.PADDLE_Y, p.w, R.PADDLE_H, 4)
    g.fill()
    if (game.t < game.wideUntil) {
      g.strokeStyle = palette.wide
      g.lineWidth = 1.5
      g.stroke()
    }
    g.fillStyle = palette.ball
    for (const b of game.balls) {
      g.beginPath()
      g.arc(b.x, b.y, R.BALL_R, 0, Math.PI * 2)
      g.fill()
    }
    const hint = V.hint(game, hold)
    if (hint && cover.hidden) {
      g.fillStyle = palette.hint
      g.font = `11px ${font}`
      g.fillText(hint, R.W / 2, R.H - 50)
    }
  }

  let lastCover = ''
  function drawCover() {
    const spec = V.coverFor(game, hold, game ? best[game.speed] : undefined)
    const key = JSON.stringify([spec, notice])
    if (key === lastCover) return
    lastCover = key
    const hadFocus = document.activeElement === canvas || cover.contains(document.activeElement)
    if (!spec) {
      const coverHadFocus = !cover.hidden && cover.contains(document.activeElement)
      cover.hidden = true
      cover.textContent = ''
      notice = ''
      if (coverHadFocus) focusBoard()
      return
    }
    cover.className = `cover ${spec.kind}`
    cover.textContent = ''
    const big = document.createElement('div')
    big.className = 'big'
    if (spec.dot) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      big.append(dot)
    }
    // Plain text only: a tab's name is never put into HTML.
    big.append(spec.title)
    cover.append(big)
    if (spec.text) {
      const what = document.createElement('div')
      what.className = 'what'
      what.textContent = spec.text
      cover.append(what)
    }
    if (notice) {
      const line = document.createElement('div')
      line.className = 'cc-error-line'
      line.textContent = notice
      cover.append(line)
    }
    const row = document.createElement('div')
    row.className = 'buttons'
    let primary = null
    for (const b of spec.buttons) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = b.label
      btn.dataset.act = b.act
      if (b.primary) {
        btn.className = 'cc-primary'
        primary = btn
      }
      row.append(btn)
    }
    cover.append(row)
    cover.hidden = false
    // Someone playing by keyboard goes on from the cover's main button; a page without focus never takes it.
    if (hadFocus && primary) primary.focus()
  }

  cover.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'resume' || act === 'next') resume()
    else if (act === 'new') {
      if (hold && hold.kind === 'claude') post({ act: 'resume' })
      newGame()
      focusBoard()
    } else if (act === 'goto') post({ act: 'goto' })
  })
  // Space or P on the cover is its main button, as on the board (Enter is the focused button's own).
  cover.addEventListener('keydown', (e) => {
    const k = V.keyOf(e.key)
    if (k !== 'space' && k !== 'pause') return
    e.preventDefault()
    const primary = cover.querySelector('.cc-primary')
    if (primary) primary.click()
  })

  // ---- input ----

  // Keys only while the board has focus, and only these; everything else goes on to the app.
  canvas.addEventListener('keydown', (e) => {
    if (!game || e.ctrlKey || e.metaKey || e.altKey) return
    const k = V.keyOf(e.key)
    if (k === 'left' || k === 'right') {
      if (V.isRunning(game, hold)) keys[k] = true
    } else if (k === 'space') {
      if (e.repeat) return e.preventDefault()
      if (!V.isRunning(game, hold)) resume()
      else if (game.phase === 'aim') launch()
      else pause('key')
    } else if (k === 'pause') {
      if (e.repeat) return e.preventDefault()
      if (V.isRunning(game, hold)) pause('key')
      else if (hold) resume()
    } else if (k === 'new') {
      if (hold && hold.kind === 'claude') return
      newGame()
    } else return
    e.preventDefault()
  })
  canvas.addEventListener('keyup', (e) => {
    const k = V.keyOf(e.key)
    if (k === 'left' || k === 'right') keys[k] = false
  })

  // The mouse (or a finger on the board) moves the paddle; a press launches.
  function pointTo(e) {
    if (!V.isRunning(game, hold)) return
    const rect = canvas.getBoundingClientRect()
    const x = V.boardX(e.clientX, rect.left, rect.width, R.W)
    if (x === null) return
    R.movePaddleTo(game, x)
    if (!rafId) drawBoard()
  }
  canvas.addEventListener('pointermove', pointTo)
  // The press focuses the board by itself (it has a tabindex), so its focus ring shows for keys only.
  canvas.addEventListener('pointerdown', (e) => {
    if (!game) return
    pointTo(e)
    if (V.isRunning(game, hold) && game.phase === 'aim') launch()
  })
  // The pointer leaving the board while the ball is in play pauses: the paddle has lost its hand. Only a mouse: a
  // finger leaves the board every time it lifts.
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && game && V.isRunning(game, hold) && game.phase === 'play') pause('pointer')
  })
  canvas.addEventListener('blur', () => {
    keys.left = keys.right = false
    if (game && V.isRunning(game, hold) && game.phase === 'play') pause('blur')
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause('hidden')
  })
  // The panel being hidden or closed unmounts the page: the game in hand goes to the host one last time.
  window.addEventListener('pagehide', () => {
    if (game && V.isRunning(game, hold)) {
      hold = { kind: 'paused', reason: 'hidden' }
      saveGame('hide')
    }
  })

  // ---- theme and size ----

  readPalette()
  if (ccPanel.theme && typeof ccPanel.theme.onChange === 'function') {
    ccPanel.theme.onChange(() => {
      readPalette()
      drawBoard()
    })
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    readPalette()
    drawBoard()
  })
  new ResizeObserver(() => drawBoard()).observe(canvas)
})()
