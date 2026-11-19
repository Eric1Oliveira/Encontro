// Janelas de diálogo (elemento <dialog>) e confirmações.
import { h, button } from './ui.js';
import { icon } from './icons.js';

/**
 * @typedef {{ label: string, variant?: string, icon?: string, onClick?: (ctx: ModalCtx) => any, close?: boolean, id?: string }} ModalAction
 * @typedef {{ close: () => void, setBusy: (busy: boolean) => void, setError: (message: string) => void, dialog: HTMLDialogElement, body: HTMLElement }} ModalCtx
 */

/**
 * @param {{ title: string, lead?: string, body?: any, actions?: ModalAction[], size?: 'sm'|'md'|'lg'|'full', dismissible?: boolean, onClose?: () => void, className?: string }} options
 * @returns {ModalCtx}
 */
let counter = 0;

export function openModal({ title, lead, body, actions = [], size = 'md', dismissible = true, onClose, className }) {
  let closed = false;
  const titleId = `modal-title-${++counter}`;
  const error = h('p', { class: 'modal__error', role: 'alert', hidden: true });
  const bodyNode = h('div', { class: 'modal__body' }, body);
  const footer = actions.length ? h('footer', { class: 'modal__foot' }) : null;
  const dialog = /** @type {HTMLDialogElement} */ (
    h(
      'dialog',
      { class: ['modal', `modal--${size}`, className], 'aria-labelledby': titleId },
      h('header', { class: 'modal__head' }, h('div', null, h('h2', { class: 'modal__title', id: titleId }, title), lead && h('p', { class: 'modal__lead' }, lead)), dismissible && h('button', { type: 'button', class: 'btn btn--ghost btn--icon modal__x', 'aria-label': 'Fechar', onclick: () => ctx.close() }, icon('x'))),
      bodyNode,
      error,
      footer,
    )
  );

  const ctx = {
    dialog,
    body: bodyNode,
    close() {
      if (closed) return;
      closed = true;
      dialog.close();
      dialog.remove();
      onClose?.();
    },
    setBusy(busy) {
      dialog.classList.toggle('is-busy', busy);
      for (const b of dialog.querySelectorAll('.modal__foot button')) b.disabled = busy;
    },
    setError(message) {
      error.textContent = message;
      error.hidden = !message;
    },
  };

  for (const action of actions) {
    const btn = button(action.label, {
      variant: action.variant ?? 'secondary',
      icon: action.icon,
      attrs: action.id ? { 'data-action': action.id } : undefined,
      onClick: async () => {
        ctx.setError('');
        if (!action.onClick) return ctx.close();
        ctx.setBusy(true);
        try {
          const keepOpen = (await action.onClick(ctx)) === false;
          if (!keepOpen && action.close !== false) ctx.close();
        } catch (err) {
          console.error(err);
          ctx.setError(err?.message || 'Não foi possível concluir. Tente novamente.');
        } finally {
          if (!closed) ctx.setBusy(false);
        }
      },
    });
    footer.append(btn);
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (dismissible && !dialog.classList.contains('is-busy')) ctx.close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && dismissible && !dialog.classList.contains('is-busy')) ctx.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  const focusTarget = dialog.querySelector('[autofocus], .modal__body input:not([type=hidden]):not([type=checkbox]):not([type=radio]), .modal__body select, .modal__body textarea');
  if (focusTarget instanceof HTMLElement) focusTarget.focus();
  return ctx;
}

/**
 * @param {{ title: string, message: any, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Voltar', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      size: 'sm',
      body: typeof message === 'string' ? h('p', { class: 'modal__text' }, message) : message,
      onClose: () => !answered && resolve(false),
      actions: [
        { label: cancelLabel, variant: 'ghost' },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', id: 'confirm', onClick: () => ((answered = true), resolve(true)) },
      ],
    });
  });
}

/**
 * Escolha entre caminhos (ex.: arquivar ou excluir).
 * @param {{ title: string, message: any, choices: { value: string, label: string, variant?: string }[] }} options
 * @returns {Promise<string|null>}
 */
export function choiceDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      size: 'sm',
      body: typeof message === 'string' ? h('p', { class: 'modal__text' }, message) : message,
      onClose: () => !answered && resolve(null),
      actions: [{ label: 'Voltar', variant: 'ghost' }, ...choices.map((c) => ({ label: c.label, variant: c.variant ?? 'secondary', id: c.value, onClick: () => ((answered = true), resolve(c.value)) }))],
    });
  });
}
