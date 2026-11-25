/* Steckbrief je Song (KI, einmalig): Genres und Sprache. Daraus zwei Punkte-Bausteine, die danach ohne KI rechnen:
   Wie häufig sind Genre und Sprache des Songs unter den Songs einer Playlist? */
import { completeJson } from '../ai'
import { db, kv, type Track } from '../data/db'

export interface Style { g: string[]; l: string }
const KEY = 'styles'   // shortcut: alle Steckbriefe in einem kv-Eintrag (~60 Byte je Song); ab ~20 000 Songs in einen eigenen Speicher umziehen
const BATCH = 50

export const getStyles = async () => new Map(Object.entries((await kv.get<Record<string, Style>>(KEY)) ?? {}))

/** Die häufigsten bisher vergebenen Genres – gehen mit an die KI, damit sie dieselben Namen wiederverwendet. */
function vocab(styles: Map<string, Style>, n: number) {
  const c = new Map<string, number>()
  for (const s of styles.values()) for (const g of s.g) c.set(g, (c.get(g) ?? 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => g)
}

/** Steckbriefe für alle Songs der Sammlung (auch Sammel-Playlists) und extra (z. B. Inbox), die noch keinen haben. Gibt die Zahl der KI-Anfragen zurück. */
export async function syncStyles(onProgress?: (done: number, todo: number) => void, extra: Track[] = [], maxBatches = Infinity) {
  const d = await db
  const styles = await getStyles()
  const todo = [...new Map([...(await d.getAll('tracks')).flatMap(t => t.tracks), ...extra].filter(t => !styles.has(t.id)).map(t => [t.id, t])).values()]
  const batches = Math.min(maxBatches, Math.ceil(todo.length / BATCH))
  for (let b = 0; b < batches; b++) {
    onProgress?.(b, batches)
    const part = todo.slice(b * BATCH, (b + 1) * BATCH)
    const known = vocab(styles, 120)
    const { data } = await completeJson<{ s: { i: number; g?: unknown; l?: unknown }[] }>({
      system: 'Du bist Musikexperte und ordnest Songs Genres und Sprache zu. Antworte ausschließlich mit JSON.',
      prompt: `Gib für jeden Song an:
- g: 1–3 Genres, vom genauesten zum allgemeinsten, englisch und klein geschrieben (z. B. "german rap", "trap", "pop").${known.length ? ` Verwende möglichst diese schon benutzten Namen: ${known.join(', ')}` : ''}
- l: Sprache des Gesangs als Kürzel (de, en, es, fr, tr …), "instrumental" ohne Gesang
Format: {"s":[{"i":0,"g":["german rap","hip hop"],"l":"de"}]}

${part.map((t, i) => `${i}: ${t.artists.join(', ')} – ${t.name}${t.year ? ` (${t.year})` : ''}`).join('\n')}`,
    })
    for (const x of data.s ?? []) {
      const t = part[x.i]
      if (!t) continue
      const g = Array.isArray(x.g) ? [...new Set(x.g.map(v => String(v).toLowerCase().trim()).filter(Boolean))].slice(0, 3) : []
      styles.set(t.id, { g, l: typeof x.l === 'string' ? x.l.toLowerCase().trim().slice(0, 12) : '' })
    }
    for (const t of part) if (!styles.has(t.id)) styles.set(t.id, { g: [], l: '' })   // von der KI ausgelassen: nicht endlos neu fragen
    await kv.set(KEY, Object.fromEntries(styles))
  }
  return batches
}

/** Anteil der Playlist-Songs mit einem Genre des Songs (das häufigste zählt) und mit derselben Sprache.
    Zu wenig bekannt (unter 3 Songs mit Steckbrief) oder Song ohne Steckbrief: neutral (Genre 0, Sprache ½). */
export function styleMatch(s: Style | undefined, tracks: Track[], styles: Map<string, Style>) {
  if (!s || (!s.g.length && !s.l)) return { genre: 0, lang: .5 }
  let n = 0, same = 0
  const gc = new Map<string, number>()
  for (const t of tracks) {
    const x = styles.get(t.id)
    if (!x || (!x.g.length && !x.l)) continue
    n++
    for (const g of x.g) if (s.g.includes(g)) gc.set(g, (gc.get(g) ?? 0) + 1)
    if (x.l === s.l) same++
  }
  if (n < 3) return { genre: 0, lang: .5 }
  return { genre: Math.max(0, ...gc.values()) / n, lang: s.l ? same / n : .5 }
}

export async function styleStats() {
  const styles = await getStyles()
  const ids = new Set((await (await db).getAll('tracks')).flatMap(t => t.tracks.map(x => x.id)))
  return { done: [...ids].filter(id => styles.get(id)?.g.length).length, all: ids.size }
}

// Selbsttest (nur im Entwicklungsmodus)
if (import.meta.env.DEV) {
  const tr = (id: string) => ({ id } as Track)
  const st = new Map<string, Style>([['a', { g: ['german rap'], l: 'de' }], ['b', { g: ['german rap', 'trap'], l: 'de' }], ['c', { g: ['pop'], l: 'en' }], ['d', { g: ['pop'], l: 'en' }]])
  const m = styleMatch({ g: ['german rap'], l: 'de' }, ['a', 'b', 'c', 'd'].map(tr), st)
  console.assert(m.genre === .5 && m.lang === .5, 'styleMatch', m)
  console.assert(styleMatch(undefined, [], st).lang === .5, 'styleMatch neutral')
}
