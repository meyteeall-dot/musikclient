# Musikclient

Persönlicher Musik-Client (PWA) auf Basis der Spotify Web API. Vite + React + TypeScript, Daten in IndexedDB.

- `src/spotify/` Login (PKCE), API-Client, später Player
- `src/data/` IndexedDB und Abgleich über `snapshot_id`
- `src/ui/` Oberfläche, Glas-Theme

Keine Schlüssel im Repository: Client ID und KI-Schlüssel werden in den App-Einstellungen eingetragen und nur lokal gespeichert.
