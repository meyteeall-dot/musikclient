/* Feinabstimmung aus der eigenen Sammlung, ganz ohne Anfragen:
   1) Klangvergleich (wie viele ähnliche Songs abstimmen, wie stark Energie, Sprechgesang, Tempo … zählen),
   2) Gewichte der Punkte-Bausteine,
   3) häufigste Verwechslungen.
   Hälfte A lernt, Hälfte B prüft – übernommen wird nur, was auch auf B besser trifft. */
import { kv, type Track } from '../data/db'
import { DEFAULT_SOUND, distance as distanceTo, KEYS, nearest, votesOf, type Feat, type FeatKey, type SoundParams } from './sound'
import { loadLibrary, SIGNALS, suggest, type Parts, type Signal, type Weights } from './suggest'

export interface Case { inn: Set<string>; ranking: { id: string; parts: Parts }[] }
/** Fall mit Klangdaten: die 150 klanglich nächsten Songs, damit andere Klang-Einstellungen schnell nachgerechnet werden können */
interface SoundCase extends Case { f?: Feat; near?: { feat: Feat; pls: string[] }[] }
export interface Confusion { from: string; to: string; n: number }
export interface Optimized {
  before: { train: number; test: number }; after: { train: number; test: number }
  weights: Weights; sound: SoundParams; n: number; confusion: Confusion[]
  /** Magnet-Bremse: gelernter Ausgleich je Playlist (− = gewann zu oft, + = zu selten) */
  bias: Record<string, number>; biasNamed: { name: string; v: number }[]
}

const GRID = [0, .25, .5, .75, 1, 1.5, 2, 3, 4, 6]   // Gewichte je Baustein
const K_GRID = [5, 10, 15, 20, 30, 40, 60]          // so viele ähnliche Songs stimmen ab
const F_GRID = [0, .5, 1, 1.5, 2, 3]                // Faktor je Klang-Merkmal
const SIZE_GRID = [0, .25, .5, .75, 1]              // Größen-Ausgleich
const POOL = 150                                     // shortcut: Nachbarn außerhalb der 150 nächsten (Standard-Einstellung) werden nicht neu bewertet

export const getWeights = async () => (await kv.get<Weights>('weights')) ?? {}
export const getSoundParams = async () => (await kv.get<SoundParams>('soundParams')) ?? DEFAULT_SOUND
export async function saveTuning(w: Weights, s: SoundParams, b: Record<string, number>) { await kv.set('weights', w); await kv.set('soundParams', s); await kv.set('bias', b) }
export async function resetTuning() { await kv.del('weights'); await kv.del('soundParams'); await kv.del('bias') }
export const getBias = async () => (await kv.get<Record<string, number>>('bias')) ?? {}

const tick = () => new Promise(r => setTimeout(r))   // Anzeige zwischendurch atmen lassen

/** Platz 1 bei diesen Gewichten (Gleichstand neutral nach ID, wie in der Trefferquote). */
/** b: andere Magnet-Bremse ausprobieren (statt der gespeicherten im Baustein „bias“). */
function top(c: Case, w: Weights, b?: Record<string, number>) {
  let best = '', bs = -Infinity
  for (const r of c.ranking) {
    let s = b ? b[r.id] ?? 0 : r.parts.bias
    for (const k in r.parts) if (k !== 'bias') s += r.parts[k as Signal] * (w[k as Signal] ?? 1)
    if (s > bs || (s === bs && r.id < best)) { bs = s; best = r.id }
  }
  return best
}
export const hits = (cases: Case[], w: Weights, b?: Record<string, number>) => cases.length ? cases.filter(c => c.inn.has(top(c, w, b))).length / cases.length : 0

/** Klang-Bausteine mit anderen Klang-Einstellungen neu berechnen. */
let SIZES: Map<string, number> | undefined   // Playlist-Größen der aktuellen Abstimmung
function withSound(cases: SoundCase[], p: SoundParams): Case[] {
  return cases.map(c => {
    if (!c.f || !c.near) return c
    const near = c.near.map(n => ({ ...n, d: distanceTo(c.f!, n.feat, p.w) })).sort((a, b) => a.d - b.d)
    const votes = votesOf(near, p.k, SIZES, p.size)
    return { inn: c.inn, ranking: c.ranking.map(r => ({ id: r.id, parts: { ...r.parts, sound: (votes.get(r.id) ?? 0) * 8 } })) }
  })
}

export async function optimizeAll(onProgress?: (text: string) => void): Promise<Optimized> {
  const lib = await loadLibrary()
  SIZES = lib.plSize
  const name = new Map(lib.all.map(p => [p.id, p.name]))
  const where = new Map<string, { t: Track; inn: Set<string> }>()
  for (const p of lib.all) {
    if ((!p.ownedByMe && !p.collaborative) || lib.excluded.has(p.id)) continue
    const tracks = lib.tracks.get(p.id) ?? []
    if (tracks.length < 5) continue
    for (const t of tracks) { const e = where.get(t.id) ?? { t, inn: new Set<string>() }; e.inn.add(p.id); where.set(t.id, e) }
  }
  const songs = [...where.values()]
  if (songs.length < 50) throw new Error('Zu wenige eingelesene Songs für eine verlässliche Optimierung.')
  const cases: SoundCase[] = []
  for (const [i, { t, inn }] of songs.entries()) {
    if (i % 25 === 0) { onProgress?.(`rechne Songs durch ${i}/${songs.length}`); await tick() }
    const r = await suggest(t, { test: true, local: true, lib })
    if (!r.ranking?.length) continue
    const s = lib.sound.get(t.id), f = s && s.src !== 'fehlt' ? s : undefined
    cases.push({ inn, ranking: r.ranking, f, near: f && nearest(f, lib.sound, lib.inPl, t.id, lib.soundParams.w).slice(0, POOL) })
  }
  const shuffled = cases.map(c => ({ c, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.c)
  const train = shuffled.filter((_, i) => i % 2 === 0), test = shuffled.filter((_, i) => i % 2 === 1)
  const startW = lib.weights, startS = lib.soundParams

  // 1) Klang: erst Anzahl der Nachbarn, dann Faktor je Merkmal, zwei Durchgänge
  const sp: SoundParams = { k: startS.k, w: { ...startS.w }, size: startS.size ?? 0 }
  let best = hits(withSound(train, sp), startW)
  for (let pass = 0; pass < 2; pass++) {
    onProgress?.(`Klang: Anzahl ähnlicher Songs (Durchgang ${pass + 1}/2)`); await tick()
    for (const g of SIZE_GRID) { const v = hits(withSound(train, { ...sp, size: g }), startW); if (v > best + 1e-9) { best = v; sp.size = g } }
    for (const k of K_GRID) { const v = hits(withSound(train, { ...sp, k }), startW); if (v > best + 1e-9) { best = v; sp.k = k } }
    for (const f of KEYS as readonly FeatKey[]) {
      onProgress?.(`Klang: ${f} (Durchgang ${pass + 1}/2)`); await tick()
      for (const g of F_GRID) { const v = hits(withSound(train, { ...sp, w: { ...sp.w, [f]: g } }), startW); if (v > best + 1e-9) { best = v; sp.w = { ...sp.w, [f]: g } } }
    }
  }
  // 2) Gewichte auf Basis des neuen Klangs
  const trainS = withSound(train, sp), testS = withSound(test, sp)
  const { w } = await search(trainS, startW, onProgress)
  const b = await biasSearch(trainS, w, lib.bias, onProgress)

  // 3) Verwechslungen über alle Songs mit den neuen Einstellungen
  const conf = new Map<string, number>()
  for (const c of withSound(cases, sp)) {
    const t = top(c, w, b)
    if (!t || c.inn.has(t)) continue
    const key = `${name.get([...c.inn][0]) ?? '?'}\u0000${name.get(t) ?? '?'}`
    conf.set(key, (conf.get(key) ?? 0) + 1)
  }
  const confusion = [...conf].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => { const [from, to] = k.split('\u0000'); return { from, to, n } })

  return {
    n: cases.length, weights: w, sound: sp, confusion,
    before: { train: hits(withSound(train, startS), startW), test: hits(withSound(test, startS), startW) },
    after: { train: hits(trainS, w, b), test: hits(testS, w, b) }, bias: b,
    biasNamed: Object.entries(b).filter(([, v]) => v).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).map(([id, v]) => ({ name: name.get(id) ?? '?', v })),
  }
}

/** Koordinatensuche: je Baustein das beste Gewicht aus GRID, die anderen fest; bis zu 3 Durchgänge. */
export async function search(train: Case[], start: Weights, onProgress?: (text: string) => void) {
  const w: Weights = { ...start }
  const used = (Object.keys(SIGNALS) as Signal[]).filter(s => s !== 'bias' && train.some(c => c.ranking.some(r => r.parts[s] !== 0)))   // Bausteine ohne Daten bleiben; Magnet-Bremse lernt eigens
  let best = hits(train, w)
  for (let pass = 0; pass < 3; pass++) {
    let improved = false
    for (const s of used) {
      onProgress?.(`optimiere ${SIGNALS[s]} (Durchgang ${pass + 1}/3)`)
      await tick()
      for (const g of GRID) {
        const v = hits(train, { ...w, [s]: g })
        if (v > best + 1e-9) { best = v; w[s] = g; improved = true }
      }
    }
    if (!improved) break
  }
  return { w, best }
}

const B_GRID = [-1.5, -1, -.5, -.25, 0, .25, .5, 1]   // fein: grobe Sprünge passen sich zu sehr an die Lern-Hälfte an

/** Magnet-Bremse: je Playlist der Ausgleich, der auf der Lern-Hälfte am meisten Treffer bringt; zwei Durchgänge. */
export async function biasSearch(train: Case[], w: Weights, start: Record<string, number>, onProgress?: (text: string) => void) {
  // Punkte ohne Ausgleich einmal vorrechnen – danach kostet jeder Versuch nur noch Additionen
  const base = train.map(c => c.ranking.map(r => {
    let s = 0
    for (const k in r.parts) if (k !== 'bias') s += r.parts[k as Signal] * (w[k as Signal] ?? 1)
    return { id: r.id, s }
  }))
  const count = (b: Record<string, number>) => {
    let ok = 0
    for (let i = 0; i < train.length; i++) {
      let best = '', bs = -Infinity
      for (const r of base[i]) { const s = r.s + (b[r.id] ?? 0); if (s > bs || (s === bs && r.id < best)) { bs = s; best = r.id } }
      if (train[i].inn.has(best)) ok++
    }
    return ok
  }
  const ids = [...new Set(train.flatMap(c => c.ranking.map(r => r.id)))]
  const b: Record<string, number> = { ...start }
  let best = count(b)
  const minGain = Math.max(2, Math.round(train.length * .002))   // nur ändern, wenn es spürbar mehr Treffer bringt (gegen Zufallstreffer)
  for (let pass = 0; pass < 2; pass++) {
    onProgress?.(`Magnet-Bremse (Durchgang ${pass + 1}/2)`); await tick()
    for (const id of ids) for (const g of B_GRID) {
      const v = count({ ...b, [id]: g })
      if (v >= best + minGain) { best = v; b[id] = g }
    }
  }
  for (const id in b) if (!b[id]) delete b[id]
  return b
}
