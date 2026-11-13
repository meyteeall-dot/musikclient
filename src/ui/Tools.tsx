import { useEffect, useState } from 'react'
import { lastAccuracy, measureAccuracy, type Accuracy } from '../features/accuracy'

/** Werkzeuge, die Spotify nicht hat. */
export function Tools({ onError }: { onError: (m: string) => void }) {
  return <div className="panels">
    <AccuracyPanel onError={onError} />
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
    {res && <p className="cap left">{res.n} Songs · {res.provider} · {new Date(res.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</p>}
    {!!res?.misses.length && <details className="misses"><summary>Daneben ({res.misses.length})</summary>
      <ul>{res.misses.map((m, i) => <li key={i}><b>{m.song}</b><small>gehört in: {m.expected.join(', ')}</small><small>vorgeschlagen: {m.got.join(', ')}</small></li>)}</ul>
    </details>}
    <div className="actions"><button className="pill glass hot" disabled={busy !== null} onClick={run}>
      {busy !== null ? `Prüfe … ${busy}/${N}` : res ? 'Erneut messen' : 'Jetzt messen'}</button></div>
  </section>
}
