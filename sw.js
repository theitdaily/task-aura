const SW_VERSION = 'v1.0.18.4';
const CACHE = 'task-aura-cache-' + SW_VERSION;

console.log('Service Worker: ' + SW_VERSION);

const RESOURCES_TO_CACHE = [
    'resources/bootstrap.bundle.min.js',
    'resources/bootstrap.min.css',
    'resources/bootstrap-icons.css',
    'resources/fonts/bootstrap-icons.woff2',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(RESOURCES_TO_CACHE))
    );

    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) =>
                Promise.all(
                    cacheNames
                        .filter((cacheName) =>
                            cacheName.startsWith('task-aura-cache-') && cacheName !== CACHE
                        )
                        .map((cacheName) => caches.delete(cacheName))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const requestUrl = new URL(request.url);

    // Не трогаем не-GET запросы.
    if (request.method !== 'GET') {
        return;
    }

    // Не трогаем внешние API, Google OAuth, Google Tasks и любые cross-origin запросы.
    if (requestUrl.origin !== self.location.origin) {
        return;
    }

    // Не трогаем запросы к Google API на всякий случай, если URL когда-то будет проксироваться.
    if (
        requestUrl.hostname.includes('googleapis.com') ||
        requestUrl.hostname.includes('accounts.google.com') ||
        requestUrl.hostname.includes('gstatic.com')
    ) {
        return;
    }

    event.respondWith(cacheFirstWithNetworkFallback(request));
});

async function cacheFirstWithNetworkFallback(request) {
    const cache = await caches.open(CACHE);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
        updateCacheInBackground(request);
        return cachedResponse;
    }

    const networkResponse = await fetch(request);

    if (networkResponse && networkResponse.ok) {
        await cache.put(request, networkResponse.clone());
    }

    return networkResponse;
}

async function updateCacheInBackground(request) {
    try {
        const cache = await caches.open(CACHE);
        const response = await fetch(request);

        if (!response || !response.ok) {
            return;
        }

        await cache.put(request, response.clone());
        await refresh(response);
    } catch (error) {
        console.warn('Service Worker background update failed:', {
            url: request.url,
            message: error?.message ?? String(error),
        });
    }
}

function refresh(response) {
    return self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
            const message = {
                type: 'refresh',
                url: response.url,
                eTag: response.headers.get('ETag')
            };

            client.postMessage(JSON.stringify(message));
        });
    });
}