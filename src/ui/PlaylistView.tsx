import { useEffect, useState } from 'react'
import { db, type Playlist, type Profile, type Track } from '../data/db'
import { CoverRow } from './Cover'

/** Inhalt einer Playlist in Spotify-Reihenfolge, aus der lokalen Datenbank (sofort, auch offline). */
export function PlaylistView({ p, profile, onBack }: { p: Playlist; profile?: Profile; onBack: () => void }) {
  const [tracks, setTracks] = useState<Track[] | null>(null)
  useEffect(() => { db.then(d => d.get('tracks', p.id)).then(t => setTracks(t?.tracks ?? [])) }, [p.id])
  const missing = tracks ? p.total - tracks.length : 0

  return <div className="panels">
    <CoverRow big image={p.image} title={p.name} sub={`${p.total} Songs · ${p.ownedByMe ? 'eigene' : p.owner}`}
      extra={profile && <small className="prof">{[profile.genres.join(', '), profile.era, profile.mood].filter(Boolean).join(' · ')}</small>} />
    {profile?.summary && <p className="cap">{profile.summary}</p>}
    {p.tracksBlocked && <p className="cap">Spotify gibt die Songs dieser Playlist nicht heraus (fremde Playlist im Entwicklungsmodus).</p>}
    {!!tracks?.length && <section className="panel glass tracks" data-fixed>
      <ol>
        {tracks.map((t, i) => <li key={i}>
          <span className="nr">{i + 1}</span>
          <span className="meta"><b>{t.name}</b><small>{t.artists.join(', ')} · {t.album}{t.year ? ` · ${t.year}` : ''}</small></span>
        </li>)}
      </ol>
    </section>}
    {missing > 0 && !p.tracksBlocked && <p className="cap">{missing === 1 ? 'Ein Eintrag wird' : `${missing} Einträge werden`} nicht angezeigt (lokale Dateien oder Podcast-Folgen).</p>}
    <div className="actions center"><button className="pill glass" onClick={onBack}>Zurück</button></div>
  </div>
}
