import { CARRY_SLOTS, OXYGEN_WARN } from '../sim/config.ts'
import { RELICS, SHOP_ITEMS } from '../sim/economy.ts'
import {
  carrySlots, maxOxygen, progressSummary, rank, systemReport,
} from '../sim/game.ts'
import { planetById } from '../sim/planets.ts'
import type { Game, GameEvent, JunkClass } from '../sim/types.ts'

export interface HudCallbacks {
  /** brand new shift */
  start(): void
  /** pick the autosaved run back up */
  continueRun(): void
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

export interface RadarBlip {
  /** radians relative to the janitor's facing */
  bearing: number
  distance: number
  kind: 'junk' | 'lander' | 'iss' | 'planet'
  cls?: JunkClass
}

export interface RadarState {
  visible: boolean
  /** world radius the blips are plotted against, in surface units */
  range: number
  note: string
  blips: RadarBlip[]
}

export interface HazardHud {
  text: string
  level: 'warn' | 'danger' | ''
}

export interface HudFrame {
  game: Game
  context: string
  compass: CompassState
  radar: RadarState
  hazard: HazardHud
}

export interface Hud {
  update(frame: HudFrame): void
  pushEvent(event: GameEvent): void
  showTitle(best: number, saveInfo: string | null): void
  showPause(game: Game): void
  showResults(game: Game, best: number, isBest: boolean): void
  showShop(game: Game): void
  hideOverlay(): void
  setMuted(muted: boolean): void
  setTouch(enabled: boolean): void
  setLookHint(visible: boolean): void
  setPerf(text: string | null): void
  overlayVisible(): boolean
}

const MAX_SLOTS = 12
const RADAR_SIZE = 132

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

const SLOT_CLASS: Record<JunkClass, string> = {
  scrap: 'scrap', tech: 'tech', hazardous: 'hazardous', relic: 'relic',
}

const BLIP_COLOR: Record<string, string> = {
  scrap: '#d8b46a', tech: '#8fd3ff', hazardous: '#b6ff6a', relic: '#ffc24d',
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
  const compassEl = pick('compass')
  const compassArrow = pick('compass-arrow')
  const compassLabel = pick('compass-label')
  const hazardEl = pick('hazard')
  const systemEl = pick('system')
  const radarCanvas = pick<HTMLCanvasElement>('radar')
  const radarWrap = pick('radar-wrap')
  const radarNote = pick('radar-note')
  const lookHint = document.getElementById('look-hint')
  const perfEl = pick<HTMLPreElement>('perf')
  const muteButton = pick<HTMLButtonElement>('mute')
  const pauseButton = pick<HTMLButtonElement>('pause')

  const radarCtx = radarCanvas.getContext('2d')
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  radarCanvas.width = RADAR_SIZE * ratio
  radarCanvas.height = RADAR_SIZE * ratio

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
  let lastHazard = ''
  let lastSystem = ''
  let overlayUp = false

  function toastClass(event: GameEvent): string {
    if (event.kind === 'block' || event.kind === 'lose' || event.kind === 'meteor' || event.kind === 'scrape') return 'bad'
    if (event.kind === 'oxygen' || event.kind === 'takeoff' || event.kind === 'land' || event.kind === 'hint') return 'warn'
    if (event.kind === 'relic' || event.kind === 'clean' || event.kind === 'win') return 'great'
    return 'good'
  }

  function bindOverlay() {
    overlay.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
      element.addEventListener('click', () => {
        const action = element.dataset.action
        if (action === 'start') callbacks.start()
        else if (action === 'continue') callbacks.continueRun()
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
    overlayUp = true
    bindOverlay()
  }

  function relicToolsHtml(game: Game): string {
    if (game.relicTools.length === 0) {
      return `<p class="hint-line">No relic tools yet — every world hides one relic in its junk.</p>`
    }
    const chips = game.relicTools.map(tool => {
      const relic = RELICS.find(entry => entry.tool === tool)
      if (!relic) return ''
      return `<span class="chip" title="${escapeHtml(relic.effect)}">${escapeHtml(relic.toolName)}</span>`
    }).join('')
    return `<p class="hint-line">RELIC TOOLS ONLINE ${chips}</p>`
  }

  function shopHtml(game: Game): string {
    const groups: { kind: 'suit' | 'tool' | 'ship'; title: string }[] = [
      { kind: 'suit', title: 'SUIT' },
      { kind: 'tool', title: 'TOOLS' },
      { kind: 'ship', title: 'SHIP' },
    ]
    const sections = groups.map(group => {
      const cards = SHOP_ITEMS.filter(item => item.kind === group.kind).map(item => {
        const owned = game.upgrades.includes(item.id) && !item.repeatable
        const needs = item.requires && !game.upgrades.includes(item.requires)
        const affordable = game.credits >= item.cost
        const state = owned ? 'owned' : needs ? 'locked' : affordable ? 'ready' : 'poor'
        const note = owned ? 'INSTALLED'
          : needs ? `NEEDS ${(SHOP_ITEMS.find(entry => entry.id === item.requires)?.name ?? '').toUpperCase()}`
            : affordable ? 'BUY' : 'NEED CREDITS'
        return `<button class="shop-item ${state}" data-action="buy" data-id="${item.id}" ${state === 'owned' || state === 'locked' ? 'disabled' : ''}>
            <b>${escapeHtml(item.name)}</b>
            <span class="desc">${escapeHtml(item.description)}</span>
            <span class="cost">${note} · ${item.cost.toLocaleString()} cr</span>
          </button>`
      }).join('')
      return `<h3 class="shop-group">${group.title}</h3><div class="shop">${cards}</div>`
    }).join('')

    const summary = progressSummary(game)
    return `
      <div class="card wide">
        <h2>ISS MARKET</h2>
        <p class="dock-note">${game.credits.toLocaleString()} credits ·
          system swept ${summary.systemDelivered}/${summary.systemTotal} ·
          worlds cleaned ${summary.planetsCleaned}/${summary.planetCount}</p>
        <div class="shop-scroll">
          ${sections}
          ${relicToolsHtml(game)}
        </div>
        <div class="modes">
          <button class="btn" data-action="depart">DEPART (F)</button>
          <button class="btn ghost" data-action="close-shop">CLOSE</button>
        </div>
      </div>`
  }

  function drawRadar(radar: RadarState) {
    if (!radarCtx) return
    const size = RADAR_SIZE
    const centre = size / 2
    const radius = centre - 6
    radarCtx.setTransform(ratio, 0, 0, ratio, 0, 0)
    radarCtx.clearRect(0, 0, size, size)

    radarCtx.beginPath()
    radarCtx.arc(centre, centre, radius, 0, Math.PI * 2)
    radarCtx.fillStyle = 'rgba(6, 14, 26, 0.62)'
    radarCtx.fill()
    radarCtx.strokeStyle = 'rgba(140, 200, 255, 0.35)'
    radarCtx.lineWidth = 1.4
    radarCtx.stroke()

    radarCtx.beginPath()
    radarCtx.arc(centre, centre, radius * 0.5, 0, Math.PI * 2)
    radarCtx.strokeStyle = 'rgba(140, 200, 255, 0.16)'
    radarCtx.lineWidth = 1
    radarCtx.stroke()

    radarCtx.beginPath()
    radarCtx.moveTo(centre, 4)
    radarCtx.lineTo(centre, size - 4)
    radarCtx.moveTo(4, centre)
    radarCtx.lineTo(size - 4, centre)
    radarCtx.strokeStyle = 'rgba(140, 200, 255, 0.12)'
    radarCtx.stroke()

    for (const blip of radar.blips) {
      const t = Math.min(1, blip.distance / Math.max(1, radar.range))
      // blips arrive as compass-relative bearings; the rendered world is
      // mirror-handed, so the horizontal axis is flipped to match the screen
      const x = centre - Math.sin(blip.bearing) * t * radius
      const y = centre - Math.cos(blip.bearing) * t * radius
      radarCtx.beginPath()
      if (blip.kind === 'lander') {
        radarCtx.fillStyle = '#7ee0a8'
        radarCtx.moveTo(x, y - 5)
        radarCtx.lineTo(x + 4.4, y + 3.6)
        radarCtx.lineTo(x - 4.4, y + 3.6)
        radarCtx.closePath()
        radarCtx.fill()
        continue
      }
      const color = BLIP_COLOR[blip.cls ?? 'scrap'] ?? '#d8b46a'
      radarCtx.fillStyle = color
      const dot = blip.cls === 'relic' ? 4.2 : 2.6
      radarCtx.arc(x, y, dot, 0, Math.PI * 2)
      radarCtx.fill()
      if (blip.cls === 'relic') {
        radarCtx.strokeStyle = 'rgba(255, 220, 130, 0.9)'
        radarCtx.lineWidth = 1.2
        radarCtx.stroke()
      }
    }

    // the janitor: a small chevron at the centre pointing up (the radar is facing-relative)
    radarCtx.beginPath()
    radarCtx.fillStyle = '#e9f3ff'
    radarCtx.moveTo(centre, centre - 6)
    radarCtx.lineTo(centre + 4, centre + 4)
    radarCtx.lineTo(centre - 4, centre + 4)
    radarCtx.closePath()
    radarCtx.fill()
  }

  return {
    update(frame) {
      const { game, compass, radar, hazard } = frame
      hud.classList.toggle('hidden', game.phase === 'ready')
      hud.setAttribute('aria-hidden', game.phase === 'ready' ? 'true' : 'false')

      const summary = progressSummary(game)
      const planet = planetById(game.planetId)

      if (game.credits !== lastCredits) {
        lastCredits = game.credits
        creditsEl.textContent = game.credits.toLocaleString()
      }
      scoreEl.textContent = game.score.toLocaleString()
      placeEl.textContent = game.mode === 'surface' ? planet.name.toUpperCase() : 'ORBIT'
      noteEl.textContent = game.transition
        ? (game.transition.kind === 'takeoff' ? 'LIFTING OFF' : 'DESCENDING')
        : `${summary.systemDelivered}/${summary.systemTotal} swept · ${summary.planetsCleaned}/${summary.planetCount} worlds`

      const oxygen = game.oxygen / maxOxygen(game)
      oxygenFill.style.width = `${Math.max(0, Math.min(1, oxygen)) * 100}%`
      oxygenFill.classList.toggle('low', game.oxygen <= OXYGEN_WARN)
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
          slots[i].className = `slot${cls ? ` ${SLOT_CLASS[cls]}` : ''}`
          slots[i].style.display = i < cap ? '' : 'none'
        }
      }
      if (summary.hold !== lastHold) {
        lastHold = summary.hold
        holdEl.textContent = `HOLD ${summary.hold}/${summary.holdCap}`
        holdEl.classList.toggle('full', summary.hold >= summary.holdCap)
      }

      if (frame.context !== lastPrompt) {
        lastPrompt = frame.context
        if (frame.context) {
          promptEl.innerHTML = `<kbd>F</kbd> ${escapeHtml(frame.context)}`
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

      radarWrap.classList.toggle('hidden', !radar.visible)
      if (radar.visible) {
        drawRadar(radar)
        if (radarNote.textContent !== radar.note) radarNote.textContent = radar.note
      }

      if (hazard.text !== lastHazard) {
        lastHazard = hazard.text
        hazardEl.textContent = hazard.text
        hazardEl.classList.toggle('hidden', hazard.text === '')
        hazardEl.classList.toggle('danger', hazard.level === 'danger')
        hazardEl.classList.toggle('warn', hazard.level === 'warn')
      }

      const report = systemReport(game)
      const systemText = report
        ? report.map(entry => `${entry.name.toUpperCase()} ${entry.total - entry.remaining}/${entry.total}`).join(' · ')
        : ''
      if (systemText !== lastSystem) {
        lastSystem = systemText
        systemEl.textContent = systemText
        systemEl.classList.toggle('hidden', systemText === '')
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

    showTitle(best, saveInfo) {
      showOverlay(`
        <div class="card">
          <h1 class="title">SOLAR SYSTEM JANITOR</h1>
          <p class="subtitle">The last janitor of Sol. Sweep the junk off Earth, the Moon and Mars,
            haul it up to the ISS before your oxygen runs out, and spend the credits on gear.</p>
          <div class="modes">
            ${saveInfo ? '<button class="btn" data-action="continue">CONTINUE</button>' : ''}
            <button class="btn ${saveInfo ? 'ghost' : ''}" data-action="start">NEW SHIFT</button>
          </div>
          ${saveInfo ? `<p class="save-note">${escapeHtml(saveInfo)}</p>` : ''}
          <p class="best">${best > 0 ? `BEST ${best.toLocaleString()}` : 'NO SHIFTS LOGGED YET'}</p>
          <div class="howto">
            <div><b>ON FOOT</b>the camera rides behind you - steer with the mouse ·
              <kbd>W</kbd>/<kbd>↑</kbd> walks forward · <kbd>S</kbd>/<kbd>↓</kbd> back ·
              <kbd>A</kbd>/<kbd>D</kbd>/<kbd>←</kbd>/<kbd>→</kbd> side-step · <kbd>Shift</kbd> sprint</div>
            <div><b>VACUUM</b>walk near junk to suck it up - up to ${CARRY_SLOTS} pieces</div>
            <div><b>LANDER</b>stand in the ring to refill O<sub>2</sub> · <kbd>F</kbd> stows your haul or lifts off</div>
            <div><b>FLY</b>the mouse is your pointer — the nose follows it ·
              <kbd>W</kbd>/<kbd>S</kbd>/<kbd>↑</kbd>/<kbd>↓</kbd> thrust · <kbd>←</kbd>/<kbd>→</kbd> strafe ·
              <kbd>A</kbd>/<kbd>D</kbd> roll · near a world the tug coasts on its pull, so slow down and you orbit it
            </div>
            <div><b>DOCK</b>fly to the ISS and press <kbd>F</kbd> to deliver, shop and gear up</div>
            <div><b>LAND</b>fly to a planet, slow down and press <kbd>F</kbd> to land</div>
            <div><b>HAZARDS</b>Moon meteor showers · Mars dust storms · watch the warnings</div>
          </div>
          <p class="subtitle small">Sweep all three worlds to restore the system. Relics hidden in the junk
            unlock tools. <kbd>P</kbd> pauses, <kbd>M</kbd> mutes.</p>
        </div>`)
    },

    showPause(game) {
      const summary = progressSummary(game)
      showOverlay(`
        <div class="card">
          <h2>PAUSED</h2>
          <p>${summary.systemDelivered}/${summary.systemTotal} junk delivered ·
            ${summary.planetsCleaned}/${summary.planetCount} worlds cleaned ·
            ${game.credits.toLocaleString()} credits ·
            ${game.mode === 'surface' ? `on ${summary.planetName.toLowerCase()}` : game.mode === 'docked' ? 'docked at the ISS' : 'in orbit'}</p>
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
          <p class="rank ${rank(game).toLowerCase()}">${rank(game)}</p>
          <div class="stats">
            <div class="stat"><b>${game.score.toLocaleString()}</b><span>SCORE</span></div>
            <div class="stat"><b>${summary.planetsCleaned}/${summary.planetCount}</b><span>WORLDS CLEANED</span></div>
            <div class="stat"><b>${summary.systemDelivered}/${summary.systemTotal}</b><span>JUNK DELIVERED</span></div>
            <div class="stat"><b>${game.bestBatch}</b><span>BEST BATCH</span></div>
            <div class="stat"><b>${game.credits.toLocaleString()}</b><span>CREDITS</span></div>
            <div class="stat"><b>${game.trips}</b><span>ISS TRIPS</span></div>
            <div class="stat"><b>${game.upgrades.length}</b><span>UPGRADES</span></div>
            <div class="stat"><b>${game.relicTools.length}/${RELICS.length}</b><span>RELIC TOOLS</span></div>
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
      overlayUp = false
      hud.setAttribute('aria-hidden', 'false')
    },

    setMuted(muted) {
      muteButton.textContent = muted ? 'MUTED' : 'SOUND'
    },

    setTouch(enabled) {
      pick('touch').classList.toggle('hidden', !enabled)
    },

    setLookHint(visible) {
      lookHint?.classList.toggle('hidden', !visible)
    },

    setPerf(text) {
      perfEl.textContent = text ?? ''
      perfEl.classList.toggle('hidden', text === null)
    },

    overlayVisible() {
      return overlayUp
    },
  }
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
