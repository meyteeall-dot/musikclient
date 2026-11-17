/* Playlist-Vorschläge für einen Song: lokale Punkte (Künstler schon drin, Epoche, frühere Entscheidungen),
   dann eine KI-Anfrage, die aus den Kandidaten die 3 besten wählt und begründet. Ohne KI: die 3 mit den meisten Punkten. */
import { completeJson, hasAi, status } from '../ai'
import { db, kv, type Choice, type Playlist, type Profile, type Track } from '../data/db'
import { addToPlaylist } from '../spotify/api'
import { getLessons, type Lesson } from './lessons'
import { DEFAULT_SOUND, soundOf, soundVotes, type SoundParams } from './sound'

export interface Suggestion { playlist: Playlist; reason: string }
/** Bausteine der Punkte – einzeln abschaltbar für die Signal-Analyse der Trefferquote. */
export const SIGNALS = { artist: 'Künstler schon drin', sound: 'Klang', chosen: 'Deine Hinzufügungen', rejected: '✕ Ablehnungen', lessons: 'Merksätze', era: 'Epoche', general: 'Oft gewählte Playlists' } as const
export type Signal = keyof typeof SIGNALS
export type Parts = Record<Signal, number>

export interface SuggestResult {
  suggestions: Suggestion[]; contains: Playlist[]; provider: string
  /** nur im Test: alle Kandidaten mit ihren Punkte-Bausteinen */
  ranking?: { id: string; parts: Parts }[]
}

interface Cand { p: Playlist; prof?: Profile; tracks: Track[]; k: number; w: number; era: boolean; score: number; kl: number; parts: Parts }

const SHORTLIST = 8   // Stufe 1 wählt so viele Kandidaten, Stufe 2 sieht von ihnen echte Songs
const SONGS_PER_CAND = 25

/** Lokale Punkte einer Playlist für einen Song. Ablehnungen („auf keinen Fall") desselben Künstlers ziehen stark ab. */
/** Gewicht je Baustein (1 = wie eingebaut). Von der Gewichts-Optimierung gelernt, unter kv „weights“ gespeichert. */
export type Weights = Partial<Record<Signal, number>>
const sum = (p: Parts, without?: Signal, w: Weights = {}) => (Object.keys(p) as Signal[]).reduce((a, s) => s === without ? a : a + p[s] * (w[s] ?? 1), 0)

export function score(song: Track, tracks: Track[], prof: Profile | undefined, choices: Choice[], playlistId: string, lessons: Lesson[] = []) {
  const ids = new Set(song.artistIds), sameArtist = (c: Choice) => c.artistIds.some(a => ids.has(a))
  const k = tracks.filter(t => t.artistIds.some(a => ids.has(a))).length                      // Songs desselben Künstlers
  const mine = choices.filter(c => c.playlistId === playlistId && !c.rejected)
  const w = mine.filter(sameArtist).length                                                   // früher gewählt, gleicher Künstler
  const no = choices.filter(c => c.playlistId === playlistId && c.rejected && sameArtist(c)).length
  const y = prof?.years, era = !!(song.year && y && song.year >= y[0] - 3 && song.year <= y[1] + 3)
  // Merksätze zum selben Künstler: hierher gehört (+), fälschlich hierher vorgeschlagen (−)
  const same = lessons.filter(l => l.artistIds.some(a => ids.has(a)))
  const lr = same.filter(l => l.right.includes(playlistId)).length, lw = same.filter(l => l.wrong === playlistId).length
  const parts: Parts = {
    artist: Math.min(k, 5) * 2, chosen: w * 3, rejected: -no * 4, lessons: Math.min(lr, 3) * 2 - Math.min(lw, 3) * 2,
    era: era ? 2 : 0, general: Math.min(mine.length, 6) * .25, sound: 0,   // Klang kommt in compute() dazu
  }
  return { k, w, era, parts, score: sum(parts) }
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

// Gleicher Song erneut geöffnet (zurück/vor, Inbox): Ergebnis wiederverwenden statt neu fragen; Hinzufügen/Ablehnen leert es
const cache = new Map<string, { at: number; res: SuggestResult }>()
const CACHE_MS = 15 * 60_000

/** test: Trefferquote – Song aus seinen Playlists herausgerechnet. local: nur lokale Punkte, keine KI (Vergleichswert). */
export async function suggest(song: Track, opts: { test?: boolean; local?: boolean; lib?: Library } = {}): Promise<SuggestResult> {
  const hit = !opts.test && cache.get(song.id)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.res
  const res = await compute(song, opts)
  if (!opts.test) cache.set(song.id, { at: Date.now(), res })
  return res
}

export type Library = Awaited<ReturnType<typeof loadLibrary>>

/** Alles, was ein Vorschlag braucht, in wenigen Datenbankzugriffen (alle Songs auf einmal statt einzeln je Playlist). */
export async function loadLibrary() {
  status('lese Songs aus dem Speicher')
  const d = await db
  const [all, profiles, choices, excluded, tracks, lessons, weights, soundParams] = await Promise.all([d.getAll('playlists'), d.getAll('profiles'), d.getAll('choices'), getExcluded(), d.getAll('tracks'), getLessons(), kv.get<Weights>('weights'), kv.get<SoundParams>('soundParams')])
  const sound = new Map((await d.getAll('sound')).map(s => [s.id, s]))
  const inPl = new Map<string, string[]>()   // Song → Playlists, in denen er liegt (für den Klangvergleich)
  for (const t of tracks) for (const x of t.tracks) inPl.set(x.id, [...(inPl.get(x.id) ?? []), t.id])
  const plSize = new Map<string, number>()   // Songs mit Klangdaten je Playlist (für den Größen-Ausgleich)
  for (const t of tracks) plSize.set(t.id, t.tracks.filter(x => { const s = sound.get(x.id); return s && s.src !== 'fehlt' }).length)
  return { all, profiles, choices, excluded, lessons, sound, inPl, plSize, weights: weights ?? {}, soundParams: soundParams ?? DEFAULT_SOUND, tracks: new Map(tracks.map(t => [t.id, t.tracks])) }
}

async function compute(song: Track, opts: { test?: boolean; local?: boolean; lib?: Library }): Promise<SuggestResult> {
  const lib = opts.lib ?? await loadLibrary()
  const { all, profiles, choices: allChoices, excluded, lessons: allLessons, tracks: tracksOf } = lib
  const lessons = allLessons.filter(l => l.trackId !== song.id)   // den Song selbst nie aus seinem eigenen Merksatz „wissen“
  const nameOf = new Map(all.map(p => [p.id, p.name]))
  // Klang: die ähnlichst klingenden Songs der Sammlung stimmen für ihre Playlists (der Song selbst zählt nie mit)
  const f = await soundOf(song, lib.sound)
  const votes = f ? soundVotes(f, lib.sound, lib.inPl, song.id, lib.soundParams, lib.plSize) : new Map<string, number>()
  status('berechne Punkte')
  const choices = opts.test ? allChoices.filter(c => c.trackId !== song.id) : allChoices
  const never = new Set(choices.filter(c => c.rejected && c.trackId === song.id).map(c => c.playlistId))
  const profOf = new Map(profiles.map(p => [p.id, p]))
  const cands: Cand[] = [], contains: Playlist[] = []
  for (const p of all) {
    if ((!p.ownedByMe && !p.collaborative) || excluded.has(p.id) || never.has(p.id)) continue   // fremde, ignorierte, „auf keinen Fall"
    let tracks = tracksOf.get(p.id) ?? []
    if (tracks.some(t => t.id === song.id)) {
      if (!opts.test) { contains.push(p); continue }
      tracks = tracks.filter(t => t.id !== song.id)
    }
    const s = score(song, tracks, profOf.get(p.id), choices, p.id, lessons), kl = votes.get(p.id) ?? 0
    const parts = { ...s.parts, sound: kl * 8 }   // Klang: bis zu 8 Punkte
    cands.push({ p, prof: profOf.get(p.id), tracks, ...s, kl, parts, score: sum(parts, undefined, lib.weights) })
  }
  cands.sort((a, b) => b.score - a.score)

  let picks: Suggestion[] = [], provider = 'lokal'
  if (cands.length > 3 && !opts.local && await hasAi()) try {
    // Stufe 1: aus allen Playlists (Kurzprofil) die engere Wahl, ergänzt um die lokal stärksten
    let short = cands.slice(0, SHORTLIST)
    if (cands.length > SHORTLIST) {
      const lines = cands.map((c, i) => JSON.stringify({
        i, n: c.p.name, g: c.prof?.genres.join(', '), e: c.prof?.era, m: c.prof?.mood, a: c.prof?.artists.slice(0, 5).join(', '),
        ...(c.k ? { k: c.k } : {}), ...(c.w ? { w: c.w } : {}), ...(c.kl >= .05 ? { kl: Math.round(c.kl * 100) } : {}),
      })).join('\n')
      const r1 = await completeJson<{ top: number[] }>({ system: SYSTEM, prompt: `Song: ${songLine(song)}
Wähle die ${SHORTLIST} Playlists, in die dieser Song am ehesten passen könnte, beste zuerst.
Felder: i = Nummer, n = Name, g = Genres, e = Epoche, m = Stimmung, a = Hauptkünstler, k = Songs desselben Künstlers schon drin, w = wie oft ich diesen Künstler schon dorthin gelegt habe, kl = Prozent der klanglich ähnlichsten Songs meiner Sammlung (Tempo, Energie, Stimmung …), die in dieser Playlist liegen.
Format: {"top":[0,1,…]}

Playlists:
${lines}` })
      const idx = [...new Set((r1.data.top ?? []).filter(i => cands[i]))].slice(0, SHORTLIST)
      short = [...idx.map(i => cands[i]), ...cands.filter(c => c.score > 0).slice(0, 4)].filter((c, i, a) => a.indexOf(c) === i)
    }
    // Merksätze aus früheren Fehlgriffen, je Playlist die 5 neuesten: so lernt die KI die Abgrenzung ähnlicher Playlists
    const notes = (id: string) => {
      const m = lessons.filter(l => l.right.includes(id) || l.wrong === id).slice(-5)
      return m.length ? '\nMerke: ' + m.map(l => l.right.includes(id) ? `„${l.song}“ gehört hierher` : `„${l.song}“ gehört NICHT hierher, sondern nach ${l.right.map(r => nameOf.get(r)).join(' / ')}`).join('; ') : ''
    }
    // Stufe 2: die engere Wahl mit echten Songs aus jeder Playlist – daran erkennt die KI den Stil viel genauer
    const blocks = short.map((c, i) => `[${i}] ${c.p.name}${c.prof ? ` – ${[c.prof.genres.join(', '), c.prof.era, c.prof.mood].filter(Boolean).join(' · ')}` : ''}${c.prof?.summary ? `\n${c.prof.summary}` : ''}${c.w ? `\nIch habe ${c.w}× Songs dieses Künstlers hierher gelegt.` : ''}${c.kl >= .05 ? `\nKlang: ${Math.round(c.kl * 100)} % der ähnlich klingenden Songs meiner Sammlung liegen hier.` : ''}
Songs: ${sample(song, c.tracks, SONGS_PER_CAND).join('; ') || '(keine Songs bekannt)'}${notes(c.p.id)}`).join('\n\n')
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
  } catch (e) {
    // KI nicht erreichbar oder Unsinn geantwortet: lieber lokale Vorschläge als gar keine
    console.warn('KI-Vorschlag fehlgeschlagen, nutze lokale Punkte:', e)
    picks = []; provider = 'lokal (KI nicht erreichbar)'
  }
  // Auffüllen (ohne KI oder bei lückenhafter Antwort) mit den lokal besten
  for (const c of cands) {
    if (picks.length >= 3) break
    if (picks.some(s => s.playlist.id === c.p.id)) continue
    picks.push({ playlist: c.p, reason: localReason(song, c) })
  }
  return { suggestions: picks, contains, provider, ...(opts.test ? { ranking: cands.map(c => ({ id: c.p.id, parts: c.parts })) } : {}) }
}

function localReason(song: Track, c: Cand) {
  if (c.kl >= .3) return `Klingt wie viele Songs hier (${Math.round(c.kl * 100)} % der ähnlichsten).`
  if (c.w) return `Dorthin hast du ${song.artists[0]} schon ${c.w}× gelegt.`
  if (c.k) return c.k > 1 ? `${c.k} Songs von ${song.artists[0]} sind schon drin.` : `Ein Song von ${song.artists[0]} ist schon drin.`
  if (c.era) return `Passt zur Epoche der Playlist (${c.prof?.era}).`
  return c.prof?.summary || 'Allgemein passend.'
}

/** Song hinzufügen und die Wahl fürs Lernen merken. */
export async function choose(song: Track, playlist: Playlist, suggested: string[]) {
  cache.clear()
  await addToPlaylist(playlist.id, song.uri)
  const d = await db
  await d.add('choices', { trackId: song.id, artistIds: song.artistIds, playlistId: playlist.id, suggested, at: Date.now() })
  // Sofort lokal vermerken, damit der Song als „schon drin" gilt; der nächste Abgleich liest die Playlist ohnehin neu
  const pt = await d.get('tracks', playlist.id)
  if (pt) { pt.tracks.push(song); await d.put('tracks', pt) }
}

/** „Auf keinen Fall": diese Playlist für diesen Song nie wieder, für denselben Künstler deutlich seltener. */
export async function reject(song: Track, playlist: Playlist) {
  cache.clear()
  await (await db).add('choices', { trackId: song.id, artistIds: song.artistIds, playlistId: playlist.id, suggested: [], at: Date.now(), rejected: true })
}

/** Signal-Analyse: Rangfolge der Playlists nur nach Punkten, einmal ohne den genannten Baustein. */
export const rankWithout = (ranking: { id: string; parts: Parts }[], without?: Signal, w: Weights = {}) =>
  // Gleichstand neutral nach ID lösen – nicht nach der vollen Rangfolge, sonst sähe „ohne X“ zu gut aus
  [...ranking].sort((a, b) => sum(b.parts, without, w) - sum(a.parts, without, w) || a.id.localeCompare(b.id)).map(r => r.id)
