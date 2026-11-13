import { accessToken } from './auth'

const BASE = 'https://api.spotify.com/v1'

export class NotLoggedIn extends Error {}

/** Spotify-Web-API-Aufruf mit Token-Erneuerung bei 401 und Warten bei 429. */
export async function api<T = any>(path: string, init: RequestInit = {}, retry = 0): Promise<T> {
  const token = await accessToken(retry > 0 && retry < 2)
  if (!token) throw new NotLoggedIn()
  const r = await fetch(path.startsWith('http') ? path : BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  })
  if (r.status === 401 && retry < 1) return api(path, init, retry + 1)
  if (r.status === 429 && retry < 5) {
    const wait = Number(r.headers.get('Retry-After') || 2)
    await new Promise(res => setTimeout(res, wait * 1000))
    return api(path, init, retry + 2)
  }
  if (!r.ok) throw new Error(`Spotify ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return (r.status === 204 ? undefined : r.json()) as T
}

/** Alle Seiten eines Paging-Objekts einsammeln. */
export async function getAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let next: string | null = path; next; ) {
    const page: { items: T[]; next: string | null } = await api(next)
    out.push(...page.items)
    next = page.next
  }
  return out
}

export const me = () => api<{ id: string; display_name: string }>('/me')
