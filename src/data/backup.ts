/* Sicherung: alle eingelesenen Daten als Datei, damit nach einem Datenverlust (Browser räumt auf, neues Gerät)
   nichts neu bei Spotify eingelesen und keine Profile neu erzeugt werden müssen. Ohne Anmeldedaten und KI-Schlüssel. */
import { db, kv } from './db'

const STORES = ['playlists', 'tracks', 'profiles', 'choices'] as const
const KEYS = ['excluded', 'inboxDone', 'accuracy', 'theme', 'glass', 'clientId', 'geminiModel', 'groqModel', 'user']   // keine Tokens, keine Schlüssel

/** Browser bitten, die Daten nicht von selbst zu löschen. true = zugesagt. */
export const persist = async () => !!(await navigator.storage?.persist?.())
export const persisted = async () => !!(await navigator.storage?.persisted?.())

export async function exportData() {
  const d = await db
  const data: Record<string, unknown> = { app: 'musikclient', version: 1, at: Date.now(), kv: {} }
  for (const s of STORES) data[s] = await d.getAll(s)
  for (const k of KEYS) (data.kv as Record<string, unknown>)[k] = await kv.get(k)
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `musikclient-sicherung-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  await kv.set('lastBackup', Date.now())
}

export async function importData(file: File) {
  let data: any
  try { data = JSON.parse(await file.text()) } catch { throw new Error('Das ist keine gültige Sicherungsdatei.') }
  if (data?.app !== 'musikclient' || !Array.isArray(data.playlists)) throw new Error('Das ist keine Musikclient-Sicherung.')
  const d = await db
  const tx = d.transaction([...STORES], 'readwrite')   // alles oder nichts: bricht etwas ab, bleibt der alte Stand
  for (const s of STORES) {
    await tx.objectStore(s).clear()
    for (const v of data[s] ?? []) await tx.objectStore(s).put(v)
  }
  await tx.done
  for (const k of KEYS) if (data.kv?.[k] !== undefined) await kv.set(k, data.kv[k])
  return (data.playlists as unknown[]).length
}
