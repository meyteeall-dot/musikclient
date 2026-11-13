import { useEffect, useState } from 'react'
import { lastAccuracy, measureAccuracy, type Accuracy } from '../features/accuracy'
import { doneInbox, loadInbox } from '../features/inbox'
import { buildMix, createMix, type Mix } from '../features/mix'
import { findDuplicates, type Dupe } from '../features/tools'
import type { SearchHit } from '../spotify/api'
import { CoverRow } from './Cover'
import { SongSuggest } from './Search'

/** Werkzeuge, die Spotify nicht hat. */
export function Tools({ onError, onAdded }: { onError: (m: string) => void; onAdded: () => void }) {
  const [song, setSong] = useState<SearchHit | null>(null)
  if (song) return <SongSuggest song={song} back="Zurück zur Inbox" onError={onError}
    onBack={() => setSong(null)} onAdded={() => { doneInbox(song.id); inboxCache = inboxCache?.filter(x => x.id !== song.id) ?? null; onAdded() }} />
  return <div className="panels">
    <InboxPanel onError={onError} onPick={setSong} />
    <MixPanel onError={onError} />
    <AccuracyPanel onError={onError} />
    <DupesPanel />
  </div>
}

const pct = (a: number, n: number) => `${Math.round(a / n * 100)} %`

function AccuracyPanel({ onError }: { onError: (m: string) => void }) {
  const [res, setRes] = useState<Accuracy | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const N = 10
  useEffect(() => { lastAccuracy().then(r => r && setRes(r)) }, [])
  const run = async () => {
    setBusy(0)
    try { setRes(await measureAccuracy(N, setBusy)) } catch (e) { onError((e as Error).message) }
    setBusy(null)
  }
  return <section className="panel glass">
    <h2>Trefferquote</h2>
    <p className="cap left">Die App nimmt {N} zufällige Songs aus deinen Playlists, tut so, als wären sie neu, und prüft, ob sie die richtige Playlist vorschlägt. Kostet nur KI-Anfragen (≈ 2 pro Song), keine bei Spotify.</p>
    {res && <div className="stats">
      <div><b>{pct(res.top1, res.n)}</b><small>auf Platz 1</small></div>
      <div><b>{pct(res.top3, res.n)}</b><small>unter den Top 3</small></div>
    </div>}
    {res?.local && <p className="cap left">Ohne KI wären es {pct(res.local.top1, res.n)} auf Platz 1 und {pct(res.local.top3, res.n)} in den Top 3.</p>}
    {res && <p className="cap left">{res.n} Songs · {res.provider} · {new Date(res.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</p>}
    {!!res?.misses.length && <details className="misses"><summary>Daneben ({res.misses.length})</summary>
      <ul>{res.misses.map((m, i) => <li key={i}><b>{m.song}</b><small>gehört in: {m.expected.join(', ')}</small><small>vorgeschlagen: {m.got.join(', ')}</small></li>)}</ul>
    </details>}
    <div className="actions"><button className="pill glass hot" disabled={busy !== null} onClick={run}>
      {busy !== null ? `Prüfe … ${busy}/${N}` : res ? 'Erneut messen' : 'Jetzt messen'}</button></div>
  </section>
}

function DupesPanel() {
  const [list, setList] = useState<Dupe[] | null>(null)
  return <section className="panel glass">
    <h2>Doppelte Songs</h2>
    <p className="cap left">Derselbe Song mehrfach in einer Playlist – genau gleich oder als andere Version (Remaster, Live, Edit). Lokal, ohne Anfragen.</p>
    {list && !list.length && <p className="cap left">Keine doppelten Songs gefunden.</p>}
    {list && !!list.length && <ul className="dupes">{list.map((x, i) => <li key={i}>
      <b>{x.name}</b><small>{x.count}× in „{x.playlist.name}“{x.versions ? ' · verschiedene Versionen' : ''}</small></li>)}</ul>}
    <div className="actions"><button className="pill glass" onClick={() => findDuplicates().then(setList)}>{list ? 'Erneut suchen' : 'Suchen'}</button></div>
  </section>
}

// Bleibt beim Wechsel zur Vorschlagsansicht erhalten, damit nicht jedes Mal neu bei Spotify angefragt wird
let inboxCache: SearchHit[] | null = null

function InboxPanel({ onError, onPick }: { onError: (m: string) => void; onPick: (s: SearchHit) => void }) {
  const [list, setList] = useState<SearchHit[] | null>(inboxCache)
  const [busy, setBusy] = useState(false)
  const show = (l: SearchHit[]) => { inboxCache = l; setList(l) }
  const load = () => { setBusy(true); loadInbox().then(show, e => onError(e.message)).finally(() => setBusy(false)) }
  const skip = (h: SearchHit) => { doneInbox(h.id); show(list!.filter(x => x !== h)) }
  return <section className="panel glass">
    <h2>Inbox</h2>
    <p className="cap left">Zuletzt gehörte Songs, die in keiner deiner Playlists liegen. Antippen zum Einsortieren. Eine Spotify-Anfrage pro Laden.</p>
    {list && !list.length && <p className="cap left">Alles einsortiert.</p>}
    {list && !!list.length && <ul className="list">{list.map(h => <li key={h.id} className="inbox-item">
      <CoverRow image={h.image} title={h.name} sub={h.artists.join(', ')} onClick={() => onPick(h)} />
      <button className="never" aria-label="Überspringen" title="Überspringen" onClick={() => skip(h)}>✕</button>
    </li>)}</ul>}
    <div className="actions"><button className="pill glass hot" disabled={busy} onClick={load}>{busy ? 'Lade …' : list ? 'Neu laden' : 'Inbox laden'}</button></div>
  </section>
}

function MixPanel({ onError }: { onError: (m: string) => void }) {
  const [words, setWords] = useState('')
  const [count, setCount] = useState(30)
  const [mix, setMix] = useState<Mix | null>(null)
  const [busy, setBusy] = useState<'build' | 'create' | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const build = () => { setBusy('build'); setUrl(null); buildMix(words.trim(), count).then(setMix, e => onError(e.message)).finally(() => setBusy(null)) }
  const create = () => { setBusy('create'); createMix(mix!).then(setUrl, e => onError(e.message)).finally(() => setBusy(null)) }
  return <section className="panel glass">
    <h2>KI-Playlist</h2>
    <p className="cap left">Ein paar Worte, z. B. „ruhig, Nacht, 2010er“ – die KI stellt aus deinen eigenen Songs eine Playlist in guter Reihenfolge zusammen.</p>
    <input className="field" value={words} onChange={e => setWords(e.target.value)} placeholder="Stimmung, Anlass, Genre …" enterKeyHint="go"
      onKeyDown={e => e.key === 'Enter' && words.trim() && build()} />
    <div className="actions">
      {[20, 30, 50].map(n => <button key={n} className={'pill glass' + (count === n ? ' hot' : '')} onClick={() => setCount(n)}>{n} Songs</button>)}
    </div>
    <div className="actions"><button className="pill glass hot" disabled={!words.trim() || !!busy} onClick={build}>
      {busy === 'build' ? 'Stelle zusammen …' : mix ? 'Neu zusammenstellen' : 'Zusammenstellen'}</button></div>
    {mix && <>
      <b className="mix-name">{mix.name}</b>
      {mix.description && <p className="cap left">{mix.description}</p>}
      <ol className="mix">{mix.tracks.map((t, i) => <li key={t.id}><span className="nr">{i + 1}</span>{t.artists[0]} – {t.name}</li>)}</ol>
      <div className="actions">
        {url ? <a className="pill glass hot" href={url} target="_blank" rel="noreferrer">In Spotify öffnen ↗</a>
          : <button className="pill glass hot" disabled={!!busy} onClick={create}>{busy === 'create' ? 'Lege an …' : 'In Spotify anlegen'}</button>}
      </div>
    </>}
  </section>
}
