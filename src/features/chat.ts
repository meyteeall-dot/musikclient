/* Jarvis: Chat über die eigene Sammlung. Kennt Playlists, Profile, Steckbriefe und Notizen; merkt sich, was der Nutzer
   über seine Playlists denkt (Notizen je Playlist) – diese Notizen bekommt die KI bei jedem knappen Vorschlag mit. */
import { completeJson } from '../ai'
import { db, kv } from '../data/db'
import { getExcluded, getNoLearn } from './suggest'
import { getStyles } from './style'
import { getNotes, setNote } from './notes'
import { GUIDE } from './guide'

export interface Msg { role: 'user' | 'jarvis'; text: string; saved?: string[] }

export const getChat = async () => (await kv.get<Msg[]>('chat')) ?? []
export const clearChat = () => kv.del('chat')

const SYSTEM = `Du bist Jarvis, der Musik-Assistent in der App deines Erbauers. Du sprichst Deutsch, ruhig, sachlich, knapp und leicht trocken, und redest ihn mit „Sir“ an. Bedankt er sich, ist das schlicht dein Job.
Du kennst nur seine Spotify-Sammlung (unten). Deine Aufgaben:
1. Fragen zur Sammlung beantworten.
2. Merken, was er sich bei seinen Playlists denkt: Sagt er, wie eine Playlist gemeint ist oder was hinein gehört bzw. nicht, speicherst du das als Notiz zu genau dieser Playlist.
3. Gedanken vorschlagen: Will er etwas umsetzen und weiß nicht wie (Playlists aufteilen, abgrenzen, neu ordnen), mach konkrete, kurze Vorschläge mit Bezug auf seine echten Playlists.
4. Playlist-Regeln schreiben: Auf Wunsch formulierst du eine klare Regel, wie eine Playlist auszusehen hat (was hinein gehört, was nicht, Abgrenzung zu ähnlichen Playlists) – als Text, den die Sortier-KI später als Anweisung liest. Speichere ihn erst, wenn er zustimmt oder es ausdrücklich verlangt.
Notizen sind die Regeln, nach denen die Sortier-KI entscheidet. Schreib sie als klare Anweisung in seiner Sicht („Hier nur …, keine …“). „add“ ergänzt die bestehende Notiz, „replace“ ersetzt sie, „delete“ löscht sie.
Brauchst du konkrete Songs (eines Künstlers, einer Playlist oder einen bestimmten Titel), fordere sie mit „lookup“ an statt zu raten; du bekommst sie dann und antwortest erst danach.
Antworte ausschließlich mit JSON: {"reply":"…","notes":[{"playlist":"exakter Name","mode":"add|replace|delete","text":"…"}],"lookup":{"artist":"…"} oder {"playlist":"…"} oder {"song":"…"}}
„notes“ und „lookup“ nur, wenn nötig.

${GUIDE}`

/** Kompakte Übersicht der Sammlung – eine Zeile je Playlist. */
async function overview() {
  const d = await db
  const [pls, profiles, tracks, styles, notes, excluded, noLearn] = await Promise.all([d.getAll('playlists'), d.getAll('profiles'), d.getAll('tracks'), getStyles(), getNotes(), getExcluded(), getNoLearn()])
  const prof = new Map(profiles.map(p => [p.id, p])), tr = new Map(tracks.map(t => [t.id, t.tracks]))
  const lines = pls.filter(p => p.ownedByMe || p.collaborative).sort((a, b) => a.name.localeCompare(b.name)).map(p => {
    const t = tr.get(p.id) ?? [], pr = prof.get(p.id)
    const gc = new Map<string, number>(), lc = new Map<string, number>(), mc = new Map<string, number>(), us: number[] = []
    for (const x of t) {
      const s = styles.get(x.id)
      s?.g.forEach(g => gc.set(g, (gc.get(g) ?? 0) + 1)); s?.m?.forEach(m => mc.set(m, (mc.get(m) ?? 0) + 1))
      if (s?.l) lc.set(s.l, (lc.get(s.l) ?? 0) + 1)
      if (s?.u !== undefined) us.push(s.u)
    }
    const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${Math.round(v / t.length * 100)}%`).join(', ')
    return [`• ${p.name} (${t.length} Songs${excluded.has(p.id) ? ', Vorschlagen aus' : ''}${noLearn.has(p.id) ? ', Lernen aus' : ''})`,
      gc.size ? `Genres: ${top(gc, 4)}` : pr?.genres.length ? `Genres: ${pr.genres.join(', ')}` : '',
      lc.size ? `Sprachen: ${top(lc, 3)}` : '', mc.size ? `Stimmungen: ${top(mc, 4)}` : '',
      us.length ? `Unterton Ø ${(us.reduce((a, b) => a + b, 0) / us.length).toFixed(1)} (−2 traurig … +2 euphorisch)` : '', pr?.mood ? `Stimmung: ${pr.mood}` : '', pr?.era ? `Epoche: ${pr.era}` : '',
      pr?.artists.length ? `Künstler: ${pr.artists.slice(0, 6).join(', ')}` : '', p.description ? `Spotify-Beschreibung: ${p.description}` : '',
      notes[p.id] ? `NOTIZ VON SIR: ${notes[p.id]}` : ''].filter(Boolean).join(' | ')
  })
  return { text: lines.join('\n'), pls, tr }
}

/** Gezielte Suche für Jarvis: Songs eines Künstlers, einer Playlist oder ein Titel – samt Fundort. */
function lookup(q: { artist?: string; playlist?: string; song?: string }, pls: { id: string; name: string }[], tr: Map<string, { name: string; artists: string[] }[]>) {
  const low = (s?: string) => (s ?? '').toLowerCase().trim()
  const out: string[] = []
  if (q.playlist) {
    const p = pls.find(p => low(p.name) === low(q.playlist)) ?? pls.find(p => low(p.name).includes(low(q.playlist)))
    const t = p ? tr.get(p.id) ?? [] : []
    return p ? `Songs in „${p.name}“ (${t.length}): ${t.slice(0, 150).map(x => `${x.artists[0]} – ${x.name}`).join('; ')}` : `Keine Playlist „${q.playlist}“ gefunden.`
  }
  const want = low(q.artist || q.song)
  for (const p of pls) for (const x of tr.get(p.id) ?? []) {
    const hit = q.artist ? x.artists.some(a => low(a).includes(want)) : low(x.name).includes(want)
    if (hit) out.push(`${x.artists.join(', ')} – ${x.name} → ${p.name}`)
  }
  return out.length ? `Treffer (${out.length}): ${out.slice(0, 150).join('; ')}` : 'Keine Treffer in der Sammlung.'
}

/** Eine Nachricht an Jarvis. Speichert Verlauf und Notizen; gibt die neue Antwort zurück. */
export async function ask(text: string): Promise<Msg> {
  const history = [...await getChat(), { role: 'user', text } as Msg]
  const { text: lib, pls, tr } = await overview()
  const talk = history.slice(-12).map(m => `${m.role === 'user' ? 'Sir' : 'Jarvis'}: ${m.text}`).join('\n')
  type Out = { reply?: string; notes?: { playlist?: string; mode?: string; text?: string }[]; lookup?: { artist?: string; playlist?: string; song?: string } }
  const call = (extra = '') => completeJson<Out>({ system: SYSTEM, prompt: `Sammlung:\n${lib}\n\nGespräch:\n${talk}${extra}\n\nAntworte jetzt als Jarvis.` })
  let { data } = await call()
  if (data.lookup && Object.values(data.lookup).some(Boolean)) {   // einmal nachschlagen, dann endgültig antworten
    ({ data } = await call(`\n\n[Nachgeschlagen: ${lookup(data.lookup, pls, tr)}]\nKein weiteres lookup.`))
  }
  const saved: string[] = []
  const notes = await getNotes()
  for (const n of data.notes ?? []) {
    const p = pls.find(p => p.name.toLowerCase().trim() === String(n.playlist ?? '').toLowerCase().trim())
    if (!p) continue
    const t = String(n.text ?? '').trim()
    if (n.mode === 'delete') { await setNote(p.id, ''); saved.push(`Notiz zu „${p.name}“ gelöscht`); continue }
    if (!t) continue
    await setNote(p.id, n.mode === 'replace' || !notes[p.id] ? t : `${notes[p.id]} ${t}`)
    saved.push(`Notiz zu „${p.name}“ gespeichert`)
  }
  const reply: Msg = { role: 'jarvis', text: String(data.reply ?? '').trim() || 'Verzeihung, Sir, die Antwort kam leer zurück.', ...(saved.length ? { saved } : {}) }
  await kv.set('chat', [...history, reply].slice(-60))
  return reply
}
