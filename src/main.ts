import { JUNK_COLORS, JUNK_POINTS, OXYGEN_WARN } from './sim/config.ts'
import {
  bearingTo, buyItem, canDock, canLand, contextAction, contextLabel, createGame, holdCount,
  latLonDistance, nearLander, step, undock, wrapAngle,
} from './sim/game.ts'
import { landerSite } from './sim/planets.ts'
import type { Game, GameEvent } from './sim/types.ts'
import { createWorld } from './render/scene.ts'
import { createHud } from './ui/hud.ts'
import type { CompassState } from './ui/hud.ts'
import { createInput } from './input.ts'
import { createAudio } from './audio.ts'

const STEP = 1 / 120
const BEST_KEY = 'solar-janitor:best'
const MUTE_KEY = 'solar-janitor:muted'

const sceneRoot = document.getElementById('scene')
if (!sceneRoot) throw new Error('Missing #scene container')
const fadeEl = document.getElementById('fade')

const world = createWorld(sceneRoot)
const audio = createAudio()

const PICKUP_COLORS: Record<number, number> = {
  [JUNK_POINTS.scrap]: JUNK_COLORS.scrap,
  [JUNK_POINTS.tech]: JUNK_COLORS.tech,
  [JUNK_POINTS.hazardous]: JUNK_COLORS.hazardous,
}

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0
  } catch {
    return 0
  }
}

function saveBest(value: number) {
  try {
    localStorage.setItem(BEST_KEY, String(value))
  } catch {
    /* storage can be blocked; keep it in memory */
  }
}

let best = loadBest()
let game: Game = createGame()
let lastPhase = game.phase
let lastMode = game.mode
let accumulator = 0
let lastFrame = performance.now()
let shopOpen = false
let fadeOut = 0

function newRun() {
  game = createGame({ seed: Date.now() >>> 0 })
  game.phase = 'playing'
  lastPhase = 'playing'
  lastMode = game.mode
  accumulator = 0
  shopOpen = false
  fadeOut = 1
  hud.hideOverlay()
  audio.unlock()
  audio.play('ui')
}

function toMenu() {
  game = createGame()
  lastPhase = 'ready'
  lastMode = game.mode
  shopOpen = false
  fadeOut = 1
  best = loadBest()
  hud.showTitle(best)
}

function togglePause() {
  if (game.phase === 'playing') {
    game.phase = 'paused'
    lastPhase = 'paused'
    hud.showPause(game)
    audio.play('ui')
  } else if (game.phase === 'paused') {
    game.phase = 'playing'
    lastPhase = 'playing'
    hud.hideOverlay()
    audio.play('ui')
  }
}

function toggleMute() {
  const muted = !audio.isMuted()
  audio.setMuted(muted)
  hud.setMuted(muted)
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function onContext() {
  audio.unlock()
  if (game.phase !== 'playing' || game.transition) return
  if (game.mode === 'docked') {
    if (shopOpen) {
      if (undock(game)) {
        shopOpen = false
        hud.hideOverlay()
      }
    } else {
      shopOpen = true
      hud.showShop(game)
      audio.play('ui')
    }
    return
  }
  contextAction(game)
}

function onConfirm() {
  audio.unlock()
  if (game.phase === 'ready') newRun()
  else if (game.phase === 'finished') newRun()
}

const hud = createHud({
  start: newRun,
  resume: togglePause,
  restart: newRun,
  quit: toMenu,
  togglePause,
  toggleMute,
  buy: (id: string) => {
    if (buyItem(game, id)) {
      audio.unlock()
      hud.showShop(game)
    }
  },
  depart: () => {
    if (undock(game)) {
      shopOpen = false
      hud.hideOverlay()
    }
  },
  closeShop: () => {
    shopOpen = false
    hud.hideOverlay()
    audio.play('ui')
  },
})

const input = createInput({
  context: onContext,
  confirm: onConfirm,
  togglePause,
  toggleMute,
  boost: () => {
    if (game.phase === 'playing' && game.mode === 'space') audio.play('thrust', 0.6)
  },
})

function handleEvent(event: GameEvent) {
  hud.pushEvent(event)
  switch (event.kind) {
    case 'pickup':
      world.burst(event, PICKUP_COLORS[event.amount] ?? JUNK_COLORS.scrap, 9, 7)
      audio.play('pickup', 0.7)
      break
    case 'deposit':
      world.burst(event, 0xffd9a3, 16, 9)
      world.addShake(0.16)
      audio.play('deposit')
      break
    case 'deliver':
      world.burst(event, 0x9ff3d4, 34, 14)
      world.addShake(0.32)
      audio.play('deliver', Math.min(1.4, 0.75 + event.amount / 2000))
      break
    case 'buy':
      audio.play('buy')
      break
    case 'dock':
      world.burst(event, 0xcfe9ff, 18, 9)
      world.addShake(0.5)
      audio.play('dock')
      break
    case 'undock':
      world.addShake(0.2)
      audio.play('undock')
      break
    case 'takeoff':
      world.burst(event, 0xffe3b0, 22, 12)
      world.addShake(0.45)
      audio.play('takeoff')
      break
    case 'land':
      world.burst(event, 0xd9c9a8, event.text ? 20 : 10, 8)
      if (event.text) world.addShake(0.35)
      audio.play('land', event.text ? 1 : 0.55)
      break
    case 'oxygen':
      world.addShake(0.25)
      audio.play('oxygen')
      break
    case 'rescue':
      world.burst(event, 0xb6ff9d, 44, 16)
      world.addShake(0.85)
      audio.play('rescue')
      break
    case 'block':
      audio.play('block')
      break
    case 'scrape':
      world.burst(event, 0xffb28a, 16, 9)
      world.addShake(0.5)
      audio.play('scrape')
      break
    case 'clean':
      world.burst(event, 0x9ff3d4, 60, 20)
      world.addShake(0.9)
      audio.play('clean')
      break
    case 'win':
      world.addShake(1)
      audio.play('win')
      break
    case 'lose':
      world.addShake(1.2)
      audio.play('lose')
      break
    default:
      break
  }
}

function compassFor(game: Game): CompassState {
  if (game.phase !== 'playing' || game.transition || game.mode === 'docked') {
    return { angle: 0, label: '', danger: false, visible: false }
  }
  if (game.mode === 'surface') {
    const site = landerSite(game.planetId)
    const angle = wrapAngle(bearingTo(game.player, site) - game.player.facing)
    const distance = latLonDistance(game.player, site)
    return {
      angle,
      label: `LANDER ${distance.toFixed(0)}u`,
      danger: game.oxygen <= OXYGEN_WARN,
      visible: true,
    }
  }
  const carrying = holdCount(game) > 0 || game.junk.some(item => item.status === 'carried')
  const target = carrying ? game.issPos : game.earthPos
  const dx = target.x - game.ship.x
  const dz = target.z - game.ship.z
  return {
    angle: wrapAngle(Math.atan2(dx, dz) - game.ship.yaw),
    label: `${carrying ? 'ISS' : 'EARTH'} ${Math.hypot(dx, dz).toFixed(0)}u`,
    danger: false,
    visible: true,
  }
}

function currentContext(): string {
  if (game.phase !== 'playing' || game.transition) return ''
  if (game.mode === 'docked') return shopOpen ? 'DEPART' : 'SHOP'
  return contextLabel(game)
}

function contextReady(): boolean {
  if (game.phase !== 'playing' || game.transition) return false
  if (game.mode === 'docked') return true
  if (game.mode === 'space') return canDock(game) || canLand(game)
  return nearLander(game)
}

function syncPhase() {
  if (game.phase === lastPhase) return
  lastPhase = game.phase
  if (game.phase === 'finished') {
    const previous = best
    const isBest = game.score > previous
    if (isBest) {
      best = game.score
      saveBest(best)
    }
    shopOpen = false
    hud.showResults(game, Math.max(previous, game.score), isBest)
  } else if (game.phase === 'paused') {
    hud.showPause(game)
  } else if (game.phase === 'playing') {
    hud.hideOverlay()
  }
}

function syncMode() {
  if (game.mode === lastMode) return
  const previous = lastMode
  lastMode = game.mode
  fadeOut = game.mode === 'docked' ? 0.5 : 1
  if (game.mode === 'docked') {
    shopOpen = true
    hud.showShop(game)
  } else if (previous === 'docked') {
    shopOpen = false
    if (game.phase === 'playing') hud.hideOverlay()
  }
}

function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000))
  lastFrame = now

  if (game.phase === 'playing') {
    accumulator += dt
    let steps = 0
    const command = input.read()
    while (accumulator >= STEP && steps < 12) {
      step(game, STEP, command)
      accumulator -= STEP
      steps++
      if (game.phase !== 'playing') break
    }
    if (accumulator > 0.5) accumulator = 0
  }

  if (game.events.length > 0) {
    for (const event of game.events) handleEvent(event)
    game.events.length = 0
  }

  syncPhase()
  syncMode()

  const context = currentContext()
  world.update(game, dt)
  hud.update(game, context, compassFor(game))
  hud.setTouch(input.isTouch() && game.phase !== 'ready')
  input.setTouchLabels(
    game.mode === 'surface' ? 'HOP' : 'BOOST',
    context,
    contextReady(),
  )

  // transition fade: opaque across the mode switch, then a quick clear
  if (fadeEl) {
    if (game.transition) {
      const t = Math.min(1, game.transition.t / game.transition.duration)
      fadeEl.style.opacity = String(Math.pow(t, 1.5).toFixed(3))
    } else if (fadeOut > 0) {
      fadeOut = Math.max(0, fadeOut - dt / 0.55)
      fadeEl.style.opacity = String(fadeOut.toFixed(3))
    } else if (fadeEl.style.opacity !== '0') {
      fadeEl.style.opacity = '0'
    }
  }

  // ambient loops
  if (game.phase === 'playing' && game.mode === 'surface') {
    const carrying = game.junk.some(item => item.status === 'carried')
    audio.setLoop('vacuum', carrying ? 0.75 : 0.35)
    audio.setLoop('thruster', 0)
  } else if (game.phase === 'playing' && game.mode === 'space') {
    audio.setLoop('vacuum', 0)
    audio.setLoop('thruster', Math.max(0, game.ship.thrust) * (game.ship.boosting ? 1.3 : 0.65))
  } else {
    audio.setLoop('vacuum', 0)
    audio.setLoop('thruster', 0)
  }
}

window.addEventListener('resize', () => world.resize())
window.addEventListener('orientationchange', () => setTimeout(() => world.resize(), 200))
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.phase === 'playing') {
    game.phase = 'paused'
    hud.showPause(game)
    audio.setLoop('vacuum', 0)
    audio.setLoop('thruster', 0)
  }
})
window.addEventListener('pointerdown', () => audio.unlock(), { once: true })

try {
  if (localStorage.getItem(MUTE_KEY) === '1') audio.setMuted(true)
} catch {
  /* ignore */
}

// dev-only handle so browser playtests can inspect and drive the run
if (import.meta.env.DEV) {
  ;(window as unknown as { __solar: unknown }).__solar = {
    get game() {
      return game
    },
    newRun,
    toMenu,
    world,
    hud,
    audio,
    contextAction: onContext,
    buy: (id: string) => buyItem(game, id),
  }
}

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  world.setReducedMotion(true)
  world.setQuality(false)
}

hud.setMuted(audio.isMuted())
hud.showTitle(best)
hud.update(game, '', compassFor(game))
requestAnimationFrame(frame)
