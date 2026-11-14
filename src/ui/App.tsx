import { useCallback, useEffect, useRef, useState } from 'react'
import { db, kv, type Playlist, type Profile } from '../data/db'
import { syncPlaylists, syncTracks } from '../data/sync'
import { AI_DEFAULTS, hasAi } from '../ai'
import { buildProfiles } from '../features/profiles'
import { getExcluded } from '../features/suggest'
import { clearPause, NotLoggedIn, RateLimited } from '../spotify/api'
import { startWebPlayer } from '../spotify/player'
import { accessToken, handleRedirect, login, logout, redirectUri } from '../spotify/auth'
import { glassScroll } from './glass/scroll'
import { CoverRow } from './Cover'
import { Player } from './Player'
import { PlaylistView } from './PlaylistView'
import { Search } from './Search'
import { Tools } from './Tools'
import { applyGlass, applyTheme, GLASS_DEFAULTS, GLASS_SLIDERS, THEMES, type GlassValues, type ThemeId } from './glass/engine'

type Tab = 'search' | 'playlists' | 'tools' | 'player' | 'settings'
const TABS: Tab[] = ['search', 'playlists', 'tools', 'player', 'settings']
const SYNC_EVERY = 15 * 60 * 1000

export function App() {
  const [tab, setTab] = useState<Tab>('search')
  const [openId, setOpenId] = useState<string | null>(null)
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [profiles, setProfiles] = useState(new Map<string, Profile>())
  const [excluded, setExcludedIds] = useState(new Set<string>())
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    const d = await db
    setPlaylists((await d.getAll('playlists')).sort((a, b) => a.name.localeCompare(b.name)))
    setProfiles(new Map((await d.getAll('profiles')).map(p => [p.id, p])))
    setExcludedIds(await getExcluded())
  }

  const running = useRef(false)
  const sync = useCallback(async () => {
    if (running.current) return   // Knopf, Timer und Start nicht doppelt laufen lassen
    running.current = true
    setBusy(true)
    try {
      const r = await syncPlaylists()
      setStatus([r.added && `${r.added} neu`, r.changed && `${r.changed} geändert`, r.removed && `${r.removed} weg`, r.held && `${r.held} fehlen (gehalten)`].filter(Boolean).join(' · ') || 'aktuell')
      await load()
      const t = await syncTracks((n, all) => all && setStatus(`Tracks ${n}/${all}`))
      if (t.done) {
        setStatus(`${t.done} eingelesen` + (t.blocked ? ` · ${t.blocked} gesperrt` : ''))
        await load()
      }
      if (await hasAi()) {
        try {
          const n = await buildProfiles((i, all) => all && setStatus(`Profile ${i}/${all}`))
          if (n) { setStatus('Profile aktuell'); await load() }
        } catch (e) { await load(); setStatus('Profile unvollständig'); setError((e as Error).message) }   // fertige Stapel bleiben gespeichert, Rest beim nächsten Abgleich
      }
    } catch (e) {
      if (e instanceof NotLoggedIn) setLoggedIn(false)
      else if (e instanceof RateLimited) setStatus('Spotify-Limit · pausiert')
      else setError(String((e as Error).message))
    }
    setBusy(false)
    running.current = false
  }, [])

  useEffect(() => {
    (async () => {
      let fresh = false
      try { fresh = await handleRedirect() } catch (e) { setError((e as Error).message) }
      await load()
      const ok = !!(await accessToken())
      setLoggedIn(ok)
      if (ok) startWebPlayer()   // PC: Browser wird zum Spotify-Gerät
      // Neuladen allein kostet keine Spotify-Anfragen: nur abgleichen, wenn der letzte Abgleich alt ist
      if (ok && (fresh || Date.now() - ((await kv.get<number>('lastSync')) ?? 0) > SYNC_EVERY)) sync()
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

  const open = openId ? playlists.find(p => p.id === openId) : undefined

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="dot" /><span className="word">Musik<i>·</i>client</span></div>
        <div className="tools">
          {loggedIn && <button className={'iconbtn glass' + (busy ? ' spin' : '')} aria-label="Jetzt abgleichen" onClick={async () => { if (!busy) { await clearPause(); sync() } }}>
            <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" /></svg>
          </button>}
        </div>
      </header>

      <div className="readout glass" aria-live="polite">
        <div><span className="k">Bibliothek</span><span className="n">{busy ? 'Abgleich …' : `${playlists.length} Playlists`}</span></div>
        <span className="v">{loggedIn ? status : 'nicht verbunden'}</span>
      </div>

      {error && <div className="panel glass error" onClick={() => setError('')}>{error}</div>}

      <Scroll key={tab + (openId ?? '')}>
        {tab === 'search' && (loggedIn
          ? <Search onError={setError} onAdded={load} />
          : <div className="panel glass center"><p className="cap">Noch nicht mit Spotify verbunden.</p>
              <button className="pill glass hot" onClick={() => setTab('settings')}>Zu den Einstellungen</button></div>)}
        {tab === 'playlists' && (loggedIn
          ? (open ? <PlaylistView p={open} profile={profiles.get(open.id)} onBack={() => setOpenId(null)} onError={setError} onChanged={load} />
            : <Playlists items={playlists} profiles={profiles} excluded={excluded} onOpen={setOpenId} />)
          : <div className="panel glass center"><p className="cap">Noch nicht mit Spotify verbunden.</p>
              <button className="pill glass hot" onClick={() => setTab('settings')}>Zu den Einstellungen</button></div>)}
        {tab === 'tools' && <Tools onError={setError} onAdded={load} />}
        {tab === 'player' && <Player onError={setError} />}
        {tab === 'settings' && <Settings loggedIn={!!loggedIn} onError={setError} onAiSaved={sync}
          onLogout={async () => { await logout(); setLoggedIn(false) }} />}
      </Scroll>

      <Tabs tab={tab} onPick={t => { setTab(t); setOpenId(null) }} />
    </div>
  )
}

function Scroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => glassScroll(ref.current!), [])
  return <main className="scroll" ref={ref}><div className="sc">{children}</div></main>
}

const TAB_UI: Record<Tab, [string, React.ReactNode]> = {
  search: ['Suche', <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>],
  playlists: ['Playlists', <path d="M4 6h12M4 12h12M4 18h8M18 16v-9l3-1" />],
  tools: ['Werkzeuge', <path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.5-2.5z" />],
  player: ['Player', <><circle cx="12" cy="12" r="8.5" /><path d="M10 8.5v7l5.5-3.5z" /></>],
  settings: ['Optionen', <><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2" /><circle cx="9" cy="16" r="2" /></>],
}

/** Tableiste mit gleitender Glaslinse (aus Druckpunkt): antippen oder die Linse seitlich ziehen. */
function Tabs({ tab, onPick }: { tab: Tab; onPick: (t: Tab) => void }) {
  const nav = useRef<HTMLElement>(null), ind = useRef<HTMLSpanElement>(null)
  const swp = useRef<{ id: number; x0: number; x: number; t: number; v: number; on: boolean; near: number } | null>(null)
  const [near, setNear] = useState(-1)
  const n = TABS.length

  const down = (e: React.PointerEvent) => { swp.current = { id: e.pointerId, x0: e.clientX, x: e.clientX, t: e.timeStamp, v: 0, on: false, near: -1 } }
  const move = (e: React.PointerEvent) => {
    const s = swp.current, el = nav.current!
    if (!s || e.pointerId !== s.id) return
    if (!s.on) {
      if (Math.abs(e.clientX - s.x0) < 8) return
      s.on = true; el.setPointerCapture(e.pointerId); el.classList.add('drag')   // Capture: danach kein Klick auf einen Tab
    }
    const r = el.getBoundingClientRect(), iw = (r.width - 12 - (n - 1) * 4) / n
    const pos = Math.max(0, Math.min(n - 1, (e.clientX - r.left - 6 - iw / 2) / (iw + 4)))
    const dt = Math.max(1, e.timeStamp - s.t)
    s.v = s.v * .6 + (e.clientX - s.x) / dt * .4; s.x = e.clientX; s.t = e.timeStamp
    const st = Math.min(.35, Math.abs(s.v) * .18)   // schnell gezogen: Linse dehnt sich in Zugrichtung
    el.style.setProperty('--i', String(pos))
    ind.current!.style.scale = `${1.08 + st} ${1.08 - st * .5}`
    if (Math.round(pos) !== s.near) { s.near = Math.round(pos); setNear(s.near); navigator.vibrate?.(4) }
  }
  const end = (e: React.PointerEvent) => {
    const s = swp.current
    if (!s || e.pointerId !== s.id) return
    swp.current = null
    if (!s.on) return
    nav.current!.classList.remove('drag'); ind.current!.style.scale = ''
    nav.current!.style.setProperty('--i', String(s.near))   // React setzt --i nur bei geändertem Tab neu
    setNear(-1); onPick(TABS[s.near])
  }

  return <nav ref={nav} className="tabs glass" role="tablist" style={{ '--n': n, '--i': TABS.indexOf(tab) } as React.CSSProperties}
    onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    <span className="ind" ref={ind} />
    {TABS.map((t, i) => <button key={t} className={'tab' + (i === near ? ' near' : '')} role="tab" aria-selected={t === tab} onClick={() => onPick(t)}>
      <svg viewBox="0 0 24 24">{TAB_UI[t][1]}</svg>{TAB_UI[t][0]}</button>)}
  </nav>
}

function Playlists({ items, profiles, excluded, onOpen }: { items: Playlist[]; profiles: Map<string, Profile>; excluded: Set<string>; onOpen: (id: string) => void }) {
  return <ul className="list">
    {items.map(p => {
      const pr = profiles.get(p.id)
      return <li key={p.id}><CoverRow image={p.image} title={p.name} onClick={() => onOpen(p.id)}
        sub={`${p.total} Songs · ${p.ownedByMe ? 'eigene' : p.owner}${excluded.has(p.id) ? ' · ignoriert' : ''}${p.tracksBlocked ? ' · Tracks gesperrt' : p.tracksSnapshot ? '' : ' · wird noch eingelesen'}`}
        extra={pr && <small className="prof">{[pr.genres.slice(0, 2).join(', '), pr.era, pr.mood].filter(Boolean).join(' · ')}</small>} /></li>
    })}
  </ul>
}

function Settings(p: { loggedIn: boolean; onLogout: () => void; onError: (m: string) => void; onAiSaved: () => void }) {
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
    <AiKeys onSaved={p.onAiSaved} />
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

/** KI-Schlüssel und Modelle. Gemini zuerst, Groq springt bei Fehler oder Limit ein. */
function AiKeys({ onSaved }: { onSaved: () => void }) {
  const fields = [
    ['geminiKey', 'Gemini-Schlüssel', 'password'], ['geminiModel', 'Gemini-Modell', 'text'],
    ['groqKey', 'Groq-Schlüssel (Ersatz)', 'password'], ['groqModel', 'Groq-Modell', 'text'],
  ] as const
  const [v, setV] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    Promise.all(fields.map(async ([k]) => [k, (await kv.get<string>(k)) ?? AI_DEFAULTS[k as keyof typeof AI_DEFAULTS] ?? ''] as const))
      .then(e => setV(Object.fromEntries(e)))
  }, [])
  const save = async () => {
    for (const [k] of fields) await kv.set(k, (v[k] ?? '').trim())
    setSaved(true); setTimeout(() => setSaved(false), 1500)
    onSaved()
  }
  return <section className="panel glass">
    <h2>KI</h2>
    {fields.map(([k, label, type]) => <div key={k} className="kfield">
      <label className="k" htmlFor={k}>{label}</label>
      <input id={k} type={type} className="field mono" value={v[k] ?? ''} onChange={e => setV({ ...v, [k]: e.target.value })}
        autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" />
    </div>)}
    <div className="actions"><button className="pill glass" onClick={save}>{saved ? 'Gespeichert ✓' : 'Speichern'}</button></div>
  </section>
}
