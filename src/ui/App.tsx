import { useCallback, useEffect, useRef, useState } from 'react'
import { db, kv, type Playlist } from '../data/db'
import { syncPlaylists, syncTracks } from '../data/sync'
import { NotLoggedIn } from '../spotify/api'
import { accessToken, handleRedirect, login, logout, redirectUri } from '../spotify/auth'
import { glassScroll } from './glass/scroll'
import { applyGlass, applyTheme, GLASS_DEFAULTS, GLASS_SLIDERS, THEMES, type GlassValues, type ThemeId } from './glass/engine'

type Tab = 'playlists' | 'settings'
const TABS: Tab[] = ['playlists', 'settings']
const SYNC_EVERY = 15 * 60 * 1000

export function App() {
  const [tab, setTab] = useState<Tab>('playlists')
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => setPlaylists((await (await db).getAll('playlists')).sort((a, b) => a.name.localeCompare(b.name)))

  const running = useRef(false)
  const sync = useCallback(async () => {
    if (running.current) return   // Knopf, Timer und Start nicht doppelt laufen lassen
    running.current = true
    setBusy(true)
    try {
      const r = await syncPlaylists()
      setStatus([r.added && `${r.added} neu`, r.changed && `${r.changed} geändert`, r.removed && `${r.removed} weg`].filter(Boolean).join(' · ') || 'aktuell')
      await load()
      const t = await syncTracks((n, all) => all && setStatus(`Tracks ${n}/${all}`))
      if (t.done) {
        setStatus(`${t.done} Playlists eingelesen` + (t.blocked ? ` · ${t.blocked} gesperrt` : ''))
        await load()
      }
    } catch (e) {
      if (e instanceof NotLoggedIn) setLoggedIn(false)
      else setError(String((e as Error).message))
    }
    setBusy(false)
    running.current = false
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
        <div className="tools">
          {loggedIn && <button className={'iconbtn glass' + (busy ? ' spin' : '')} aria-label="Jetzt abgleichen" onClick={sync}>
            <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" /></svg>
          </button>}
        </div>
      </header>

      <div className="readout glass" aria-live="polite">
        <div><span className="k">Bibliothek</span><span className="n">{busy ? 'Abgleich …' : `${playlists.length} Playlists`}</span></div>
        <span className="v">{loggedIn ? status : 'nicht verbunden'}</span>
      </div>

      {error && <div className="panel glass error" onClick={() => setError('')}>{error}</div>}

      <Scroll key={tab}>
        {tab === 'playlists' && (loggedIn
          ? <Playlists items={playlists} />
          : <div className="panel glass center"><p className="cap">Noch nicht mit Spotify verbunden.</p>
              <button className="pill glass hot" onClick={() => setTab('settings')}>Zu den Einstellungen</button></div>)}
        {tab === 'settings' && <Settings loggedIn={!!loggedIn} onError={setError}
          onLogout={async () => { await logout(); setLoggedIn(false) }} />}
      </Scroll>

      <nav className="tabs glass" role="tablist" style={{ '--n': TABS.length, '--i': TABS.indexOf(tab) } as React.CSSProperties}>
        <span className="ind" />
        <TabBtn on={tab === 'playlists'} onClick={() => setTab('playlists')} label="Playlists"
          icon={<path d="M4 6h12M4 12h12M4 18h8M18 16v-9l3-1" />} />
        <TabBtn on={tab === 'settings'} onClick={() => setTab('settings')} label="Einstellungen"
          icon={<><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2" /><circle cx="9" cy="16" r="2" /></>} />
      </nav>
    </div>
  )
}

function Scroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => glassScroll(ref.current!), [])
  return <main className="scroll" ref={ref}><div className="sc">{children}</div></main>
}

function TabBtn(p: { on: boolean; onClick: () => void; label: string; icon: React.ReactNode }) {
  return <button className="tab" role="tab" aria-selected={p.on} onClick={p.onClick}>
    <svg viewBox="0 0 24 24">{p.icon}</svg>{p.label}</button>
}

function Playlists({ items }: { items: Playlist[] }) {
  return <ul className="list">
    {items.map(p => <li key={p.id} className="row glass">
      {p.image ? <img src={p.image} alt="" loading="lazy" /> : <span className="ph" />}
      <span className="meta"><b>{p.name}</b><small>{p.total} Songs · {p.ownedByMe ? 'eigene' : p.owner}{p.tracksBlocked ? ' · Tracks gesperrt' : ''}</small></span>
    </li>)}
  </ul>
}

function Settings(p: { loggedIn: boolean; onLogout: () => void; onError: (m: string) => void }) {
  const [clientId, setClientId] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => { kv.get<string>('clientId').then(v => setClientId(v ?? '')) }, [])

  const save = async () => { await kv.set('clientId', clientId.trim()); setSaved(true); setTimeout(() => setSaved(false), 1500) }
  const copy = async () => { await navigator.clipboard.writeText(redirectUri()); setCopied(true); setTimeout(() => setCopied(false), 1500) }

  return <div className="panels">
    <section className="panel glass">
      <h2>Spotify</h2>
      <label className="k">Redirect-URI (ins Dashboard eintragen)</label>
      <button className="field mono" onClick={copy}>{copied ? 'Kopiert ✓' : redirectUri()}</button>
      <label className="k" htmlFor="cid">Client ID</label>
      <input id="cid" className="field mono" value={clientId} onChange={e => setClientId(e.target.value)}
        placeholder="aus dem Spotify Dashboard einfügen" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <div className="actions">
        <button className="pill glass" onClick={save}>{saved ? 'Gespeichert ✓' : 'Speichern'}</button>
        {p.loggedIn
          ? <button className="pill glass" onClick={p.onLogout}>Abmelden</button>
          : <button className="pill glass hot" onClick={async () => { await save(); login().catch(e => p.onError(e.message)) }}>Mit Spotify anmelden</button>}
      </div>
    </section>
    <Look />
    <p className="cap">Alle Daten und Schlüssel bleiben nur auf diesem Gerät gespeichert.</p>
  </div>
}

/** Farbwelt und Glas-Regler aus Druckpunkt; lokal gespeichert. */
function Look() {
  const [theme, setTheme] = useState<ThemeId>((document.body.dataset.theme as ThemeId) || 'color')
  const [glass, setGlass] = useState<GlassValues>(GLASS_DEFAULTS)
  useEffect(() => { kv.get<GlassValues>('glass').then(v => v && setGlass({ ...GLASS_DEFAULTS, ...v })) }, [])
  const pickTheme = (t: ThemeId) => { setTheme(t); applyTheme(t); kv.set('theme', t) }
  const change = (g: GlassValues) => { setGlass(g); applyGlass(g); kv.set('glass', g) }

  return <section className="panel glass">
    <h2>Aussehen</h2>
    <span className="k">Farbwelt · {THEMES[theme].name}</span>
    <div className="swatches" role="radiogroup" aria-label="Farbwelt">
      {(Object.keys(THEMES) as ThemeId[]).map(id => <button key={id} className="swatch" role="radio" aria-checked={id === theme}
        aria-label={THEMES[id].name} style={{ background: THEMES[id].sw }} onClick={() => pickTheme(id)} />)}
    </div>
    {GLASS_SLIDERS.map(s => <div className="gs" key={s.k}>
      <div className="gs-head"><span>{s.name}</span><b>{glass[s.k]} %</b></div>
      <div className="gs-track glass" style={{ '--v': glass[s.k] / 100 } as React.CSSProperties}>
        <span className="gs-fill" /><span className="gs-thumb glass" />
        <input type="range" min={0} max={100} value={glass[s.k]} aria-label={s.name}
          onChange={e => change({ ...glass, [s.k]: +e.target.value })} />
      </div>
    </div>)}
    <div className="actions"><button className="pill glass" onClick={() => change(GLASS_DEFAULTS)}>Glas zurücksetzen</button></div>
  </section>
}
