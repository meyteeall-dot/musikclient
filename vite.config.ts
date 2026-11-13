import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serviert unter /musikclient/
export default defineConfig({
  base: '/musikclient/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Musikclient',
        short_name: 'Musik',
        description: 'Persönlicher Musik-Client auf Spotify-Basis',
        theme_color: '#060b1a',
        background_color: '#060b1a',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { navigateFallbackDenylist: [/\?code=/] },
    }),
  ],
})
