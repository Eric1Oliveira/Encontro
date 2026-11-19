// Avisos do sistema: atualização do app, instalação, espaço livre, lembrete de backup e banco bloqueado.
import { h, button, daysSince, relativeDays, fmtBytes } from './components/ui.js';
import { icon } from './components/icons.js';
import { confirmDialog } from './components/modal.js';
import { toast } from './components/toast.js';
import { pendingWork, navigate } from './router.js';
import { setting, getOne, countAll, subscribe } from './database.js';

const changed = () => document.dispatchEvent(new Event('notices:changed'));

// ---------- Instalação ----------

let deferredPrompt = null;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const installAvailable = () => !isStandalone();
export const canPromptInstall = () => Boolean(deferredPrompt);

export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
  deferredPrompt = null;
  changed();
  return choice.outcome === 'accepted';
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  changed();
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  toast('Aplicativo instalado. Ele já abre sem internet.');
  changed();
});

// ---------- Atualização controlada ----------

let waitingWorker = null;
let updateRequested = false;
export const updateReady = () => Boolean(waitingWorker);

function setWaiting(worker) {
  waitingWorker = worker;
  changed();
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker);
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested) location.reload();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  } catch (error) {
    console.warn('Funcionamento offline indisponível:', error);
  }
}

/** Só atualiza quando o usuário pede — e avisa se algo está em andamento. */
export async function applyUpdate() {
  if (!waitingWorker) return;
  const pending = pendingWork();
  if (pending.length) {
    const ok = await confirmDialog({
      title: 'Atualizar agora?',
      message: `Há ${pending.join(' e ')} em andamento. Atualizar recarrega o aplicativo e interrompe isso. Conclua primeiro, se puder.`,
      confirmLabel: 'Atualizar mesmo assim',
      cancelLabel: 'Depois',
      danger: true,
    });
    if (!ok) return;
  }
  updateRequested = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

// ---------- Armazenamento ----------

export async function storageInfo() {
  const info = { usage: null, quota: null, persisted: null };
  try {
    if (navigator.storage?.estimate) Object.assign(info, await navigator.storage.estimate());
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
  } catch {
    /* sem informação disponível */
  }
  return info;
}

/** Pede ao navegador para não apagar os dados quando faltar espaço. */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

// ---------- Avisos ----------

let dbState = '';
subscribe((event) => {
  if (event.type === 'versionchange' || event.type === 'blocked' || event.type === 'closed') {
    dbState = event.type;
    changed();
  }
});

const dismissed = new Set();

/** @returns {Promise<{ id: string, tone: 'warn'|'info'|'danger', text: string, action?: { label: string, run: () => any }, dismissible?: boolean }[]>} */
export async function collectNotices() {
  const list = [];
  if (dbState) {
    list.push({ id: 'db', tone: 'danger', text: dbState === 'blocked' ? 'Feche as outras abas deste aplicativo para terminar a atualização do banco.' : 'O aplicativo foi atualizado em outra aba. Recarregue para continuar com segurança.', action: { label: 'Recarregar', run: () => location.reload() } });
  }
  if (waitingWorker) list.push({ id: 'update', tone: 'info', text: 'Há uma nova versão do aplicativo pronta.', action: { label: 'Atualizar', run: applyUpdate }, dismissible: true });
  if (!window.isSecureContext) list.push({ id: 'insecure', tone: 'warn', text: 'Endereço sem https: o PIN, o backup protegido por senha e o uso sem internet ficam indisponíveis. Abra pelo endereço publicado.' });

  const [people, lastChange, storage] = await Promise.all([countAll('people').catch(() => 0), getOne('metadata', 'lastChangeAt').catch(() => null), storageInfo()]);
  const lastBackup = setting('lastBackupAt');
  const reminder = Number(setting('backupReminderDays')) || 0;
  const changedSinceBackup = !lastBackup || (lastChange?.value && lastChange.value > lastBackup);
  if (people > 0 && reminder > 0 && changedSinceBackup && (!lastBackup || daysSince(lastBackup) >= reminder)) {
    list.push({ id: 'backup', tone: 'warn', text: lastBackup ? `Último backup ${relativeDays(lastBackup)}. Há alterações que ainda não estão em nenhuma cópia.` : 'Você ainda não fez nenhum backup. Se o aparelho for perdido ou limpo, os dados vão junto.', action: { label: 'Fazer backup', run: () => navigate('/backup') }, dismissible: true });
  }
  if (storage.quota && storage.usage != null) {
    const free = storage.quota - storage.usage;
    if (free < 50 * 1024 ** 2 || storage.usage / storage.quota > 0.85) {
      list.push({ id: 'storage', tone: 'danger', text: `Pouco espaço livre para o aplicativo (${fmtBytes(free)} restantes). Exporte um backup e libere espaço no aparelho.`, action: { label: 'Ver armazenamento', run: () => navigate('/ajustes') } });
    }
  }
  return list.filter((notice) => !dismissed.has(notice.id));
}

export function noticeItem(notice) {
  const tone = notice.tone === 'info' ? 'info' : 'alert';
  return h(
    'div',
    { class: ['notice', `notice--${notice.tone}`], role: notice.tone === 'danger' ? 'alert' : 'status' },
    icon(tone, { size: 18 }),
    h('p', { class: 'notice__text' }, notice.text),
    notice.action && button(notice.action.label, { variant: 'quiet', small: true, onClick: notice.action.run }),
    notice.dismissible && h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Dispensar aviso', onclick: () => (dismissed.add(notice.id), changed()) }, icon('x', { size: 16 })),
  );
}

/** Barra de avisos no topo da área principal. */
export function mountNoticeBar(container) {
  let busy = false;
  const paint = async () => {
    if (busy) return;
    busy = true;
    try {
      const notices = await collectNotices();
      container.replaceChildren(...notices.filter((n) => n.id !== 'backup' || location.hash !== '#/backup').slice(0, 2).map(noticeItem));
    } finally {
      busy = false;
    }
  };
  document.addEventListener('notices:changed', paint);
  document.addEventListener('route', paint);
  subscribe((event) => event.type === 'change' && event.stores.includes('settings') && paint());
  paint();
}

export const refreshNotices = changed;
