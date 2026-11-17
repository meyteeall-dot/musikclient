/* Trefferquote: zufällige Songs aus den eigenen Playlists werden herausgerechnet und neu zugeordnet.
   Treffer = eine Playlist, in der der Song wirklich liegt, steht auf Platz 1 bzw. unter den Top 3. Kostet nur KI-Anfragen. */
import { kv, type Track } from '../data/db'
import { hasAi } from '../ai'
import { addLesson } from './lessons'
import { loadLibrary, rankWithout, SIGNALS, suggest, type Signal } from './suggest'

/** Platz 1 falsch. top3: lag die richtige Playlist wenigstens unter den Top 3. */
export interface Miss { song: string; trackId?: string; expected: string[]; got: string[]; top3?: boolean }
/** Ein geprüfter Song, live für die Anzeige. */
export interface Step { song: string; top1: boolean; top3: boolean; failed?: string }
export type Ablation = Partial<Record<Signal, { top1: number; top3: number }>>
export interface Accuracy {
  at: number; n: number; top1: number; top3: number; provider: string; misses: Miss[]; local?: { top1: number; top3: number }; tested?: string[]
  /** Signal-Analyse: Treffer der Punkte, wenn jeweils ein Baustein fehlt (Vergleich mit local) */
  ablation?: Ablation
}

export const lastAccuracy = () => kv.get<Accuracy>('accuracy')

/** skip: schon geprüfte Songs (Endlos-Modus). stop: true = nach dem aktuellen Song aufhören. */
export async function measureAccuracy(n: number, onStep?: (done: number, total: number, step?: Step) => void,
  opts: { skip?: Set<string>; stop?: () => boolean; localOnly?: boolean } = {}): Promise<Accuracy> {
  const lib = await loadLibrary()   // einmal für die ganze Messung, nicht zweimal pro Song
  const { all, excluded } = lib
  const learned = new Set(lib.lessons.map(l => l.trackId))   // gelernte Songs nicht prüfen: das Ergebnis bliebe sonst geschönt
  const name = new Map(all.map(p => [p.id, p.name]))
  const where = new Map<string, { t: Track; in: Set<string> }>()   // Song → alle eigenen Playlists, in denen er liegt
  for (const p of all) {
    if ((!p.ownedByMe && !p.collaborative) || excluded.has(p.id)) continue
    const tracks = lib.tracks.get(p.id) ?? []
    if (tracks.length < 5) continue   // zu kleine Playlists lassen sich nicht fair prüfen
    for (const t of tracks) {
      const e = where.get(t.id) ?? { t, in: new Set<string>() }
      e.in.add(p.id); where.set(t.id, e)
    }
  }
  // Je Playlist höchstens ein Song, damit große Playlists das Ergebnis nicht dominieren
  const homes = new Set([...where.values()].map(e => [...e.in][0]))
  const used = new Set<string>(), pool: { t: Track; in: Set<string> }[] = []
  for (const e of [...where.values()].filter(e => !learned.has(e.t.id) && !opts.skip?.has(e.t.id)).sort(() => Math.random() - .5)) {
    if (pool.length >= n) break
    const home = [...e.in][0]
    if (used.has(home) && used.size < homes.size) continue   // erst jede Playlist einmal, dann Wiederholungen
    used.add(home); pool.push(e)
  }
  if (!pool.length) throw new Error(where.size ? 'Alle Songs sind schon geprüft oder gelernt.' : 'Noch keine eingelesenen Songs zum Prüfen – erst abgleichen.')

  let top1 = 0, top3 = 0, provider = opts.localOnly ? 'nur Punkte' : 'lokal', done = 0, lastErr = ''
  const tested: string[] = [], ai = await hasAi()
  const local = { top1: 0, top3: 0 }   // dieselben Songs nur mit lokalen Punkten: kostet nichts, zeigt den Wert der KI
  const ablation: Ablation = {}
  const misses: Miss[] = []
  onStep?.(0, pool.length)
  for (const [i, { t, in: inn }] of pool.entries()) {
    if (opts.stop?.()) break
    const song = `${t.artists[0]} – ${t.name}`
    if (i && !opts.localOnly && provider.startsWith('Gemini')) await new Promise(r => setTimeout(r, 3000))   // KI-Minutenlimit schonen
    try {
      let ids: string[] = []
      if (!opts.localOnly) {
        // Wächter: ein Song darf höchstens 3 Minuten brauchen, dann zählt er als Fehler und es geht weiter
        const res = await Promise.race([suggest(t, { test: true, lib }),
          new Promise<never>((_, no) => setTimeout(() => no(new Error('keine Antwort nach 3 Minuten')), 180_000))])
        // KI ausgefallen und nur Punkte geliefert: nicht als KI-Ergebnis werten
        if (ai && res.provider.startsWith('lokal')) throw new Error('KI nicht erreichbar')
        provider = res.provider
        ids = res.suggestions.map(s => s.playlist.id)
      }
      const lres = await suggest(t, { test: true, local: true, lib })
      const lids = rankWithout(lres.ranking ?? []).slice(0, 3)   // gleiche Gleichstand-Regel wie die Analyse: fairer Vergleich
      if (inn.has(lids[0])) local.top1++
      if (lids.some(id => inn.has(id))) local.top3++
      for (const s of Object.keys(SIGNALS) as Signal[]) {   // dieselbe Rechnung, jeweils ohne einen Baustein
        const r = rankWithout(lres.ranking ?? [], s).slice(0, 3), a = ablation[s] ??= { top1: 0, top3: 0 }
        if (inn.has(r[0])) a.top1++
        if (r.some(id => inn.has(id))) a.top3++
      }
      if (opts.localOnly) ids = lids
      const ok1 = inn.has(ids[0]), ok3 = ids.some(id => inn.has(id))
      if (ok1) top1++
      if (ok3) top3++
      if (!ok1) {   // Platz 1 daneben: merken und lernen (nur aus echten KI-Fehlgriffen)
        misses.push({ song, trackId: t.id, top3: ok3, expected: [...inn].map(id => name.get(id) ?? '?'), got: ids.map(id => name.get(id) ?? '?') })
        if (!opts.localOnly) await addLesson({ trackId: t.id, song, artistIds: t.artistIds, right: [...inn], wrong: ids[0], at: Date.now() })
      }
      done++; tested.push(t.id)
      onStep?.(i + 1, pool.length, { song, top1: ok1, top3: ok3 })
    } catch (e) {   // ein Fehler bricht nicht die ganze Messung ab: Song zählt nicht mit
      lastErr = (e as Error).message
      onStep?.(i + 1, pool.length, { song, top1: false, top3: false, failed: lastErr })
    }
  }
  if (!done && !opts.stop?.()) throw new Error('Kein Song ließ sich prüfen: ' + lastErr)
  const r = { at: Date.now(), n: done, top1, top3, provider, misses, local, tested, ablation }
  if (done) await kv.set('accuracy', r)
  return r
}
