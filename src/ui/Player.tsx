import { useEffect, useState, useSyncExternalStore } from 'react'
import * as P from '../spotify/player'
import { Cover } from './Cover'

const POLL_MS = 60_000   // Fernsteuerung: Zustand nur 1× pro Minute holen (plus nach jedem Befehl), solange der Player sichtbar ist – Spotify-Limit
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

export function Player({ onError }: { onError: (m: string) => void }) {
  const s = useSyncExternalStore(P.subscribe, P.getState)
  const [, tick] = useState(0)
  const [devs, setDevs] = useState<P.Device[] | null>(null)
  const run = (f: () => Promise<unknown>) => f().catch(e => onError((e as Error).message))

  useEffect(() => {
    const poll = () => { if (document.visibilityState === 'visible' && !P.usesWebPlayer()) run(P.refresh) }
    poll()
    const a = setInterval(poll, POLL_MS), b = setInterval(() => tick(n => n + 1), 1000)   // Fortschritt lokal weiterzählen
    return () => { clearInterval(a); clearInterval(b) }
  }, [])

  const pos = s ? Math.min(s.track.durationMs, s.progressMs + (s.playing ? Date.now() - s.at : 0)) : 0

  return <div className="panels">
    <section className="panel glass player">
      <Cover url={s?.track.image} />
      <div className="np">
        <b>{s?.track.name ?? 'Gerade läuft nichts'}</b>
        <small>{s ? s.track.artists.join(', ') : 'Starte einen Song in der Suche oder einer Playlist.'}</small>
      </div>
      <div className="prog" style={{ '--v': s ? pos / s.track.durationMs : 0 } as React.CSSProperties}><span /></div>
      <div className="times"><span>{fmt(pos)}</span><span>{s ? fmt(s.track.durationMs) : '0:00'}</span></div>
      <div className="ctrl">
        <button className="iconbtn glass" aria-label="Zurück" onClick={() => run(P.previous)}>
          <svg viewBox="0 0 24 24"><path d="M18 6v12L9 12zM6 6v12" /></svg></button>
        <button className="iconbtn glass big" aria-label={s?.playing ? 'Pause' : 'Abspielen'} onClick={() => run(s?.playing ? P.pause : P.resume)}>
          <svg viewBox="0 0 24 24">{s?.playing ? <path d="M8 5v14M16 5v14" /> : <path d="M7 5v14l12-7z" />}</svg></button>
        <button className="iconbtn glass" aria-label="Weiter" onClick={() => run(P.next)}>
          <svg viewBox="0 0 24 24"><path d="M6 6v12l9-6zM18 6v12" /></svg></button>
      </div>
    </section>

    <section className="panel glass">
      <span className="k">Läuft auf · {s?.device?.name ?? 'keinem Gerät'}</span>
      {devs && (devs.length
        ? <div className="actions">{devs.map(d => <button key={d.id} className={'pill glass' + (d.is_active ? ' hot' : '')}
            onClick={() => run(async () => { await P.transfer(d.id); setDevs(null) })}>{d.name}</button>)}</div>
        : <p className="cap">Kein Gerät gefunden. Öffne die Spotify-App auf Handy oder PC, dann erscheint sie hier.</p>)}
      <div className="actions"><button className="pill glass" onClick={() => run(async () => setDevs(await P.devices()))}>
        {devs ? 'Geräte neu laden' : 'Gerät wählen'}</button></div>
    </section>
    {P.isMobile && <p className="cap">Am Handy und Tablet steuert Musikclient die Spotify-App fern – der Ton kommt aus der Spotify-App.</p>}
  </div>
}
