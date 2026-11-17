/* Klangdaten (Tempo, Energie, Tanzbarkeit …) von ReccoBeats – kostenlos, ohne Schlüssel, per Spotify-ID.
   Erst als Test: klappt der Abruf direkt aus dem Browser? */
import { db, type Track } from '../data/db'

export interface Sound { id: string; tempo?: number; energy?: number; danceability?: number; valence?: number; acousticness?: number; instrumentalness?: number; speechiness?: number }

const spotifyId = (x: any): string | undefined => x?.href?.match(/track\/([A-Za-z0-9]+)/)?.[1] ?? x?.spotifyId

export async function fetchSound(ids: string[]) {
  const r = await fetch(`https://api.reccobeats.com/v1/audio-features?ids=${ids.join(',')}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  const text = await r.text()
  if (!r.ok) throw new Error(`ReccoBeats ${r.status}: ${text.slice(0, 160)}`)
  const j = JSON.parse(text)
  return ((j.content ?? j.audio_features ?? []) as any[]).map(x => ({ ...x, id: spotifyId(x) ?? x.id }) as Sound)
}

/** 5 zufällige Songs der Sammlung abfragen. Ergebnis als lesbare Zeilen. */
export async function testSound() {
  const d = await db
  const all: Track[] = (await d.getAll('tracks')).flatMap(t => t.tracks)
  const pick = all.sort(() => Math.random() - .5).slice(0, 5)
  if (!pick.length) throw new Error('Noch keine Songs eingelesen.')
  let got: Sound[]
  try { got = await fetchSound(pick.map(t => t.id)) }
  catch (e) {
    const m = (e as Error).message
    // fetch scheitert ohne Statuscode: meist blockiert der Dienst Aufrufe aus dem Browser (CORS) oder ist nicht erreichbar
    throw new Error(m === 'Failed to fetch' || m.includes('NetworkError') || m.includes('Load failed') ? 'Abruf aus dem Browser blockiert oder Dienst nicht erreichbar.' : m)
  }
  const byId = new Map(got.map(s => [s.id, s]))
  const f = (v?: number) => v == null ? '–' : Math.round(v * 100) + ' %'
  return pick.map(t => {
    const s = byId.get(t.id)
    return `${t.artists[0]} – ${t.name}: ${s ? `Tempo ${Math.round(s.tempo ?? 0)} · Energie ${f(s.energy)} · Tanzbar ${f(s.danceability)} · Stimmung ${f(s.valence)} · Akustisch ${f(s.acousticness)}` : 'keine Daten'}`
  }).concat(`→ ${got.length} von ${pick.length} Songs mit Klangdaten`)
}
