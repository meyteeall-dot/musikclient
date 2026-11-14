/* Gemeinsame KI-Schicht: Anbieter der Reihe nach; meldet einer einen Fehler oder ein Limit, übernimmt der nächste.
   Neuer Anbieter = weiteres Objekt mit available()/complete() in PROVIDERS. */
import { kv } from '../data/db'

export interface AiRequest { system: string; prompt: string; json?: boolean }
interface Provider { name: string; available(): Promise<boolean>; complete(r: AiRequest): Promise<string> }

export const AI_DEFAULTS = { geminiModel: 'gemini-3.8-flash', groqModel: 'openai/gpt-oss-120b' }

class AiError extends Error { constructor(public status: number, msg: string) { super(msg) } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
async function post(url: string, headers: Record<string, string>, body: unknown) {
  for (let attempt = 0; ; attempt++) {
    let r: Response
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) })
    } catch (e) {
      throw new AiError(0, (e as Error).name === 'TimeoutError' ? 'keine Antwort nach 90 s' : 'nicht erreichbar')
    }
    const j = await r.json().catch(() => ({}))
    if (r.ok) return j
    const msg = `${r.status} ${j.error?.message ?? ''}`.trim()
    if (r.status !== 429 || attempt >= 3) throw new AiError(r.status, msg)
    const said = waitOf(r, j, msg)
    // Langes Limit (Minuten bis Stunden = Tageskontingent): nicht warten, der nächste Anbieter soll übernehmen
    if (said > 30_000) throw new AiError(429, `Limit erreicht, wieder frei in ca. ${Math.ceil(said / 60_000)} Min.`)
    await sleep(Math.max(said, [3000, 8000, 20000][attempt]))
  }
}

const gemini: Provider = {
  name: 'Gemini',
  available: async () => !!(await kv.get('geminiKey')),
  async complete({ system, prompt, json }) {
    const model = (await kv.get<string>('geminiModel')) || AI_DEFAULTS.geminiModel
    const key = (await kv.get<string>('geminiKey'))!
    const req = (m: string) => post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
      { 'x-goog-api-key': key }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: .4, ...(json ? { responseMimeType: 'application/json' } : {}) },
      })
    let j
    try { j = await req(model) } catch (e) {
      // Modell abgeschaltet: Google nennt den Nachfolger in der Fehlermeldung – übernehmen und merken
      const next = e instanceof AiError && e.status === 404 && e.message.match(/use models\/([\w.-]+)/)?.[1]
      if (!next || next === model) throw e
      j = await req(next)
      await kv.set('geminiModel', next)
    }
    const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('')
    if (!text) throw new Error('leere Antwort')
    return text
  },
}

const groq: Provider = {
  name: 'Groq',
  available: async () => !!(await kv.get('groqKey')),
  async complete({ system, prompt, json }) {
    const model = (await kv.get<string>('groqModel')) || AI_DEFAULTS.groqModel
    const j = await post('https://api.groq.com/openai/v1/chat/completions',
      { Authorization: `Bearer ${await kv.get<string>('groqKey')}` }, {
        model, temperature: .4,
        ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),   // Denk-Tokens zählen ins Minutenlimit
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      })
    const text = j.choices?.[0]?.message?.content
    if (!text) throw new Error('leere Antwort')
    return text
  },
}

const PROVIDERS = [gemini, groq]

export async function hasAi() {
  for (const p of PROVIDERS) if (await p.available()) return true
  return false
}

export async function complete(r: AiRequest) {
  const errors: string[] = []
  for (const p of PROVIDERS) {
    if (!(await p.available())) continue
    try { return { text: await p.complete(r), provider: p.name } }
    catch (e) { errors.push(`${p.name}: ${(e as Error).message}`) }
  }
  throw new Error(errors.length ? 'KI nicht erreichbar – ' + errors.join(' | ') : 'Kein KI-Schlüssel eingetragen')
}

export async function completeJson<T>(r: AiRequest): Promise<{ data: T; provider: string }> {
  const { text, provider } = await complete({ ...r, json: true })
  return { data: JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, '')), provider }
}
