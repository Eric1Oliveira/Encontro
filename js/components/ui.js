// Peças básicas de interface: criação de elementos, formatação e blocos reutilizados pelas telas.
import { icon } from './icons.js';
import { getOne } from '../database.js';

const PROPERTIES = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'multiple', 'required', 'readOnly', 'indeterminate', 'open']);

/**
 * Cria um elemento. Texto do usuário entra sempre como texto, nunca como HTML.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'style') for (const [prop, v] of Object.entries(value)) prop.startsWith('--') ? node.style.setProperty(prop, v) : (node.style[prop] = v);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (PROPERTIES.has(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return append(node, children);
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** Botão padrão. variant: primary | secondary | ghost | danger | quiet */
export function button(label, { variant = 'secondary', icon: iconName, onClick, type = 'button', small = false, title, disabled, className, attrs } = {}) {
  return h(
    'button',
    { type, class: ['btn', `btn--${variant}`, small && 'btn--sm', !label && 'btn--icon', className], onclick: onClick, title: title ?? (label ? undefined : ''), 'aria-label': label ? undefined : title, disabled, ...attrs },
    iconName && icon(iconName, { size: small ? 16 : 18 }),
    label && h('span', null, label),
  );
}

// ---------- Datas e números ----------

const MONTHS = ['jan.', 'fev.', 'mar.', 'abr.', 'maio', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function fmtDateTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** 14–16 nov. 2026 · 28 nov. – 2 dez. 2026 */
export function fmtRange(start, end) {
  if (!start) return '—';
  const [y1, m1, d1] = start.split('-').map(Number);
  const [y2, m2, d2] = (end || start).split('-').map(Number);
  if (y1 === y2 && m1 === m2 && d1 === d2) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y1}`;
  return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

export const monthName = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} de ${y}`;
};

export function daysSince(timestamp) {
  if (!timestamp) return null;
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / 86400000);
}

export function relativeDays(timestamp) {
  const days = daysSince(timestamp);
  if (days == null) return 'nunca';
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  return `há ${days} dias`;
}

export const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
}

// ---------- Pessoas ----------

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter((p) => p.length > 2 || /^[A-ZÀ-Ý]/.test(p));
  if (!parts.length) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function hue(text) {
  let n = 0;
  for (const ch of String(text)) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

const photoUrls = new Map();

export async function photoUrl(photoId) {
  if (!photoId) return null;
  if (photoUrls.has(photoId)) return photoUrls.get(photoId);
  const record = await getOne('photos', photoId).catch(() => null);
  if (!record?.blob) return null;
  const url = URL.createObjectURL(record.blob);
  photoUrls.set(photoId, url);
  return url;
}

export function forgetPhoto(photoId) {
  const url = photoUrls.get(photoId);
  if (url) URL.revokeObjectURL(url);
  photoUrls.delete(photoId);
}

export function forgetAllPhotos() {
  for (const id of [...photoUrls.keys()]) forgetPhoto(id);
}

/** Foto ou iniciais. A foto carrega em segundo plano para não travar listas. */
export function avatar(person, size = 'md') {
  const node = h('span', { class: ['avatar', `avatar--${size}`], style: { '--avatar-hue': String(hue(person?.name ?? '')) }, 'aria-hidden': 'true' }, initials(person?.name));
  if (person?.photoId) {
    photoUrl(person.photoId).then((url) => {
      if (!url) return;
      node.replaceChildren(h('img', { src: url, alt: '' }));
      node.classList.add('avatar--photo');
    });
  }
  return node;
}

// ---------- Blocos ----------

export function badge(text, tone = 'neutral', iconName) {
  return h('span', { class: ['badge', `badge--${tone}`] }, iconName && icon(iconName, { size: 14 }), text);
}

/** Selo de equipe: cor + ícone + nome. */
export function teamChip(team, { small = false } = {}) {
  return h('span', { class: ['team-chip', small && 'team-chip--sm'], style: { '--team': team?.color ?? '#5B6770' } }, h('span', { class: 'team-chip__icon' }, icon(team?.icon ?? 'teams', { size: small ? 13 : 15 })), h('span', { class: 'team-chip__name' }, team?.name ?? 'Equipe removida'));
}

export function pageHeader({ eyebrow, title, lead, actions, back }) {
  return h(
    'header',
    { class: 'page-head' },
    back && h('a', { class: 'page-head__back', href: `#${back.href}` }, icon('chevron-left', { size: 16 }), back.label),
    h('div', { class: 'page-head__row' }, h('div', { class: 'page-head__text' }, eyebrow && h('p', { class: 'eyebrow' }, eyebrow), h('h1', { class: 'page-title' }, title), lead && h('p', { class: 'page-lead' }, lead)), actions && h('div', { class: 'page-head__actions' }, actions)),
  );
}

export function emptyState({ icon: iconName = 'info', title, text, action }) {
  return h('div', { class: 'empty' }, h('span', { class: 'empty__icon' }, icon(iconName, { size: 26 })), h('h3', { class: 'empty__title' }, title), text && h('p', { class: 'empty__text' }, text), action);
}

export function section(title, options, ...children) {
  const { lead, actions, className } = options ?? {};
  return h('section', { class: ['panel', className] }, (title || actions) && h('div', { class: 'panel__head' }, h('div', null, title && h('h2', { class: 'panel__title' }, title), lead && h('p', { class: 'panel__lead' }, lead)), actions && h('div', { class: 'panel__actions' }, actions)), children);
}

export function loading(text = 'Carregando…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'loading__dot' }), text);
}

/** Baixa um arquivo gerado no aparelho. */
export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
