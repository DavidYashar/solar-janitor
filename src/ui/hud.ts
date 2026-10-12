import { CARRY_SLOTS } from '../sim/config.ts'
import { carrySlots, maxOxygen, progressSummary, rank } from '../sim/game.ts'
import { SHOP_ITEMS } from '../sim/economy.ts'
import { planetById } from '../sim/planets.ts'
import type { Game, GameEvent, JunkClass } from '../sim/types.ts'

export interface HudCallbacks {
  start(): void
  resume(): void
  restart(): void
  quit(): void
  togglePause(): void
  toggleMute(): void
  buy(id: string): void
  depart(): void
  closeShop(): void
}

export interface CompassState {
  /** radians, 0 = straight ahead */
  angle: number
  label: string
  danger: boolean
  visible: boolean
}

export interface Hud {
  update(game: Game, context: string, compass: CompassState): void
  pushEvent(event: GameEvent): void
  showTitle(best: number): void
  showPause(game: Game): void
  showResults(game: Game, best: number, isBest: boolean): void
  showShop(game: Game): void
  hideOverlay(): void
  setMuted(muted: boolean): void
  setTouch(enabled: boolean): void
  overlayVisible(): boolean
}

const MAX_SLOTS = 12

function pick<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing HUD element #${id}`)
  return element as T
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char
  ))
}

export function createHud(callbacks: HudCallbacks): Hud {
  const hud = pick('hud')
  const overlay = pick('overlay')
  const creditsEl = pick('credits')
  const placeEl = pick('place')
  const noteEl = pick('progress-note')
  const scoreEl = pick('score')
  const oxygenFill = pick('oxygen-fill')
  const healthFill = pick('health-fill')
  const carryEl = pick('carry')
  const holdEl = pick('hold')
  const promptEl = pick('prompt')
  const toastsEl = pick('toasts')
  const touchEl = pick('touch')
  const compassEl = pick('compass')
  const compassArrow = pick('compass-arrow')
  const compassLabel = pick('compass-label')
  const muteButton = pick<HTMLButtonElement>('mute')
  const pauseButton = pick<HTMLButtonElement>('pause')

  muteButton.addEventListener('click', () => callbacks.toggleMute())
  pauseButton.addEventListener('click', () => callbacks.togglePause())

  const slots: HTMLElement[] = []
  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = document.createElement('i')
    slot.className = 'slot'
    carryEl.appendChild(slot)
    slots.push(slot)
  }

  let lastCredits = -1
  let lastCarry = -1
  let lastHold = -1
  let lastPrompt = ''

  function toastClass(event: GameEvent): string {
    if (event.kind === 'block' || event.kind === 'lose' || event.kind === 'scrape') return 'bad'
    if (event.kind === 'oxygen' || event.kind === 'takeoff' || event.kind === 'land') return 'warn'
    return 'good'
  }

  function bindOverlay() {
    overlay.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
      element.addEventListener('click', () => {
        const action = element.dataset.action
        if (action === 'start') callbacks.start()
        else if (action === 'resume') callbacks.resume()
        else if (action === 'restart') callbacks.restart()
        else if (action === 'quit') callbacks.quit()
        else if (action === 'buy' && element.dataset.id) callbacks.buy(element.dataset.id)
        else if (action === 'depart') callbacks.depart()
        else if (action === 'close-shop') callbacks.closeShop()
      })
    })
  }

  function showOverlay(html: string) {
    overlay.innerHTML = html
    overlay.classList.remove('hidden')
    hud.setAttribute('aria-hidden', 'true')
    bindOverlay()
  }

  function shopHtml(game: Game): string {
    const cards = SHOP_ITEMS.map(item => {
      const owned = game.upgrades.includes(item.id)
      const affordable = game.credits >= item.cost
      const state = owned && !item.repeatable ? 'owned' : affordable ? 'ready' : 'poor'
      const note = owned && !item.repeatable ? 'INSTALLED' : affordable ? 'BUY' : 'NEED CREDITS'
      return `<button class="shop-item ${state}" data-action="buy" data-id="${item.id}" ${state === 'owned' ? 'disabled' : ''}>
          <span class="kind">${item.kind.toUpperCase()}</span>
          <b>${item.name}</b>
          <span class="desc">${item.description}</span>
          <span class="cost">${note} · ${item.cost.toLocaleString()} cr</span>
        </button>`
    }).join('')
    const summary = progressSummary(game)
    return `
      <div class="card wide">
        <h2>ISS MARKET</h2>
        <p class="dock-note">Hold delivered · ${game.credits.toLocaleString()} credits ·
          ${summary.delivered}/${summary.total} of Earth's junk cleared</p>
        <div class="shop">${cards}</div>
        <div class="modes">
          <button class="btn" data-action="depart">DEPART (F)</button>
          <button class="btn ghost" data-action="close-shop">CLOSE</button>
        </div>
      </div>`
  }

  return {
    update(game, context, compass) {
      hud.classList.toggle('hidden', game.phase === 'ready')
      hud.setAttribute('aria-hidden', game.phase === 'ready' ? 'true' : 'false')

      const summary = progressSummary(game)
      const planet = planetById(game.planetId)

      if (game.credits !== lastCredits) {
        lastCredits = game.credits
        creditsEl.textContent = game.credits.toLocaleString()
      }
      scoreEl.textContent = game.score.toLocaleString()
      placeEl.textContent = game.mode === 'space' || game.mode === 'docked' ? 'ORBIT' : planet.name.toUpperCase()
      noteEl.textContent = game.transition
        ? (game.transition.kind === 'takeoff' ? 'LIFTING OFF' : 'DESCENDING')
        : `${summary.delivered}/${summary.total} cleared`

      const oxygen = game.oxygen / maxOxygen(game)
      oxygenFill.style.width = `${Math.max(0, Math.min(1, oxygen)) * 100}%`
      oxygenFill.classList.toggle('low', game.oxygen <= 30)
      const health = game.health / 100
      healthFill.style.width = `${Math.max(0, health) * 100}%`
      healthFill.classList.toggle('low', health < 0.35)

      if (summary.carry !== lastCarry || summary.carryCap !== slots.length) {
        lastCarry = summary.carry
        const held: JunkClass[] = []
        for (const item of game.junk) if (item.status === 'carried') held.push(item.cls)
        const cap = carrySlots(game)
        for (let i = 0; i < slots.length; i++) {
          const cls = held[i]
          slots[i].className = `slot${cls ? ` ${cls}` : ''}`
          slots[i].style.display = i < cap ? '' : 'none'
        }
      }
      if (summary.hold !== lastHold) {
        lastHold = summary.hold
        holdEl.textContent = `HOLD ${summary.hold}/${summary.holdCap}`
        holdEl.classList.toggle('full', summary.hold >= summary.holdCap)
      }

      if (context !== lastPrompt) {
        lastPrompt = context
        if (context) {
          promptEl.innerHTML = `<kbd>F</kbd> ${escapeHtml(context)}`
          promptEl.classList.remove('hidden')
        } else {
          promptEl.classList.add('hidden')
        }
      }

      compassEl.classList.toggle('hidden', !compass.visible)
      if (compass.visible) {
        compassArrow.style.transform = `rotate(${(compass.angle * 180) / Math.PI}deg)`
        compassLabel.textContent = compass.label
        compassEl.classList.toggle('danger', compass.danger)
      }
    },

    pushEvent(event) {
      if (!event.text) return
      const toast = document.createElement('div')
      toast.className = `toast ${toastClass(event)}`
      const amount = event.kind === 'deliver' || event.kind === 'clean'
        ? ` · +${event.amount.toLocaleString()}`
        : ''
      toast.textContent = `${event.text}${amount}`
      toastsEl.appendChild(toast)
      while (toastsEl.children.length > 5) toastsEl.removeChild(toastsEl.children[0])
      setTimeout(() => toast.classList.add('fade'), 1500)
      setTimeout(() => toast.remove(), 2100)
    },

    showTitle(best) {
      showOverlay(`
        <div class="card">
          <h1 class="title">SOLAR JANITOR</h1>
          <p class="subtitle">The last janitor of Sol. Sweep the junk off Earth, haul it up to the ISS
            before your oxygen runs out, and spend the credits on gear.</p>
          <div class="modes">
            <button class="btn" data-action="start">START SHIFT</button>
          </div>
          <p class="best">${best > 0 ? `BEST ${best.toLocaleString()}` : 'NO SHIFTS LOGGED YET'}</p>
          <div class="howto">
            <div><b>MOVE</b><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk the whole planet · <kbd>Shift</kbd> sprint</div>
            <div><b>HOP</b><kbd>Space</kbd> low-gravity hop over rocks and junk</div>
            <div><b>VACUUM</b>walk near junk to suck it up - up to ${CARRY_SLOTS} pieces</div>
            <div><b>LANDER</b>stand in the green ring to refill O<sub>2</sub>, press <kbd>F</kbd> to stow your haul</div>
            <div><b>FLY</b><kbd>W</kbd><kbd>S</kbd> thrust · <kbd>A</kbd><kbd>D</kbd> yaw · <kbd>Shift</kbd> boost</div>
            <div><b>DOCK</b>fly to the ISS and press <kbd>F</kbd> to deliver, shop and refuel</div>
            <div><b>LAND</b>fly back to Earth, slow down and press <kbd>F</kbd> to land</div>
          </div>
          <p class="subtitle small">Clear all of Earth's junk to restore the system. <kbd>P</kbd> pauses, <kbd>M</kbd> mutes.</p>
        </div>`)
    },

    showPause(game) {
      const summary = progressSummary(game)
      showOverlay(`
        <div class="card">
          <h2>PAUSED</h2>
          <p>${summary.delivered}/${summary.total} junk delivered · ${game.credits.toLocaleString()} credits ·
            ${game.mode === 'surface' ? 'on the surface' : game.mode === 'docked' ? 'docked at the ISS' : 'in orbit'}</p>
          <div class="modes">
            <button class="btn" data-action="resume">RESUME</button>
            <button class="btn ghost" data-action="restart">RESTART RUN</button>
            <button class="btn ghost" data-action="quit">MAIN MENU</button>
          </div>
        </div>`)
    },

    showResults(game, best, isBest) {
      const summary = progressSummary(game)
      const won = game.outcome === 'won'
      showOverlay(`
        <div class="card">
          <h2>${won ? 'SYSTEM RESTORED' : 'SHIFT OVER'}</h2>
          <p class="rank ${won ? 'saved' : 'lost'}">${rank(game)}</p>
          <div class="stats">
            <div class="stat"><b>${game.score.toLocaleString()}</b><span>SCORE</span></div>
            <div class="stat"><b>${game.credits.toLocaleString()}</b><span>CREDITS</span></div>
            <div class="stat"><b>${summary.delivered}/${summary.total}</b><span>JUNK CLEARED</span></div>
            <div class="stat"><b>${game.bestBatch}</b><span>BEST BATCH</span></div>
            <div class="stat"><b>${game.trips}</b><span>ISS TRIPS</span></div>
            <div class="stat"><b>${game.upgrades.length}</b><span>UPGRADES</span></div>
            <div class="stat"><b>${formatTime(game.time)}</b><span>SHIFT TIME</span></div>
            <div class="stat"><b>${game.rescued ? 'YES' : 'NO'}</b><span>BEACON USED</span></div>
          </div>
          <p class="best">${isBest ? 'NEW PERSONAL BEST' : `BEST ${best.toLocaleString()}`}</p>
          <div class="modes">
            <button class="btn" data-action="restart">RUN IT AGAIN</button>
            <button class="btn ghost" data-action="quit">MAIN MENU</button>
          </div>
        </div>`)
    },

    showShop(game) {
      showOverlay(shopHtml(game))
    },

    hideOverlay() {
      overlay.classList.add('hidden')
      overlay.innerHTML = ''
      hud.setAttribute('aria-hidden', 'false')
    },

    setMuted(muted) {
      muteButton.textContent = muted ? 'MUTED' : 'SOUND'
      muteButton.classList.toggle('off', muted)
    },

    setTouch(enabled) {
      touchEl.classList.toggle('hidden', !enabled)
    },

    overlayVisible() {
      return !overlay.classList.contains('hidden')
    },
  }
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
