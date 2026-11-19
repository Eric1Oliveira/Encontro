// Busca e filtros combináveis.
import { h } from './ui.js';
import { icon } from './icons.js';
import { normalize } from '../validation.js';

/** Todas as palavras da busca precisam aparecer no texto (sem diferenciar acentos). */
export function matchesQuery(text, query) {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const haystack = normalize(text);
  return tokens.every((token) => haystack.includes(token));
}

export function searchBox({ value = '', placeholder = 'Buscar', label = 'Buscar', onInput }) {
  let timer = 0;
  const input = h('input', { type: 'search', class: 'search__input', value, placeholder, 'aria-label': label, autocomplete: 'off' });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => onInput(input.value), 120);
  });
  return h('label', { class: 'search' }, icon('search', { size: 18 }), input);
}

/**
 * Seletor compacto para barras de filtro. `options`: { value, label, group? } — `group` vira <optgroup>.
 * Fica destacado só quando o valor é diferente do padrão.
 */
export function selectBox({ label, value = '', options, onChange, defaultValue = '' }) {
  const option = (o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label);
  const children = [];
  const groups = new Map();
  for (const o of options) {
    if (!o.group) children.push(option(o));
    else {
      if (!groups.has(o.group)) children.push(groups.set(o.group, h('optgroup', { label: o.group })).get(o.group));
      groups.get(o.group).append(option(o));
    }
  }
  const select = h('select', { class: 'select-box__control', 'aria-label': label }, children);
  const wrap = h('label', { class: ['select-box', String(value) !== String(defaultValue) && 'is-active'] }, h('span', { class: 'select-box__label' }, label), select);
  select.addEventListener('change', () => {
    wrap.classList.toggle('is-active', select.value !== String(defaultValue));
    onChange(select.value);
  });
  return wrap;
}

/** Busca sempre visível; os demais filtros ficam atrás do botão "Filtros" no celular. */
export function collapsibleFilters(search, ...filters) {
  const more = h('div', { class: 'filter-bar__more' }, filters);
  const label = h('span');
  const toggleButton = h('button', { type: 'button', class: 'btn btn--secondary filter-bar__toggle', 'aria-expanded': 'false' }, icon('sliders', { size: 18 }), label);
  const bar = h('div', { class: 'filter-bar' }, search, toggleButton, more);
  toggleButton.addEventListener('click', () => {
    const open = !bar.classList.contains('is-open');
    bar.classList.toggle('is-open', open);
    toggleButton.setAttribute('aria-expanded', String(open));
  });
  const update = () => {
    const active = more.querySelectorAll('.select-box.is-active').length;
    label.textContent = active ? `Filtros (${active})` : 'Filtros';
  };
  more.addEventListener('change', update);
  update();
  return bar;
}

export function toggle({ label, checked = false, onChange }) {
  const input = h('input', { type: 'checkbox', class: 'toggle__input', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, input, h('span', { class: 'toggle__track', 'aria-hidden': 'true' }), h('span', { class: 'toggle__label' }, label));
}

export function filterBar(...children) {
  return h('div', { class: 'filter-bar' }, children);
}

/** Lista de opções agrupadas para <select>, com "Todos" no topo. */
export function withAll(allLabel, options) {
  return [{ value: '', label: allLabel }, ...options];
}
