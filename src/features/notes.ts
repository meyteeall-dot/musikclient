/* Notizen des Nutzers je Playlist: was er sich dabei denkt, wie sie aussehen soll (per Jarvis-Chat oder von Hand).
   Die Sortier-KI liest sie bei jedem knappen Vorschlag als Regel mit Vorrang. */
import { kv } from '../data/db'

export const getNotes = async () => (await kv.get<Record<string, string>>('notes')) ?? {}
export async function setNote(id: string, text: string) {
  const n = await getNotes()
  if (text.trim()) n[id] = text.trim(); else delete n[id]
  await kv.set('notes', n)
}
