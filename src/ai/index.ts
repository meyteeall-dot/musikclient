/* Gemeinsame KI-Schicht: Anbieter der Reihe nach; meldet einer einen Fehler oder ein Limit, übernimmt der nächste.
   Neuer Anbieter = weiteres Objekt mit available()/complete() in PROVIDERS. */
import { kv } from '../data/db'

export interface AiRequest { system: string; prompt: string; json?: boolean }
interface Provider { name: string; available(): Promise<boolean>; complete(r: AiRequest): Promise<string> }

export const AI_DEFAULTS = { geminiModel: 'gemini-2.5-flash', groqModel: 'openai/gpt-oss-120b' }

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${r.status} ${j.error?.message ?? ''}`.trim())
  return j
}

const gemini: Provider = {
  name: 'Gemini',
  available: async () => !!(await kv.get('geminiKey')),
  async complete({ system, prompt, json }) {
    const model = (await kv.get<string>('geminiModel')) || AI_DEFAULTS.geminiModel
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': (await kv.get<string>('geminiKey'))! }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: .4, ...(json ? { responseMimeType: 'application/json' } : {}) },
      })
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
