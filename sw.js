const CACHE = 'planner-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

// ---- Best-effort background check (only fires if the OS/browser
// grants a periodic sync window — not guaranteed on all devices) ----
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('planner-db', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function minutesLabel(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function dateAtMinutes(key, minutes) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setMinutes(minutes);
  return dt.getTime();
}

async function checkDueBlocks() {
  const db = await openDB();
  const blocks = await new Promise((resolve, reject) => {
    const tx = db.transaction('blocks', 'readonly');
    const req = tx.objectStore('blocks').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const now = Date.now();
  for (const b of blocks) {
    if (b.notify === false || b.notified) continue;
    const due = dateAtMinutes(b.date, b.start);
    if (due > now) continue;
    await self.registration.showNotification(b.title, {
      body: 'Запланировано на ' + minutesLabel(b.start),
      icon: 'icons/icon-192.png',
      tag: 'block-' + b.id,
      renotify: true
    });
    const tx = db.transaction('blocks', 'readwrite');
    b.notified = true;
    tx.objectStore('blocks').put(b);
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-blocks') {
    event.waitUntil(checkDueBlocks());
  }
});
