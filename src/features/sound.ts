/* Klangdaten: Tempo, Energie, Tanzbarkeit, Stimmung … von ReccoBeats (kostenlos, ohne Schlüssel, per Spotify-ID).
   Fehlt ein Song dort, schätzt die KI die Werte; im Hintergrund werden andere Spotify-Versionen desselben Songs probiert.
   Damit vergleicht die App Songs nach Klang: die ähnlichsten Songs der Sammlung stimmen für ihre Playlists. */
import { completeJson, status } from '../ai'
import { db, type Sound, type Track } from '../data/db'
import { api } from '../spotify/api'

const BATCH = 40          // ReccoBeats: Songs pro Abfrage
const AI_BATCH = 50       // KI-Schätzung: Songs pro Anfrage

export type Feat = Omit<Sound, 'id' | 'src' | 'at' | 'alt' | 'tried'>
export const KEYS = ['tempo', 'energy', 'danceability', 'valence', 'acousticness', 'instrumentalness', 'speechiness'] as const
export type FeatKey = typeof KEYS[number]
/** Klangvergleich einstellbar (Feinabstimmung unter Werkzeuge): k = so viele ähnliche Songs stimmen ab, w = Faktor je Merkmal. */
export interface SoundParams { k: number; w: Partial<Record<FeatKey, number>> }
export const DEFAULT_SOUND: SoundParams = { k: 20, w: {} }

const spotifyId = (x: any): string | undefined => x?.href?.match(/track\/([A-Za-z0-9]+)/)?.[1]
const pickFeat = (x: any): Feat => Object.fromEntries(KEYS.filter(k => typeof x?.[k] === 'number').map(k => [k, x[k]]))

/** Klangdaten für bis zu 40 Spotify-IDs. Ergebnis: Spotify-ID → Werte (unbekannte fehlen). */
export async function fetchSound(ids: string[], retry = 0): Promise<Map<string, Feat>> {
  const r = await fetch(`https://api.reccobeats.com/v1/audio-features?ids=${ids.join(',')}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (r.status === 429 && retry < 2) {   // kurz warten, wenn ReccoBeats bremst
    await new Promise(res => setTimeout(res, Math.min(30, Number(r.headers.get('retry-after')) || 5) * 1000))
    return fetchSound(ids, retry + 1)
  }
  const text = await r.text()
  if (!r.ok) throw new Error(`ReccoBeats ${r.status}: ${text.slice(0, 160)}`)
  const out = new Map<string, Feat>()
  for (const x of JSON.parse(text).content ?? []) { const id = spotifyId(x); if (id) out.set(id, pickFeat(x)) }
  return out
}

/** Alle Songs der Sammlung ohne Klangdaten bei ReccoBeats abfragen. Nicht gefundene werden als „fehlt“ gemerkt. */
export async function syncSound(onProgress?: (done: number, todo: number) => void) {
  const d = await db
  const have = new Set(await d.getAllKeys('sound'))
  const ids = [...new Set((await d.getAll('tracks')).flatMap(t => t.tracks.map(x => x.id)))].filter(id => !have.has(id))
  const batches = Math.ceil(ids.length / BATCH)
  for (let b = 0; b < batches; b++) {
    onProgress?.(b, batches)
    const part = ids.slice(b * BATCH, (b + 1) * BATCH)
    const got = await fetchSound(part)
    const tx = d.transaction('sound', 'readwrite')
    for (const id of part) tx.store.put(got.has(id) ? { id, src: 'echt', at: Date.now(), ...got.get(id) } : { id, src: 'fehlt', at: Date.now() })
    await tx.done
    if (b < batches - 1) await new Promise(r => setTimeout(r, 300))
  }
  return batches
}

const clamp01 = (v: unknown) => typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined

/** Fehlende Klangdaten von der KI schätzen lassen (aus ihrem Wissen über Song und Künstler). */
export async function estimateSound(onProgress?: (done: number, todo: number) => void) {
  const d = await db
  const missing = new Set((await d.getAll('sound')).filter(s => s.src === 'fehlt').map(s => s.id))
  const tracks = [...new Map((await d.getAll('tracks')).flatMap(t => t.tracks).filter(t => missing.has(t.id)).map(t => [t.id, t])).values()]
  const batches = Math.ceil(tracks.length / AI_BATCH)
  for (let b = 0; b < batches; b++) {
    onProgress?.(b, batches)
    const part = tracks.slice(b * AI_BATCH, (b + 1) * AI_BATCH)
    const { data } = await completeJson<{ songs: ({ i: number } & Feat)[] }>({
      system: 'Du bist Musikexperte und schätzt Klangeigenschaften von Songs. Antworte ausschließlich mit JSON.',
      prompt: `Schätze für jeden Song: tempo (BPM), energy, danceability, valence (fröhlich=1, traurig=0), acousticness, instrumentalness, speechiness (Sprechgesang/Rap hoch) – alle außer tempo von 0 bis 1, wie bei Spotify.
Format: {"songs":[{"i":0,"tempo":95,"energy":0.6,"danceability":0.7,"valence":0.4,"acousticness":0.1,"instrumentalness":0,"speechiness":0.2}]}

${part.map((t, i) => `${i}: ${t.artists.join(', ')} – ${t.name}${t.year ? ` (${t.year})` : ''}`).join('\n')}`,
    })
    const tx = d.transaction('sound', 'readwrite')
    for (const x of data.songs ?? []) {
      const t = part[x.i]
      if (!t) continue
      const f: Feat = { tempo: typeof x.tempo === 'number' ? Math.min(220, Math.max(40, x.tempo)) : undefined }
      for (const k of KEYS.slice(1)) f[k] = clamp01(x[k])
      tx.store.put({ id: t.id, src: 'schätzung', at: Date.now(), ...f })
    }
    await tx.done
    if (b < batches - 1) await new Promise(r => setTimeout(r, 4000))
  }
  return batches
}

/** Für geschätzte/fehlende Songs andere Spotify-Versionen suchen und deren echte Daten übernehmen.
    shortcut: höchstens `max` Songs pro Abgleich (je 1 Spotify-Suche), damit das Spotify-Limit geschont wird. */
export async function findAlternates(max = 15) {
  const d = await db
  const open = (await d.getAll('sound')).filter(s => s.src !== 'echt' && !s.tried).slice(0, max)
  if (!open.length) return 0
  const trackOf = new Map((await d.getAll('tracks')).flatMap(t => t.tracks).map(t => [t.id, t]))
  let found = 0
  for (const s of open) {
    const t = trackOf.get(s.id)
    if (!t) { await d.put('sound', { ...s, tried: true }); continue }
    const res = await api(`/search?type=track&limit=10&q=${encodeURIComponent(`track:${t.name} artist:${t.artists[0]}`)}`)
    const alts = (res?.tracks?.items ?? []).filter((x: any) => x?.id && x.id !== t.id && x.name?.toLowerCase().startsWith(t.name.toLowerCase().slice(0, 12))).map((x: any) => x.id)
    const got = alts.length ? await fetchSound(alts.slice(0, 10)) : new Map<string, Feat>()
    const alt = alts.find((a: string) => got.has(a))
    await d.put('sound', alt ? { id: s.id, src: 'echt', at: Date.now(), alt, tried: true, ...got.get(alt) } : { ...s, tried: true })
    if (alt) found++
    await new Promise(r => setTimeout(r, 2000))
  }
  return found
}

// Abstand im Klangraum: Sprechgesang und Energie trennen Genres am stärksten, Tempo ist wegen halb/doppelt unsicher
const W: Record<typeof KEYS[number], number> = { tempo: .5, energy: 1.2, danceability: 1, valence: 1, acousticness: .9, instrumentalness: .6, speechiness: 1.3 }
const norm = (k: typeof KEYS[number], v: number) => k === 'tempo' ? Math.min(1, Math.max(0, (v - 60) / 140)) : v
export function distance(a: Feat, b: Feat, mul: SoundParams['w'] = {}) {
  let sum = 0, w = 0
  for (const k of KEYS) {
    if (a[k] == null || b[k] == null) continue
    const wk = W[k] * (mul[k] ?? 1)
    sum += wk * (norm(k, a[k]!) - norm(k, b[k]!)) ** 2; w += wk
  }
  return w ? Math.sqrt(sum / w) : Infinity
}

/** Klangdaten eines (neuen) Songs: aus dem Speicher, sonst live von ReccoBeats. null = keine. */
export async function soundOf(t: Track, stored: Map<string, Sound>): Promise<Feat | null> {
  const s = stored.get(t.id)
  if (s && s.src !== 'fehlt') return s
  if (s) return null   // schon bekannt: ReccoBeats hat ihn nicht
  try {
    status('frage Klangdaten ab')
    const got = (await fetchSound([t.id])).get(t.id)
    await (await db).put('sound', got ? { id: t.id, src: 'echt', at: Date.now(), ...got } : { id: t.id, src: 'fehlt', at: Date.now() })
    return got ?? null
  } catch { return null }
}

/** Die ähnlichsten Songs der Sammlung stimmen für ihre Playlists. Ergebnis: Playlist-ID → Anteil 0–1. */
export function soundVotes(f: Feat, stored: Map<string, Sound>, inPl: Map<string, string[]>, skipId?: string, p: SoundParams = DEFAULT_SOUND) {
  return votesOf(nearest(f, stored, inPl, skipId, p.w), p.k)
}

/** Alle Songs der Sammlung mit Klangdaten, nach Abstand sortiert (der Song selbst nie). */
export function nearest(f: Feat, stored: Map<string, Sound>, inPl: Map<string, string[]>, skipId?: string, mul: SoundParams['w'] = {}) {
  const near: { d: number; feat: Feat; pls: string[] }[] = []
  for (const [id, s] of stored) {
    if (id === skipId || s.src === 'fehlt' || !inPl.has(id)) continue
    near.push({ d: distance(f, s, mul), feat: s, pls: inPl.get(id)! })
  }
  return near.sort((a, b) => a.d - b.d)
}

/** Die k nächsten stimmen ab, nähere zählen mehr. Ergebnis: Playlist-ID → Anteil 0–1. */
export function votesOf(near: { d: number; pls: string[] }[], k: number) {
  const votes = new Map<string, number>()
  let total = 0
  for (const { d, pls } of near.slice(0, k)) {
    const w = 1 / (.05 + d)
    for (const p of pls) votes.set(p, (votes.get(p) ?? 0) + w)
    total += w
  }
  for (const [p, v] of votes) votes.set(p, v / (total || 1))
  return votes
}

/** Abdeckung für die Anzeige unter Optionen. */
export async function soundStats() {
  const all = await (await db).getAll('sound')
  return { echt: all.filter(s => s.src === 'echt').length, schätzung: all.filter(s => s.src === 'schätzung').length, fehlt: all.filter(s => s.src === 'fehlt').length }
}
