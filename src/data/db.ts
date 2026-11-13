import { openDB, type DBSchema } from 'idb'

export interface Playlist {
  id: string
  name: string
  description: string
  snapshot_id: string
  owner: string
  ownedByMe: boolean
  collaborative: boolean
  image?: string
  total: number
  /** snapshot_id, zu dem die Tracks zuletzt eingelesen wurden – weicht er ab, ist neu einlesen nötig */
  tracksSnapshot?: string
  /** Spotify gibt die Tracks nicht heraus (Entwicklungsmodus: meist fremde Playlists) */
  tracksBlocked?: boolean
}

export interface Track {
  id: string
  uri: string
  name: string
  artists: string[]
  artistIds: string[]
  album: string
  year?: number
}

export interface PlaylistTracks { id: string; tracks: Track[] }

interface Schema extends DBSchema {
  kv: { key: string; value: unknown }
  playlists: { key: string; value: Playlist }
  tracks: { key: string; value: PlaylistTracks }
}

// Neue Stores (Tracks, Profile, Wahl-Historie) kommen als weitere Versionen hier dazu.
export const db = openDB<Schema>('musikclient', 2, {
  upgrade(d, old) {
    if (old < 1) {
      d.createObjectStore('kv')
      d.createObjectStore('playlists', { keyPath: 'id' })
    }
    if (old < 2) d.createObjectStore('tracks', { keyPath: 'id' })
  },
})

/** Einstellungen, Tokens, API-Schlüssel – nur lokal im Browser. */
export const kv = {
  get: async <T>(k: string) => (await db).get('kv', k) as Promise<T | undefined>,
  set: async (k: string, v: unknown) => { await (await db).put('kv', v, k) },
  del: async (k: string) => { await (await db).delete('kv', k) },
}
