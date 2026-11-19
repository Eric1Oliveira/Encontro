// Menu lateral (computador) e barra inferior (celular).
import { h } from './ui.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { hasPin, lockNow } from '../security.js';
import { installAvailable } from '../notifications.js';

const MAIN = [
  { path: '/', label: 'Início', icon: 'home' },
  { path: '/pessoas', label: 'Pessoas', icon: 'people' },
  { path: '/equipes', label: 'Equipes', icon: 'teams' },
  { path: '/encontros', label: 'Encontros', icon: 'calendar' },
  { path: '/historico', label: 'Histórico', icon: 'history' },
  { path: '/relatorios', label: 'Relatórios', icon: 'chart' },
];
const SETUP = [
  { path: '/cadastros', label: 'Habilidades e perfis', icon: 'tag' },
  { path: '/backup', label: 'Backup', icon: 'archive' },
  { path: '/ajustes', label: 'Ajustes e segurança', icon: 'sliders' },
];
const TABBAR = ['/', '/pessoas', '/encontros', '/equipes'];

const isActive = (itemPath, path) => (itemPath === '/' ? path === '/' : path === itemPath || path.startsWith(`${itemPath}/`));

function link(item, className) {
  return h('a', { class: className, href: `#${item.path}`, dataset: { path: item.path } }, icon(item.icon, { size: 20 }), h('span', null, item.label));
}

function extras(className) {
  return [
    installAvailable() && h('a', { class: className, href: '#/instalar' }, icon('install', { size: 20 }), h('span', null, 'Instalar aplicativo')),
    hasPin() && h('button', { type: 'button', class: className, onclick: lockNow }, icon('lock', { size: 20 }), h('span', null, 'Travar agora')),
  ];
}

export function renderNavigation() {
  const sidebar = document.getElementById('sidebar');
  const tabbar = document.getElementById('tabbar');

  const paintSidebar = () =>
    sidebar.replaceChildren(
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand__mark', 'aria-hidden': 'true' }), h('span', { class: 'brand__text' }, h('span', { class: 'brand__name' }, 'Encontro'), h('span', { class: 'brand__tag' }, 'Voluntários e equipes'))),
      h('div', { class: 'nav-group' }, MAIN.map((item) => link(item, 'nav-link'))),
      h('p', { class: 'nav-label' }, 'Configuração'),
      h('div', { class: 'nav-group' }, SETUP.map((item) => link(item, 'nav-link'))),
      h('div', { class: 'nav-group nav-group--end' }, extras('nav-link')),
    );

  const paintTabbar = () =>
    tabbar.replaceChildren(
      ...MAIN.filter((item) => TABBAR.includes(item.path)).map((item) => link(item, 'tab')),
      h('button', { type: 'button', class: 'tab', dataset: { path: 'more' }, onclick: openMore }, icon('more', { size: 20 }), h('span', null, 'Mais')),
    );

  function openMore() {
    const items = [...MAIN.filter((item) => !TABBAR.includes(item.path)), ...SETUP];
    const sheet = openModal({
      title: 'Mais opções',
      size: 'sm',
      className: 'sheet',
      body: h('nav', { class: 'sheet-nav' }, items.map((item) => link(item, 'sheet-link')), extras('sheet-link')),
    });
    sheet.body.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a, button')) sheet.close();
    });
  }

  const markActive = () => {
    const path = (location.hash.slice(1) || '/').split('?')[0];
    for (const a of document.querySelectorAll('.nav-link[data-path], .tab[data-path]')) {
      const itemPath = a.getAttribute('data-path');
      const active = itemPath === 'more' ? ![...TABBAR].some((p) => isActive(p, path)) : isActive(itemPath, path);
      a.classList.toggle('is-active', active);
      if (a.tagName === 'A') active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    }
  };

  const paint = () => {
    paintSidebar();
    paintTabbar();
    markActive();
  };
  paint();
  document.addEventListener('route', markActive);
  document.addEventListener('navigation:refresh', paint);
  document.addEventListener('notices:changed', paint);
}

/** Pede para o menu se redesenhar (ex.: PIN criado, instalação disponível). */
export const refreshNavigation = () => document.dispatchEvent(new Event('navigation:refresh'));
