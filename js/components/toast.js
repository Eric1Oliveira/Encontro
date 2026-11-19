// Avisos rápidos no canto da tela. Erros ficam mais tempo e podem ser fechados.
import { h } from './ui.js';
import { icon } from './icons.js';

const ICON = { ok: 'check', error: 'alert', info: 'info', warn: 'alert' };

/**
 * @param {string} message
 * @param {{ type?: 'ok'|'error'|'info'|'warn', action?: { label: string, onClick: () => void }, duration?: number }} [options]
 */
export function toast(message, { type = 'ok', action, duration } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const close = () => {
    item.classList.add('toast--out');
    setTimeout(() => item.remove(), 200);
  };
  const item = h(
    'div',
    { class: ['toast', `toast--${type}`], role: type === 'error' ? 'alert' : 'status' },
    icon(ICON[type], { size: 18 }),
    h('p', { class: 'toast__text' }, message),
    action && h('button', { type: 'button', class: 'toast__action', onclick: () => (action.onClick(), close()) }, action.label),
    h('button', { type: 'button', class: 'toast__close', 'aria-label': 'Fechar aviso', onclick: close }, icon('x', { size: 16 })),
  );
  // No máximo 3 avisos na tela: o mais antigo sai.
  while (region.children.length >= 3) region.firstElementChild.remove();
  region.append(item);
  const time = duration ?? (type === 'error' ? 9000 : action ? 7000 : 3800);
  if (time > 0) setTimeout(close, time);
}

export function toastError(error) {
  console.error(error);
  toast(error?.message || 'Algo deu errado. Tente novamente.', { type: 'error' });
}
