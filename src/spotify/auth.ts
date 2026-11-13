import { kv } from '../data/db'

const SCOPES = [
  'playlist-read-private', 'playlist-read-collaborative',
  'playlist-modify-private', 'playlist-modify-public',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'streaming', 'user-read-private', 'user-read-email',
].join(' ')

export const redirectUri = () => location.origin + import.meta.env.BASE_URL

interface Tokens { access: string; refresh: string; expires: number }

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function login() {
  const clientId = await kv.get<string>('clientId')
  if (!clientId) throw new Error('Bitte zuerst die Client ID in den Einstellungen eintragen.')
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)))
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  await kv.set('pkce', { verifier, state })
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  })
}

async function tokenRequest(body: Record<string, string>) {
  const clientId = (await kv.get<string>('clientId'))!
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...body }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error_description || j.error || 'Token-Fehler')
  const old = await kv.get<Tokens>('tokens')
  const t: Tokens = {
    access: j.access_token,
    refresh: j.refresh_token ?? old?.refresh, // Spotify liefert nicht immer einen neuen Refresh-Token
    expires: Date.now() + (j.expires_in - 60) * 1000,
  }
  await kv.set('tokens', t)
  return t
}

/** Nach dem Redirect von Spotify: Code gegen Tokens tauschen. Gibt true zurück, wenn ein Login abgeschlossen wurde. */
export async function handleRedirect() {
  const q = new URLSearchParams(location.search)
  const code = q.get('code'), err = q.get('error')
  if (!code && !err) return false
  history.replaceState(null, '', redirectUri())
  if (err) throw new Error('Spotify-Login abgebrochen: ' + err)
  const pkce = await kv.get<{ verifier: string; state: string }>('pkce')
  if (!pkce || pkce.state !== q.get('state')) throw new Error('Login-Status passt nicht – bitte erneut anmelden.')
  await kv.del('pkce')
  await tokenRequest({ grant_type: 'authorization_code', code: code!, redirect_uri: redirectUri(), code_verifier: pkce.verifier })
  return true
}

let refreshing: Promise<Tokens> | null = null

/** Gültiger Access-Token oder null (= nicht eingeloggt). force: auch einen noch nicht abgelaufenen erneuern. */
export async function accessToken(force = false): Promise<string | null> {
  const t = await kv.get<Tokens>('tokens')
  if (!t) return null
  if (!force && Date.now() < t.expires) return t.access
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }).finally(() => { refreshing = null })
  try { return (await refreshing).access } catch { await kv.del('tokens'); return null }
}

export const logout = async () => { await kv.del('tokens'); await kv.del('user') }   // anderes Konto: Nutzer-ID neu holen
