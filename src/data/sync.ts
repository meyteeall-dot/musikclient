import { ApiError, getAll, me, toTrack } from '../spotify/api'
import { db, kv, type Playlist, type Track } from './db'

export interface SyncResult { added: number; changed: number; removed: number; held: number; total: number }

/**
 * Playlist-Liste mit Spotify abgleichen (eine Anfrage je 50 Playlists).
 * Geänderte snapshot_id → Playlist gilt als "Tracks neu einlesen" (tracksSnapshot !== snapshot_id).
 */
export async function syncPlaylists(): Promise<SyncResult> {
  const user = await me()
  await kv.set('user', user)
  const remote = await getAll<any>('/me/playlists?limit=50')
  const d = await db
  const local = new Map((await d.getAll('playlists')).map(p => [p.id, p]))
  const res: SyncResult = { added: 0, changed: 0, removed: 0, held: 0, total: remote.length }
  const tx = d.transaction('playlists', 'readwrite')
  for (const p of remote) {
    if (!p) continue
    const old = local.get(p.id)
    local.delete(p.id)
    if (!old) res.added++
    else if (old.snapshot_id !== p.snapshot_id) res.changed++
    const pl: Playlist = {
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      snapshot_id: p.snapshot_id,
      owner: p.owner?.display_name ?? p.owner?.id ?? '',
      ownedByMe: p.owner?.id === user.id,
      collaborative: !!p.collaborative,
      image: (p.images?.[1] ?? p.images?.[0])?.url,   // mittlere Größe: 60 px wären auf Retina unscharf
      total: p.items?.total ?? p.tracks?.total ?? 0, // seit Feb. 2026 heißt das Feld "items"
      tracksSnapshot: old?.tracksSnapshot,
    }
    tx.store.put(pl)
  }
  await tx.done
  // Was jetzt noch in "local" steht, fehlt bei Spotify: gelöscht oder entfolgt.
  let gone = [...local.keys()]
  const kept = res.total - res.added
  if (gone.length >= 5 && gone.length > (gone.length + kept) * .25) {
    // Viele auf einmal weg: bei Spotify-Störungen kommen manchmal unvollständige Listen. Erst löschen,
    // wenn ein Abgleich mindestens 10 Minuten später dieselben Playlists immer noch vermisst.
    const prev = await kv.get<{ ids: string[]; at: number }>('pendingRemoval')
    const same = !!prev && gone.every(id => prev.ids.includes(id))
    if (!(same && Date.now() - prev!.at > 10 * 60_000)) {
      await kv.set('pendingRemoval', { ids: gone, at: same ? prev!.at : Date.now() })
      res.held = gone.length; gone = []
    }
  } else await kv.del('pendingRemoval')
  for (const id of gone) {   // Playlist samt Tracks und Profil entfernen
    await d.delete('playlists', id); await d.delete('tracks', id); await d.delete('profiles', id); res.removed++
  }
  await kv.set('lastSync', Date.now())
  return res
}

const ITEM_FIELDS = 'id,uri,name,type,artists(id,name),album(name,release_date)'
// Feld heißt seit Feb. 2026 "item", vorher "track" – beide anfordern
const FIELDS = `next,total,items(item(${ITEM_FIELDS}),track(${ITEM_FIELDS}))`

/** Tracks aller Playlists einlesen, deren snapshot_id sich seit dem letzten Einlesen geändert hat. */
export async function syncTracks(onProgress?: (done: number, todo: number) => void) {
  const d = await db
  const todo = (await d.getAll('playlists')).filter(p => p.tracksSnapshot !== p.snapshot_id)
  let done = 0
  for (const p of todo) {
    onProgress?.(done, todo.length)
    if (done) await new Promise(r => setTimeout(r, 400))   // keine Anfrage-Salven: Spotify sperrt sonst die App
    try {
      const raw = await getAll<any>(`/playlists/${p.id}/items?limit=50&fields=${encodeURIComponent(FIELDS)}`)
      const tracks: Track[] = []
      for (const r of raw) {
        const t = r.item ?? r.track
        if (!t?.id || t.type !== 'track') continue   // lokale Dateien, Podcast-Folgen
        tracks.push(toTrack(t))
      }
      await d.put('tracks', { id: p.id, tracks })
      p.tracksBlocked = false
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 403 && e.status !== 404)) throw e
      p.tracksBlocked = true   // nicht bei jedem Abgleich erneut versuchen, erst bei neuer snapshot_id
    }
    p.tracksSnapshot = p.snapshot_id
    // Nur speichern, wenn die Playlist inzwischen nicht gelöscht wurde
    if (await d.getKey('playlists', p.id)) await d.put('playlists', p)
    done++
  }
  onProgress?.(done, todo.length)
  return { done, blocked: todo.filter(p => p.tracksBlocked).length }
}
