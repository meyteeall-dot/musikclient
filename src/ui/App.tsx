import { useCallback, useEffect, useState } from 'react'
import { db, kv, type Playlist } from '../data/db'
import { syncPlaylists } from '../data/sync'
import { NotLoggedIn } from '../spotify/api'
import { accessToken, handleRedirect, login, logout, redirectUri } from '../spotify/auth'

type Tab = 'playlists' | 'settings'
const SYNC_EVERY = 15 * 60 * 1000

export function App() {
  const [tab, setTab] = useState<Tab>('playlists')
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const load = async () => setPlaylists((await (await db).getAll('playlists')).sort((a, b) => a.name.localeCompare(b.name)))

  const sync = useCallback(async () => {
    setStatus('Gleiche Playlists ab …')
    try {
      const r = await syncPlaylists()
      setStatus(`${r.total} Playlists · ${r.added} neu · ${r.changed} geändert · ${r.removed} entfernt`)
      await load()
    } catch (e) {
      if (e instanceof NotLoggedIn) setLoggedIn(false)
      else setError(String((e as Error).message))
      setStatus('')
    }
  }, [])

  useEffect(() => {
    (async () => {
      try { await handleRedirect() } catch (e) { setError((e as Error).message) }
      await load()
      const ok = !!(await accessToken())
      setLoggedIn(ok)
      if (ok) sync()
      else setTab('settings')
    })()
  }, [sync])

  // Hintergrund-Abgleich: alle 15 Min. und beim Zurückkehren in die App
  useEffect(() => {
    if (!loggedIn) return
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      const last = (await kv.get<number>('lastSync')) ?? 0
      if (Date.now() - last > SYNC_EVERY) sync()
    }
    const id = setInterval(tick, 60_000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [loggedIn, sync])

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="dot" /><span className="word">Musik<i>·</i>client</span></div>
        {loggedIn && <button className="iconbtn" aria-label="Jetzt abgleichen" onClick={sync}>
          <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" /></svg>
        </button>}
      </header>

      {error && <div className="panel error" onClick={() => setError('')}>{error}</div>}

      <main className="stage">
        {tab === 'playlists' && (loggedIn
          ? <Playlists items={playlists} status={status} />
          : <div className="panel center"><p className="cap">Noch nicht mit Spotify verbunden.</p>
              <button className="pill hot" onClick={() => setTab('settings')}>Zu den Einstellungen</button></div>)}
        {tab === 'settings' && <Settings loggedIn={!!loggedIn} onError={setError}
          onLogout={async () => { await logout(); setLoggedIn(false) }} />}
      </main>

      <nav className="tabs" role="tablist">
        <TabBtn on={tab === 'playlists'} onClick={() => setTab('playlists')} label="Playlists"
          icon={<path d="M4 6h12M4 12h12M4 18h8M18 16v-9l3-1" />} />
        <TabBtn on={tab === 'settings'} onClick={() => setTab('settings')} label="Einstellungen"
          icon={<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>} />
      </nav>
    </div>
  )
}

function TabBtn(p: { on: boolean; onClick: () => void; label: string; icon: React.ReactNode }) {
  return <button className="tab" role="tab" aria-selected={p.on} onClick={p.onClick}>
    <svg viewBox="0 0 24 24">{p.icon}</svg>{p.label}</button>
}

function Playlists({ items, status }: { items: Playlist[]; status: string }) {
  return <>
    <div className="readout"><span className="k">Bibliothek</span><span className="v">{status || `${items.length} Playlists`}</span></div>
    <ul className="list">
      {items.map(p => <li key={p.id} className="row">
        {p.image ? <img src={p.image} alt="" loading="lazy" /> : <span className="ph" />}
        <span className="meta"><b>{p.name}</b><small>{p.total} Songs · {p.ownedByMe ? 'eigene' : p.owner}</small></span>
      </li>)}
    </ul>
  </>
}

function Settings(p: { loggedIn: boolean; onLogout: () => void; onError: (m: string) => void }) {
  const [clientId, setClientId] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => { kv.get<string>('clientId').then(v => setClientId(v ?? '')) }, [])

  const save = async () => { await kv.set('clientId', clientId.trim()); setSaved(true); setTimeout(() => setSaved(false), 1500) }
  const copy = async () => { await navigator.clipboard.writeText(redirectUri()); setCopied(true); setTimeout(() => setCopied(false), 1500) }

  return <div className="panels">
    <section className="panel">
      <h2>Spotify</h2>
      <label className="k">Redirect-URI (ins Dashboard eintragen)</label>
      <button className="field mono" onClick={copy}>{copied ? 'Kopiert ✓' : redirectUri()}</button>
      <label className="k" htmlFor="cid">Client ID</label>
      <input id="cid" className="field mono" value={clientId} onChange={e => setClientId(e.target.value)}
        placeholder="aus dem Spotify Dashboard einfügen" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <div className="actions">
        <button className="pill" onClick={save}>{saved ? 'Gespeichert ✓' : 'Speichern'}</button>
        {p.loggedIn
          ? <button className="pill" onClick={p.onLogout}>Abmelden</button>
          : <button className="pill hot" onClick={async () => { await save(); login().catch(e => p.onError(e.message)) }}>Mit Spotify anmelden</button>}
      </div>
    </section>
    <p className="cap">Alle Daten und Schlüssel bleiben nur auf diesem Gerät gespeichert.</p>
  </div>
}
