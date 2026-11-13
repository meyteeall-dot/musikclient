/* Playlist-Profile: Künstler, Jahre und Beispielsongs werden lokal gezählt (kostet keine KI),
   Genres, Stimmung, Epoche und Kurzbeschreibung kommen von der KI – 10 Playlists pro Anfrage. */
import { completeJson } from '../ai'
import { db, type Playlist, type Profile, type Track } from '../data/db'

const VERSION = 2   // erhöhen, wenn sich die Eingabe an die KI ändert: alle Profile werden neu erzeugt
const BATCH = 6   // ~3.500 Tokens pro Anfrage: passt ins Groq-Minutenlimit (8.000)
const PAUSE_MS = 6500   // < 10 Anfragen/Minute: Gemini-Gratislimit

function localStats(tracks: Track[]) {
  const count = new Map<string, number>()
  for (const t of tracks) for (const a of t.artists) count.set(a, (count.get(a) ?? 0) + 1)
  const artists = [...count].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([a]) => a)
  const ys = tracks.map(t => t.year).filter((y): y is number => !!y).sort((a, b) => a - b)
  const years: [number, number] | undefined = ys.length ? [ys[Math.floor(ys.length * .1)], ys[Math.floor((ys.length - 1) * .9)]] : undefined
  const step = Math.max(1, Math.floor(tracks.length / 12))
  const examples = tracks.filter((_, i) => i % step === 0).slice(0, 12).map(t => `${t.artists[0]} – ${t.name}`)
  return { artists, years, examples }
}

const SYSTEM = 'Du analysierst Spotify-Playlists und erstellst kompakte Profile, mit denen man später neue Songs der passenden Playlist zuordnet. Antworte ausschließlich mit JSON.'
const TASK = `Erstelle für jede Playlist ein Profil:
- genres: 2–5 konkrete Genres/Subgenres (übliche englische Bezeichnungen)
- mood: Stimmung, 2–4 deutsche Stichworte, kommagetrennt
- era: Epoche, z. B. "2010er" oder "80er–90er"
- summary: ein kurzer deutscher Satz, wofür die Playlist steht
Liegen nur Name und Beschreibung vor, leite vorsichtig daraus ab.
Format: {"profiles":[{"id":"…","genres":["…"],"mood":"…","era":"…","summary":"…"}]}

Playlists:
`

/** Profile für alle Playlists erzeugen, deren Tracks sich seit dem letzten Profil geändert haben. */
export async function buildProfiles(onProgress?: (done: number, todo: number) => void) {
  const d = await db
  const profiles = new Map((await d.getAll('profiles')).map(p => [p.id, p]))
  const todo = (await d.getAll('playlists')).filter(p => p.tracksSnapshot && profiles.get(p.id)?.basedOn !== `${VERSION}:${p.tracksSnapshot}`)
  const batches: Playlist[][] = []
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))

  for (const [n, batch] of batches.entries()) {
    onProgress?.(n, batches.length)
    if (n) await new Promise(r => setTimeout(r, PAUSE_MS))
    const input = await Promise.all(batch.map(async p => {
      const stats = localStats((await d.get('tracks', p.id))?.tracks ?? [])
      return { p, stats, ai: { id: p.id, name: p.name, description: p.description || undefined, artists: stats.artists, years: stats.years, examples: stats.examples } }
    }))
    const { data, provider } = await completeJson<{ profiles: Partial<Profile>[] }>({ system: SYSTEM, prompt: TASK + JSON.stringify(input.map(i => i.ai)) })
    const byId = new Map((data.profiles ?? []).map(x => [x.id, x]))
    for (const { p, stats } of input) {
      const x = byId.get(p.id)
      if (!x) continue   // fehlt in der Antwort: beim nächsten Abgleich erneut
      await d.put('profiles', {
        id: p.id, basedOn: `${VERSION}:${p.tracksSnapshot}`, ...stats, provider,
        genres: Array.isArray(x.genres) ? x.genres.map(String).slice(0, 5) : [],
        mood: String(x.mood ?? ''), era: String(x.era ?? ''), summary: String(x.summary ?? ''),
      })
    }
  }
  onProgress?.(batches.length, batches.length)
  return batches.length
}
