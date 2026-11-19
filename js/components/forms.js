// Campos de formulário, grupos de opções, leitura de valores e exibição de erros.
import { h } from './ui.js';
import { icon } from './icons.js';
import { setDirty } from '../router.js';

let counter = 0;

/**
 * @param {{ label: string, name: string, type?: string, value?: any, required?: boolean, hint?: string, placeholder?: string,
 *   options?: { value: string, label: string }[], rows?: number, attrs?: Record<string, any>, wide?: boolean }} spec
 */
export function field({ label, name, type = 'text', value = '', required = false, hint, placeholder, options = [], rows = 3, attrs = {}, wide = false }) {
  const id = `f-${name}-${++counter}`;
  let control;
  if (type === 'textarea') {
    control = h('textarea', { id, name, rows, placeholder, ...attrs });
    control.value = value ?? '';
  } else if (type === 'select') {
    control = h('select', { id, name, ...attrs }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
  } else {
    control = h('input', { id, name, type, value: value ?? '', placeholder, ...attrs });
  }
  if (required) control.setAttribute('aria-required', 'true');
  const hintNode = hint ? h('p', { class: 'field__hint', id: `${id}-hint` }, hint) : null;
  const errorNode = h('p', { class: 'field__error', id: `${id}-error`, hidden: true });
  control.setAttribute('aria-describedby', [hintNode && `${id}-hint`, `${id}-error`].filter(Boolean).join(' '));
  return h('div', { class: ['field', wide && 'field--wide'], dataset: { field: name } }, h('label', { class: 'field__label', for: id }, label, required && h('span', { class: 'field__req', 'aria-hidden': 'true' }, ' *')), control, hintNode, errorNode);
}

/**
 * Seleção múltipla em fichas. `options`: { id, label, muted?, title? }.
 * @returns {HTMLElement}
 */
export function chipGroup({ name, options, selected = [], onChange, label }) {
  const chosen = new Set(selected);
  const group = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  for (const option of options) {
    group.append(
      h(
        'label',
        { class: ['chip', option.muted && 'chip--muted'], title: option.title },
        h('input', { type: 'checkbox', class: 'chip__input', name, value: option.id, checked: chosen.has(option.id) }),
        h('span', { class: 'chip__box' }, icon('check', { size: 13 })),
        h('span', { class: 'chip__label' }, option.label),
      ),
    );
  }
  if (onChange) group.addEventListener('change', () => onChange(checkedValues(group, name)));
  return group;
}

export const checkedValues = (root, name) => [...root.querySelectorAll(`input[name="${CSS.escape(name)}"]:checked`)].map((input) => input.value);

/** Botões de escolha única (rádio com cara de segmento). */
export function segmented({ name, options, value, onChange, label }) {
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const option of options) {
    group.append(h('label', { class: 'segmented__item' }, h('input', { type: 'radio', name, value: option.value, checked: String(option.value) === String(value) }), h('span', null, option.label)));
  }
  if (onChange) group.addEventListener('change', (event) => onChange(event.target.value));
  return group;
}

/** Valores simples de um formulário (um valor por nome). */
export function readForm(form) {
  const data = {};
  for (const [key, value] of new FormData(form)) if (!(key in data)) data[key] = typeof value === 'string' ? value : value;
  return data;
}

/**
 * Mostra erros por campo. Retorna true quando não há erro.
 * @param {HTMLElement} form @param {Record<string,string>} errors
 */
export function showErrors(form, errors) {
  let first = null;
  for (const wrapper of form.querySelectorAll('.field[data-field], [data-error-for]')) {
    const name = wrapper.getAttribute('data-field') ?? wrapper.getAttribute('data-error-for');
    const message = errors[name];
    const node = wrapper.matches('[data-error-for]') ? wrapper : wrapper.querySelector('.field__error');
    wrapper.classList.toggle('field--error', Boolean(message));
    if (node) {
      node.textContent = message ?? '';
      node.hidden = !message;
    }
    const control = wrapper.querySelector('input, select, textarea');
    if (control) control.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message && !first) first = wrapper;
  }
  if (first) {
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const control = first.querySelector('input, select, textarea');
    if (control instanceof HTMLElement) control.focus({ preventScroll: true });
  }
  return !first;
}

/** Avisa a navegação quando o formulário tem alterações. */
export function trackDirty(form) {
  const mark = () => form.isConnected && setDirty(true);
  form.addEventListener('input', mark);
  form.addEventListener('change', mark);
}

export const markSaved = () => setDirty(false);
