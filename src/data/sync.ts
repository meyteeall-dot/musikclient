import { getAll, me } from '../spotify/api'
import { db, kv, type Playlist } from './db'

export interface SyncResult { added: number; changed: number; removed: number; total: number }

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
  const res: SyncResult = { added: 0, changed: 0, removed: 0, total: remote.length }
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
      image: p.images?.at(-1)?.url ?? p.images?.[0]?.url,
      total: p.items?.total ?? p.tracks?.total ?? 0, // seit Feb. 2026 heißt das Feld "items"
      tracksSnapshot: old?.tracksSnapshot,
    }
    tx.store.put(pl)
  }
  for (const id of local.keys()) { tx.store.delete(id); res.removed++ }
  await tx.done
  await kv.set('lastSync', Date.now())
  return res
}
