import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { constants as zlib } from 'node:zlib'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { compression, defineAlgorithm } from 'vite-plugin-compression2'

// The web client lives under /web/, the prefix Emby's own web app uses; the handler
// (web.go) serves dist from there and answers page loads of other paths with index.html.
// CI builds dist into release tags; a local build is only for running from source.
// API calls go to /emby/..., which the handler routes like any Emby client's. During
// development both are proxied to a running Caddy with the plugin.
const api = process.env.EMBY_USERS_DEV_API ?? 'http://127.0.0.1:8080'

/**
 * dist is emptied before every build, but Go's embed refuses an empty directory, so a
 * source checkout keeps one tracked placeholder there. Put it back after the build.
 */
function keepPlaceholder(): Plugin {
    return {
        name: 'emby-users:keep-placeholder',
        apply: 'build',
        closeBundle() {
            writeFileSync(resolve(import.meta.dirname, 'dist/.gitkeep'), '')
        },
    }
}

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
        keepPlaceholder(),
    ],
    resolve: {
        tsconfigPaths: true,
    },
    server: {
        proxy: {
            // Some upstreams redirect streams and images to other paths of their own host
            // (/play/..., /img/...); rewritten to the dev server, they stay same-origin as in production.
            '/emby': { target: api, changeOrigin: true, autoRewrite: true, protocolRewrite: 'http' },
            '/play': { target: api, changeOrigin: true },
            '/img': { target: api, changeOrigin: true },
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
        // The WebAssembly decoders are single chunks, each fetched only for files that need it.
        chunkSizeWarningLimit: 2000,
    },
})
