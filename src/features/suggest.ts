/* Playlist-Vorschläge für einen Song: lokale Punkte (Künstler schon drin, Epoche, frühere Entscheidungen),
   dann eine KI-Anfrage, die aus den Kandidaten die 3 besten wählt und begründet. Ohne KI: die 3 mit den meisten Punkten. */
import { completeJson, hasAi, status, type AiRequest } from '../ai'
import { db, kv, type Choice, type Playlist, type Profile, type Track } from '../data/db'
import { addToPlaylist } from '../spotify/api'
import { getLessons, type Lesson } from './lessons'
import { getStyles, styleMatch } from './style'
import { getNotes } from './notes'
import { GUIDE } from './guide'
import { DEFAULT_SOUND, soundOf, soundVotes, type SoundParams } from './sound'

/** votes: Abstimmung mehrerer KIs, z. B. „3 von 3 KIs · 72 %“ */
export interface Suggestion { playlist: Playlist; reason: string; votes?: string }
/** Bausteine der Punkte – einzeln abschaltbar für die Signal-Analyse der Trefferquote. */
export const SIGNALS = { artist: 'Künstler schon drin', sound: 'Klang', chosen: 'Deine Hinzufügungen', rejected: '✕ Ablehnungen', lessons: 'Merksätze', genre: 'Genre (Steckbrief)', lang: 'Sprache (Steckbrief)', mood: 'Stimmung (Steckbrief)', tone: 'Unterton (Steckbrief)', era: 'Epoche', general: 'Oft gewählte Playlists', bias: 'Magnet-Bremse' } as const
export type Signal = keyof typeof SIGNALS
export type Parts = Record<Signal, number>

export interface SuggestResult {
  suggestions: Suggestion[]; contains: Playlist[]; provider: string
  /** nur im Test: alle Kandidaten mit ihren Punkte-Bausteinen */
  ranking?: { id: string; parts: Parts }[]
  /** Punkte-Vorsprung von Platz 1 vor Platz 2 – klein = unsicher */
  margin?: number
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
    era: era ? 2 : 0, general: Math.min(mine.length, 6) * .25, sound: 0, bias: 0, genre: 0, lang: 0, mood: 0, tone: 0,   // Klang, Steckbrief und Magnet-Bremse kommen in compute() dazu
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

/** Playlists, die nicht als Vorbild dienen (z. B. Sammel-Playlists): ihre Songs zählen nirgends mit – Klang, Künstler, Tests. */
export const getNoLearn = async () => new Set((await kv.get<string[]>('noLearn')) ?? [])
export async function setNoLearn(id: string, on: boolean) {
  const ex = await getNoLearn()
  if (on) ex.add(id); else ex.delete(id)
  await kv.set('noLearn', [...ex])
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

const SYSTEM = `Du ordnest Songs den passenden Playlists eines Nutzers zu. Antworte ausschließlich mit JSON.\n\n${GUIDE}`
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
  const [all, profiles, choices, excluded, allTracks, lessons, weights, soundParams, noLearn, bias, aiMargin] = await Promise.all([d.getAll('playlists'), d.getAll('profiles'), d.getAll('choices'), getExcluded(), d.getAll('tracks'), getLessons(), kv.get<Weights>('weights'), kv.get<SoundParams>('soundParams'), getNoLearn(), kv.get<Record<string, number>>('bias'), kv.get<number>('aiMargin')])
  const tracks = allTracks.map(t => noLearn.has(t.id) ? { id: t.id, tracks: [] } : t)   // „Lernen“ aus: Songs zählen nirgends als Vorbild
  const sound = new Map((await d.getAll('sound')).map(s => [s.id, s]))
  const styles = await getStyles(), notes = await getNotes()
  const inPl = new Map<string, string[]>()   // Song → Playlists, in denen er liegt (für den Klangvergleich)
  for (const t of tracks) for (const x of t.tracks) inPl.set(x.id, [...(inPl.get(x.id) ?? []), t.id])
  const plSize = new Map<string, number>()   // Songs mit Klangdaten je Playlist (für den Größen-Ausgleich)
  for (const t of tracks) plSize.set(t.id, t.tracks.filter(x => { const s = sound.get(x.id); return s && s.src !== 'fehlt' }).length)
  const has = new Map(allTracks.map(t => [t.id, new Set(t.tracks.map(x => x.id))]))   // „schon drin“ immer mit allen Songs
  return { all, profiles, choices, excluded, noLearn, has, lessons, sound, styles, notes, inPl, plSize, weights: weights ?? {}, soundParams: soundParams ?? DEFAULT_SOUND, bias: bias ?? {}, aiMargin, tracks: new Map(tracks.map(t => [t.id, t.tracks])) }
}

async function compute(song: Track, opts: { test?: boolean; local?: boolean; lib?: Library }): Promise<SuggestResult> {
  const t0 = Date.now()
  const lib = opts.lib ?? await loadLibrary()
  const { all, profiles, choices: allChoices, excluded, lessons: allLessons, tracks: tracksOf } = lib
  const lessons = allLessons.filter(l => l.trackId !== song.id)   // den Song selbst nie aus seinem eigenen Merksatz „wissen“
  const nameOf = new Map(all.map(p => [p.id, p.name]))
  // Klang: die ähnlichst klingenden Songs der Sammlung stimmen für ihre Playlists (der Song selbst zählt nie mit)
  const f = await soundOf(song, lib.sound)
  const votes = f ? soundVotes(f, lib.sound, lib.inPl, song.id, lib.soundParams, lib.plSize) : new Map<string, number>()
  status('berechne Punkte')
  const st = lib.styles.get(song.id)
  const choices = opts.test ? allChoices.filter(c => c.trackId !== song.id) : allChoices
  const never = new Set(choices.filter(c => c.rejected && c.trackId === song.id).map(c => c.playlistId))
  const profOf = new Map(profiles.map(p => [p.id, p]))
  const cands: Cand[] = [], contains: Playlist[] = []
  for (const p of all) {
    if ((!p.ownedByMe && !p.collaborative) || excluded.has(p.id) || never.has(p.id)) continue   // fremde, ignorierte, „auf keinen Fall"
    let tracks = tracksOf.get(p.id) ?? []
    if (lib.has.get(p.id)?.has(song.id)) {
      if (!opts.test) { contains.push(p); continue }
      tracks = tracks.filter(t => t.id !== song.id)
    }
    const s = score(song, tracks, profOf.get(p.id), choices, p.id, lessons), kl = votes.get(p.id) ?? 0
    const m = styleMatch(st, tracks, lib.styles)
    // Klang bis 8 Punkte; Genre und Stimmung bis 6; Sprache und Unterton −2 (passt zu keinem) bis +2 (zu allen); Magnet-Bremse: gelernter Ausgleich je Playlist
    const parts = { ...s.parts, sound: kl * 8, genre: m.genre * 6, lang: (m.lang - .5) * 4, mood: m.mood * 6, tone: (m.tone - .5) * 4, bias: lib.bias[p.id] ?? 0 }
    cands.push({ p, prof: profOf.get(p.id), tracks, ...s, kl, parts, score: sum(parts, undefined, lib.weights) })
  }
  cands.sort((a, b) => b.score - a.score)

  let picks: Suggestion[] = [], provider = 'lokal'
  const margin = cands.length > 1 ? cands[0].score - cands[1].score : Infinity
  // KI nur bei knappen Fällen: Schwelle aus der Trefferquote gelernt (im Test immer KI, damit gemessen werden kann)
  const clear = !opts.test && lib.aiMargin != null && margin >= lib.aiMargin
  if (clear) provider = 'Punkte (eindeutig)'
  if (cands.length > 3 && !opts.local && !clear && await hasAi()) try {
    // Stufe 1: aus allen Playlists (Kurzprofil) die engere Wahl, ergänzt um die lokal stärksten
    let short = cands.slice(0, SHORTLIST)
    if (cands.length > SHORTLIST) {
      const lines = cands.map((c, i) => JSON.stringify({
        i, n: c.p.name, ...(lib.notes[c.p.id] ? { r: lib.notes[c.p.id].slice(0, 200) } : {}), g: c.prof?.genres.join(', '), e: c.prof?.era, m: c.prof?.mood, a: c.prof?.artists.slice(0, 5).join(', '),
        ...(c.k ? { k: c.k } : {}), ...(c.w ? { w: c.w } : {}), ...(c.kl >= .05 ? { kl: Math.round(c.kl * 100) } : {}),
      })).join('\n')
      const call1 = completeJson<{ top: number[] }>({ system: SYSTEM, prompt: `Song: ${songLine(song)}
Wähle die ${SHORTLIST} Playlists, in die dieser Song am ehesten passen könnte, beste zuerst.
Felder: i = Nummer, n = Name, r = meine eigene Regel für diese Playlist (hat Vorrang), g = Genres, e = Epoche, m = Stimmung, a = Hauptkünstler, k = Songs desselben Künstlers schon drin, w = wie oft ich diesen Künstler schon dorthin gelegt habe, kl = Prozent der klanglich ähnlichsten Songs meiner Sammlung (Tempo, Energie, Stimmung …), die in dieser Playlist liegen.
Format: {"top":[0,1,…]}

Playlists:
${lines}` })
      // Live-Suche: braucht die Vorauswahl länger als 8 s, gehen die lokal besten in die Abstimmung (20-s-Ziel)
      const r1 = opts.test ? await call1 : await Promise.race([call1, wait(t0 + 8_000 - Date.now()).then(() => null)])
      const idx = r1 ? [...new Set((r1.data.top ?? []).filter(i => cands[i]))].slice(0, SHORTLIST) : cands.slice(0, SHORTLIST).map((_, i) => i)
      short = [...idx.map(i => cands[i]), ...cands.filter(c => c.score > 0).slice(0, 4)].filter((c, i, a) => a.indexOf(c) === i)
    }
    // Merksätze aus früheren Fehlgriffen, je Playlist die 5 neuesten: so lernt die KI die Abgrenzung ähnlicher Playlists
    const notes = (id: string) => {
      const m = lessons.filter(l => l.right.includes(id) || l.wrong === id).slice(-5)
      return m.length ? '\nMerke: ' + m.map(l => l.right.includes(id) ? `„${l.song}“ gehört hierher` : `„${l.song}“ gehört NICHT hierher, sondern nach ${l.right.map(r => nameOf.get(r)).join(' / ')}`).join('; ') : ''
    }
    // Stufe 2: die engere Wahl mit echten Songs aus jeder Playlist – daran erkennt die KI den Stil viel genauer
    const blocks = short.map((c, i) => `[${i}] ${c.p.name}${c.prof ? ` – ${[c.prof.genres.join(', '), c.prof.era, c.prof.mood].filter(Boolean).join(' · ')}` : ''}${lib.notes[c.p.id] ? `\nMeine Regel: ${lib.notes[c.p.id]}` : ''}${c.prof?.summary ? `\n${c.prof.summary}` : ''}${c.w ? `\nIch habe ${c.w}× Songs dieses Künstlers hierher gelegt.` : ''}${c.kl >= .05 ? `\nKlang: ${Math.round(c.kl * 100)} % der ähnlich klingenden Songs meiner Sammlung liegen hier.` : ''}
Songs: ${sample(song, c.tracks, SONGS_PER_CAND).join('; ') || '(keine Songs bekannt)'}${notes(c.p.id)}`).join('\n\n')
    const req = { system: SYSTEM, prompt: `Song: ${songLine(song)}
Wähle die 3 Playlists, in die dieser Song am besten passt, beste zuerst. Vergleiche mit den Songs, die schon drin sind. „Meine Regel“ hat Vorrang vor allem anderen: widerspricht der Song einer Regel, wähle diese Playlist nicht. Begründe jede mit einem kurzen deutschen Satz (höchstens 15 Wörter), konkret zu Klang, Stimmung, Genre oder ähnlichen Songs.
Format: {"suggestions":[{"i":0,"reason":"…"}]}

${blocks}` }
    if (opts.test) {   // Trefferquote: eine KI je Song (misst dieselbe Entscheidung, kostet ein Drittel)
      const res = await completeJson<{ suggestions: { i: number; reason: string }[] }>(req)
      provider = res.provider
      picks = clean(res.data.suggestions, short.length).map(s => ({ playlist: short[s.i].p, reason: s.reason }))
    } else {
      const r = await council(song, req, short.map(c => c.p), t0)
      provider = r.provider; picks = r.picks
    }
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
  return { suggestions: picks, contains, provider, margin, ...(opts.test ? { ranking: cands.map(c => ({ id: c.p.id, parts: c.parts })) } : {}) }
}

type Pick = { i: number; reason: string }
/** Antwort prüfen: erfundene oder doppelte Nummern verwerfen, höchstens 3. */
function clean(list: unknown, count: number): Pick[] {
  const seen = new Set<number>(), out: Pick[] = []
  for (const s of Array.isArray(list) ? list : []) {
    const i = Number(s?.i)
    if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) continue
    seen.add(i); out.push({ i, reason: String(s?.reason ?? '') })
  }
  return out.slice(0, 3)
}

const VOTERS = 3          // so viele KIs stimmen parallel ab (jede bei einem anderen Modell)
const VOTE_MS = 14_000    // bis dahin gesammelte Stimmen zählen; Nachzügler werden ignoriert
const MAX_MS = 20_000     // spätestens dann steht das Ergebnis – notfalls mit den Punkten
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))

/** Mehrere KIs stimmen ab (Platz 1 = 3, Platz 2 = 2, Platz 3 = 1 Stimme), eine Haupt-KI fasst die Argumente zusammen.
    Zeitplan: Stimmen bis 14 s; kam bis dahin keine, warten bis 20 s auf die erste; Zusammenfassung nur, wenn noch Zeit ist,
    sonst die Begründung der besten Stimme. Kommt gar keine Stimme, füllt der Aufrufer mit den Punkten auf. */
async function council(song: Track, req: AiRequest, pls: Playlist[], t0: number): Promise<{ picks: Suggestion[]; provider: string }> {
  const votes: { provider: string; picks: Pick[] }[] = []
  let first!: () => void
  const firstVote = new Promise<void>(r => { first = r })
  const all = Promise.all(Array.from({ length: VOTERS }, () => completeJson<{ suggestions: unknown }>(req)
    .then(r => { const p = clean(r.data.suggestions, pls.length); if (p.length) { votes.push({ provider: r.provider, picks: p }); first() } }).catch(() => {})))
  await Promise.race([all, wait(t0 + VOTE_MS - Date.now())])
  if (!votes.length) await Promise.race([all, firstVote, wait(t0 + MAX_MS - Date.now())])
  const got = [...votes]   // Nachzügler ändern nichts mehr
  if (!got.length) return { picks: [], provider: Date.now() - t0 >= MAX_MS ? 'Punkte (KI zu langsam)' : 'lokal (KI nicht erreichbar)' }

  const score = new Map<number, { pts: number; n: number; reasons: string[] }>()
  for (const v of got) v.picks.forEach((p, rank) => {
    const s = score.get(p.i) ?? { pts: 0, n: 0, reasons: [] }
    s.pts += 3 - rank; s.n++; if (p.reason) s.reasons.push(p.reason)
    score.set(p.i, s)
  })
  const top = [...score].sort((a, b) => b[1].pts - a[1].pts || b[1].n - a[1].n).slice(0, 3)
  const picks: Suggestion[] = top.map(([i, s]) => ({ playlist: pls[i], reason: s.reasons[0] ?? '', votes: `${s.n} von ${got.length} KIs · ${Math.round(s.pts / (got.length * 6) * 100)} %` }))
  let provider = `${got.length} KIs abgestimmt`
  // Haupt-KI: die Argumente aller Stimmen je Playlist zu einem Satz verdichten – nur mit mehreren Stimmen und wenn die Zeit reicht
  if (got.length > 1 && top.some(([, s]) => s.reasons.length > 1)) {
    const sum = completeJson<{ reasons: string[] }>({ system: SYSTEM, prompt: `Song: ${songLine(song)}
Mehrere Prüfer haben diese Playlists gewählt und begründet. Fasse für jede die stärksten Argumente in einem deutschen Satz zusammen (höchstens 20 Wörter), konkret zu Stimmung, Unterton, Klang oder ähnlichen Songs.
Format: {"reasons":["…","…","…"]}

${top.map(([i, s], k) => `${k}. ${pls[i].name}: ${s.reasons.join(' | ')}`).join('\n')}` }).catch(() => null)
    const r = await Promise.race([sum, wait(t0 + MAX_MS - Date.now()).then(() => null)])
    if (r) {
      r.data.reasons?.forEach((t, k) => { if (picks[k] && typeof t === 'string' && t.trim()) picks[k].reason = t.trim() })
      provider += ` · zusammengefasst von ${r.provider}`
    }
  }
  return { picks, provider }
}

function localReason(song: Track, c: Cand) {
  if (c.kl >= .3) return `Klingt wie viele Songs hier (${Math.round(c.kl * 100)} % der ähnlichsten).`
  if (c.parts.genre >= 3) return 'Genre und Sprache passen zu vielen Songs hier.'
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
