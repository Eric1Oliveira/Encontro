// Encontros: cadastro, ciclo de vida (planejamento → andamento → concluído ↔ reaberto) e página do encontro.
import { transaction, req, readStores, uid, nowISO, AppError } from '../database.js';
import { EVENT_STATUS, ROLES } from '../schema.js';
import { validateEvent, normalize, clean } from '../validation.js';
import { h, button, pageHeader, emptyState, avatar, badge, teamChip, plural, fmtRange, todayISO, section } from '../components/ui.js';
import { icon } from '../components/icons.js';
import { dataTable } from '../components/tables.js';
import { segmented, field, readForm, showErrors } from '../components/forms.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { navigate, refresh } from '../router.js';
import { reopenEvent, discardCorrections } from './history.js';
import { loadEventContext, renderBoard } from './allocations.js';

// ---------- Escrita ----------

export async function saveEvent(input) {
  const data = { ...input, name: clean(input.name), location: clean(input.location) };
  const errors = validateEvent(data);
  if (Object.keys(errors).length) throw Object.assign(new AppError('invalid', 'Confira os campos destacados.'), { fields: errors });
  return transaction(['events', 'participationHistory'], 'readwrite', async (s) => {
    const before = data.id ? await req(s.events.get(data.id)) : null;
    if (data.id && !before) throw new AppError('not_found', 'Encontro não encontrado.');
    const now = nowISO();
    const record = { status: 'planejamento', concludedAt: null, reopenedAt: null, ...before, ...data, id: before?.id ?? uid(), nameKey: normalize(data.name), createdAt: before?.createdAt ?? now, updatedAt: now };
    s.events.put(record);
    // Corrigir nome ou datas de um encontro já registrado atualiza a referência no histórico.
    if (before && (before.name !== record.name || before.startDate !== record.startDate || before.endDate !== record.endDate)) {
      for (const r of await req(s.participationHistory.index('eventId').getAll(record.id))) s.participationHistory.put({ ...r, eventName: record.name, eventStart: record.startDate, eventEnd: record.endDate });
    }
    return { record, created: !before };
  });
}

const TRANSITIONS = {
  start: { from: ['planejamento'], to: 'em_andamento' },
  backToPlanning: { from: ['em_andamento', 'cancelado'], to: 'planejamento' },
  cancel: { from: ['planejamento', 'em_andamento'], to: 'cancelado' },
};

export async function changeStatus(eventId, transitionKey) {
  const transition = TRANSITIONS[transitionKey];
  return transaction(['events'], 'readwrite', async (s) => {
    const event = await req(s.events.get(eventId));
    if (!event) throw new AppError('not_found', 'Encontro não encontrado.');
    if (!transition.from.includes(event.status)) throw new AppError('state', `Não é possível fazer isso com um encontro "${EVENT_STATUS[event.status].label.toLowerCase()}".`);
    s.events.put({ ...event, status: transition.to, updatedAt: nowISO() });
  });
}

/** Encontros com histórico não podem ser apagados — apagar levaria junto a memória de quem serviu. */
export async function deleteEvent(eventId) {
  return transaction(['events', 'eventTeams', 'allocations', 'participationHistory'], 'readwrite', async (s) => {
    const event = await req(s.events.get(eventId));
    if (!event) throw new AppError('not_found', 'Encontro não encontrado.');
    if (await req(s.participationHistory.index('eventId').count(eventId))) throw new AppError('has_history', 'Este encontro já faz parte do histórico. Para corrigir, reabra o encontro.');
    if (['concluido', 'reaberto'].includes(event.status)) throw new AppError('state', 'Encontros concluídos não podem ser excluídos.');
    for (const a of await req(s.allocations.index('eventId').getAll(eventId))) s.allocations.delete(a.id);
    for (const t of await req(s.eventTeams.index('eventId').getAll(eventId))) s.eventTeams.delete(t.id);
    s.events.delete(eventId);
  });
}

// ---------- Formulário ----------

export function eventDialog(event) {
  const form = h(
    'form',
    { class: 'form-grid', novalidate: true },
    field({ label: 'Nome do encontro', name: 'name', value: event?.name, required: true, wide: true, placeholder: 'Ex.: 12º Encontro de Jovens', attrs: { maxlength: '100' } }),
    field({ label: 'Início', name: 'startDate', type: 'date', value: event?.startDate ?? '', required: true }),
    field({ label: 'Término', name: 'endDate', type: 'date', value: event?.endDate ?? '', required: true }),
    field({ label: 'Local', name: 'location', value: event?.location, wide: true, attrs: { maxlength: '120' } }),
    field({ label: 'Descrição', name: 'description', type: 'textarea', value: event?.description, wide: true, rows: 3 }),
    field({ label: 'Observações', name: 'notes', type: 'textarea', value: event?.notes, wide: true, rows: 2 }),
  );
  const start = form.querySelector('[name=startDate]');
  const end = form.querySelector('[name=endDate]');
  start.addEventListener('change', () => {
    if (!end.value || end.value < start.value) end.value = start.value;
  });
  openModal({
    title: event ? 'Editar encontro' : 'Novo encontro',
    lead: event && ['concluido', 'reaberto'].includes(event.status) ? 'Nome e datas corrigidos aqui também são atualizados no histórico deste encontro.' : null,
    size: 'lg',
    body: form,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: event ? 'Salvar encontro' : 'Criar encontro',
        variant: 'primary',
        id: 'save-event',
        onClick: async () => {
          const v = readForm(form);
          try {
            const { record, created } = await saveEvent({ ...event, name: v.name, startDate: v.startDate, endDate: v.endDate, location: v.location, description: v.description.trim(), notes: v.notes.trim() });
            toast(created ? 'Encontro criado. Agora adicione as equipes.' : 'Encontro salvo.');
            if (created) navigate(`/encontros/${record.id}`);
            else refresh();
          } catch (error) {
            if (error.fields) {
              showErrors(form, error.fields);
              return false;
            }
            throw error;
          }
        },
      },
    ],
  });
}

// ---------- Lista ----------

function dateBlock(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const month = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][m - 1];
  return h('span', { class: 'date-block', 'aria-hidden': 'true' }, h('span', { class: 'date-block__day' }, String(d)), h('span', { class: 'date-block__month' }, month), h('span', { class: 'date-block__year' }, String(y)));
}

export async function renderEvents(view) {
  const { events, eventTeams, allocations } = await readStores(['events', 'eventTeams', 'allocations']);
  const today = todayISO();
  const card = (e) => {
    const teams = eventTeams.filter((t) => t.eventId === e.id);
    const people = new Set(allocations.filter((a) => a.eventId === e.id).map((a) => a.personId)).size;
    const target = teams.reduce((sum, t) => sum + (t.targetSize ?? 0), 0);
    const status = EVENT_STATUS[e.status];
    return h(
      'a',
      { class: ['event-card', `event-card--${e.status}`], href: `#/encontros/${e.id}` },
      dateBlock(e.startDate),
      h('span', { class: 'event-card__body' }, h('span', { class: 'event-card__name' }, e.name), h('span', { class: 'event-card__meta' }, [fmtRange(e.startDate, e.endDate), e.location].filter(Boolean).join(' · ')), h('span', { class: 'event-card__stats' }, `${plural(teams.length, 'equipe', 'equipes')} · ${plural(people, 'pessoa', 'pessoas')}${target ? ` de ${target} desejadas` : ''}`), h('span', { class: 'event-card__ribbon' }, teams.slice(0, 14).map((t) => h('span', { class: 'ribbon-dot', style: { '--team': t.color }, title: t.name })))),
      badge(status.label, status.tone),
    );
  };
  const active = events.filter((e) => ['planejamento', 'em_andamento', 'reaberto'].includes(e.status)).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const done = events.filter((e) => e.status === 'concluido').sort((a, b) => b.startDate.localeCompare(a.startDate));
  const cancelled = events.filter((e) => e.status === 'cancelado').sort((a, b) => b.startDate.localeCompare(a.startDate));
  const late = active.filter((e) => e.endDate < today && e.status !== 'reaberto');

  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({ eyebrow: 'Cada encontro tem a própria distribuição', title: 'Encontros', lead: events.length ? `${plural(done.length, 'concluído', 'concluídos')} · ${plural(active.length, 'em aberto', 'em aberto')}` : null, actions: button('Novo encontro', { variant: 'primary', icon: 'plus', onClick: () => eventDialog() }) }),
      late.length ? h('div', { class: 'notice notice--warn' }, icon('alert', { size: 18 }), h('p', { class: 'notice__text' }, `${late.map((e) => e.name).join(', ')} já ${late.length === 1 ? 'terminou' : 'terminaram'} pela data. Conclua para registrar quem serviu no histórico.`)) : null,
      !events.length
        ? emptyState({ icon: 'calendar', title: 'Nenhum encontro ainda', text: 'Crie um encontro, adicione as equipes e distribua as pessoas. Ao concluir, o histórico é registrado.', action: button('Criar o primeiro encontro', { variant: 'primary', icon: 'plus', onClick: () => eventDialog() }) })
        : [
            section('Em aberto', { lead: active.length ? null : 'Nenhum encontro em planejamento.' }, active.length ? h('div', { class: 'event-list' }, active.map(card)) : null),
            done.length ? section('Concluídos', null, h('div', { class: 'event-list' }, done.map(card))) : null,
            cancelled.length ? h('details', { class: 'panel panel--details' }, h('summary', { class: 'panel__title' }, `Cancelados (${cancelled.length})`), h('div', { class: 'event-list' }, cancelled.map(card))) : null,
          ],
    ),
  );
}

// ---------- Página do encontro ----------

const tabs = new Map();

export async function renderEvent(view, { id }) {
  const ctx = await loadEventContext(id);
  if (!ctx) {
    view.replaceChildren(emptyState({ icon: 'calendar', title: 'Encontro não encontrado', action: h('a', { class: 'btn btn--primary', href: '#/encontros' }, 'Ver encontros') }));
    return;
  }
  const { event } = ctx;
  const status = EVENT_STATUS[event.status];
  let tab = tabs.get(id) ?? 'quadrante';

  const run = async (work, message, after) => {
    try {
      await work();
      toast(message);
      after ? after() : refresh();
    } catch (error) {
      toastError(error);
    }
  };

  const more = () => {
    const items = [
      event.status === 'em_andamento' && button('Voltar para planejamento', { icon: 'undo', onClick: () => (modal.close(), run(() => changeStatus(id, 'backToPlanning'), 'Encontro voltou para planejamento.')) }),
      ['planejamento', 'em_andamento'].includes(event.status) && button('Cancelar encontro', { icon: 'x', onClick: async () => { modal.close(); if (await confirmDialog({ title: 'Cancelar este encontro?', message: 'A distribuição fica guardada, mas não poderá ser alterada nem entrar no histórico. Você pode retomar o planejamento depois.', confirmLabel: 'Cancelar encontro', cancelLabel: 'Voltar', danger: true })) run(() => changeStatus(id, 'cancel'), 'Encontro cancelado.'); } }),
      !['concluido', 'reaberto'].includes(event.status) && button('Excluir encontro', { icon: 'trash', variant: 'danger', onClick: async () => { modal.close(); if (await confirmDialog({ title: `Excluir ${event.name}?`, message: `O encontro, as ${plural(ctx.eventTeams.length, 'equipe', 'equipes')} e a distribuição de ${plural(new Set(ctx.allocations.map((a) => a.personId)).size, 'pessoa', 'pessoas')} serão apagados. Fichas e equipes cadastradas não mudam.`, confirmLabel: 'Excluir', danger: true })) run(() => deleteEvent(id), 'Encontro excluído.', () => navigate('/encontros')); } }),
    ].filter(Boolean);
    const modal = openModal({ title: 'Mais ações', size: 'sm', className: 'sheet', body: h('div', { class: 'menu-list' }, items) });
  };

  const actions = [];
  if (event.status === 'planejamento') actions.push(button('Iniciar encontro', { icon: 'play', onClick: () => run(() => changeStatus(id, 'start'), 'Encontro em andamento.') }));
  if (['planejamento', 'em_andamento'].includes(event.status)) actions.push(button('Concluir encontro', { variant: 'primary', icon: 'flag', attrs: { 'data-action': 'conclude' }, onClick: () => navigate(`/encontros/${id}/concluir`) }));
  if (event.status === 'concluido') actions.push(button('Reabrir para correção', { icon: 'reopen', attrs: { 'data-action': 'reopen' }, onClick: async () => (await confirmDialog({ title: 'Reabrir para correção?', message: 'Você poderá mexer na distribuição. O histórico continua como está até você confirmar as correções.', confirmLabel: 'Reabrir' })) && run(() => reopenEvent(id), 'Encontro reaberto. O histórico só muda quando você confirmar.') }));
  if (event.status === 'cancelado') actions.push(button('Retomar planejamento', { icon: 'undo', onClick: () => run(() => changeStatus(id, 'backToPlanning'), 'Encontro de volta ao planejamento.') }));
  actions.push(button('Editar', { icon: 'edit', onClick: () => eventDialog(event) }));
  actions.push(button('', { icon: 'printer', title: 'Imprimir quadrante', onClick: () => printBoard() }));
  if (event.status !== 'concluido') actions.push(button('', { icon: 'more', title: 'Mais ações', onClick: more }));

  const reopenedBanner =
    event.status === 'reaberto'
      ? h(
          'div',
          { class: 'notice notice--warn notice--block' },
          icon('alert', { size: 18 }),
          h('div', { class: 'notice__text' }, h('strong', null, 'Reaberto para correção. '), 'O histórico continua valendo como estava. Mexa na distribuição e confirme; ou descarte para voltar exatamente ao que estava registrado.'),
          h('div', { class: 'notice__actions' }, button('Descartar correções', { variant: 'ghost', small: true, attrs: { 'data-action': 'discard' }, onClick: async () => (await confirmDialog({ title: 'Descartar correções?', message: 'A distribuição volta a ser exatamente a do histórico registrado e o encontro fica concluído de novo.', confirmLabel: 'Descartar', danger: true })) && run(() => discardCorrections(id), 'Correções descartadas.') }), button('Confirmar correções', { variant: 'primary', small: true, icon: 'check', attrs: { 'data-action': 'confirm-corrections' }, onClick: () => navigate(`/encontros/${id}/concluir`) })),
        )
      : null;

  const panel = h('div', { class: 'event-panel' });
  const printBoard = () => {
    tab = 'quadrante';
    tabs.set(id, tab);
    paint();
    setTimeout(() => window.print(), 50);
  };
  const paint = () => {
    if (tab === 'quadrante') panel.replaceChildren(renderBoard(ctx));
    else if (tab === 'pessoas') panel.replaceChildren(peopleTab(ctx));
    else panel.replaceChildren(detailsTab(ctx));
  };

  view.replaceChildren(
    h(
      'div',
      { class: 'page page--wide' },
      pageHeader({
        back: { href: '/encontros', label: 'Encontros' },
        eyebrow: h('span', { class: 'eyebrow-row' }, badge(status.label, status.tone), fmtRange(event.startDate, event.endDate)),
        title: event.name,
        lead: event.location ? h('span', { class: 'with-icon' }, icon('pin', { size: 16 }), event.location) : null,
        actions,
      }),
      reopenedBanner,
      !ctx.editable && event.status === 'concluido' ? h('p', { class: 'muted lock-note' }, icon('lock', { size: 14 }), ` Concluído${event.concludedAt ? ` em ${new Date(event.concludedAt).toLocaleDateString('pt-BR')}` : ''}. A distribuição está travada; reabra para corrigir.`) : null,
      segmented({
        name: 'event-tab',
        label: 'Seção do encontro',
        value: tab,
        options: [
          { value: 'quadrante', label: 'Quadrante' },
          { value: 'pessoas', label: 'Pessoas' },
          { value: 'dados', label: 'Dados' },
        ],
        onChange: (v) => {
          tab = v;
          tabs.set(id, v);
          paint();
        },
      }),
      panel,
    ),
  );
  paint();
}

function peopleTab(ctx) {
  const byPerson = new Map();
  for (const a of ctx.allocations) byPerson.set(a.personId, [...(byPerson.get(a.personId) ?? []), a]);
  const rows = [...byPerson.entries()].map(([personId, list]) => ({ personId, person: ctx.people.get(personId), list, name: ctx.people.get(personId)?.name ?? '—' }));
  if (!rows.length) return emptyState({ icon: 'people', title: 'Ninguém distribuído ainda', text: 'Use "Montar equipe" no quadrante para colocar pessoas nas equipes.' });
  const multi = rows.filter((r) => r.list.length > 1).length;
  return h(
    'div',
    { class: 'stack' },
    multi ? h('div', { class: 'notice notice--info' }, icon('info', { size: 18 }), h('p', { class: 'notice__text' }, `${plural(multi, 'pessoa está', 'pessoas estão')} em mais de uma equipe. É permitido — confira se a disponibilidade permite.`)) : null,
    dataTable({
      rows,
      sortKey: 'name',
      onRowClick: (r) => navigate(`/pessoas/${r.personId}`),
      columns: [
        { key: 'name', label: 'Pessoa', primary: true, sortValue: (r) => r.name, render: (r) => h('span', { class: 'cell-person' }, avatar(r.person ?? { name: '?' }, 'sm'), r.name) },
        { key: 'teams', label: 'Equipes neste encontro', sortValue: (r) => r.list.length, render: (r) => h('span', { class: 'tags' }, r.list.map((a) => { const t = ctx.eventTeams.find((x) => x.teamId === a.teamId); return h('span', { class: 'tag-team' }, teamChip(t, { small: true }), a.role === 'coordenador' ? badge(ROLES.coordenador, 'gold') : null); })) },
        { key: 'experience', label: 'Encontros servidos', align: 'end', sortValue: (r) => ctx.stats.get(r.personId)?.events.size ?? 0, render: (r) => h('span', { class: 'num' }, ctx.stats.get(r.personId)?.events.size ?? 0) },
        { key: 'flag', label: 'Aviso', render: (r) => (r.list.length > 1 ? badge(`${r.list.length} equipes`, 'warn', 'alert') : '—') },
      ],
    }),
  );
}

function detailsTab(ctx) {
  const { event } = ctx;
  const item = (label, value) => h('div', { class: 'detail' }, h('dt', null, label), h('dd', null, value || h('span', { class: 'muted' }, '—')));
  return section(
    'Dados do encontro',
    { actions: button('Editar', { icon: 'edit', small: true, onClick: () => eventDialog(event) }) },
    h('dl', { class: 'details' }, item('Nome', event.name), item('Datas', fmtRange(event.startDate, event.endDate)), item('Local', event.location), item('Situação', EVENT_STATUS[event.status].label), item('Descrição', event.description && h('span', { class: 'prose' }, event.description)), item('Observações', event.notes && h('span', { class: 'prose' }, event.notes))),
  );
}
