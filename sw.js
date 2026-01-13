const CACHE_NAME = 'task-aura-cache-v1';

// Пара ресурсов для кэширования
const RESOURCES_TO_CACHE = [
    'index.html',  // или index_ru.html, в зависимости от языка
    'ru.html',  // или index_ru.html, в зависимости от языка
    'sources/',       // папка с библиотеками
    'styles.css',     // если есть
    'main.js',        // ваш основной JS файл
    // добавьте иконки, шрифты и другие ресурсы
    // 'icons/icon-192.png',
    // 'icons/icon-512.png'
];

// Установка Service Worker и предзагрузка кеша
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(RESOURCES_TO_CACHE))
    );
});

// Активация и очистка старых кешей
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
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
            // Если ресурс не в кеше, загрузить из сети
            return fetch(event.request).then(networkResponse => {
                // Можно кешировать новые ресурсы динамически (опционально)
                return networkResponse;
            });
        })
    );
});