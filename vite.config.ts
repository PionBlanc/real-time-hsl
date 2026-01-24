import { defineConfig, loadEnv } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      devtools(),
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
      }),
      viteReact(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: {
        '/api/digitransit': {
          target: 'https://api.digitransit.fi',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/digitransit/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              // Add API key header on the server side - never exposed to client
              const apiKey = env.DIGITRANSIT_API_KEY
              if (apiKey) {
                proxyReq.setHeader('digitransit-subscription-key', apiKey)
              }
            })
          },
        },
      },
    },
  }
})
