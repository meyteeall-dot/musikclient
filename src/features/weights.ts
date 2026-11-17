/* Gewichts-Optimierung: die App lernt aus der eigenen Sammlung, wie stark jeder Punkte-Baustein zählen soll.
   Hälfte A zum Lernen, Hälfte B zum Prüfen – übernommen wird nur, was auch auf B besser trifft. Alles lokal, ohne Anfragen. */
import { kv, type Track } from '../data/db'
import { loadLibrary, SIGNALS, suggest, type Parts, type Signal, type Weights } from './suggest'

export interface Case { inn: Set<string>; ranking: { id: string; parts: Parts }[] }
export interface Optimized { before: { train: number; test: number }; after: { train: number; test: number }; weights: Weights; n: number }

const GRID = [0, .25, .5, .75, 1, 1.5, 2, 3, 4, 6]   // ausprobierte Gewichte je Baustein

export const getWeights = async () => (await kv.get<Weights>('weights')) ?? {}
export const saveWeights = (w: Weights) => kv.set('weights', w)
export const resetWeights = () => kv.del('weights')

/** Anteil Platz-1-Treffer bei diesen Gewichten (Gleichstand neutral nach ID, wie in der Trefferquote). */
export function hits(cases: Case[], w: Weights) {
  let ok = 0
  for (const c of cases) {
    let best = '', bs = -Infinity
    for (const r of c.ranking) {
      let s = 0
      for (const k in r.parts) s += r.parts[k as Signal] * (w[k as Signal] ?? 1)
      if (s > bs || (s === bs && r.id < best)) { bs = s; best = r.id }
    }
    if (c.inn.has(best)) ok++
  }
  return cases.length ? ok / cases.length : 0
}

export async function optimizeWeights(onProgress?: (text: string) => void): Promise<Optimized> {
  const lib = await loadLibrary()
  // Jeder Song der eigenen Playlists, so getestet, als wäre er neu (wie „Nur Punkte“)
  const where = new Map<string, { t: Track; inn: Set<string> }>()
  for (const p of lib.all) {
    if ((!p.ownedByMe && !p.collaborative) || lib.excluded.has(p.id)) continue
    const tracks = lib.tracks.get(p.id) ?? []
    if (tracks.length < 5) continue
    for (const t of tracks) { const e = where.get(t.id) ?? { t, inn: new Set<string>() }; e.inn.add(p.id); where.set(t.id, e) }
  }
  const songs = [...where.values()]
  if (songs.length < 50) throw new Error('Zu wenige eingelesene Songs für eine verlässliche Optimierung.')
  const cases: Case[] = []
  for (const [i, { t, inn }] of songs.entries()) {
    if (i % 25 === 0) { onProgress?.(`rechne Songs durch ${i}/${songs.length}`); await new Promise(r => setTimeout(r)) }   // Anzeige atmen lassen
    const r = await suggest(t, { test: true, local: true, lib })
    if (r.ranking?.length) cases.push({ inn, ranking: r.ranking })
  }
  // fest gemischt in zwei Hälften: A lernt, B prüft
  const shuffled = cases.map(c => ({ c, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.c)
  const train = shuffled.filter((_, i) => i % 2 === 0), test = shuffled.filter((_, i) => i % 2 === 1)

  const start = lib.weights
  const { w, best } = await search(train, start, onProgress)
  return { n: cases.length, weights: w, before: { train: hits(train, start), test: hits(test, start) }, after: { train: best, test: hits(test, w) } }
}

/** Koordinatensuche: je Baustein das beste Gewicht aus GRID, die anderen fest; bis zu 3 Durchgänge. */
export async function search(train: Case[], start: Weights, onProgress?: (text: string) => void) {
  const w: Weights = { ...start }
  const used = (Object.keys(SIGNALS) as Signal[]).filter(s => train.some(c => c.ranking.some(r => r.parts[s] !== 0)))   // Bausteine ohne Daten bleiben
  let best = hits(train, w)
  for (let pass = 0; pass < 3; pass++) {
    let improved = false
    for (const s of used) {
      onProgress?.(`optimiere ${SIGNALS[s]} (Durchgang ${pass + 1}/3)`)
      await new Promise(r => setTimeout(r))
      for (const g of GRID) {
        const v = hits(train, { ...w, [s]: g })
        if (v > best + 1e-9) { best = v; w[s] = g; improved = true }
      }
    }
    if (!improved) break
  }
  return { w, best }
}
