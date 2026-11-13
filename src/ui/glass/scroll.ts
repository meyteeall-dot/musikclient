import { onFrame } from './engine'

/** Wischen irgendwo auf dem Bildschirm scrollt diesen Bereich. Touch-/Maus-/Rad-Scrollen mit Schwung und Gummiband, getaktet mit dem Glas (onFrame). Gibt Aufräumfunktion zurück. */
export function glassScroll(box: HTMLElement) {
  const inner = box.firstElementChild as HTMLElement
  let y = 0, v = 0, shown = NaN, moved = false
  let drag: { id: number; y0: number; s0: number; last: number; t: number } | null = null
  const max = () => Math.max(0, inner.offsetHeight - box.clientHeight)
  const clamp = (n: number) => Math.min(max(), Math.max(0, n))

  const off = onFrame(dt => {
    const m = max()
    if (!drag) {
      if (y < 0 || y > m) { y += (Math.min(m, Math.max(0, y)) - y) * Math.min(1, dt * 12); v *= Math.exp(-dt * 20) }   // zurückfedern
      y += v * dt; v *= Math.exp(-dt * 2.5)
      if (Math.abs(v) < 8) v = 0
      if (Math.abs(y - clamp(y)) < .3 && !v) y = clamp(y)
    }
    if (y !== shown) { inner.style.transform = `translate3d(0,${-y}px,0)`; shown = y }
  })

  const down = (e: PointerEvent) => {
    moved = false
    if ((e.target as Element).closest('input, textarea, select, .gs, .tabs')) return   // Regler und Felder behalten ihre Gesten
    drag = { id: e.pointerId, y0: e.clientY, s0: y, last: e.clientY, t: e.timeStamp }; v = 0
  }
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    const d = e.clientY - drag.y0
    if (!moved && Math.abs(d) > 8) moved = true
    if (!moved) return
    const raw = drag.s0 - d, m = max()
    y = raw < 0 ? raw * .35 : raw > m ? m + (raw - m) * .35 : raw   // Gummiband am Rand
    const dt = Math.max(1, e.timeStamp - drag.t)
    v = v * .6 + -(e.clientY - drag.last) / dt * 1000 * .4
    drag.last = e.clientY; drag.t = e.timeStamp
  }
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    if (e.timeStamp - drag.t > 80) v = 0   // Finger stand still vor dem Loslassen: kein Schwung
    drag = null
  }
  const click = (e: MouseEvent) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false } }   // Wischen ist kein Tippen
  const wheel = (e: WheelEvent) => { e.preventDefault(); y = clamp(y + e.deltaY * (e.deltaMode ? 16 : 1)); v = 0 }
  // Browser scrollt selbst (z. B. Fokus auf ein Eingabefeld): in unser y übernehmen
  const native = () => { if (box.scrollTop) { y = clamp(y + box.scrollTop); box.scrollTop = 0 } }

  addEventListener('pointerdown', down)
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up)
  addEventListener('click', click, true)
  addEventListener('wheel', wheel, { passive: false })
  // Ansicht innerhalb desselben Tabs gewechselt (z. B. Liste ↔ Vorschläge): oben anfangen
  const top = () => { y = 0; v = 0 }
  box.addEventListener('scroll', native)
  addEventListener('glass-scroll-top', top)
  return () => {
    removeEventListener('glass-scroll-top', top)
    off()
    removeEventListener('pointerdown', down)
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
    removeEventListener('click', click, true)
    removeEventListener('wheel', wheel)
    box.removeEventListener('scroll', native)
  }
}
