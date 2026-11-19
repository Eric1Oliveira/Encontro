// Tabela com ordenação por coluna. No celular cada linha vira um cartão (rótulos via data-label).
import { h } from './ui.js';
import { icon } from './icons.js';

export const compareValues = (a, b) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR', { sensitivity: 'base', numeric: true });

/**
 * @param {{ columns: { key: string, label: string, render?: (row: any) => any, sortValue?: (row: any) => any, align?: 'end'|'center', hideSm?: boolean, primary?: boolean, defaultDir?: 'asc'|'desc' }[],
 *   rows: any[], onRowClick?: (row: any) => void, sortKey?: string, sortDir?: 'asc'|'desc', rowClass?: (row: any) => string, caption?: string, onSortChange?: (key: string, dir: string) => void }} spec
 */
export function dataTable({ columns, rows, onRowClick, sortKey, sortDir = 'asc', rowClass, caption, onSortChange }) {
  let key = sortKey;
  let dir = sortDir;
  const tbody = h('tbody');
  const heads = columns.map((col) => {
    const th = h('th', { scope: 'col', class: [col.align && `is-${col.align}`, col.hideSm && 'hide-sm'] });
    if (col.sortValue) {
      th.append(
        h(
          'button',
          {
            type: 'button',
            class: 'th-sort',
            onclick: () => {
              if (key === col.key) dir = dir === 'asc' ? 'desc' : 'asc';
              else {
                key = col.key;
                dir = col.defaultDir ?? 'asc';
              }
              onSortChange?.(key, dir);
              paint();
            },
          },
          col.label,
          icon('chevron-down', { size: 14, className: 'th-sort__icon' }),
        ),
      );
    } else th.textContent = col.label;
    return th;
  });

  function paint() {
    const col = columns.find((c) => c.key === key);
    const sorted = col?.sortValue ? [...rows].sort((a, b) => compareValues(col.sortValue(a), col.sortValue(b)) * (dir === 'asc' ? 1 : -1)) : rows;
    heads.forEach((th, i) => th.setAttribute('aria-sort', columns[i].key === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'));
    tbody.replaceChildren(
      ...sorted.map((row) => {
        const tr = h(
          'tr',
          { class: [onRowClick && 'is-clickable', rowClass?.(row)] },
          columns.map((c) => h('td', { class: [c.align && `is-${c.align}`, c.hideSm && 'hide-sm', c.primary && 'is-primary'], dataset: { label: c.label } }, c.render ? c.render(row) : (row[c.key] ?? '—'))),
        );
        if (onRowClick) {
          tr.tabIndex = 0;
          tr.addEventListener('click', (event) => {
            if (event.target instanceof Element && event.target.closest('button, a, input, select, label')) return;
            onRowClick(row);
          });
          tr.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target === tr) onRowClick(row);
          });
        }
        return tr;
      }),
    );
  }
  paint();
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, caption && h('caption', { class: 'sr-only' }, caption), h('thead', null, h('tr', null, heads)), tbody));
}
