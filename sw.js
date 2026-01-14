const CACHE_NAME = 'task-aura-cache-v1';

// Названия ресурсов для кэширования. Убедитесь, что пути соответствуют структуре сайта.
const RESOURCES_TO_CACHE = [
    'index.html',
    'ru.html',
    'resources/bootstrap.bundle.min.js',
    'resources/bootstrap.min.css',
    'resources/bootstrap-icons.css',
    'resources/fonts/bootstrap-icons.woff2',
];

// Установка и предзагрузка кеша
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // Добавляем указанные ресурсы в кеш
            return cache.addAll(RESOURCES_TO_CACHE);
        })
    );
});

// Активация и очистка старых кешей
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            // Удаляем все кеши, не являющиеся текущим
            keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
        ))
    );
});

// Обработка fetch-запросов
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                return cachedResponse;
            }
            // Не нашли в кеше - делаем запрос в сеть
            return fetch(event.request).then(networkResponse => {
                // Проверяем ответ
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }
                // Кешируем ответ для будущих запросов
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseClone);
                });
                return networkResponse;
            });
        })
    );
});