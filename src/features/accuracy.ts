/* Trefferquote: zufällige Songs aus den eigenen Playlists werden herausgerechnet und neu zugeordnet.
   Treffer = eine Playlist, in der der Song wirklich liegt, steht auf Platz 1 bzw. unter den Top 3. Kostet nur KI-Anfragen. */
import { db, kv, type Track } from '../data/db'
import { getExcluded, suggest } from './suggest'

export interface Miss { song: string; expected: string[]; got: string[] }
/** Ein geprüfter Song, live für die Anzeige. */
export interface Step { song: string; top1: boolean; top3: boolean; failed?: string }
export interface Accuracy { at: number; n: number; top1: number; top3: number; provider: string; misses: Miss[]; local?: { top1: number; top3: number } }

export const lastAccuracy = () => kv.get<Accuracy>('accuracy')

export async function measureAccuracy(n: number, onStep?: (done: number, total: number, step?: Step) => void): Promise<Accuracy> {
  const d = await db
  const [all, excluded] = await Promise.all([d.getAll('playlists'), getExcluded()])
  const name = new Map(all.map(p => [p.id, p.name]))
  const where = new Map<string, { t: Track; in: Set<string> }>()   // Song → alle eigenen Playlists, in denen er liegt
  for (const p of all) {
    if ((!p.ownedByMe && !p.collaborative) || excluded.has(p.id)) continue
    const tracks = (await d.get('tracks', p.id))?.tracks ?? []
    if (tracks.length < 5) continue   // zu kleine Playlists lassen sich nicht fair prüfen
    for (const t of tracks) {
      const e = where.get(t.id) ?? { t, in: new Set<string>() }
      e.in.add(p.id); where.set(t.id, e)
    }
  }
  // Je Playlist höchstens ein Song, damit große Playlists das Ergebnis nicht dominieren
  const homes = new Set([...where.values()].map(e => [...e.in][0]))
  const used = new Set<string>(), pool: { t: Track; in: Set<string> }[] = []
  for (const e of [...where.values()].sort(() => Math.random() - .5)) {
    if (pool.length >= n) break
    const home = [...e.in][0]
    if (used.has(home) && used.size < homes.size) continue   // erst jede Playlist einmal, dann Wiederholungen
    used.add(home); pool.push(e)
  }
  if (!pool.length) throw new Error('Noch keine eingelesenen Songs zum Prüfen – erst abgleichen.')

  let top1 = 0, top3 = 0, provider = 'lokal', done = 0, lastErr = ''
  const local = { top1: 0, top3: 0 }   // dieselben Songs nur mit lokalen Punkten: kostet nichts, zeigt den Wert der KI
  const misses: Miss[] = []
  onStep?.(0, pool.length)
  for (const [i, { t, in: inn }] of pool.entries()) {
    const song = `${t.artists[0]} – ${t.name}`
    if (i && provider.startsWith('Gemini')) await new Promise(r => setTimeout(r, 3000))   // KI-Minutenlimit schonen
    try {
      const res = await suggest(t, { test: true })
      provider = res.provider
      const lids = (await suggest(t, { test: true, local: true })).suggestions.map(s => s.playlist.id)
      if (inn.has(lids[0])) local.top1++
      if (lids.some(id => inn.has(id))) local.top3++
      const ids = res.suggestions.map(s => s.playlist.id), ok1 = inn.has(ids[0]), ok3 = ids.some(id => inn.has(id))
      if (ok1) top1++
      if (ok3) top3++
      else misses.push({ song, expected: [...inn].map(id => name.get(id) ?? '?'), got: ids.map(id => name.get(id) ?? '?') })
      done++
      onStep?.(i + 1, pool.length, { song, top1: ok1, top3: ok3 })
    } catch (e) {   // ein Fehler bricht nicht die ganze Messung ab: Song zählt nicht mit
      lastErr = (e as Error).message
      onStep?.(i + 1, pool.length, { song, top1: false, top3: false, failed: lastErr })
    }
  }
  if (!done) throw new Error('Kein Song ließ sich prüfen: ' + lastErr)
  const r = { at: Date.now(), n: done, top1, top3, provider, misses, local }
  await kv.set('accuracy', r)
  return r
}
