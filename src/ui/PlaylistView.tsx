import { useEffect, useState } from 'react'
import { db, type Playlist, type Profile, type Track } from '../data/db'
import { getExcluded, setExcluded } from '../features/suggest'
import { findOutliers, saveDescription, writeDescription, type Outlier } from '../features/tools'
import { addToPlaylist } from '../spotify/api'
import { play } from '../spotify/player'
import { CoverRow } from './Cover'

/** Inhalt einer Playlist in Spotify-Reihenfolge, aus der lokalen Datenbank (sofort, auch offline). */
export function PlaylistView({ p, profile, onBack, onError, onChanged }: { p: Playlist; profile?: Profile; onBack: () => void; onError: (m: string) => void; onChanged: () => void }) {
  const [tracks, setTracks] = useState<Track[] | null>(null)
  useEffect(() => { db.then(d => d.get('tracks', p.id)).then(t => setTracks(t?.tracks ?? [])) }, [p.id])
  const missing = tracks ? p.total - tracks.length : 0
  const [ignored, setIgnored] = useState(false)
  useEffect(() => { getExcluded().then(ex => setIgnored(ex.has(p.id))) }, [p.id])
  const toggle = async () => { await setExcluded(p.id, !ignored); setIgnored(!ignored); onChanged() }
  const [outliers, setOutliers] = useState<Outlier[] | 'busy' | null>(null)
  const [moved, setMoved] = useState(new Set<string>())
  const [desc, setDesc] = useState<string | 'busy' | null>(null)
  const [saved, setSaved] = useState(false)
  const err = (e: unknown) => onError((e as Error).message)
  const scan = () => { setOutliers('busy'); findOutliers(p).then(setOutliers, e => { setOutliers(null); err(e) }) }
  const moveTo = (o: Outlier) => addToPlaylist(o.better!.id, o.track.uri).then(() => setMoved(m => new Set(m).add(o.track.id)), err)
  const write = () => { setDesc('busy'); setSaved(false); writeDescription(p).then(setDesc, e => { setDesc(null); err(e) }) }
  const own = p.ownedByMe || p.collaborative

  return <div className="panels">
    <CoverRow image={p.image} title={p.name} sub={`${p.total} Songs · ${p.ownedByMe ? 'eigene' : p.owner}`}
      extra={profile && <small className="prof">{[profile.genres.join(', '), profile.era, profile.mood].filter(Boolean).join(' · ')}</small>} />
    {profile?.summary && <p className="cap">{profile.summary}</p>}
    {own && <div className="actions center">
      <button className={'pill glass' + (ignored ? ' hot' : '')} aria-pressed={ignored} onClick={toggle}>
        {ignored ? '✓ Bei Vorschlägen ignoriert' : 'Bei Vorschlägen ignorieren'}</button>
      {!!tracks?.length && <button className="pill glass" disabled={outliers === 'busy'} onClick={scan}>{outliers === 'busy' ? 'Prüfe …' : 'Fremdkörper finden'}</button>}
      {p.ownedByMe && <button className="pill glass" disabled={desc === 'busy'} onClick={write}>{desc === 'busy' ? 'Schreibe …' : 'Beschreibung schreiben'}</button>}
    </div>}
    {Array.isArray(outliers) && <section className="panel glass">
      <h2>Fremdkörper</h2>
      {!outliers.length && <p className="cap left">Keine klaren Ausreißer – die Playlist ist stimmig.</p>}
      {outliers.map(o => <div key={o.track.id} className="outlier">
        <b>{o.track.artists[0]} – {o.track.name}</b><small>{o.reason}</small>
        {o.better && <button className="pill glass" disabled={moved.has(o.track.id)} onClick={() => moveTo(o)}>
          {moved.has(o.track.id) ? `In „${o.better.name}“ ✓` : `Auch in „${o.better.name}“ legen`}</button>}
      </div>)}
      {!!outliers.length && <p className="cap left">Aus dieser Playlist entfernen geht weiterhin in Spotify.</p>}
    </section>}
    {typeof desc === 'string' && desc !== 'busy' && <section className="panel glass">
      <h2>Beschreibung</h2>
      <textarea className="field" rows={3} maxLength={300} value={desc} onChange={e => { setDesc(e.target.value); setSaved(false) }} />
      <div className="actions"><button className="pill glass hot" disabled={saved}
        onClick={() => saveDescription(p, desc).then(() => { setSaved(true); onChanged() }, err)}>{saved ? 'In Spotify übernommen ✓' : 'In Spotify übernehmen'}</button>
        <button className="pill glass" onClick={write}>Neu schreiben</button></div>
    </section>}
    {!p.tracksSnapshot && <p className="cap">Songs noch nicht eingelesen – das passiert beim nächsten Abgleich, sobald Spotify es zulässt.</p>}
    {p.tracksBlocked && <p className="cap">Spotify gibt die Songs dieser Playlist nicht heraus (fremde Playlist im Entwicklungsmodus).</p>}
    {!!tracks?.length && <section className="panel glass tracks" data-fixed>
      <ol>
        {tracks.map((t, i) => <li key={i}><button onClick={() =>   // antippen: Playlist ab diesem Song abspielen
          play({ context_uri: `spotify:playlist:${p.id}`, offset: { uri: t.uri } }).catch(e => onError(e.message))}>
          <span className="nr">{i + 1}</span>
          <span className="meta"><b>{t.name}</b><small>{t.artists.join(', ')} · {t.album}{t.year ? ` · ${t.year}` : ''}</small></span>
        </button></li>)}
      </ol>
    </section>}
    {missing > 0 && !p.tracksBlocked && <p className="cap">{missing === 1 ? 'Ein Eintrag wird' : `${missing} Einträge werden`} nicht angezeigt (lokale Dateien oder Podcast-Folgen).</p>}
    <div className="actions center"><button className="pill glass" onClick={onBack}>Zurück</button></div>
  </div>
}
