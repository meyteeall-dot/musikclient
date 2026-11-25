import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { persist } from './data/backup'
import { AI_DEFAULTS, AI_PRESETS, type ExtraAi } from './ai'
import { kv } from './data/db'
import { App } from './ui/App'
import { applyGlass, applyTheme, initGlass, GLASS_DEFAULTS, type GlassValues, type ThemeId } from './ui/glass/engine'
import './ui/theme.css'

registerSW({ immediate: true })
persist()   // Browser bitten, die Daten dauerhaft zu behalten (sonst darf er sie bei Platzmangel oder nach Wochen ohne Nutzung löschen)
// Einmalig: Gemini mit nur einem Modell auf die Modell-Liste heben, Mistral-Feld bereitstellen (nur noch Schlüssel eintragen)
if (!(await kv.get('aiMigr1'))) {
  if ((await kv.get<string>('geminiModel'))?.trim() === 'gemini-3.8-flash') await kv.set('geminiModel', AI_DEFAULTS.geminiModel)
  const extra = (await kv.get<ExtraAi[]>('aiExtra')) ?? []
  const mistral = AI_PRESETS.find(p => p.name === 'Mistral')!
  if (!extra.some(x => x.name === 'Mistral')) await kv.set('aiExtra', [...extra, { ...mistral, id: crypto.randomUUID(), key: '' }])
  await kv.set('aiMigr1', true)
}
applyTheme((await kv.get<ThemeId>('theme')) ?? 'color')
applyGlass({ ...GLASS_DEFAULTS, ...(await kv.get<GlassValues>('glass')) })
initGlass(document.getElementById('gl') as HTMLCanvasElement)
createRoot(document.getElementById('root')!).render(<App />)
