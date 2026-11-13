/* KI-Playlist aus der eigenen Sammlung: ein paar Worte → passende Playlists (Stufe 1) → Songs daraus in guter Reihenfolge (Stufe 2)
   → als neue private Playlist in Spotify. Nur Songs, die schon in deinen Playlists liegen. */
import { completeJson } from '../ai'
import { db, type Track } from '../data/db'
import { api } from '../spotify/api'
import { setExcluded } from './suggest'

const POOL = 300   // Songs, aus denen die KI auswählt
const line = (t: Track) => `${t.artists[0]} – ${t.name}${t.year ? ` (${t.year})` : ''}`

export interface Mix { name: string; description: string; tracks: Track[] }

export async function buildMix(words: string, count: number): Promise<Mix> {
  const d = await db
  const profOf = new Map((await d.getAll('profiles')).map(p => [p.id, p]))
  const lists = (await d.getAll('playlists')).filter(p => profOf.has(p.id) && !p.tracksBlocked)
  if (!lists.length) throw new Error('Noch keine Profile – erst abgleichen und Profile erzeugen lassen.')
  const r1 = await completeJson<{ top: number[] }>({
    system: 'Du stellst aus der Musiksammlung eines Nutzers Playlists zusammen. Antworte ausschließlich mit JSON.',
    prompt: `Wunsch: „${words}“
Welche dieser Playlists enthalten am ehesten passende Songs? Höchstens 8, beste zuerst.
Format: {"top":[0,1,…]}

${lists.map((p, i) => `${i}: ${p.name} – ${[profOf.get(p.id)!.genres.join(', '), profOf.get(p.id)!.era, profOf.get(p.id)!.mood].join(' · ')}`).join('\n')}`,
  })
  const seen = new Set<string>(), pool: Track[] = []
  for (const i of r1.data.top ?? []) {
    if (!lists[i]) continue
    for (const t of (await d.get('tracks', lists[i].id))?.tracks ?? []) if (!seen.has(t.id)) { seen.add(t.id); pool.push(t) }
  }
  if (!pool.length) throw new Error('Keine passenden Songs gefunden – anders formulieren?')
  const songs = pool.sort(() => Math.random() - .5).slice(0, POOL)
  const r2 = await completeJson<{ name: string; description: string; songs: number[] }>({
    system: 'Du bist ein DJ und stellst aus vorgegebenen Songs eine stimmige Playlist zusammen. Antworte ausschließlich mit JSON.',
    prompt: `Wunsch: „${words}“
Wähle ${count} Songs, die am besten passen, und ordne sie in eine Reihenfolge mit gutem Fluss (Übergänge, Spannungsbogen). Nur Nummern aus der Liste.
Gib außerdem einen kurzen Playlist-Namen (höchstens 40 Zeichen) und eine deutsche Beschreibung (1 Satz) zurück.
Format: {"name":"…","description":"…","songs":[0,1,…]}

${songs.map((t, i) => `${i}: ${line(t)}`).join('\n')}`,
  })
  const picked = [...new Set((r2.data.songs ?? []).filter(i => songs[i]))].map(i => songs[i]).slice(0, count)
  return { name: String(r2.data.name || words).slice(0, 80), description: String(r2.data.description ?? '').slice(0, 300), tracks: picked }
}

/** Als private Playlist in Spotify anlegen. Sie wird bei Vorschlägen ignoriert (sie ist ja aus anderen zusammengesetzt). */
export async function createMix(m: Mix) {
  const pl = await api<{ id: string; external_urls?: { spotify?: string } }>('/me/playlists', {
    method: 'POST', body: JSON.stringify({ name: m.name, description: m.description, public: false }),
  })
  for (let i = 0; i < m.tracks.length; i += 100)
    await api(`/playlists/${pl.id}/items`, { method: 'POST', body: JSON.stringify({ uris: m.tracks.slice(i, i + 100).map(t => t.uri) }) })
  await setExcluded(pl.id, true)
  return pl.external_urls?.spotify ?? `https://open.spotify.com/playlist/${pl.id}`
}
