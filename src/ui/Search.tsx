import { useEffect, useState } from 'react'
import { choose, suggest, type SuggestResult } from '../features/suggest'
import { searchTracks, type SearchHit } from '../spotify/api'

/** Song suchen → 3 Playlist-Vorschläge mit Begründung → Hinzufügen. */
export function Search({ onError, onAdded }: { onError: (m: string) => void; onAdded: () => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [song, setSong] = useState<SearchHit | null>(null)
  const [res, setRes] = useState<SuggestResult | null>(null)
  const [added, setAdded] = useState<Record<string, 'busy' | 'done'>>({})

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const id = setTimeout(() => searchTracks(q.trim()).then(setHits, e => onError(e.message)), 350)
    return () => clearTimeout(id)
  }, [q])

  const pick = async (h: SearchHit) => {
    setSong(h); setRes(null); setAdded({})
    try { setRes(await suggest(h)) } catch (e) { onError((e as Error).message); setSong(null) }
  }
  const add = async (i: number) => {
    const s = res!.suggestions[i]
    setAdded(a => ({ ...a, [s.playlist.id]: 'busy' }))
    try {
      await choose(song!, s.playlist, res!.suggestions.map(x => x.playlist.id))
      setAdded(a => ({ ...a, [s.playlist.id]: 'done' })); onAdded()
    } catch (e) { setAdded(a => { const { [s.playlist.id]: _, ...r } = a; return r }); onError((e as Error).message) }
  }

  if (song) return <div className="panels">
    <div className="row glass">
      {song.image ? <img src={song.image} alt="" /> : <span className="ph" />}
      <span className="meta"><b>{song.name}</b><small>{song.artists.join(', ')}{song.year ? ` · ${song.year}` : ''}</small></span>
    </div>
    {!res && <p className="cap">Suche passende Playlists …</p>}
    {res?.suggestions.map((s, i) => <section key={s.playlist.id} className="panel glass sugg">
      <div className="sugg-head">
        {s.playlist.image ? <img src={s.playlist.image} alt="" /> : <span className="ph" />}
        <b>{s.playlist.name}</b>
      </div>
      <p>{s.reason}</p>
      <button className={'pill glass' + (added[s.playlist.id] ? '' : ' hot')} disabled={!!added[s.playlist.id]} onClick={() => add(i)}>
        {added[s.playlist.id] === 'done' ? 'Hinzugefügt ✓' : added[s.playlist.id] ? 'Füge hinzu …' : 'Hinzufügen'}
      </button>
    </section>)}
    {res && !res.suggestions.length && <p className="cap">Keine eigene Playlist gefunden, in die der Song noch passt.</p>}
    {res?.contains.length ? <p className="cap">Schon drin in: {res.contains.map(p => p.name).join(', ')}</p> : null}
    {res && <p className="cap">Vorschläge von: {res.provider}</p>}
    <div className="actions center"><button className="pill glass" onClick={() => setSong(null)}>Zurück zur Suche</button></div>
  </div>

  return <div className="panels">
    <input className="field" type="search" enterKeyHint="search" placeholder="Song oder Künstler suchen"
      value={q} onChange={e => setQ(e.target.value)} autoCorrect="off" spellCheck={false} />
    <ul className="list">
      {hits.map(h => <li key={h.id}><button className="row glass" onClick={() => pick(h)}>
        {h.image ? <img src={h.image} alt="" loading="lazy" /> : <span className="ph" />}
        <span className="meta"><b>{h.name}</b><small>{h.artists.join(', ')}{h.year ? ` · ${h.year}` : ''}</small></span>
      </button></li>)}
    </ul>
  </div>
}
