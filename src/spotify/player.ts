/* Wiedergabe. PC: Spotify Web Playback SDK – der Browser wird selbst zum Spotify-Gerät „Musikclient".
   Handy/Tablet (dort läuft das SDK nicht): Fernsteuerung der offiziellen Spotify-App über Spotify Connect.
   Beide Wege teilen dieselben Befehle (/me/player/...); der Zustand kommt vom SDK oder per Abfrage. */
import { api, ApiError } from './api'
import { accessToken } from './auth'

export interface PlayerState {
  playing: boolean
  track: { name: string; artists: string[]; image?: string; uri: string; durationMs: number }
  progressMs: number
  at: number   // Zeitpunkt von progressMs, damit der Fortschritt lokal weiterlaufen kann
  device?: { id: string; name: string }
}
export interface Device { id: string; name: string; type: string; is_active: boolean }

let state: PlayerState | null = null
const subs = new Set<() => void>()
const set = (s: PlayerState | null) => { state = s; subs.forEach(f => f()) }
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
export const getState = () => state

// iPadOS meldet sich als „Macintosh": an den Touchpunkten erkennen
export const isMobile = /Android|iPhone|iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

let webDevice: string | null = null   // Geräte-ID des Browser-Players, sobald bereit
let sdk: any = null
export const usesWebPlayer = () => !!webDevice && state?.device?.id === webDevice

/** Browser-Player starten (nur PC, Spotify Premium nötig). Fehler sind still: dann bleibt die Fernsteuerung. */
export function startWebPlayer() {
  if (isMobile || sdk || document.getElementById('spotify-sdk')) return
  ;(window as any).onSpotifyWebPlaybackSDKReady = () => {
    sdk = new (window as any).Spotify.Player({
      name: 'Musikclient', volume: .8,
      getOAuthToken: (cb: (t: string) => void) => { accessToken().then(t => t && cb(t)) },
    })
    sdk.addListener('ready', ({ device_id }: { device_id: string }) => { webDevice = device_id })
    sdk.addListener('not_ready', () => { webDevice = null })
    for (const ev of ['initialization_error', 'authentication_error', 'account_error'])
      sdk.addListener(ev, ({ message }: { message: string }) => console.warn('Web Playback SDK:', ev, message))
    sdk.addListener('player_state_changed', (s: any) => {   // kommt vom SDK selbst: keine API-Anfrage nötig
      const t = s?.track_window?.current_track
      if (!t) return
      set({
        playing: !s.paused, progressMs: s.position, at: Date.now(), device: { id: webDevice!, name: 'Musikclient (dieser Browser)' },
        track: { name: t.name, artists: t.artists.map((a: any) => a.name), image: t.album?.images?.[0]?.url, uri: t.uri, durationMs: s.duration },
      })
    })
    sdk.connect()
  }
  const el = document.createElement('script')
  el.id = 'spotify-sdk'; el.src = 'https://sdk.scdn.co/spotify-player.js'
  document.head.append(el)
}

/** Aktuellen Zustand bei Spotify abfragen (für die Fernsteuerung; kostet eine Anfrage). */
export async function refresh() {
  const j = await api('/me/player')   // 204 = gerade nichts aktiv
  const t = j?.item
  set(t ? {
    playing: j.is_playing, progressMs: j.progress_ms ?? 0, at: Date.now(), device: j.device && { id: j.device.id, name: j.device.name },
    track: { name: t.name, artists: (t.artists ?? []).map((a: any) => a.name), image: (t.album?.images?.[1] ?? t.album?.images?.[0])?.url, uri: t.uri, durationMs: t.duration_ms },
  } : null)
}

async function cmd(method: string, path: string, body?: unknown) {
  await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!usesWebPlayer()) setTimeout(() => refresh().catch(() => {}), 700)   // Fernsteuerung: neuen Zustand holen
}

const friendly = (e: unknown) => {
  if (e instanceof ApiError && e.status === 404) return new Error('Kein aktives Spotify-Gerät. Öffne kurz die Spotify-App (Handy oder PC) und starte dort einen Song – danach lässt sie sich von hier steuern.')
  if (e instanceof ApiError && e.status === 403) return new Error('Spotify erlaubt die Steuerung nur mit Premium.')
  return e
}

/** Abspielen: einzelne Songs (uris) oder eine Playlist ab einem Song (context_uri + offset). */
export async function play(body: { uris?: string[]; context_uri?: string; offset?: { uri: string } }) {
  sdk?.activateElement?.()   // Browser erlauben Ton nur nach einer Berührung: diese Berührung gilt
  try { await cmd('PUT', '/me/player/play', body) }   // ohne device_id: das gerade aktive Gerät
  catch (e) {
    if (!(e instanceof ApiError && e.status === 404 && webDevice)) throw friendly(e)
    try { await cmd('PUT', `/me/player/play?device_id=${webDevice}`, body) } catch (e2) { throw friendly(e2) }   // keins aktiv: Browser-Player
  }
}

const safe = (p: Promise<unknown>) => p.catch(e => { throw friendly(e) })
// Läuft der Ton im Browser, steuert das SDK selbst: keine Anfrage an die Web API, zählt nicht ins Spotify-Limit
const local = (f: string, path: string, method = 'POST') => usesWebPlayer() ? sdk[f]() as Promise<void> : safe(cmd(method, path))
export const pause = () => local('pause', '/me/player/pause', 'PUT')
export const resume = () => local('resume', '/me/player/play', 'PUT')
export const next = () => local('nextTrack', '/me/player/next')
export const previous = () => local('previousTrack', '/me/player/previous')
export const devices = async () => (await api<{ devices: Device[] }>('/me/player/devices')).devices.filter(d => d.id)
export const transfer = (id: string) => safe(cmd('PUT', '/me/player', { device_ids: [id], play: true }))
