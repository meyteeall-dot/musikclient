/* Gemeinsame KI-Schicht: Anbieter und Modelle der Reihe nach; meldet einer einen Fehler oder ein Limit, übernimmt der nächste.
   Jedes Modell hat beim Anbieter sein eigenes Kontingent – deshalb zählt jedes Modell als eigener Eintrag.
   Weitere Anbieter mit OpenAI-kompatibler Schnittstelle (OpenRouter, Cerebras, Mistral …) trägt man unter Optionen ein. */
import { kv } from '../data/db'

export interface AiRequest { system: string; prompt: string; json?: boolean }
interface Provider { name: string; complete(r: AiRequest): Promise<string> }

// Gemini: mehrere Modelle, jedes mit eigenem Kontingent; nicht verfügbare werden übersprungen (404 → nächster)
export const AI_DEFAULTS = { geminiModel: 'gemini-3.8-flash, gemini-3.5-flash, gemini-3-flash-preview', groqModel: 'openai/gpt-oss-120b' }

/** until: Anbieter ist bis dahin gesperrt (langes Limit) – nicht vorher erneut fragen. */
class AiError extends Error { constructor(public status: number, msg: string, public until = 0) { super(msg) } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Was die KI gerade tut, für Live-Anzeigen (z. B. Trefferquote): „Gemini antwortet …“, „Limit, warte 8 s“. */
export const status = (text: string) => dispatchEvent(new CustomEvent('ai-status', { detail: { text, at: Date.now() } }))

/** Wartezeit aus einer Limit-Antwort in ms: Header retry-after, Geminis retryDelay oder Text wie „try again in 7m30.5s“ / „retry in 26s“. */
export function waitOf(r: { headers: { get(k: string): string | null } }, j: any, msg: string) {
  const h = Number(r.headers.get('retry-after'))
  if (h) return h * 1000
  const delay = JSON.stringify(j?.error?.details ?? '').match(/"retryDelay":"([\d.]+)s"/)
  if (delay) return +delay[1] * 1000
  const t = msg.match(/(?:try again|retry) in ((?:[\d.]+(?:h|ms|m|s))+)/i)?.[1]
  if (!t) return 0
  let ms = 0
  for (const [, n, u] of t.matchAll(/([\d.]+)(h|ms|m|s)/g)) ms += +n * { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }[u as 'h']
  return ms
}

/** POST mit Geduld bei kurzen Limits (429): wartet bis 30 s, sonst gleich weiter zum nächsten Anbieter. Nie ohne Ende. */
async function post(label: string, url: string, headers: Record<string, string>, body: unknown) {
  for (let attempt = 0; ; attempt++) {
    status(`${label} antwortet`)
    let r: Response
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) })
    } catch (e) {
      throw new AiError(0, (e as Error).name === 'TimeoutError' ? 'keine Antwort nach 90 s' : 'nicht erreichbar')
    }
    const j = await r.json().catch(() => ({}))
    if (r.ok) return j
    const msg = `${r.status} ${j.error?.message ?? ''}`.trim()
    // 429 trotz Warten: vermutlich Tageskontingent ohne Zeitangabe – 30 Min. Ruhe für diesen Anbieter
    if (r.status !== 429 || attempt >= 3) throw new AiError(r.status, msg, r.status === 429 ? Date.now() + 30 * 60_000 : 0)
    const said = waitOf(r, j, msg)
    // Langes Limit (Minuten bis Stunden = Tageskontingent): nicht warten, der nächste Anbieter soll übernehmen
    if (said > 30_000) throw new AiError(429, `Limit erreicht, wieder frei in ca. ${Math.ceil(said / 60_000)} Min.`, Date.now() + said)
    const wait = Math.max(said, [3000, 8000, 20000][attempt])
    status(`${label}: Limit, warte ${Math.round(wait / 1000)} s`)
    await sleep(wait)
  }
}

/** Weitere Anbieter (OpenAI-kompatibel), unter Optionen gepflegt. */
export interface ExtraAi { id: string; name: string; url: string; key: string; model: string }
export const AI_PRESETS: Omit<ExtraAi, 'id' | 'key'>[] = [
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: '' },   // Gratis-Modelle enden auf „:free“
  { name: 'Cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', model: 'gpt-oss-120b' },
  { name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
  { name: 'Eigener Anbieter', url: '', model: '' },
]

const models = (v: string | undefined, fallback: string) => [...new Set((v || fallback).split(',').map(x => x.trim()).filter(Boolean))]   // doppelte raus (z. B. nach automatischem Nachfolger-Tausch)

/** OpenAI-kompatible Chat-Schnittstelle (Groq, OpenRouter, Cerebras, Mistral …). */
async function openAi(label: string, url: string, key: string, model: string, { system, prompt, json }: AiRequest) {
  const body = (fmt: boolean) => ({
    model, temperature: .4,
    ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),   // Denk-Tokens zählen ins Minutenlimit
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    ...(json && fmt ? { response_format: { type: 'json_object' } } : {}),
  })
  let j
  try { j = await post(label, url, { Authorization: `Bearer ${key}` }, body(true)) }
  catch (e) {   // manche Modelle kennen den JSON-Modus nicht: ohne erneut, die Antwort wird ohnehin auf JSON geprüft
    if (!(e instanceof AiError && e.status === 400 && /response_format|json/i.test(e.message))) throw e
    j = await post(label, url, { Authorization: `Bearer ${key}` }, body(false))
  }
  const text = j.choices?.[0]?.message?.content
  if (!text) throw new Error('leere Antwort')
  return text as string
}

async function gemini(model: string, key: string, { system, prompt, json }: AiRequest) {
  // Kurzes Nachdenken: Sortieren braucht kein langes Grübeln, spart viel Zeit (sonst bis zu Minuten pro Anfrage)
  const think = (m: string) => m.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : m.startsWith('gemini-3') ? { thinkingLevel: 'low' } : undefined
  const req = (m: string, fast = true) => post(`Gemini · ${m}`, `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
    { 'x-goog-api-key': key }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: .4, ...(json ? { responseMimeType: 'application/json' } : {}),
        ...(fast && think(m) ? { thinkingConfig: think(m) } : {}),
      },
    })
  let j
  try {
    try { j = await req(model) }
    catch (e) {   // Modell kennt die Denk-Einstellung nicht: ohne sie erneut
      if (!(e instanceof AiError && e.status === 400 && /think/i.test(e.message))) throw e
      j = await req(model, false)
    }
  } catch (e) {
    // Modell abgeschaltet: Google nennt den Nachfolger in der Fehlermeldung – übernehmen und merken
    const next = e instanceof AiError && e.status === 404 && e.message.match(/use models\/([\w.-]+)/)?.[1]
    if (!next || next === model) throw e
    j = await req(next)
    const list = models(await kv.get<string>('geminiModel'), AI_DEFAULTS.geminiModel)
    await kv.set('geminiModel', list.map(m => m === model ? next : m).join(', '))
  }
  const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('')
  if (!text) throw new Error('leere Antwort')
  return text as string
}

/** Alle eingetragenen Anbieter × Modelle in Reihenfolge: Gemini, Groq, dann die weiteren. */
async function providers(): Promise<Provider[]> {
  const [gk, gm, qk, qm, extra] = await Promise.all([kv.get<string>('geminiKey'), kv.get<string>('geminiModel'), kv.get<string>('groqKey'), kv.get<string>('groqModel'), kv.get<ExtraAi[]>('aiExtra')])
  const out: Provider[] = []
  if (gk) for (const m of models(gm, AI_DEFAULTS.geminiModel)) out.push({ name: `Gemini · ${m}`, complete: r => gemini(m, gk, r) })
  if (qk) for (const m of models(qm, AI_DEFAULTS.groqModel)) out.push({ name: `Groq · ${m}`, complete: r => openAi(`Groq · ${m}`, 'https://api.groq.com/openai/v1/chat/completions', qk, m, r) })
  for (const x of extra ?? []) if (x.key && x.url && x.model) for (const m of models(x.model, '')) {
    const name = `${x.name} · ${m}`
    out.push({ name, complete: r => openAi(name, x.url, x.key, m, r) })
  }
  known = out.map(p => p.name)
  return out
}
let known: string[] = []

export async function hasAi() { return (await providers()).length > 0 }

/** parse: prüft die Antwort; ist sie unbrauchbar, kommt der nächste Anbieter dran. */
// Gesperrte Anbieter (langes Limit) werden bis zum Ablauf übersprungen statt bei jeder Anfrage erneut probiert
const health = new Map<string, { until: number; error: string }>()
/** Zustand der Anbieter für Anzeigen: gesperrt bis (0 = frei) und letzter Fehler. */
export const aiHealth = () => known.map(name => { const h = health.get(name); return { name, until: h && h.until > Date.now() ? h.until : 0, error: h?.error ?? '' } })

export async function complete<T = string>(r: AiRequest, parse: (text: string) => T = t => t as T) {
  const errors: string[] = []
  for (const p of await providers()) {
    const h = health.get(p.name)
    if (h && h.until > Date.now()) { errors.push(`${p.name}: ${h.error}`); continue }
    try {
      const data = parse(await p.complete(r))
      health.delete(p.name)
      return { data, provider: p.name }
    } catch (e) {
      const m = (e as Error).message
      errors.push(`${p.name}: ${m}`)
      health.set(p.name, { until: e instanceof AiError ? e.until : 0, error: m })
      status(`${p.name} fehlgeschlagen (${m.slice(0, 60)}) – nächster Anbieter`)
    }
  }
  throw new Error(errors.length ? 'KI nicht erreichbar – ' + errors.join(' | ') : 'Kein KI-Schlüssel eingetragen')
}

/** Einen einzelnen Anbieter prüfen (Knopf „Testen“): klappt der Aufruf aus dem Browser, kommt lesbares JSON zurück? */
export async function testAi(x: Pick<ExtraAi, 'name' | 'url' | 'key' | 'model'>) {
  const t0 = Date.now()
  const m = models(x.model, '')[0]
  if (!x.url || !x.key || !m) throw new Error('Adresse, Schlüssel und Modell eintragen.')
  const text = await openAi(`${x.name} · ${m}`, x.url, x.key, m, { system: 'Antworte ausschließlich mit JSON.', prompt: 'Gib {"ok": true} zurück.', json: true })
  JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  return Date.now() - t0
}

export async function completeJson<T>(r: AiRequest): Promise<{ data: T; provider: string }> {
  return complete<T>({ ...r, json: true }, text => {
    // Modelle packen JSON gern in ```-Blöcke oder schreiben einen Satz davor: vom ersten { bis zur letzten } lesen
    try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) }
    catch { throw new Error('Antwort war kein lesbares JSON') }
  })
}
