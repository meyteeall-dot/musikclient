/* Gedächtnis aus Fehlgriffen der Trefferquote: „Song X gehört nach A, nicht nach B“.
   Fließt in die Punkte ein (gleicher Künstler) und wird der KI bei den betroffenen Playlists als Merksatz gezeigt. */
import { kv } from '../data/db'

export interface Lesson { trackId: string; song: string; artistIds: string[]; right: string[]; wrong?: string; at: number }

const KEY = 'lessons'
const MAX = 2000   // shortcut: älteste fallen raus, wenn es mehr werden; bei Bedarf in eigenen Datenbank-Speicher umziehen

export const getLessons = async () => (await kv.get<Lesson[]>(KEY)) ?? []

let queue: Promise<unknown> = Promise.resolve()   // nacheinander schreiben: parallele Tests würden sich sonst Merksätze überschreiben
export function addLesson(l: Lesson) {
  return queue = queue.catch(() => {}).then(async () => {
    const all = (await getLessons()).filter(x => x.trackId !== l.trackId)   // pro Song nur der neueste Merksatz
    all.push(l)
    await kv.set(KEY, all.slice(-MAX))
  })
}

/** „Kein echter Fehler“: Merksatz für diesen Song wieder vergessen. */
export async function forgetLesson(trackId: string) {
  await kv.set(KEY, (await getLessons()).filter(x => x.trackId !== trackId))
}
