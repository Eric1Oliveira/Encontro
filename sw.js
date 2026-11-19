// Service worker: guarda os arquivos do aplicativo para funcionar sem internet.
// Atualização controlada: a nova versão só assume quando o usuário toca em "Atualizar".
// Ao publicar qualquer alteração, troque VERSION (os testes conferem se a lista está completa).

const VERSION = 'encontro-1.1.0';

const ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'css/layout.css',
  'css/components.css',
  'css/responsive.css',
  'js/app.js',
  'js/router.js',
  'js/database.js',
  'js/schema.js',
  'js/validation.js',
  'js/security.js',
  'js/backup.js',
  'js/notifications.js',
  'js/modules/dashboard.js',
  'js/modules/people.js',
  'js/modules/skills.js',
  'js/modules/teams.js',
  'js/modules/events.js',
  'js/modules/allocations.js',
  'js/modules/assistant.js',
  'js/modules/history.js',
  'js/modules/reports.js',
  'js/modules/settings.js',
  'js/components/ui.js',
  'js/components/icons.js',
  'js/components/modal.js',
  'js/components/toast.js',
  'js/components/forms.js',
  'js/components/tables.js',
  'js/components/filters.js',
  'js/components/navigation.js',
  'vendor/jszip.min.js',
  'assets/fonts/alegreya-normal.woff2',
  'assets/fonts/alegreya-italic.woff2',
  'assets/fonts/atkinson-next-normal.woff2',
  'assets/fonts/atkinson-next-italic.woff2',
  'assets/fonts/atkinson-mono-normal.woff2',
  'assets/icons/icon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-192.png',
  'assets/icons/icon-maskable-512.png',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  // Sem skipWaiting aqui: a versão nova espera o usuário confirmar.
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS.map((path) => new Request(path, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('encontro-') && key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Qualquer endereço do app abre o index guardado (as rotas ficam depois do #).
    event.respondWith(caches.match('index.html', { ignoreSearch: true }).then((cached) => cached || fetch(request)));
    return;
  }
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(request).catch(() => new Response('', { status: 504, statusText: 'Sem conexão' })),
    ),
  );
});
