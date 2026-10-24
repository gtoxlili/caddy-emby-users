import { constants as zlib } from 'node:zlib'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { compression, defineAlgorithm } from 'vite-plugin-compression2'

// The web client lives under /web/, the prefix Emby's own web app uses; the handler
// (web.go) serves dist from there and answers every path without a file with index.html.
// API calls go to /emby/..., which the handler routes like any Emby client's. During
// development both are proxied to a running Caddy with the plugin.
const api = process.env.EMBY_USERS_DEV_API ?? 'http://127.0.0.1:42817'

export default defineConfig({
    base: '/web/',
    plugins: [
        // The React Compiler runs through oxc's native transform, not Babel.
        react({ compiler: true }),
        tailwindcss(),
        // Brotli only: the handler serves .br siblings and nothing else. Below 1 KB
        // compression does not save a packet.
        compression({
            include: [/\.(html|css|js|mjs|json|svg|txt|webmanifest)$/i],
            threshold: 1024,
            skipIfLargerOrEqual: true,
            deleteOriginalAssets: false,
            algorithms: [defineAlgorithm('brotliCompress', { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } })],
        }),
    ],
    resolve: {
        tsconfigPaths: true,
    },
    server: {
        proxy: {
            '/emby': { target: api, changeOrigin: true },
            '/web/manifest.json': { target: api, changeOrigin: true },
        },
    },
    build: {
        target: 'baseline-widely-available',
        minify: 'oxc',
        cssMinify: 'lightningcss',
        modulePreload: { polyfill: false },
        // The handler embeds dist as is; a stale file from an earlier build would ship.
        emptyOutDir: true,
    },
})
