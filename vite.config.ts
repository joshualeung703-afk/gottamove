import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const key = env.DIGITRANSIT_KEY ?? ''

  // The Digitransit key is attached here, server-side, so it never ships in the client bundle.
  const proxy: Record<string, ProxyOptions> = {
    '/api/digitransit': {
      target: 'https://api.digitransit.fi',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/digitransit/, ''),
      headers: { 'digitransit-subscription-key': key },
    },
  }

  // `npm run dev:phone` serves over HTTPS on the local network: phones only allow compass and
  // location access on secure pages. The certificate is self-signed, so accept the warning once.
  const phone = mode === 'phone'

  return {
    plugins: phone ? [react(), basicSsl()] : [react()],
    worker: { format: 'es' },
    server: { proxy, host: phone },
    preview: { proxy },
  }
})
