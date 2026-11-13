import { kv, type Track } from '../data/db'
import { accessToken } from './auth'

const BASE = 'https://api.spotify.com/v1'

export class NotLoggedIn extends Error {}
export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg) } }
/** Spotify drosselt die App. Wann es wieder geht, sagt Spotify nicht. */
export class RateLimited extends ApiError {
  constructor() { super(429, 'Spotify-Limit erreicht – zu viele Anfragen. Später erneut versuchen oder oben auf Abgleich tippen.') }
}
// Pause nach Sperre: automatische Versuche warten 15, 30, 60, 120, max. 240 Minuten; Erfolg setzt zurück
let pause: { until: number; step: number } | null = null   // null = noch nicht aus der Datenbank gelesen
/** Nutzer will es jetzt wissen (Abgleich-Knopf): Pause aufheben. */
export const clearPause = async () => { pause = { until: 0, step: 0 }; await kv.del('spotifyBackoff') }

/** Spotify-Web-API-Aufruf mit Token-Erneuerung bei 401, Warten bei 429 und neuem Versuch bei Serverfehlern (5xx). */
export async function api<T = any>(path: string, init: RequestInit = {}, retry = 0): Promise<T> {
  pause ??= (await kv.get<{ until: number; step: number }>('spotifyBackoff')) ?? { until: 0, step: 0 }
  if (Date.now() < pause.until) throw new RateLimited()
  const token = await accessToken(retry > 0 && retry < 2)
  if (!token) throw new NotLoggedIn()
  const r = await fetch(path.startsWith('http') ? path : BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  if (r.status === 401 && retry < 1) return api(path, init, retry + 1)
  if (r.status === 429) {
    const said = Number(r.headers.get('Retry-After')) * 1000
    if (said && said <= 10_000 && retry < 4) {   // kurzes Limit: abwarten und erneut
      await new Promise(res => setTimeout(res, said))
      return api(path, init, retry + 2)
    }
    const step = Math.min(pause.step + 1, 5)   // Kontingent erschöpft: Pause statt weiter anklopfen, jedes Mal länger
    pause = { until: Date.now() + Math.max(said || 0, 15 * 60_000 * 2 ** (step - 1)), step }
    await kv.set('spotifyBackoff', pause)
    throw new RateLimited()
  }
  if (r.status >= 500 && retry < 6) {   // Spotify hat kurz Probleme (502/503): 1, 3, 6 s warten
    await new Promise(res => setTimeout(res, [1000, 1000, 3000, 3000, 6000, 6000][retry]))
    return api(path, init, retry + 2)
  }
  if (r.ok && pause.step) await clearPause()
  if (!r.ok) throw new ApiError(r.status, `Spotify ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const txt = await r.text()   // Player-Befehle antworten teils ohne Inhalt
  return (txt ? JSON.parse(txt) : undefined) as T
}

/** Alle Seiten eines Paging-Objekts einsammeln. */
export async function getAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let next: string | null = path; next; ) {
    const page: { items: T[]; next: string | null; total?: number } = await api(next)
    out.push(...page.items)
    next = page.next
    // Spotify liefert bei Störungen manchmal Seiten ohne "next": dann lieber abbrechen als Unvollständiges speichern
    if (!next && page.total != null && out.length < page.total) throw new ApiError(0, `Spotify hat nur ${out.length} von ${page.total} Einträgen geliefert – bitte später erneut abgleichen.`)
  }
  return out
}

/** Spotify-Track-Objekt → schlanker Track für die lokale Datenbank. */
export const toTrack = (t: any): Track => ({
  id: t.id, uri: t.uri, name: t.name,
  artists: t.artists.map((a: any) => a.name), artistIds: t.artists.map((a: any) => a.id),
  album: t.album?.name ?? '', year: parseInt(t.album?.release_date) || undefined,
})

export type SearchHit = Track & { image?: string }

// Entwicklungsmodus seit Feb. 2026: höchstens 10 Treffer pro Suche
export const searchTracks = async (q: string): Promise<SearchHit[]> =>
  (await api(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`)).tracks.items
    .filter((t: any) => t?.id)
    .map((t: any) => ({ ...toTrack(t), image: (t.album?.images?.[1] ?? t.album?.images?.[0])?.url }))

export const addToPlaylist = (playlistId: string, uri: string) =>
  api(`/playlists/${playlistId}/items`, { method: 'POST', body: JSON.stringify({ uris: [uri] }) })

export const me = () => api<{ id: string; display_name: string }>('/me')
