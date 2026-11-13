/* Inbox: zuletzt gehörte Songs, die in keiner eigenen Playlist liegen – zum Einsortieren. Eine Spotify-Anfrage. */
import { db, kv } from '../data/db'
import { api, ApiError, toTrack, type SearchHit } from '../spotify/api'

export async function loadInbox(): Promise<SearchHit[]> {
  let j
  try { j = await api('/me/player/recently-played?limit=50') }
  catch (e) {
    // Alte Anmeldung ohne die neue Berechtigung „zuletzt gehört"
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw new Error('Für die Inbox braucht die App eine neue Berechtigung: unter Optionen einmal abmelden und wieder anmelden.')
    throw e
  }
  const d = await db
  const known = new Set<string>((await kv.get<string[]>('inboxDone')) ?? [])   // schon erledigt oder übersprungen
  for (const p of await d.getAll('playlists')) {
    if (!p.ownedByMe && !p.collaborative) continue
    for (const t of (await d.get('tracks', p.id))?.tracks ?? []) known.add(t.id)
  }
  const out: SearchHit[] = []
  for (const { track: t } of j?.items ?? []) {
    if (!t?.id || known.has(t.id)) continue
    known.add(t.id)   // mehrfach gehört: nur einmal
    out.push({ ...toTrack(t), image: (t.album?.images?.[1] ?? t.album?.images?.[0])?.url })
  }
  return out
}

/** Song aus der Inbox nehmen (einsortiert oder bewusst übersprungen). */
export async function doneInbox(id: string) {
  const done = (await kv.get<string[]>('inboxDone')) ?? []
  await kv.set('inboxDone', [...done.slice(-500), id])   // nur die letzten 500 merken
}
