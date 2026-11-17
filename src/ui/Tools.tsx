import { useEffect, useRef, useState } from 'react'
import { lastAccuracy, measureAccuracy, type Accuracy, type Miss, type Step } from '../features/accuracy'
import { forgetLesson, getLessons } from '../features/lessons'
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

type Totals = { n: number; top1: number; top3: number; l1: number; l3: number; misses: Miss[] }

function AccuracyPanel({ onError }: { onError: (m: string) => void }) {
  const [res, setRes] = useState<Accuracy | null>(null)
  const [n, setN] = useState(10)
  const [endless, setEndless] = useState(false)
  const [tot, setTot] = useState<Totals | null>(null)   // Endlos-Modus: Summe über alle Runden
  const [prog, setProg] = useState<{ done: number; total: number; steps: Step[]; t0: number; round: number } | null>(null)
  const [wait, setWait] = useState(0)   // Endlos: Pause wegen KI-Limit bis (ms-Zeitstempel)
  const [err, setErr] = useState('')
  const [learned, setLearned] = useState(0)
  const [forgot, setForgot] = useState(new Set<string>())
  const stop = useRef(false)
  const [, tick] = useState(0)
  useEffect(() => { lastAccuracy().then(r => r && setRes(r)); getLessons().then(l => setLearned(l.length)) }, [])
  useEffect(() => { if (!prog && !wait) return; const id = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(id) }, [!!prog, !!wait])
  const [ai, setAi] = useState<{ text: string; at: number } | null>(null)
  useEffect(() => {
    const on = (e: Event) => setAi((e as CustomEvent).detail)
    addEventListener('ai-status', on); return () => removeEventListener('ai-status', on)
  }, [])

  const round = async (size: number, skip: Set<string>, r: number) => {
    const t0 = Date.now()
    setProg({ done: 0, total: size, steps: [], t0, round: r })
    return measureAccuracy(size, (done, total, step) => setProg(p => p && ({ ...p, done, total, steps: step ? [...p.steps, step].slice(-12) : p.steps })), { skip, stop: () => stop.current })
  }
  const run = async () => {
    setErr(''); stop.current = false
    const lock = await (navigator as any).wakeLock?.request('screen').catch(() => null)   // Bildschirm anlassen, solange es läuft
    try {
      if (!endless) { setRes(await round(n, new Set(), 1)); return }
      const skip = new Set<string>(), t: Totals = { n: 0, top1: 0, top3: 0, l1: 0, l3: 0, misses: [] }
      setTot({ ...t })
      for (let r = 1; !stop.current; r++) {
        let x: Accuracy
        try { x = await round(10, skip, r) }
        catch (e) {
          const m = (e as Error).message
          if (m.startsWith('Alle Songs') && skip.size) { skip.clear(); continue }   // einmal durch: von vorn (gelernte bleiben draußen)
          if (!m.startsWith('Kein Song')) throw e
          // KI am Limit: 5 Minuten warten, dann weiter (Stopp beendet sofort)
          const until = Date.now() + 5 * 60_000
          setWait(until)
          while (!stop.current && Date.now() < until) await new Promise(res => setTimeout(res, 1000))
          setWait(0); continue
        }
        x.tested?.forEach(id => skip.add(id))
        Object.assign(t, { n: t.n + x.n, top1: t.top1 + x.top1, top3: t.top3 + x.top3, l1: t.l1 + (x.local?.top1 ?? 0), l3: t.l3 + (x.local?.top3 ?? 0), misses: [...x.misses, ...t.misses].slice(0, 100) })
        setTot({ ...t }); setRes(x)
        setLearned((await getLessons()).length)
      }
    } catch (e) { setErr((e as Error).message); onError((e as Error).message) }
    finally { lock?.release?.(); setProg(null); setWait(0); getLessons().then(l => setLearned(l.length)) }
  }
  const forget = async (id?: string) => { if (!id) return; await forgetLesson(id); setForgot(f => new Set(f).add(id)); setLearned(l => l - 1) }

  const busy = !!prog || !!wait
  const show = endless && tot ? { n: tot.n, top1: tot.top1, top3: tot.top3, local: { top1: tot.l1, top3: tot.l3 }, misses: tot.misses } : res
  const secs = prog ? Math.floor((Date.now() - prog.t0) / 1000) : 0
  return <section className="panel glass">
    <h2>Trefferquote</h2>
    <p className="cap left">Die App nimmt zufällige Songs aus deinen Playlists, tut so, als wären sie neu, und prüft, ob sie die richtige Playlist vorschlägt. Liegt sie daneben, merkt sie sich das und macht den Fehler künftig nicht mehr. Kostet nur KI-Anfragen (≈ 2 pro Song), keine bei Spotify.</p>
    {show && show.n > 0 && <div className="stats">
      <div><b>{pct(show.top1, show.n)}</b><small>auf Platz 1</small></div>
      <div><b>{pct(show.top3, show.n)}</b><small>unter den Top 3</small></div>
    </div>}
    {show?.local && show.n > 0 && <p className="cap left">Ohne KI wären es {pct(show.local.top1, show.n)} auf Platz 1 und {pct(show.local.top3, show.n)} in den Top 3.</p>}
    {show && <p className="cap left">{endless && tot ? `Endlos: ${tot.n} Songs geprüft` : `${show.n} Songs`}{res && !endless ? ` · ${res.provider} · ${new Date(res.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : ''} · {learned} Merksätze gelernt</p>}
    {!!show?.misses.length && <details className="misses"><summary>Daneben ({show.misses.length}) – daraus gelernt</summary>
      <ul>{show.misses.map((m, i) => <li key={i}><b>{m.song}</b><small>gehört in: {m.expected.join(', ')}</small>
        <small>vorgeschlagen: {m.got.join(', ')}{m.top3 ? ' (richtig war unter den Top 3)' : ''}</small>
        {m.trackId && <button className="pill glass mini" disabled={forgot.has(m.trackId)} onClick={() => forget(m.trackId)}>
          {forgot.has(m.trackId) ? 'Vergessen ✓' : 'Kein echter Fehler – nicht lernen'}</button>}</li>)}</ul>
    </details>}
    {prog && <ul className="steps">
      {prog.steps.map((s, i) => <li key={i} className={s.failed ? 'fail' : s.top1 ? 'ok' : s.top3 ? 'mid' : 'no'}>
        <span>{s.failed ? '!' : s.top1 ? '✓' : s.top3 ? '≈' : '✕'}</span>{s.song}{s.failed && <small>{s.failed}</small>}</li>)}
      {prog.done < prog.total && <li className="run"><span>…</span>{endless ? `Runde ${prog.round} · ` : ''}prüfe Song {prog.done + 1} von {prog.total} · läuft seit {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        {ai && <small>{ai.text} … {Math.floor((Date.now() - ai.at) / 1000)} s</small>}</li>}
    </ul>}
    {wait > 0 && <p className="cap left">KI am Limit – nächster Versuch in {Math.ceil((wait - Date.now()) / 60_000)} Min.</p>}
    {busy && <p className="cap left">Pro Song etwa 10–30 Sekunden. Seite offen lassen – im Hintergrund pausiert der Browser.</p>}
    {err && !busy && <p className="cap left err">Messung abgebrochen: {err}</p>}
    <div className="actions">
      {[10, 20].map(x => <button key={x} className={'pill glass' + (!endless && n === x ? ' hot' : '')} disabled={busy} onClick={() => { setN(x); setEndless(false) }}>{x} Songs</button>)}
      <button className={'pill glass' + (endless ? ' hot' : '')} disabled={busy} onClick={() => setEndless(true)}>∞ Endlos</button>
    </div>
    <div className="actions">
      {busy ? <button className="pill glass hot" onClick={() => { stop.current = true }}>{stop.current ? 'Stoppe nach diesem Song …' : 'Stopp'}</button>
        : <button className="pill glass hot" onClick={run}>{endless ? 'Endlos starten' : res ? 'Erneut messen' : 'Jetzt messen'}</button>}
    </div>
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
      {mix.criteria && <p className="cap left">Verstanden als: {mix.criteria} · {mix.tracks.length} Songs</p>}
      <ol className="mix">{mix.tracks.map((t, i) => <li key={t.id}><span className="nr">{i + 1}</span>{t.artists[0]} – {t.name}</li>)}</ol>
      <div className="actions">
        {url ? <a className="pill glass hot" href={url} target="_blank" rel="noreferrer">In Spotify öffnen ↗</a>
          : <button className="pill glass hot" disabled={!!busy} onClick={create}>{busy === 'create' ? 'Lege an …' : 'In Spotify anlegen'}</button>}
      </div>
    </>}
  </section>
}
