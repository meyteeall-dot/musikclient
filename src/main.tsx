import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { kv } from './data/db'
import { App } from './ui/App'
import { applyGlass, applyTheme, initGlass, GLASS_DEFAULTS, type GlassValues, type ThemeId } from './ui/glass/engine'
import './ui/theme.css'

registerSW({ immediate: true })
applyTheme((await kv.get<ThemeId>('theme')) ?? 'color')
applyGlass({ ...GLASS_DEFAULTS, ...(await kv.get<GlassValues>('glass')) })
initGlass(document.getElementById('gl') as HTMLCanvasElement)
createRoot(document.getElementById('root')!).render(<App />)
