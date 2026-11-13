/* Playlist-Vorschläge für einen Song: lokale Punkte (Künstler schon drin, Epoche, frühere Entscheidungen),
   dann eine KI-Anfrage, die aus den Kandidaten die 3 besten wählt und begründet. Ohne KI: die 3 mit den meisten Punkten. */
import { completeJson, hasAi } from '../ai'
import { db, type Choice, type Playlist, type Profile, type Track } from '../data/db'
import { addToPlaylist } from '../spotify/api'

export interface Suggestion { playlist: Playlist; reason: string }
export interface SuggestResult { suggestions: Suggestion[]; contains: Playlist[]; provider: string }

interface Cand { p: Playlist; prof?: Profile; k: number; w: number; era: boolean; score: number }

const MAX_CANDIDATES = 80   // shortcut: Kandidaten-Obergrenze für die KI-Anfrage, bei sehr vielen Playlists Vorauswahl verfeinern

/** Lokale Punkte einer Playlist für einen Song. Exportiert für den Selbsttest. */
export function score(song: Track, tracks: Track[], prof: Profile | undefined, choices: Choice[], playlistId: string) {
  const ids = new Set(song.artistIds)
  const k = tracks.filter(t => t.artistIds.some(a => ids.has(a))).length                      // Songs desselben Künstlers
  const mine = choices.filter(c => c.playlistId === playlistId)
  const w = mine.filter(c => c.artistIds.some(a => ids.has(a))).length                        // früher gewählt, gleicher Künstler
  const y = prof?.years, era = !!(song.year && y && song.year >= y[0] - 3 && song.year <= y[1] + 3)
  return { k, w, era, score: Math.min(k, 5) * 2 + w * 3 + (era ? 2 : 0) + Math.min(mine.length, 6) * .25 }
}

export async function suggest(song: Track): Promise<SuggestResult> {
  const d = await db
  const [all, profiles, choices] = await Promise.all([d.getAll('playlists'), d.getAll('profiles'), d.getAll('choices')])
  const profOf = new Map(profiles.map(p => [p.id, p]))
  const cands: Cand[] = [], contains: Playlist[] = []
  for (const p of all) {
    if (!p.ownedByMe && !p.collaborative) continue   // in fremde Playlists kann man nichts legen
    const tracks = (await d.get('tracks', p.id))?.tracks ?? []
    if (tracks.some(t => t.id === song.id)) { contains.push(p); continue }
    cands.push({ p, prof: profOf.get(p.id), ...score(song, tracks, profOf.get(p.id), choices, p.id) })
  }
  cands.sort((a, b) => b.score - a.score)
  const pool = cands.slice(0, MAX_CANDIDATES)

  let picks: Suggestion[] = [], provider = 'lokal'
  if (pool.length > 3 && await hasAi()) {
    const lines = pool.map((c, i) => JSON.stringify({
      i, n: c.p.name, g: c.prof?.genres.join(', '), e: c.prof?.era, m: c.prof?.mood, ...(c.k ? { k: c.k } : {}), ...(c.w ? { w: c.w } : {}),
    })).join('\n')
    const res = await completeJson<{ suggestions: { i: number; reason: string }[] }>({
      system: 'Du ordnest Songs den passenden Playlists eines Nutzers zu. Antworte ausschließlich mit JSON.',
      prompt: `Song: ${song.name} – ${song.artists.join(', ')}${song.year ? ` (${song.year})` : ''}, Album „${song.album}“
Wähle die 3 Playlists, in die dieser Song am besten passt, beste zuerst. Begründe jede mit einem kurzen deutschen Satz (höchstens 15 Wörter), konkret zu Genre, Stimmung oder Künstlern.
Felder: i = Nummer, n = Name, g = Genres, e = Epoche, m = Stimmung, k = Songs desselben Künstlers schon in der Playlist, w = wie oft ich Songs dieses Künstlers schon dorthin gelegt habe.
Format: {"suggestions":[{"i":0,"reason":"…"}]}

Playlists:
${lines}`,
    })
    provider = res.provider
    const seen = new Set<number>()
    for (const s of res.data.suggestions ?? []) {
      if (!pool[s.i] || seen.has(s.i)) continue   // erfundene oder doppelte Nummern verwerfen
      seen.add(s.i); picks.push({ playlist: pool[s.i].p, reason: String(s.reason ?? '') })
    }
    picks = picks.slice(0, 3)
  }
  // Auffüllen (ohne KI oder bei lückenhafter Antwort) mit den lokal besten
  for (const c of pool) {
    if (picks.length >= 3) break
    if (picks.some(s => s.playlist.id === c.p.id)) continue
    picks.push({ playlist: c.p, reason: localReason(song, c) })
  }
  return { suggestions: picks, contains, provider }
}

function localReason(song: Track, c: Cand) {
  if (c.w) return `Dorthin hast du ${song.artists[0]} schon ${c.w}× gelegt.`
  if (c.k) return c.k > 1 ? `${c.k} Songs von ${song.artists[0]} sind schon drin.` : `Ein Song von ${song.artists[0]} ist schon drin.`
  if (c.era) return `Passt zur Epoche der Playlist (${c.prof?.era}).`
  return c.prof?.summary || 'Allgemein passend.'
}

/** Song hinzufügen und die Wahl fürs Lernen merken. */
export async function choose(song: Track, playlist: Playlist, suggested: string[]) {
  await addToPlaylist(playlist.id, song.uri)
  const d = await db
  await d.add('choices', { trackId: song.id, artistIds: song.artistIds, playlistId: playlist.id, suggested, at: Date.now() })
  // Sofort lokal vermerken, damit der Song als „schon drin" gilt; der nächste Abgleich liest die Playlist ohnehin neu
  const pt = await d.get('tracks', playlist.id)
  if (pt) { pt.tracks.push(song); await d.put('tracks', pt) }
}
