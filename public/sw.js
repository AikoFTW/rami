// Background worker: shows Rami's notifications and opens the game when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Rami', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Rami', {
    body: data.body || '',
    tag: data.tag || 'rami',          // a newer "your turn" replaces the older one
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/#play' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#play', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate ? w.navigate(url).catch(() => {}) : null; }
    return self.clients.openWindow(url);
  })());
});
