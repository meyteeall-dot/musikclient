import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './ui/App'
import './ui/theme.css'

registerSW({ immediate: true })
createRoot(document.getElementById('root')!).render(<App />)
