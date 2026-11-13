/* Trefferquote: zufällige Songs aus den eigenen Playlists werden herausgerechnet und neu zugeordnet.
   Treffer = eine Playlist, in der der Song wirklich liegt, steht auf Platz 1 bzw. unter den Top 3. Kostet nur KI-Anfragen. */
import { db, kv, type Track } from '../data/db'
import { getExcluded, suggest } from './suggest'

export interface Miss { song: string; expected: string[]; got: string[] }
export interface Accuracy { at: number; n: number; top1: number; top3: number; provider: string; misses: Miss[] }

export const lastAccuracy = () => kv.get<Accuracy>('accuracy')

export async function measureAccuracy(n: number, onProgress?: (done: number) => void): Promise<Accuracy> {
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
  const pool = [...where.values()].sort(() => Math.random() - .5).slice(0, n)
  if (!pool.length) throw new Error('Noch keine eingelesenen Songs zum Prüfen – erst abgleichen.')

  let top1 = 0, top3 = 0, provider = 'lokal'
  const misses: Miss[] = []
  for (const [i, { t, in: inn }] of pool.entries()) {
    onProgress?.(i)
    if (i && provider !== 'lokal') await new Promise(r => setTimeout(r, 4000))   // KI-Minutenlimit schonen
    const res = await suggest(t, { test: true })
    provider = res.provider
    const ids = res.suggestions.map(s => s.playlist.id)
    if (inn.has(ids[0])) top1++
    if (ids.some(id => inn.has(id))) top3++
    else misses.push({ song: `${t.artists[0]} – ${t.name}`, expected: [...inn].map(id => name.get(id) ?? '?'), got: ids.map(id => name.get(id) ?? '?') })
  }
  onProgress?.(pool.length)
  const r = { at: Date.now(), n: pool.length, top1, top3, provider, misses }
  await kv.set('accuracy', r)
  return r
}
