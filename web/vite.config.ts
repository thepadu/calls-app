import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// base: '/app/' because Express serves this build under /app (see app.js) —
// dashboard.js has been retired, so the old HTML dashboard no longer
// competes for a URL, but the SPA stays at /app rather than / since / is a
// plain-text health check DigitalOcean App Platform may depend on.
export default defineConfig({
    plugins: [
        react(),
        VitePWA({
            // 2026-10-13 "keep calls ringing in the background" work (see
            // DECISIONS.md): switched from the default `generateSW` (a fully
            // auto-generated Service Worker with no custom code) to
            // `injectManifest`, which still auto-generates the precache
            // manifest but lets src/sw.ts add a real `push` handler —
            // needed to show a system notification when a call rings while
            // the app is fully closed. Nothing about the existing
            // install/update/caching behavior changes.
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            registerType: 'autoUpdate',
            includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'logo.svg', 'splash-*.png'],
            manifest: {
                name: 'Chumz Call Center',
                short_name: 'Chumz',
                description: 'Chumz customer support call-center dashboard and softphone',
                start_url: '/app/',
                scope: '/app/',
                display: 'standalone',
                theme_color: '#17A697',
                background_color: '#F9F9F9',
                icons: [
                    { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
                    { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
                ]
            }
        })
    ],
    base: '/app/',
    build: {
        outDir: 'dist'
    },
    server: {
        // Lets `npm run dev` (Vite's own dev server) proxy API/auth calls to
        // the real Express server running locally, so you don't need to
        // rebuild the SPA on every change during development.
        proxy: {
            '/api': 'http://localhost:3000',
            '/login': 'http://localhost:3000',
            '/auth': 'http://localhost:3000',
            '/logout': 'http://localhost:3000'
        }
    },
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: './src/test/setup.ts'
    }
});
