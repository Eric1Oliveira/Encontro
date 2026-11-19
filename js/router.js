// Navegação por endereço (#/pessoas/123), proteção de formulários não salvos e operações em andamento.
import { h, loading } from './components/ui.js';
import { icon } from './components/icons.js';
import { confirmDialog } from './components/modal.js';

/** @type {{ pattern: RegExp, keys: string[], handler: (view: HTMLElement, params: Record<string,string>, query: URLSearchParams) => any }[]} */
const routes = [];
let view = null;
let cleanup = null;
let currentHash = '';
let renderToken = 0;

export function route(path, handler) {
  const keys = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)'))}$`);
  routes.push({ pattern, keys, handler });
}

export function currentPath() {
  return (location.hash.slice(1) || '/').split('?')[0];
}

export function navigate(path, { replace = false } = {}) {
  const hash = `#${path}`;
  if (replace) {
    history.replaceState(null, '', hash);
    render();
  } else if (location.hash === hash) render();
  else location.hash = hash;
}

/** Recarrega a tela atual (depois de salvar algo, por exemplo). */
export const refresh = () => render({ keepScroll: true });

// ---------- Alterações não salvas e operações em andamento ----------

let dirty = false;
const operations = new Map();

export function setDirty(value) {
  dirty = Boolean(value);
}
export const isDirty = () => dirty;

/**
 * Marca uma operação longa (backup, restauração). Enquanto existir, o app avisa antes de sair ou atualizar.
 * @template T @param {string} label @param {Promise<T>} promise @returns {Promise<T>}
 */
export async function trackOperation(label, promise) {
  const key = Symbol(label);
  operations.set(key, label);
  try {
    return await promise;
  } finally {
    operations.delete(key);
  }
}
export const runningOperations = () => [...operations.values()];

/** O que impediria uma atualização ou saída agora. */
export function pendingWork() {
  const items = runningOperations();
  if (dirty) items.push('um formulário com alterações não salvas');
  return items;
}

async function confirmLeave() {
  if (!dirty) return true;
  const ok = await confirmDialog({ title: 'Sair sem salvar?', message: 'As alterações deste formulário ainda não foram salvas e serão perdidas.', confirmLabel: 'Sair sem salvar', cancelLabel: 'Continuar editando', danger: true });
  if (ok) dirty = false;
  return ok;
}

async function onHashChange() {
  if (dirty && location.hash !== currentHash) {
    const target = location.hash;
    // Volta o endereço sem redesenhar a tela (replaceState não dispara hashchange).
    history.replaceState(null, '', currentHash || '#/');
    if (await confirmLeave()) location.hash = target;
    return;
  }
  render();
}

async function render({ keepScroll = false } = {}) {
  if (!view) return;
  const token = ++renderToken;
  currentHash = location.hash || '#/';
  const [path, queryString = ''] = (location.hash.slice(1) || '/').split('?');
  const query = new URLSearchParams(queryString);
  const scroll = window.scrollY;
  if (cleanup) {
    try {
      cleanup();
    } catch (error) {
      console.error(error);
    }
    cleanup = null;
  }
  const match = routes.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
  document.dispatchEvent(new CustomEvent('route', { detail: { path } }));
  if (!match) {
    view.replaceChildren(notFound());
    dirty = false;
    return;
  }
  const params = Object.fromEntries(match.r.keys.map((key, i) => [key, decodeURIComponent(match.m[i + 1])]));
  const holder = h('div', { class: 'view__inner' }, loading());
  view.replaceChildren(holder);
  // Só depois de tirar a tela antiga: remover um campo com foco pode disparar "change" nele.
  dirty = false;
  try {
    const result = await match.r.handler(holder, params, query);
    if (token !== renderToken) return;
    if (typeof result === 'function') cleanup = result;
    window.scrollTo(0, keepScroll ? scroll : 0);
    if (!keepScroll) view.focus({ preventScroll: true });
  } catch (error) {
    if (token !== renderToken) return;
    console.error(error);
    holder.replaceChildren(
      h('div', { class: 'empty empty--error' }, h('span', { class: 'empty__icon' }, icon('alert', { size: 26 })), h('h3', { class: 'empty__title' }, 'Esta tela não pôde ser aberta'), h('p', { class: 'empty__text' }, error?.message || 'Erro inesperado.'), h('button', { type: 'button', class: 'btn btn--primary', onclick: () => render() }, 'Tentar de novo')),
    );
  }
}

function notFound() {
  return h('div', { class: 'view__inner' }, h('div', { class: 'empty' }, h('h3', { class: 'empty__title' }, 'Página não encontrada'), h('p', { class: 'empty__text' }, 'O endereço pode ter mudado ou o registro foi removido.'), h('a', { class: 'btn btn--primary', href: '#/' }, 'Ir para o início')));
}

export function startRouter(container) {
  view = container;
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (event) => {
    if (pendingWork().length) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  render();
}
