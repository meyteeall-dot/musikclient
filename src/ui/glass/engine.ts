/* Liquid Glass aus Druckpunkt, ohne Druckpunkt-Spielereien (Glasfäden, Verschmelzen, Klänge).
   1) Farbwelt-Hintergrund per Shader in eine Textur, 2) auf den Schirm, 3) jedes .glass/.ind als Linse,
   die den Hintergrund physikalisch bricht. Linsen werden jedes Bild neu im DOM gesucht, damit React frei rendern kann.
   Ohne WebGL2 bleibt das CSS-Glas (Blur) aus theme.css. */
import { GL_BG_FS, GL_FULL_VS, GL_LENS_FS, GL_LENS_VS } from './shaders'

export const THEMES = {
  color:     { name: 'Farbe',           bg: 0, glow: [1, .55, .22], sw: 'linear-gradient(135deg,#1a6bff,#9b46ff 55%,#ff8a3d)' },
  bw:        { name: 'Schwarz-Weiß',    bg: 1, glow: [1, 1, 1],     sw: 'linear-gradient(135deg,#f4f4f4 50%,#0d0d0d 50%)' },
  sunset:    { name: 'Sonnenuntergang', bg: 4, glow: [1, .7, .25],  sw: 'linear-gradient(180deg,#3d1473,#ee4d85 55%,#ffa33a)' },
  sea:       { name: 'Tiefsee',         bg: 3, glow: [.2, 1, .9],   sw: 'radial-gradient(circle at 40% 30%,#3ff0e0,#04404a 55%,#00141a)' },
  neon:      { name: 'Neon',            bg: 6, glow: [1, .25, .65], sw: 'conic-gradient(#ff3fa4,#1fe6ff,#ff3fa4)' },
  porcelain: { name: 'Porzellan',       bg: 2, glow: [.2, .5, 1],   sw: 'radial-gradient(circle,#1f6fe8 0 26%,#f7f6f1 30% 46%,#1f6fe8 50% 58%,#f7f6f1 62%)', light: 1 },
  aurora:    { name: 'Aurora',          bg: 5, glow: [.3, 1, .65],  sw: 'linear-gradient(180deg,#020510 10%,#9b5cff 45%,#3dffa0 75%,#020510)' },
  mono:      { name: 'Mono Rot',        bg: 1, glow: [1, .23, .28], sw: 'radial-gradient(circle,#ff3b47 0 30%,transparent 34%),linear-gradient(135deg,#f4f4f4 50%,#0d0d0d 50%)' },
} as const
export type ThemeId = keyof typeof THEMES

export const GLASS_SLIDERS = [
  { k: 'refr',  name: 'Lichtbrechung', def: 50, map: (v: number) => v / 50 },
  { k: 'frost', name: 'Milchglas',     def: 0,  map: (v: number) => v / 100 },
  { k: 'disp',  name: 'Regenbogen',    def: 50, map: (v: number) => v / 50 },
  { k: 'gloss', name: 'Glanz',         def: 50, map: (v: number) => v / 50 },
  { k: 'tint',  name: 'Färbung',       def: 0,  map: (v: number) => v / 100 },
] as const
export type GlassKey = typeof GLASS_SLIDERS[number]['k']
export type GlassValues = Record<GlassKey, number>
export const GLASS_DEFAULTS = Object.fromEntries(GLASS_SLIDERS.map(s => [s.k, s.def])) as GlassValues

const T = { bg: 0, glow: [...THEMES.color.glow] as number[], light: 0 }
const G = { refr: 1, frost: 0, disp: 1, gloss: 1, tint: 0 }

export function applyTheme(id: ThemeId) {
  const t = THEMES[id] ?? THEMES.color
  document.body.dataset.theme = id
  Object.assign(T, { bg: t.bg, glow: [...t.glow], light: 'light' in t ? t.light : 0 })
}
export function applyGlass(v: GlassValues) {
  for (const s of GLASS_SLIDERS) G[s.k] = s.map(v[s.k] ?? s.def)
}

/* Ein gemeinsamer Bild-Takt: Hooks (z. B. Scrollen) laufen vor dem Glas-Zeichnen im selben Frame,
   damit Text und Glas nie gegeneinander verrutschen. */
const hooks = new Set<(dt: number) => void>()
export const onFrame = (f: (dt: number) => void) => { hooks.add(f); return () => { hooks.delete(f) } }
let render: ((now: number) => void) | null = null, lastT = 0
function tick(now: number) {
  const dt = Math.min(.05, (now - lastT) / 1000 || .016); lastT = now
  hooks.forEach(f => f(dt)); render?.(now)
  requestAnimationFrame(tick)
}

const RM = matchMedia('(prefers-reduced-motion: reduce)').matches
const FIXED = '[data-fixed], .gs-track'   // verformbar, aber wandert nicht mit dem Finger
const BIG = '[data-big]'                  // große Flächen: Spur hinter dem Finger statt Dehnen

interface Lens {
  el: HTMLElement; r: [number, boolean] | null; fixed: boolean; big: boolean; follow: boolean; a: number
  dx: number; dy: number; vx: number; vy: number; s: number; sv: number; ax: number; ay: number
  grab: number | null; p0x: number; p0y: number; px: number; py: number; pt: number; fvx: number; fvy: number
  cdx: number; cdy: number; g: number; seen: number
}
const lenses = new WeakMap<HTMLElement, Lens>()
function lensOf(el: HTMLElement): Lens {
  let L = lenses.get(el)
  if (!L) lenses.set(el, L = {
    el, r: null, fixed: el.matches(FIXED), big: el.matches(BIG), follow: !el.matches(`${BIG}, .ind, .gs-track`), a: 0,
    dx: 0, dy: 0, vx: 0, vy: 0, s: 0, sv: 0, ax: 0, ay: 0, grab: null, p0x: 0, p0y: 0, px: 0, py: 0, pt: 0, fvx: 0, fvy: 0,
    cdx: 0, cdy: 0, g: 0, seen: -1,
  })
  return L
}

/** Lichtreflex folgt dem Finger, Hintergrund wandert leicht mit (auch für das CSS-Glas ohne WebGL). */
const PX = { x: 0, y: 0 }
let lit: Element | null = null
function light(e: PointerEvent) {
  const g = (e.target as Element).closest?.('.glass') as HTMLElement | null
  if (g !== lit) { lit?.classList.remove('lit'); lit = g; g?.classList.add('lit') }
  if (g) { const r = g.getBoundingClientRect(); g.style.setProperty('--mx', e.clientX - r.left + 'px'); g.style.setProperty('--my', e.clientY - r.top + 'px') }
  if (!RM) {
    PX.x = e.clientX / innerWidth * 2 - 1; PX.y = e.clientY / innerHeight * 2 - 1
    const st = document.documentElement.style; st.setProperty('--gx', PX.x.toFixed(2)); st.setProperty('--gy', PX.y.toFixed(2))
  }
}
function unlight(e: PointerEvent) { if (e.pointerType !== 'mouse') { lit?.classList.remove('lit'); lit = null } }

export function initGlass(cv: HTMLCanvasElement) {
  requestAnimationFrame(tick)
  document.addEventListener('pointermove', light); document.addEventListener('pointerdown', light)
  document.addEventListener('pointerup', unlight); document.addEventListener('pointercancel', unlight)
  if (document.documentElement.classList.contains('gl')) return
  const gl = cv.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power' })
  if (!gl) return
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s)
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s
    console.warn(gl.getShaderInfoLog(s)); return null
  }
  const prog = (vs: string, fs: string, names: string[]) => {
    const a = sh(gl.VERTEX_SHADER, vs), b = sh(gl.FRAGMENT_SHADER, fs)
    if (!a || !b) return null
    const p = gl.createProgram()!; gl.attachShader(p, a); gl.attachShader(p, b); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); return null }
    return { p, u: Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)])) }
  }
  const pBg = prog(GL_FULL_VS, GL_BG_FS, ['uRes', 'uPar', 'uT', 'uHot', 'uTA', 'uTB', 'uTF', 'uGlow'])
  const pLens = prog(GL_LENS_VS, GL_LENS_FS, ['uRes', 'uR', 'uP', 'uDpr', 'uBg', 'uW', 'uM', 'uNR[0]', 'uNJ[0]', 'uNQ[0]', 'uNG[0]', 'uNN', 'uK', 'uSelf', 'uNB', 'uGlowC', 'uLight', 'uClip', 'uGlass', 'uTint'])
  if (!pBg || !pLens) return
  const U = pLens.u, UB = pBg.u

  const tex = gl.createTexture(), fb = gl.createFramebuffer()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  const grabs = new Map<number, Lens>()
  document.addEventListener('pointerdown', e => {
    const el = (e.target as Element).closest?.('.glass') as HTMLElement | null
    if (!el) return
    const L = lensOf(el), r = el.getBoundingClientRect()
    L.ax = e.clientX - (r.left + r.width / 2); L.ay = e.clientY - (r.top + r.height / 2)
    L.p0x = L.px = e.clientX; L.p0y = L.py = e.clientY; L.pt = e.timeStamp; L.fvx = L.fvy = 0
    L.grab = e.pointerId; grabs.set(e.pointerId, L)
  }, true)
  document.addEventListener('pointermove', e => {
    const L = grabs.get(e.pointerId)
    if (!L) return
    const dt = Math.max(1, e.timeStamp - L.pt)
    L.fvx = L.fvx * .7 + (e.clientX - L.px) / dt * .3; L.fvy = L.fvy * .7 + (e.clientY - L.py) / dt * .3
    L.px = e.clientX; L.py = e.clientY; L.pt = e.timeStamp
    // Scrollen: Finger bewegt den Inhalt, nicht das Glas
    if (Math.hypot(L.px - L.p0x, L.py - L.p0y) > 10 && L.el.closest('.scroll')) { L.grab = null; grabs.delete(e.pointerId) }
  }, true)
  const release = (e: PointerEvent) => { const L = grabs.get(e.pointerId); if (L) { grabs.delete(e.pointerId); L.grab = null } }
  document.addEventListener('pointerup', release, true); document.addEventListener('pointercancel', release, true)

  let w = 0, h = 0, dpr = 1, gx = 0, gy = 0, last = 0, frame = 0
  let tB = T.bg, tA = tB, tF = 1, lightV = T.light; const glow = T.glow.slice()
  const NR = new Float32Array(32), NJ = new Float32Array(32), NQ = new Float32Array(32), NG = new Float32Array(32)

  function size() {
    dpr = Math.min(devicePixelRatio || 1, 2)
    const cw = cv.clientWidth, ch = cv.clientHeight
    if (cw === w && ch === h) return
    w = cw; h = ch; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
    gl!.bindTexture(gl!.TEXTURE_2D, tex)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, cv.width, cv.height, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fb)
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
  }
  function radius(L: Lens, bw2: number, bh2: number) {
    if (!L.r) { const v = getComputedStyle(L.el).borderTopLeftRadius; L.r = [parseFloat(v) || 0, v.endsWith('%')] }
    return Math.min(L.r[1] ? L.r[0] / 100 * Math.min(bw2, bh2) : L.r[0], Math.min(bw2, bh2) / 2)
  }
  const sigOf = (L: Lens, hw: number, hh: number) => L.big ? 60 : Math.min(hw, hh) * .6 + 8
  // Feder pro Linse: festgehalten straff und gedämpft, losgelassen weich und nachschwingend (Wackelpudding)
  function physics(L: Lens, hw: number, hh: number, cx: number, cy: number, dt: number) {
    const held = L.grab !== null, R = Math.min(hw, hh)
    let tx = 0, ty = 0
    if (held && L.fixed) {
      tx = (L.px - L.p0x) * .3; ty = (L.py - L.p0y) * .3
      const m = Math.hypot(tx, ty); if (m > 10) { tx *= 10 / m; ty *= 10 / m }
    } else if (held && L.big) {
      L.ax = L.px - cx; L.ay = L.py - cy
      L.fvx *= .9; L.fvy *= .9
      tx = L.fvx * 40; ty = L.fvy * 40
      const m = Math.hypot(tx, ty); if (m > 38) { tx *= 38 / m; ty *= 38 / m }
    } else if (held) {
      const ex = L.px - L.p0x, ey = L.py - L.p0y, f = .7 / (1 + Math.hypot(ex, ey) / R)   // Gummiband
      tx = ex * f; ty = ey * f
    }
    const k = held ? 520 : 190, c = held ? 40 : 6.5
    L.vx += (k * (tx - L.dx) - c * L.vx) * dt; L.dx += L.vx * dt
    L.vy += (k * (ty - L.dy) - c * L.vy) * dt; L.dy += L.vy * dt
    L.sv += (300 * ((held && (!L.big || L.fixed) ? 1 : 0) - L.s) - 9 * L.sv) * dt; L.s += L.sv * dt
    if (L.follow) {   // Inhalt schwimmt ein Stück mit
      const fx = L.dx * .45, fy = L.dy * .45
      if (Math.abs(fx - L.cdx) > .1 || Math.abs(fy - L.cdy) > .1) {
        L.cdx = Math.abs(fx) < .1 ? 0 : fx; L.cdy = Math.abs(fy) < .1 ? 0 : fy
        L.el.style.setProperty('--dx', L.cdx.toFixed(1) + 'px'); L.el.style.setProperty('--dy', L.cdy.toFixed(1) + 'px')
      }
    }
  }

  function draw(now: number) {
    size(); frame++
    const dt = RM ? 1 : Math.min(.033, Math.max(.001, (now - last) / 1000 || .016)); last = now
    gx += (PX.x - gx) * .05; gy += (PX.y - gy) * .05
    if (T.bg !== tB) { tA = tB; tB = T.bg; tF = 0 }   // neue Farbwelt: weich überblenden
    tF = RM ? 1 : Math.min(1, tF + dt * 1.4)
    for (let i = 0; i < 3; i++) glow[i] += (T.glow[i] - glow[i]) * (RM ? 1 : .08)
    lightV += (T.light - lightV) * (RM ? 1 : .08)

    gl!.disable(gl!.BLEND)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fb); gl!.viewport(0, 0, cv.width, cv.height)
    gl!.useProgram(pBg!.p)
    gl!.uniform2f(UB.uRes, cv.width, cv.height); gl!.uniform2f(UB.uPar, gx, gy)
    gl!.uniform1f(UB.uT, RM ? 0 : now / 1000); gl!.uniform1f(UB.uHot, 0); gl!.uniform1i(UB.uTA, tA); gl!.uniform1i(UB.uTB, tB)
    gl!.uniform1f(UB.uTF, tF * tF * (3 - 2 * tF)); gl!.uniform3f(UB.uGlow, glow[0], glow[1], glow[2])
    gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    gl!.bindFramebuffer(gl!.READ_FRAMEBUFFER, fb); gl!.bindFramebuffer(gl!.DRAW_FRAMEBUFFER, null)
    gl!.blitFramebuffer(0, 0, cv.width, cv.height, 0, 0, cv.width, cv.height, gl!.COLOR_BUFFER_BIT, gl!.NEAREST)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null); gl!.viewport(0, 0, cv.width, cv.height)
    gl!.activeTexture(gl!.TEXTURE0); gl!.bindTexture(gl!.TEXTURE_2D, tex)

    gl!.enable(gl!.BLEND)
    gl!.useProgram(pLens!.p)
    gl!.uniform2f(U.uRes, cv.width, cv.height); gl!.uniform1f(U.uDpr, dpr); gl!.uniform1i(U.uBg, 0)
    gl!.uniform3f(U.uGlowC, glow[0], glow[1], glow[2]); gl!.uniform1f(U.uLight, lightV)
    gl!.uniform4f(U.uGlass, G.refr, G.frost, G.disp, G.gloss); gl!.uniform1f(U.uTint, G.tint)
    gl!.uniform1f(U.uK, 10 * dpr); gl!.uniform1i(U.uNN, 1); gl!.uniform1i(U.uSelf, 0); gl!.uniform1i(U.uNB, 0)
    gl!.uniform4f(U.uW, 0, 0, 0, 0)

    const clipR = new Map<Element, DOMRect>()
    for (const el of document.querySelectorAll<HTMLElement>('.glass, .ind')) {
      if (el.closest('[data-hide]')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || r.bottom < -40 || r.top > h + 40 || r.right < -40 || r.left > w + 40) continue
      const L = lensOf(el)
      if (L.seen !== frame - 1) L.a = 0   // neu sichtbar: weich einblenden
      L.seen = frame
      L.a = RM ? 1 : Math.min(1, L.a + dt / .38)
      const hw = r.width / 2, hh = r.height / 2, cx = r.left + hw, cy = r.top + hh
      if (!RM) physics(L, hw, hh, cx, cy, dt)
      const S = 1 + (L.fixed ? .02 : .07) * L.s
      const ext = Math.hypot(L.dx, L.dy) + Math.max(hw, hh) * Math.abs(S - 1)
      const rad = radius(L, r.width, r.height), bev = Math.max(9, Math.min(46, Math.min(hw, hh) * .62, rad))
      L.g = el.classList.contains('down') ? 1 : L.g * .94
      NR.set([cx * dpr, cy * dpr, hw * dpr, hh * dpr]); NJ.set([L.ax * dpr, L.ay * dpr, L.dx * dpr, L.dy * dpr])
      NQ.set([rad * dpr, S, sigOf(L, hw, hh) * dpr, bev * dpr]); NG.set([cx * dpr, cy * dpr, L.g, 0])
      gl!.uniform4fv(U['uNR[0]'], NR); gl!.uniform4fv(U['uNJ[0]'], NJ); gl!.uniform4fv(U['uNQ[0]'], NQ); gl!.uniform4fv(U['uNG[0]'], NG)
      const a = L.a * L.a * (3 - 2 * L.a) * (el.dataset.dim ? .45 : 1)
      gl!.uniform4f(U.uR, cx * dpr, cy * dpr, hw * dpr, hh * dpr)
      gl!.uniform3f(U.uP, rad * dpr, bev * dpr, a)
      const sc = el.parentElement?.closest('.scroll')   // Scrollbereich: außerhalb kein Glas, am Rand weicher Verlauf
      if (sc) {
        let c = clipR.get(sc); if (!c) { c = sc.getBoundingClientRect(); clipR.set(sc, c) }
        gl!.uniform4f(U.uClip, c.left * dpr, c.top * dpr, c.right * dpr, c.bottom * dpr)
      } else gl!.uniform4f(U.uClip, -1e5, -1e5, 1e5, 1e5)
      gl!.uniform1f(U.uM, (ext + 4) * dpr)
      gl!.drawArrays(gl!.TRIANGLES, 0, 6)
    }
  }
  document.documentElement.classList.add('gl')
  render = draw
}
