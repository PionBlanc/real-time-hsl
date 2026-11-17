import { defineConfig, loadEnv } from 'vite'
import type { Plugin, ViteDevServer } from 'vite'

/**
 * Serves the Vercel edge functions in /api during `vite dev`, so local dev
 * runs exactly the same code as production. Put DIGITRANSIT_API_KEY in .env.
 */
function vercelApiDev(): Plugin {
  return {
    name: 'vercel-api-dev',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const m = req.url?.match(/^\/api\/([a-z]+)(\?.*)?$/)
        if (!m) return next()
        try {
          const mod = await server.ssrLoadModule(`/api/${m[1]}.ts`)
          const resp: Response = await mod.default(
            new Request(`http://localhost${req.url}`),
          )
          res.statusCode = resp.status
          resp.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await resp.arrayBuffer()))
        } catch (e) {
          next(e)
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Make .env values visible to the /api handlers in dev.
  if (env.DIGITRANSIT_API_KEY && !process.env.DIGITRANSIT_API_KEY) {
    process.env.DIGITRANSIT_API_KEY = env.DIGITRANSIT_API_KEY
  }
  const hasKey = Boolean(process.env.DIGITRANSIT_API_KEY)

  return {
    plugins: [vercelApiDev()],
    // Only a boolean is baked into the bundle; the key itself never leaves the server.
    define: { __HAS_KEY__: JSON.stringify(hasKey) },
    build: { target: 'es2020', cssCodeSplit: false },
  }
})
