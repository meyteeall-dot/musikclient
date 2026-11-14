import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { persist } from './data/backup'
import { kv } from './data/db'
import { App } from './ui/App'
import { applyGlass, applyTheme, initGlass, GLASS_DEFAULTS, type GlassValues, type ThemeId } from './ui/glass/engine'
import './ui/theme.css'

registerSW({ immediate: true })
persist()   // Browser bitten, die Daten dauerhaft zu behalten (sonst darf er sie bei Platzmangel oder nach Wochen ohne Nutzung löschen)
applyTheme((await kv.get<ThemeId>('theme')) ?? 'color')
applyGlass({ ...GLASS_DEFAULTS, ...(await kv.get<GlassValues>('glass')) })
initGlass(document.getElementById('gl') as HTMLCanvasElement)
createRoot(document.getElementById('root')!).render(<App />)
