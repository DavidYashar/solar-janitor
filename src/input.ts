import { screenMoveVector } from './sim/game.ts'
import type { Input } from './sim/types.ts'

export interface InputActions {
  context(): void
  confirm(): void
  togglePause(): void
  toggleMute(): void
  boost(): void
}

export interface InputContext {
  mode: 'surface' | 'space' | 'docked'
  /** the janitor's current facing in sim-world radians */
  facing: number
}

export interface TouchLabels {
  hop: string
  action: string
  actionReady: boolean
  /** show the roll paddles (only needed while flying) */
  roll: boolean
}

export interface InputSource {
  read(ctx: InputContext): Input
  isTouch(): boolean
  setTouchLabels(labels: TouchLabels): void
  dispose(): void
}

/** aim deadzone: below this fraction of the viewport the pointer keeps its heading */
const AIM_DEAD = 0.08
/** aim offset that commands the full steering rate */
const AIM_FULL = 0.45
/** ground steering: dead in the middle of the screen, full lock out wide */
const STEER_DEAD = 0.12
const STEER_FULL = 0.6
/** units of aim per pixel of look-pad drag (touch) */
const PAD_LOOK_GAIN = 0.006

export function createInput(actions: InputActions): InputSource {
  const held = new Set<string>()
  let touchActive = false
  let stickX = 0
  let stickY = 0
  let hopHeld = false
  let touchRoll = 0
  let boostQueued = false
  /** pointer aim, -1..1: +x = screen-right, +y = screen-up */
  let aimX = 0
  let aimY = 0

  function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null
    if (!element || !element.tagName) return false
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.repeat) {
      if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault()
      return
    }
    const code = event.code
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(code)) {
      event.preventDefault()
    }
    if (isTypingTarget(event.target)) return
    held.add(code)

    if (code === 'Space' || code === 'Enter') {
      actions.confirm()
      return
    }
    if (code === 'KeyF') {
      actions.context()
      return
    }
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      boostQueued = true
      actions.boost()
      return
    }
    if (code === 'KeyP' || code === 'Escape') {
      actions.togglePause()
      return
    }
    if (code === 'KeyM') actions.toggleMute()
  }

  function onKeyUp(event: KeyboardEvent) {
    held.delete(event.code)
  }

  function onBlur() {
    held.clear()
    hopHeld = false
    touchRoll = 0
    stickX = 0
    stickY = 0
    setKnob(0, 0)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  // ------------------------------------------------------------- pointer aim
  // The mouse is the pointer: its screen position sets the aim direction.
  // The janitor faces it, the ship steers toward it, and the arrow keys move
  // left/right and front/back relative to it. No pointer lock — the cursor
  // stays visible so the player always sees where they are pointing.
  function onPointerMove(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    aimX = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth) * 2 - 1))
    aimY = Math.max(-1, Math.min(1, 1 - (event.clientY / window.innerHeight) * 2))
  }
  window.addEventListener('pointermove', onPointerMove)

  // ------------------------------------------------------------------ touch
  const stick = document.getElementById('stick')
  const knob = document.getElementById('stick-knob')
  const hopButton = document.getElementById('touch-hop')
  const actButton = document.getElementById('touch-act')
  const rollLeft = document.getElementById('roll-left')
  const rollRight = document.getElementById('roll-right')
  const lookPad = document.getElementById('touch-look')
  let pointerId = -1
  let lookPointerId = -1

  function setKnob(x: number, y: number) {
    if (knob) knob.style.transform = `translate(${x * 30}px, ${-y * 30}px)`
  }

  function onPointerDown(event: PointerEvent) {
    if (!stick) return
    touchActive = true
    pointerId = event.pointerId
    stick.setPointerCapture(event.pointerId)
    onStickMove(event)
  }

  function onStickMove(event: PointerEvent) {
    if (!stick || event.pointerId !== pointerId) return
    const rect = stick.getBoundingClientRect()
    const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)
    const dy = ((rect.top + rect.height / 2) - event.clientY) / (rect.height / 2)
    const length = Math.hypot(dx, dy)
    const scale = length > 1 ? 1 / length : 1
    stickX = dx * scale
    stickY = dy * scale
    setKnob(stickX, stickY)
  }

  function onStickUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    pointerId = -1
    stickX = 0
    stickY = 0
    setKnob(0, 0)
  }

  stick?.addEventListener('pointerdown', onPointerDown)
  stick?.addEventListener('pointermove', onStickMove)
  stick?.addEventListener('pointerup', onStickUp)
  stick?.addEventListener('pointercancel', onStickUp)

  // right-hand drag: pitch and yaw, exactly like pointer-lock mouse look
  let lookX = 0
  let lookY = 0

  lookPad?.addEventListener('pointerdown', event => {
    event.preventDefault()
    touchActive = true
    lookPointerId = event.pointerId
    lookPad.setPointerCapture(event.pointerId)
    lookX = event.clientX
    lookY = event.clientY
  })
  lookPad?.addEventListener('pointermove', event => {
    if (event.pointerId !== lookPointerId) return
    aimX = Math.max(-1, Math.min(1, aimX + (event.clientX - lookX) * PAD_LOOK_GAIN))
    aimY = Math.max(-1, Math.min(1, aimY + (lookY - event.clientY) * PAD_LOOK_GAIN))
    lookX = event.clientX
    lookY = event.clientY
  })
  const releaseLook = (event: PointerEvent) => {
    if (event.pointerId !== lookPointerId) return
    lookPointerId = -1
  }
  lookPad?.addEventListener('pointerup', releaseLook)
  lookPad?.addEventListener('pointercancel', releaseLook)

  function bindHold(
    element: HTMLElement | null, code: string, onDown: () => void, onUp: () => void,
  ) {
    if (!element) return
    element.addEventListener('pointerdown', event => {
      event.preventDefault()
      touchActive = true
      element.setPointerCapture(event.pointerId)
      onDown()
      // keyboard state keeps the two paths identical while the button is held
      held.add(code)
    })
    const release = (event: PointerEvent) => {
      event.preventDefault()
      held.delete(code)
      onUp()
    }
    element.addEventListener('pointerup', release)
    element.addEventListener('pointercancel', release)
    element.addEventListener('lostpointercapture', () => {
      held.delete(code)
      onUp()
    })
  }

  bindHold(hopButton, 'Space', () => {
    hopHeld = true
    touchActive = true
  }, () => {
    hopHeld = false
  })

  bindHold(rollLeft, 'TouchRollLeft', () => {
    touchRoll -= 1
  }, () => {
    touchRoll += 1
  })

  bindHold(rollRight, 'TouchRollRight', () => {
    touchRoll += 1
  }, () => {
    touchRoll -= 1
  })

  actButton?.addEventListener('pointerdown', event => {
    event.preventDefault()
    touchActive = true
    actions.context()
  })

  window.addEventListener('touchstart', () => { touchActive = true }, { passive: true, once: true })

  const down = (code: string) => (held.has(code) ? 1 : 0)
  const clampInput = (value: number) => Math.max(-1, Math.min(1, value))

  /** Pointer offset -> steering rate: dead in the middle, full lock out wide. */
  const steer = (value: number) => {
    const magnitude = Math.abs(value)
    if (magnitude <= STEER_DEAD) return 0
    return Math.sign(value) * Math.min(1, (magnitude - STEER_DEAD) / (STEER_FULL - STEER_DEAD))
  }

  return {
    read(ctx) {
      const boost = boostQueued || held.has('ShiftLeft') || held.has('ShiftRight')
      const hop = hopHeld || held.has('Space')
      boostQueued = false

      // pointer heading in screen radians: 0 = straight up, + clockwise
      if (ctx.mode === 'surface') {
        // the janitor walks where he faces; the pointer only steers (chase cam),
        // so screen input is rotated into his frame rather than the pointer's
        const screenX = down('KeyD') - down('KeyA') + down('ArrowRight') - down('ArrowLeft') + stickX
        const screenY = down('KeyW') - down('KeyS') + down('ArrowUp') - down('ArrowDown') + stickY
        const move = screenMoveVector(-ctx.facing, screenX, screenY)
        return { x: move.x, y: move.y, turn: steer(aimX), pitch: 0, yaw: 0, roll: 0, boost, hop }
      }

      // space: the pointer steers the nose, the arrows fly and side-step
      const ramp = (value: number) => {
        const magnitude = Math.abs(value)
        if (magnitude <= AIM_DEAD) return 0
        return Math.sign(value) * Math.min(1, (magnitude - AIM_DEAD) / (AIM_FULL - AIM_DEAD))
      }
      const thrust = down('KeyW') - down('KeyS') + down('ArrowUp') - down('ArrowDown') + stickY
      const strafe = down('ArrowRight') - down('ArrowLeft') + stickX
      const roll = down('KeyD') - down('KeyA') + touchRoll
      return {
        x: clampInput(strafe),
        y: clampInput(thrust),
        pitch: ramp(aimY),
        yaw: ramp(aimX),
        roll: clampInput(roll),
        boost,
        hop,
      }
    },
    isTouch() {
      return touchActive
    },
    setTouchLabels(labels) {
      if (hopButton) {
        hopButton.textContent = labels.hop
        hopButton.classList.toggle('hidden', labels.hop === '')
      }
      if (actButton) {
        actButton.textContent = labels.action
        actButton.classList.toggle('ready', labels.actionReady)
        actButton.classList.toggle('hidden', labels.action === '')
      }
      for (const button of [rollLeft, rollRight]) {
        button?.classList.toggle('hidden', !labels.roll)
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointermove', onPointerMove)
    },
  }
}
