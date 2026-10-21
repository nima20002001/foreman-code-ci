import { fileURLToPath } from 'node:url'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { resolveLocalBrowserOrigin } from '@foreman-code/contracts/browser-origin'
import { devIdentity } from './dev-identity'
import { localHumanProxy } from './local-human-client'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const browser = resolveLocalBrowserOrigin(process.env)

export default defineConfig(({ command }) => ({
  define: { __RUNTIME_BUILD_IDENTITY__: command === 'build'
    ? JSON.stringify(createRuntimeBuildIdentity(fileURLToPath(new URL('../../', import.meta.url)))) : 'null' },
  plugins: [react(), tailwindcss(), localHumanProxy(),
    devIdentity(process.env.VITE_API_URL ?? 'http://127.0.0.1:3000')],
  server: {
    host: browser.host,
    port: browser.port,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
}))
