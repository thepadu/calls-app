/// <reference lib="webworker" />

// Phase 1 of the 2026-10-13 "keep calls ringing in the background" work (see
// DECISIONS.md). Replaces vite-plugin-pwa's auto-generated Service Worker
// (`generateSW`) — that mode can't run custom code, and showing a push
// notification needs a real `push` handler. Workbox's own precaching is kept
// exactly as before via `precacheAndRoute`; nothing else here intercepts any
// other request, so API calls still always hit the network fresh, same as
// the old config's explicit NetworkOnly rule (the absence of a route for a
// URL is already "don't intercept it" — no need to restate that).
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('push', event => {
    // A malformed or empty payload still deserves *a* notification rather
    // than silently doing nothing — the whole point of this feature is
    // noticing a call arrived, and a generic "Incoming call" is still useful
    // even if the real payload didn't parse.
    let data: { title?: string; body?: string } = {};
    try {
        data = event.data?.json() ?? {};
    } catch {
        // ignore — fall through to the generic text below
    }

    event.waitUntil(
        self.registration.showNotification(data.title || 'Incoming call', {
            body: data.body || 'Open Chumz to answer',
            tag: 'incoming-call',
            // Stays on screen until the agent acts on it, instead of
            // auto-dismissing after a few seconds like a typical notification
            // — this is standing in for a phone ringing, not an FYI.
            requireInteraction: true
        })
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        (async () => {
            const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            const existing = allClients.find(c => c.url.includes('/app/'));
            if (existing) {
                existing.focus();
            } else {
                self.clients.openWindow('/app/');
            }
        })()
    );
});
