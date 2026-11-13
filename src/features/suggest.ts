/* Playlist-Vorschläge für einen Song: lokale Punkte (Künstler schon drin, Epoche, frühere Entscheidungen),
   dann eine KI-Anfrage, die aus den Kandidaten die 3 besten wählt und begründet. Ohne KI: die 3 mit den meisten Punkten. */
import { completeJson, hasAi } from '../ai'
import { db, kv, type Choice, type Playlist, type Profile, type Track } from '../data/db'
import { addToPlaylist } from '../spotify/api'

export interface Suggestion { playlist: Playlist; reason: string }
export interface SuggestResult { suggestions: Suggestion[]; contains: Playlist[]; provider: string }

interface Cand { p: Playlist; prof?: Profile; tracks: Track[]; k: number; w: number; era: boolean; score: number }

const SHORTLIST = 8   // Stufe 1 wählt so viele Kandidaten, Stufe 2 sieht von ihnen echte Songs
const SONGS_PER_CAND = 25

/** Lokale Punkte einer Playlist für einen Song. Ablehnungen („auf keinen Fall") desselben Künstlers ziehen stark ab. */
export function score(song: Track, tracks: Track[], prof: Profile | undefined, choices: Choice[], playlistId: string) {
  const ids = new Set(song.artistIds), sameArtist = (c: Choice) => c.artistIds.some(a => ids.has(a))
  const k = tracks.filter(t => t.artistIds.some(a => ids.has(a))).length                      // Songs desselben Künstlers
  const mine = choices.filter(c => c.playlistId === playlistId && !c.rejected)
  const w = mine.filter(sameArtist).length                                                   // früher gewählt, gleicher Künstler
  const no = choices.filter(c => c.playlistId === playlistId && c.rejected && sameArtist(c)).length
  const y = prof?.years, era = !!(song.year && y && song.year >= y[0] - 3 && song.year <= y[1] + 3)
  return { k, w, era, score: Math.min(k, 5) * 2 + w * 3 - no * 4 + (era ? 2 : 0) + Math.min(mine.length, 6) * .25 }
}

/** Playlists, die nie vorgeschlagen werden (und kein KI-Profil brauchen). Lokal gespeichert, übersteht jeden Abgleich. */
export const getExcluded = async () => new Set((await kv.get<string[]>('excluded')) ?? [])
export async function setExcluded(id: string, on: boolean) {
  const ex = await getExcluded()
  if (on) ex.add(id); else ex.delete(id)
  await kv.set('excluded', [...ex])
}

/** Bis zu n Songs einer Playlist, die der KI zeigen, wie sie klingt: zuerst gleicher Künstler, dann nahe Jahre, dann quer verteilt. */
function sample(song: Track, tracks: Track[], n: number) {
  const ids = new Set(song.artistIds)
  const same = tracks.filter(t => t.artistIds.some(a => ids.has(a)))
  const rest = tracks.filter(t => !same.includes(t))
  const near = song.year ? [...rest].sort((a, b) => Math.abs((a.year ?? 0) - song.year!) - Math.abs((b.year ?? 0) - song.year!)).slice(0, Math.ceil(n / 3)) : []
  const spread = rest.filter(t => !near.includes(t)), step = Math.max(1, spread.length / n)
  const out = [...same.slice(0, Math.ceil(n / 3)), ...near]
  for (let i = 0; out.length < n && i < spread.length; i += step) out.push(spread[Math.floor(i)])
  return out.slice(0, n).map(t => `${t.artists[0]} – ${t.name}${t.year ? ` (${t.year})` : ''}`)
}

const SYSTEM = 'Du ordnest Songs den passenden Playlists eines Nutzers zu. Der Nutzer sortiert sehr genau nach Klang, Stimmung, Genre und Epoche. Antworte ausschließlich mit JSON.'
const songLine = (s: Track) => `${s.name} – ${s.artists.join(', ')}${s.year ? ` (${s.year})` : ''}, Album „${s.album}“`

/** test: Trefferquote – der Song wird aus seinen eigenen Playlists herausgerechnet, als wäre er neu. */
export async function suggest(song: Track, opts: { test?: boolean } = {}): Promise<SuggestResult> {
  const d = await db
  const [all, profiles, allChoices, excluded] = await Promise.all([d.getAll('playlists'), d.getAll('profiles'), d.getAll('choices'), getExcluded()])
  const choices = opts.test ? allChoices.filter(c => c.trackId !== song.id) : allChoices
  const never = new Set(choices.filter(c => c.rejected && c.trackId === song.id).map(c => c.playlistId))
  const profOf = new Map(profiles.map(p => [p.id, p]))
  const cands: Cand[] = [], contains: Playlist[] = []
  for (const p of all) {
    if ((!p.ownedByMe && !p.collaborative) || excluded.has(p.id) || never.has(p.id)) continue   // fremde, ignorierte, „auf keinen Fall"
    let tracks = (await d.get('tracks', p.id))?.tracks ?? []
    if (tracks.some(t => t.id === song.id)) {
      if (!opts.test) { contains.push(p); continue }
      tracks = tracks.filter(t => t.id !== song.id)
    }
    cands.push({ p, prof: profOf.get(p.id), tracks, ...score(song, tracks, profOf.get(p.id), choices, p.id) })
  }
  cands.sort((a, b) => b.score - a.score)

  let picks: Suggestion[] = [], provider = 'lokal'
  if (cands.length > 3 && await hasAi()) {
    // Stufe 1: aus allen Playlists (Kurzprofil) die engere Wahl, ergänzt um die lokal stärksten
    let short = cands.slice(0, SHORTLIST)
    if (cands.length > SHORTLIST) {
      const lines = cands.map((c, i) => JSON.stringify({
        i, n: c.p.name, g: c.prof?.genres.join(', '), e: c.prof?.era, m: c.prof?.mood, ...(c.k ? { k: c.k } : {}), ...(c.w ? { w: c.w } : {}),
      })).join('\n')
      const r1 = await completeJson<{ top: number[] }>({ system: SYSTEM, prompt: `Song: ${songLine(song)}
Wähle die ${SHORTLIST} Playlists, in die dieser Song am ehesten passen könnte, beste zuerst.
Felder: i = Nummer, n = Name, g = Genres, e = Epoche, m = Stimmung, k = Songs desselben Künstlers schon drin, w = wie oft ich diesen Künstler schon dorthin gelegt habe.
Format: {"top":[0,1,…]}

Playlists:
${lines}` })
      const idx = [...new Set((r1.data.top ?? []).filter(i => cands[i]))].slice(0, SHORTLIST)
      short = [...idx.map(i => cands[i]), ...cands.filter(c => c.score > 0).slice(0, 4)].filter((c, i, a) => a.indexOf(c) === i)
    }
    // Stufe 2: die engere Wahl mit echten Songs aus jeder Playlist – daran erkennt die KI den Stil viel genauer
    const blocks = short.map((c, i) => `[${i}] ${c.p.name}${c.prof ? ` – ${[c.prof.genres.join(', '), c.prof.era, c.prof.mood].filter(Boolean).join(' · ')}` : ''}${c.prof?.summary ? `\n${c.prof.summary}` : ''}${c.w ? `\nIch habe ${c.w}× Songs dieses Künstlers hierher gelegt.` : ''}
Songs: ${sample(song, c.tracks, SONGS_PER_CAND).join('; ') || '(keine Songs bekannt)'}`).join('\n\n')
    const res = await completeJson<{ suggestions: { i: number; reason: string }[] }>({ system: SYSTEM, prompt: `Song: ${songLine(song)}
Wähle die 3 Playlists, in die dieser Song am besten passt, beste zuerst. Vergleiche mit den Songs, die schon drin sind. Begründe jede mit einem kurzen deutschen Satz (höchstens 15 Wörter), konkret zu Klang, Stimmung, Genre oder ähnlichen Songs.
Format: {"suggestions":[{"i":0,"reason":"…"}]}

${blocks}` })
    provider = res.provider
    const seen = new Set<number>()
    for (const s of res.data.suggestions ?? []) {
      if (!short[s.i] || seen.has(s.i)) continue   // erfundene oder doppelte Nummern verwerfen
      seen.add(s.i); picks.push({ playlist: short[s.i].p, reason: String(s.reason ?? '') })
    }
    picks = picks.slice(0, 3)
  }
  // Auffüllen (ohne KI oder bei lückenhafter Antwort) mit den lokal besten
  for (const c of cands) {
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

/** „Auf keinen Fall": diese Playlist für diesen Song nie wieder, für denselben Künstler deutlich seltener. */
export async function reject(song: Track, playlist: Playlist) {
  await (await db).add('choices', { trackId: song.id, artistIds: song.artistIds, playlistId: playlist.id, suggested: [], at: Date.now(), rejected: true })
}
