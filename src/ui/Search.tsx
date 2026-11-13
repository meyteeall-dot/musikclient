import { useEffect, useState } from 'react'
import { choose, suggest, type SuggestResult } from '../features/suggest'
import { searchTracks, type SearchHit } from '../spotify/api'
import { Cover, CoverRow } from './Cover'

/** Song suchen → 3 Playlist-Vorschläge mit Begründung → Hinzufügen. */
export function Search({ onError, onAdded }: { onError: (m: string) => void; onAdded: () => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [song, setSong] = useState<SearchHit | null>(null)
  const [res, setRes] = useState<SuggestResult | null>(null)
  const [added, setAdded] = useState<Record<string, 'busy' | 'done'>>({})

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const id = setTimeout(() => searchTracks(q.trim()).then(setHits, e => onError(e.message)), 600)
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
    <CoverRow image={song.image} title={song.name} sub={`${song.artists.join(', ')}${song.year ? ` · ${song.year}` : ''}`} />
    {!res && <p className="cap">Suche passende Playlists …</p>}
    {res?.suggestions.map((s, i) => <Sugg key={s.playlist.id} image={s.playlist.image} name={s.playlist.name} reason={s.reason}
      state={added[s.playlist.id]} onAdd={() => add(i)} />)}
    {res && !res.suggestions.length && <p className="cap">Keine eigene Playlist gefunden, in die der Song noch passt.</p>}
    {res?.contains.length ? <p className="cap">Schon drin in: {res.contains.map(p => p.name).join(', ')}</p> : null}
    {res && <p className="cap">Vorschläge von: {res.provider}</p>}
    <div className="actions center"><button className="pill glass" onClick={() => setSong(null)}>Zurück zur Suche</button></div>
  </div>

  return <div className="panels">
    <input className="field" type="search" enterKeyHint="search" placeholder="Song oder Künstler suchen"
      value={q} onChange={e => setQ(e.target.value)} autoCorrect="off" spellCheck={false} />
    <ul className="list">
      {hits.map(h => <li key={h.id}><CoverRow image={h.image} title={h.name} onClick={() => pick(h)}
        sub={`${h.artists.join(', ')}${h.year ? ` · ${h.year}` : ''}`} /></li>)}
    </ul>
  </div>
}

function Sugg(p: { image?: string; name: string; reason: string; state?: 'busy' | 'done'; onAdd: () => void }) {
  return <section className="panel glass sugg">
    <div className="sugg-head"><Cover url={p.image} /><b>{p.name}</b></div>
    <p>{p.reason}</p>
    <button className={'pill glass' + (p.state ? '' : ' hot')} disabled={!!p.state} onClick={p.onAdd}>
      {p.state === 'done' ? 'Hinzugefügt ✓' : p.state ? 'Füge hinzu …' : 'Hinzufügen'}
    </button>
  </section>
}
