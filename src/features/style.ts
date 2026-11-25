/* Steckbrief je Song (KI, einmalig): Genres, Sprache, Stimmungen und Unterton. Daraus Punkte-Bausteine, die danach ohne KI rechnen:
   Wie häufig sind Genre, Sprache, Stimmung und Unterton des Songs unter den Songs einer Playlist? */
import { completeJson } from '../ai'
import { db, kv, type Track } from '../data/db'

/** u: Unterton −2 richtig traurig … 0 neutral … +2 euphorisch; m: Stimmungen aus MOODS. Ältere Steckbriefe haben noch kein u (werden nachgeholt). */
export interface Style { g: string[]; l: string; u?: number; m?: string[] }
// Feste Liste, damit gleiche Stimmungen gleich heißen (sonst „chillig“/„entspannt“/„relaxed“ nebeneinander)
export const MOODS = ['entspannt', 'gemütlich', 'fröhlich', 'aufgedreht', 'party', 'hart', 'motivierend', 'atmosphärisch', 'schwebend', 'verträumt', 'nächtlich', 'düster', 'nachdenklich', 'melancholisch', 'traurig', 'verzweifelt', 'sinnlich', 'süß', 'nostalgisch', 'episch', 'sommerlich']
const KEY = 'styles'   // shortcut: alle Steckbriefe in einem kv-Eintrag (~60 Byte je Song); ab ~20 000 Songs in einen eigenen Speicher umziehen
const BATCH = 50
const PARALLEL = 4   // gleichzeitige KI-Anfragen

export const getStyles = async () => new Map(Object.entries((await kv.get<Record<string, Style>>(KEY)) ?? {}))

/** Die häufigsten bisher vergebenen Genres – gehen mit an die KI, damit sie dieselben Namen wiederverwendet. */
function vocab(styles: Map<string, Style>, n: number) {
  const c = new Map<string, number>()
  for (const s of styles.values()) for (const g of s.g) c.set(g, (c.get(g) ?? 0) + 1)
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => g)
}

/** Steckbriefe für alle Songs der Sammlung (auch Sammel-Playlists) und extra (z. B. Inbox), die noch keinen haben. Jeder fertige Stapel wird sofort gespeichert. Gibt die Zahl der KI-Anfragen zurück. */
export async function syncStyles(onProgress?: (done: number, todo: number) => void, extra: Track[] = [], maxBatches = Infinity) {
  const d = await db
  const styles = await getStyles()
  const songs = [...new Map([...(await d.getAll('tracks')).flatMap(t => t.tracks), ...extra].map(t => [t.id, t])).values()]
  const todo = songs.filter(t => styles.get(t.id)?.u === undefined)   // neu oder noch ohne Unterton
  const batches = Math.min(maxBatches, Math.ceil(todo.length / BATCH))
  let next = 0, done = 0
  const one = async (b: number) => {
    const part = todo.slice(b * BATCH, (b + 1) * BATCH)
    const known = vocab(styles, 120)
    const { data } = await completeJson<{ s: { i: number; g?: unknown; l?: unknown; m?: unknown; u?: unknown }[] }>({
      system: 'Du bist Musikexperte und beschreibst Songs nach Genre, Sprache, Stimmung und Unterton. Antworte ausschließlich mit JSON.',
      prompt: `Gib für jeden Song an:
- g: 1–3 Genres, vom genauesten zum allgemeinsten, englisch und klein geschrieben (z. B. "german rap", "trap", "pop").${known.length ? ` Verwende möglichst diese schon benutzten Namen: ${known.join(', ')}` : ''}
- l: Sprache des Gesangs als Kürzel (de, en, es, fr, tr …), "instrumental" ohne Gesang
- m: 1–3 Stimmungen, nur aus dieser Liste: ${MOODS.join(', ')}
- u: Unterton als Zahl: -2 richtig traurig, -1 leicht traurig, 0 neutral, 1 fröhlich, 2 euphorisch. Entscheidend ist das Gefühl, das der Song auslöst, nicht das Tempo.
Format: {"s":[{"i":0,"g":["german rap","hip hop"],"l":"de","m":["nächtlich","nachdenklich"],"u":-1}]}

${part.map((t, i) => `${i}: ${t.artists.join(', ')} – ${t.name}${t.year ? ` (${t.year})` : ''}`).join('\n')}`,
    })
    for (const x of data.s ?? []) {
      const t = part[x.i]
      if (!t) continue
      const g = Array.isArray(x.g) ? [...new Set(x.g.map(v => String(v).toLowerCase().trim()).filter(Boolean))].slice(0, 3) : []
      const m = Array.isArray(x.m) ? [...new Set(x.m.map(v => String(v).toLowerCase().trim()).filter(v => MOODS.includes(v)))].slice(0, 3) : []
      const u = typeof x.u === 'number' && isFinite(x.u) ? Math.max(-2, Math.min(2, Math.round(x.u))) : 0
      styles.set(t.id, { g, l: typeof x.l === 'string' ? x.l.toLowerCase().trim().slice(0, 12) : '', m, u })
    }
    // von der KI ausgelassen: als neutral markieren, damit nicht endlos neu gefragt wird (vorhandenes Genre/Sprache bleibt)
    for (const t of part) { const s = styles.get(t.id); if (s?.u === undefined) styles.set(t.id, { g: s?.g ?? [], l: s?.l ?? '', m: s?.m ?? [], u: 0 }) }
    await kv.set(KEY, Object.fromEntries(styles))
    onProgress?.(Math.min(songs.length, songs.length - todo.length + ++done * BATCH), songs.length)
  }
  // Mehrere Stapel gleichzeitig, jeder bei einem anderen Modell (complete verteilt); ein Strang hört auf, wenn alle KIs am Limit sind
  const worker = async () => { while (next < batches) await one(next++) }
  onProgress?.(songs.length - todo.length, songs.length)   // Gesamtstand in Songs: Fertiges aus früheren Abgleichen zählt mit
  const res = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL, batches) }, worker))
  const failed = res.find(r => r.status === 'rejected')
  if (failed && !done) throw (failed as PromiseRejectedResult).reason
  return batches
}

/** Vergleich Song ↔ Playlist (Anteile 0–1):
    genre: Anteil der Playlist-Songs mit dem häufigsten gemeinsamen Genre; lang: Anteil mit derselben Sprache;
    mood: wie viele Playlist-Songs im Schnitt jede Stimmung des Songs teilen; tone: gleicher Unterton zählt voll, ein Schritt daneben halb.
    Zu wenig bekannt (unter 3 Songs mit Steckbrief) oder Song ohne Steckbrief: neutral (genre/mood 0, lang/tone ½). */
export function styleMatch(s: Style | undefined, tracks: Track[], styles: Map<string, Style>) {
  const neutral = { genre: 0, lang: .5, mood: 0, tone: .5 }
  if (!s || (!s.g.length && !s.l)) return neutral
  let n = 0, same = 0, nt = 0, tone = 0
  const gc = new Map<string, number>(), mc = new Map<string, number>()
  for (const t of tracks) {
    const x = styles.get(t.id)
    if (!x || (!x.g.length && !x.l)) continue
    n++
    for (const g of x.g) if (s.g.includes(g)) gc.set(g, (gc.get(g) ?? 0) + 1)
    for (const m of x.m ?? []) if (s.m?.includes(m)) mc.set(m, (mc.get(m) ?? 0) + 1)
    if (x.l === s.l) same++
    if (x.u !== undefined && s.u !== undefined) { nt++; const d = Math.abs(x.u - s.u); tone += d === 0 ? 1 : d === 1 ? .5 : 0 }
  }
  if (n < 3) return neutral
  const ms = s.m ?? []
  return {
    genre: Math.max(0, ...gc.values()) / n, lang: s.l ? same / n : .5,
    mood: ms.length ? ms.reduce((a, m) => a + (mc.get(m) ?? 0), 0) / ms.length / n : 0,
    tone: nt >= 3 ? tone / nt : .5,
  }
}

export async function styleStats() {
  const styles = await getStyles()
  const ids = new Set((await (await db).getAll('tracks')).flatMap(t => t.tracks.map(x => x.id)))
  return { done: [...ids].filter(id => styles.get(id)?.u !== undefined).length, all: ids.size }
}

// Selbsttest (nur im Entwicklungsmodus)
if (import.meta.env.DEV) {
  const tr = (id: string) => ({ id } as Track)
  const st = new Map<string, Style>([['a', { g: ['german rap'], l: 'de', m: ['düster'], u: -1 }], ['b', { g: ['german rap', 'trap'], l: 'de', m: ['düster', 'hart'], u: -1 }],
    ['c', { g: ['pop'], l: 'en', m: ['fröhlich'], u: 1 }], ['d', { g: ['pop'], l: 'en', m: ['fröhlich'], u: 0 }]])
  const m = styleMatch({ g: ['german rap'], l: 'de', m: ['düster', 'süß'], u: -1 }, ['a', 'b', 'c', 'd'].map(tr), st)
  console.assert(m.genre === .5 && m.lang === .5 && m.mood === .25 && m.tone === .625, 'styleMatch', m)
  console.assert(styleMatch(undefined, [], st).lang === .5, 'styleMatch neutral')
}
