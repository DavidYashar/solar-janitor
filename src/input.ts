import { SHIP_PITCH_RATE, SHIP_YAW_RATE } from './sim/config.ts'
import type { Input } from './sim/types.ts'

export interface InputActions {
  context(): void
  confirm(): void
  togglePause(): void
  toggleMute(): void
  boost(): void
  /** pointer lock engaged or released */
  lookActive(active: boolean): void
}

export interface TouchLabels {
  hop: string
  action: string
  actionReady: boolean
  /** show the roll paddles (only needed while flying) */
  roll: boolean
}

export interface InputSource {
  /** dt is the real frame time: pointer-lock deltas become rotation rates */
  read(dt: number): Input
  isTouch(): boolean
  /** mouse look only makes sense while flying */
  setMouseLook(enabled: boolean): void
  setTouchLabels(labels: TouchLabels): void
  dispose(): void
}

/** radians of ship rotation per pixel of pointer movement */
const MOUSE_SENSITIVITY = 0.0028
/** a finger drag is shorter than a mouse swipe, so it gets a bonus */
const TOUCH_LOOK_GAIN = 2.4

export function createInput(actions: InputActions): InputSource {
  const held = new Set<string>()
  let touchActive = false
  let stickX = 0
  let stickY = 0
  let hopHeld = false
  let touchRoll = 0
  let boostQueued = false
  let mouseDx = 0
  let mouseDy = 0
  let mouseLook = false

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
    mouseDx = 0
    mouseDy = 0
    setKnob(0, 0)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  // -------------------------------------------------------------- mouse look
  const scene = document.getElementById('scene')

  function pointerLocked(): boolean {
    return document.pointerLockElement === scene?.querySelector('canvas') || !!document.pointerLockElement
  }

  scene?.addEventListener('pointerdown', event => {
    if (!mouseLook || event.pointerType === 'touch') return
    if (pointerLocked()) return
    const canvas = scene.querySelector('canvas')
    if (canvas && 'requestPointerLock' in canvas) {
      void (canvas as HTMLCanvasElement).requestPointerLock()
    }
  })

  function onPointerMove(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    if (!mouseLook || !pointerLocked()) return
    mouseDx += event.movementX ?? 0
    mouseDy += event.movementY ?? 0
  }
  window.addEventListener('pointermove', onPointerMove)

  document.addEventListener('pointerlockchange', () => {
    actions.lookActive(pointerLocked())
    if (!pointerLocked()) window.removeEventListener('pointermove', onPointerMove)
    else window.addEventListener('pointermove', onPointerMove)
  })

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
    mouseDx += (event.clientX - lookX) * TOUCH_LOOK_GAIN
    mouseDy += (event.clientY - lookY) * TOUCH_LOOK_GAIN
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

  return {
    read(dt) {
      const dtSafe = Math.max(0.008, Math.min(0.1, dt))
      // The rendered world is mirror-handed: the sim's "east" appears on the
      // left of the screen, so the strafe axis is negated to make D move the
      // janitor toward the screen's right (roll and yaw are unaffected).
      let x = down('KeyA') - down('KeyD') + down('ArrowLeft') - down('ArrowRight')
      let y = down('KeyW') - down('KeyS') + down('ArrowUp') - down('ArrowDown')
      if (Math.abs(stickX) > 0.12 || Math.abs(stickY) > 0.12) {
        x = -stickX
        y = stickY
      }

      // pointer movement becomes an angular rate so one frame of input applies
      // exactly the rotation the player asked for
      let pitch = down('ArrowUp') - down('ArrowDown')
      let yaw = down('ArrowRight') - down('ArrowLeft')
      if (mouseDx !== 0 || mouseDy !== 0) {
        yaw += (mouseDx * MOUSE_SENSITIVITY) / (SHIP_YAW_RATE * dtSafe)
        pitch += (-mouseDy * MOUSE_SENSITIVITY) / (SHIP_PITCH_RATE * dtSafe)
        mouseDx = 0
        mouseDy = 0
      }

      const roll = down('KeyD') - down('KeyA') + touchRoll
      const boost = boostQueued || held.has('ShiftLeft') || held.has('ShiftRight')
      const hop = hopHeld || held.has('Space')
      boostQueued = false

      return {
        x: clampInput(x),
        y: clampInput(y),
        pitch: clampInput(pitch),
        yaw: clampInput(yaw),
        roll: clampInput(roll),
        boost,
        hop,
      }
    },
    isTouch() {
      return touchActive
    },
    setMouseLook(enabled) {
      mouseLook = enabled
      if (!enabled) {
        mouseDx = 0
        mouseDy = 0
        if (pointerLocked()) document.exitPointerLock()
      }
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
