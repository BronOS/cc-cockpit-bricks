# Bricks

A cc-cockpit plugin (`bronos.bricks`): a paddle-and-ball brick game in a panel, to play while Claude works. When a
Claude tab of the window finishes its turn and waits for you, the game pauses and tells you which tab it is.

It is a harmless game: no commands, no settings, no network, no secrets, no overlays. It reads the window's Claude tab
statuses and names, and its one action on a tab is to show it when you click **Go to the tab**. It never types into or
sends anything to a session.

## Install

From a checkout: `ccc plugin link <path to this repo>`, then Allow it in the app window. The **Bricks** panel opens in
the right zone (move it like any panel).

## How to play

Keep the ball in play with the paddle and break every brick.

- The mouse over the board moves the paddle; so do ← → (or A D) once the board has focus (click into it). On a touch
  screen, drag a finger on the board. Keys work only while the board has focus; other keys go on to the app.
- **Space** or a click launches the ball. Where it hits the paddle sets its angle: straight up from the middle, wider
  toward the edges.
- Grey bricks are strong: they take 2 or 3 hits. Each hit a brick has left is a white notch on it, so its strength never
  rests on telling two greys apart. A hit that does not break a brick scores 2; a broken brick scores 10 per hit it took.
- Some bricks drop a capsule; catch it with the paddle (5 points): **W** a wider paddle for 12 seconds (it gets an
  outline too), **S** a slower ball for 10 seconds, **+** one more ball, **♥** one more ball in reserve (up to 5). The
  foot of the panel shows a running W or S with the seconds left.
- You have 3 balls (the bars at the top right, the one in play included). A ball lost while another is still in play
  costs nothing.
- Clearing a level scores 100 and shows **Level N cleared**; **Next level** (or Space) goes on. There are five levels;
  after the fifth they start again, each round 12% faster (up to 60%).
- **Game over** shows the score; **New game** starts again.
- **Best** is your highest score at the game's speed, kept for every project window, across restarts.

The title bar shows the level and the speed, and has three buttons:

- **New game** (the circular arrow, or N).
- **Pause** / **Resume** (or P; Space pauses a ball in play too). Resume is greyed out when there is nothing to go on
  with.
- **Speed**: Calm, Normal or Fast, in turn. A change applies at once to a game whose ball was never launched, and
  otherwise to the next new game: the game in play keeps its speed, so its score counts toward that speed's best. The
  title bar says what comes next (`Level 3 · Normal · next Fast`). The speed you picked last comes back next time.

The board has its own colours for light and dark themes. With reduced motion asked for, a brick does not flash when hit.

## Pauses

Nothing moves while any cover is up (the ball, capsules, and the W and S timers all stop). The game pauses on:

- Space or P, or the title bar's Pause;
- the mouse leaving the board while the ball is in play (the paddle has lost its hand);
- the board losing focus while the ball is in play (a click elsewhere in the app);
- the panel being hidden or closed.

**Resume** (or Space or P on the cover) goes on; **New game** starts over.

## The Claude pause

While you play (a ball launched in this game, and the game running, not already paused), a Claude tab of the same window
that was **working** and becomes **waiting for input** pauses it, and a cover says **Claude is ready** with the tab's
name (the name you gave it, else Claude's topic for it). **Resume game** goes on; **Go to the tab** shows that tab and
leaves the game paused for when you come back.

- Only a change seen while you play pauses: a tab that was already waiting, or one that finished while the game was
  paused or before your first launch, does not.
- With several tabs, the cover names the latest one to become ready.
- A tab that stops to ask for a permission (or a question) is not "ready" and does not pause the game.

How it knows: `ctx.sessions.onChange` (the window's Claude tabs with their status, on every change) and one
`ctx.sessions.list()` at start; **Go to the tab** is `ctx.sessions.focus`.

## Hidden panels and other views

The game runs in the panel page (it is real time), and hiding a panel unmounts its page. So the page hands its game to
the plugin's host whenever it pauses, a level ends, a ball is lost, a game starts or ends, and every two seconds while
it runs; a panel shown again brings back the same game, paused (**Your game waited for you here**).

Each view of the window (the desktop and a web access browser) has its own page, and one runs the game at a time:
starting or resuming in one view pauses the one that was running, which hands its game over, and the new view takes
it, paused once more (**Picked up from your other view**), so it goes on from where it really was. A view that started
a new game keeps its own.

A restart of the plugin host (the app restarting, or a plugin being enabled, linked or updated in the project) ends the
game in progress; best scores and the speed are kept.

## Development

Plain JavaScript, no build step: `lib/rules.js` is the game (the board, collisions, capsules, lives, levels, the score
and the fixed timestep: 240 steps a second whatever the frame rate), pure and loaded both by the page (as a classic
script, `BricksRules`) and by node. `dist/host.js` wires `lib/controller.js` (the saved game, the Claude pause, the
speed, the best scores and which view runs the game, no ctx in it) to the plugin API; `lib/pause.js` is the
working-to-waiting rule shared with Mines and Tiles. `panels/` is the page: `view.js` its pure helpers, `bricks.js` the
canvas, the loop and the input. A game posted by a page goes through `rules.sanitize` before the host keeps it.

`npm test` runs the `node:test` suites: the rules, the controller and the pause rule, the host with a fake `ctx`, and the
page's helpers.

## License

MIT
