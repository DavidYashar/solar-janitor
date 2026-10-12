import type { Input } from './sim/types.ts'

export interface InputActions {
  context(): void
  confirm(): void
  togglePause(): void
  toggleMute(): void
  boost(): void
}

export interface InputSource {
  read(): Input
  isTouch(): boolean
  /** drive the touch buttons' labels from the current situation */
  setTouchLabels(hop: string, action: string, actionReady: boolean): void
  dispose(): void
}

export function createInput(actions: InputActions): InputSource {
  const held = new Set<string>()
  let touchActive = false
  let stickX = 0
  let stickY = 0
  let hopHeld = false
  let boostQueued = false

  function onKeyDown(event: KeyboardEvent) {
    if (event.repeat) {
      if (event.code === 'Space') event.preventDefault()
      return
    }
    const code = event.code
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(code)) event.preventDefault()
    held.add(code)

    if (code === 'Space' || code === 'Enter') {
      actions.confirm()
      return
    }
    if (code === 'KeyF') { actions.context(); return }
    if (code === 'ShiftLeft' || code === 'ShiftRight') { boostQueued = true; actions.boost(); return }
    if (code === 'KeyP' || code === 'Escape') { actions.togglePause(); return }
    if (code === 'KeyM') actions.toggleMute()
  }

  function onKeyUp(event: KeyboardEvent) {
    held.delete(event.code)
  }

  function onBlur() {
    held.clear()
    hopHeld = false
    stickX = 0
    stickY = 0
    setKnob(0, 0)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  // ------------------------------------------------------------- touch
  const stick = document.getElementById('stick')
  const knob = document.getElementById('stick-knob')
  const hopButton = document.getElementById('touch-hop')
  const actButton = document.getElementById('touch-act')
  let pointerId = -1

  function setKnob(x: number, y: number) {
    if (knob) knob.style.transform = `translate(${x * 30}px, ${-y * 30}px)`
  }

  function onPointerDown(event: PointerEvent) {
    if (!stick) return
    touchActive = true
    pointerId = event.pointerId
    stick.setPointerCapture(event.pointerId)
    onPointerMove(event)
  }

  function onPointerMove(event: PointerEvent) {
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

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    pointerId = -1
    stickX = 0
    stickY = 0
    setKnob(0, 0)
  }

  stick?.addEventListener('pointerdown', onPointerDown)
  stick?.addEventListener('pointermove', onPointerMove)
  stick?.addEventListener('pointerup', onPointerUp)
  stick?.addEventListener('pointercancel', onPointerUp)

  function bindHold(element: HTMLElement | null, onDown: () => void, onUp: () => void) {
    if (!element) return
    element.addEventListener('pointerdown', event => {
      event.preventDefault()
      touchActive = true
      element.setPointerCapture(event.pointerId)
      onDown()
    })
    const release = (event: PointerEvent) => {
      event.preventDefault()
      onUp()
    }
    element.addEventListener('pointerup', release)
    element.addEventListener('pointercancel', release)
    element.addEventListener('lostpointercapture', () => onUp())
  }

  bindHold(hopButton, () => {
    hopHeld = true
    touchActive = true
  }, () => {
    hopHeld = false
  })

  bindHold(actButton, () => {
    touchActive = true
    actions.context()
  }, () => {
    /* context actions are one-shot */
  })

  window.addEventListener('touchstart', () => { touchActive = true }, { passive: true, once: true })

  return {
    read() {
      let x = 0
      let y = 0
      if (held.has('KeyA') || held.has('ArrowLeft')) x -= 1
      if (held.has('KeyD') || held.has('ArrowRight')) x += 1
      if (held.has('KeyW') || held.has('ArrowUp')) y += 1
      if (held.has('KeyS') || held.has('ArrowDown')) y -= 1
      if (Math.abs(stickX) > 0.12 || Math.abs(stickY) > 0.12) {
        x = stickX
        y = stickY
      }
      const boost = boostQueued || held.has('ShiftLeft') || held.has('ShiftRight')
      const hop = hopHeld || held.has('Space')
      return { x, y, boost, hop }
    },
    isTouch() {
      return touchActive
    },
    setTouchLabels(hop, action, ready) {
      if (hopButton) {
        hopButton.textContent = hop
        hopButton.classList.toggle('hidden', hop === '')
      }
      if (actButton) {
        actButton.textContent = action
        actButton.classList.toggle('ready', ready)
        actButton.classList.toggle('hidden', action === '')
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}
