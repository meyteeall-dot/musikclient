/* Werkzeuge rund um bestehende Playlists: Fremdkörper (KI), doppelte Songs (lokal), Beschreibung schreiben (KI → Spotify). */
import { completeJson } from '../ai'
import { db, type Playlist, type Track } from '../data/db'
import { api } from '../spotify/api'

const MAX_SONGS = 250   // shortcut: längere Playlists werden nur bis hier geprüft; bei Bedarf in Stapeln prüfen
const line = (t: Track) => `${t.artists.join(', ')} – ${t.name}${t.year ? ` (${t.year})` : ''}`

export interface Outlier { track: Track; reason: string; better?: Playlist }

/** Songs, die nicht zum Rest der Playlist passen – mit Vorschlag, wohin sie besser gehören. Eine KI-Anfrage. */
export async function findOutliers(p: Playlist): Promise<Outlier[]> {
  const d = await db
  const tracks = ((await d.get('tracks', p.id))?.tracks ?? []).slice(0, MAX_SONGS)
  if (tracks.length < 5) throw new Error('Zu wenige Songs, um Ausreißer zu erkennen.')
  const prof = await d.get('profiles', p.id)
  const others = (await d.getAll('playlists')).filter(o => o.id !== p.id && (o.ownedByMe || o.collaborative))
  const profOf = new Map((await d.getAll('profiles')).map(x => [x.id, x]))
  const res = await completeJson<{ outliers: { i: number; reason: string; better?: number }[] }>({
    system: 'Du hilfst einem Nutzer, der seine Playlists sehr genau nach Klang, Stimmung, Genre und Epoche sortiert. Antworte ausschließlich mit JSON.',
    prompt: `Playlist „${p.name}“${prof ? ` – ${[prof.genres.join(', '), prof.era, prof.mood].filter(Boolean).join(' · ')}` : ''}
Welche Songs passen deutlich NICHT zum Rest dieser Playlist? Nur klare Ausreißer, lieber wenige als viele (höchstens 10).
Begründe jeden mit einem kurzen deutschen Satz und nenne, falls passend, die Nummer einer anderen Playlist, in die er besser passt.
Format: {"outliers":[{"i":0,"reason":"…","better":3}]}

Songs:
${tracks.map((t, i) => `${i}: ${line(t)}`).join('\n')}

Andere Playlists:
${others.map((o, i) => `${i}: ${o.name}${profOf.get(o.id) ? ` (${profOf.get(o.id)!.genres.slice(0, 3).join(', ')})` : ''}`).join('\n')}`,
  })
  return (res.data.outliers ?? []).filter(o => tracks[o.i]).slice(0, 10)
    .map(o => ({ track: tracks[o.i], reason: String(o.reason ?? ''), better: o.better != null ? others[o.better] : undefined }))
}

export interface Dupe { playlist: Playlist; name: string; count: number; versions: boolean }

// "Song - Remastered 2011", "Song (feat. X)", "Song – Radio Edit" → "song"
const norm = (t: Track) => `${t.artists[0]}|${t.name}`.toLowerCase().replace(/\s*[-–(\[].*(remaster|edit|version|mix|live|feat|mono|stereo|deluxe).*$/i, '').trim()

/** Doppelte Songs innerhalb einer Playlist: genau gleich oder andere Version desselben Songs. Lokal, ohne Anfragen. */
export async function findDuplicates(): Promise<Dupe[]> {
  const d = await db
  const out: Dupe[] = []
  for (const p of await d.getAll('playlists')) {
    if (!p.ownedByMe && !p.collaborative) continue
    const groups = new Map<string, Track[]>()
    for (const t of (await d.get('tracks', p.id))?.tracks ?? []) groups.set(norm(t), [...(groups.get(norm(t)) ?? []), t])
    for (const g of groups.values()) if (g.length > 1)
      out.push({ playlist: p, name: line(g[0]), count: g.length, versions: new Set(g.map(t => t.id)).size > 1 })
  }
  return out
}

/** Kurze Playlist-Beschreibung von der KI (nur Vorschlag, wird erst mit saveDescription übernommen). */
export async function writeDescription(p: Playlist) {
  const d = await db
  const tracks = (await d.get('tracks', p.id))?.tracks ?? []
  const prof = await d.get('profiles', p.id)
  const step = Math.max(1, Math.floor(tracks.length / 20))
  const res = await completeJson<{ description: string }>({
    system: 'Du schreibst kurze, stimmige Spotify-Playlist-Beschreibungen auf Deutsch. Antworte ausschließlich mit JSON.',
    prompt: `Schreibe eine Beschreibung für die Playlist „${p.name}“: 1–2 Sätze, höchstens 250 Zeichen, ohne Hashtags, ohne Emojis, ohne Anführungszeichen. Sie soll Stimmung und Klang treffen, nicht Songs aufzählen.
${prof ? `Profil: ${[prof.genres.join(', '), prof.era, prof.mood, prof.summary].filter(Boolean).join(' · ')}\n` : ''}${p.description ? `Bisherige Beschreibung: ${p.description}\n` : ''}Songs: ${tracks.filter((_, i) => i % step === 0).slice(0, 20).map(line).join('; ')}
Format: {"description":"…"}`,
  })
  return String(res.data.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** Beschreibung in Spotify eintragen (nur eigene Playlists). */
export async function saveDescription(p: Playlist, description: string) {
  await api(`/playlists/${p.id}`, { method: 'PUT', body: JSON.stringify({ description }) })
  const d = await db
  await d.put('playlists', { ...p, description })
}
