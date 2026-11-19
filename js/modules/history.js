// Histórico de participações: única fonte dos números de experiência.
// Concluir, reabrir e corrigir encontros acontece aqui, sempre numa transação só.
import { transaction, req, readStores, nowISO, uid, AppError } from '../database.js';
import { EVENT_STATUS, ROLES, PARTICIPATION_STATUS } from '../schema.js';
import { h, button, pageHeader, emptyState, avatar, teamChip, badge, fmtRange, fmtDateTime, plural, section } from '../components/ui.js';
import { icon } from '../components/icons.js';
import { dataTable } from '../components/tables.js';
import { searchBox, selectBox, collapsibleFilters, withAll, matchesQuery } from '../components/filters.js';
import { segmented } from '../components/forms.js';
import { toast, toastError } from '../components/toast.js';
import { confirmDialog } from '../components/modal.js';
import { navigate, setDirty, trackOperation } from '../router.js';

export const historyId = (eventId, teamId, personId) => `${eventId}:${teamId}:${personId}`;

// ---------- Cálculos ----------

/**
 * Agrupa as participações confirmadas por pessoa.
 * Duas equipes no mesmo encontro = 2 participações, mas 1 encontro servido.
 * @returns {Map<string, { events: Set<string>, participations: number, coordinations: number, byTeam: Map<string, {count: number, coordinations: number, name: string, color: string, icon: string}>, records: any[] }>}
 */
export function buildStats(history) {
  const byPerson = new Map();
  for (const record of history) {
    if (record.status !== 'confirmada') continue;
    let stats = byPerson.get(record.personId);
    if (!stats) byPerson.set(record.personId, (stats = emptyStats()));
    stats.events.add(record.eventId);
    stats.participations++;
    if (record.role === 'coordenador') stats.coordinations++;
    const team = stats.byTeam.get(record.teamId) ?? { count: 0, coordinations: 0, name: record.teamName, color: record.teamColor, icon: record.teamIcon };
    team.count++;
    if (record.role === 'coordenador') team.coordinations++;
    stats.byTeam.set(record.teamId, team);
    stats.records.push(record);
  }
  return byPerson;
}

export const emptyStats = () => ({ events: new Set(), participations: 0, coordinations: 0, byTeam: new Map(), records: [] });

/** Linha do tempo de uma pessoa: um item por encontro, com as equipes daquele encontro. */
export function personTimeline(records) {
  const byEvent = new Map();
  for (const r of records) {
    const item = byEvent.get(r.eventId) ?? { eventId: r.eventId, eventName: r.eventName, eventStart: r.eventStart, eventEnd: r.eventEnd, entries: [] };
    item.entries.push(r);
    byEvent.set(r.eventId, item);
  }
  return [...byEvent.values()].sort((a, b) => (b.eventStart ?? '').localeCompare(a.eventStart ?? ''));
}

// ---------- Conclusão, reabertura e correção ----------

const LIFECYCLE_STORES = ['events', 'eventTeams', 'allocations', 'participationHistory', 'people'];

/**
 * Conclui (ou reconclui) um encontro gravando o histórico a partir da distribuição.
 * @param {string} eventId
 * @param {Record<string, 'confirmada'|'ausente'>} attendance  allocationId → situação
 */
export async function concludeEvent(eventId, attendance = {}) {
  return transaction(LIFECYCLE_STORES, 'readwrite', async (s) => {
    const event = await req(s.events.get(eventId));
    if (!event) throw new AppError('not_found', 'Encontro não encontrado.');
    if (!['planejamento', 'em_andamento', 'reaberto'].includes(event.status)) throw new AppError('state', `Um encontro "${EVENT_STATUS[event.status].label.toLowerCase()}" não pode ser concluído.`);
    const [allocations, eventTeams, existing] = await Promise.all([req(s.allocations.index('eventId').getAll(eventId)), req(s.eventTeams.index('eventId').getAll(eventId)), req(s.participationHistory.index('eventId').getAll(eventId))]);
    const teams = new Map(eventTeams.map((t) => [t.teamId, t]));
    const previous = new Map(existing.map((r) => [r.id, r]));
    const now = nowISO();
    const keep = new Set();
    let confirmed = 0;
    for (const a of allocations) {
      const team = teams.get(a.teamId);
      if (!team) throw new AppError('integrity', 'Há pessoas ligadas a uma equipe que não está mais no encontro. Rode a verificação de integridade em Ajustes.');
      const person = await req(s.people.get(a.personId));
      const id = historyId(eventId, a.teamId, a.personId);
      const before = previous.get(id);
      const status = attendance[a.id] === 'ausente' ? 'ausente' : 'confirmada';
      if (status === 'confirmada') confirmed++;
      keep.add(id);
      s.participationHistory.put({
        id,
        personId: a.personId,
        eventId,
        teamId: a.teamId,
        role: a.role,
        status,
        confirmedAt: before && before.role === a.role && before.status === status ? before.confirmedAt : now,
        personName: person?.name ?? before?.personName ?? '',
        teamName: team.name,
        teamColor: team.color,
        teamIcon: team.icon,
        eventName: event.name,
        eventStart: event.startDate,
        eventEnd: event.endDate,
      });
    }
    let removed = 0;
    for (const record of existing) {
      if (!keep.has(record.id)) {
        s.participationHistory.delete(record.id);
        removed++;
      }
    }
    s.events.put({ ...event, status: 'concluido', concludedAt: now, reopenedAt: null, updatedAt: now });
    return { confirmed, absent: allocations.length - confirmed, removed };
  });
}

/** Reabre para correção. O histórico continua valendo até as correções serem confirmadas. */
export async function reopenEvent(eventId) {
  return transaction(['events'], 'readwrite', async (s) => {
    const event = await req(s.events.get(eventId));
    if (event?.status !== 'concluido') throw new AppError('state', 'Só encontros concluídos podem ser reabertos.');
    const now = nowISO();
    s.events.put({ ...event, status: 'reaberto', reopenedAt: now, updatedAt: now });
  });
}

/** Desfaz o que foi mexido na distribuição depois de reabrir: volta exatamente ao histórico. */
export async function discardCorrections(eventId) {
  return transaction(LIFECYCLE_STORES, 'readwrite', async (s) => {
    const event = await req(s.events.get(eventId));
    if (event?.status !== 'reaberto') throw new AppError('state', 'Este encontro não está reaberto.');
    const [allocations, eventTeams, records] = await Promise.all([req(s.allocations.index('eventId').getAll(eventId)), req(s.eventTeams.index('eventId').getAll(eventId)), req(s.participationHistory.index('eventId').getAll(eventId))]);
    const now = nowISO();
    const teamIds = new Set(eventTeams.map((t) => t.teamId));
    for (const a of allocations) s.allocations.delete(a.id);
    let order = eventTeams.length;
    for (const r of records) {
      if (!teamIds.has(r.teamId)) {
        s.eventTeams.put({ id: uid(), eventId, teamId: r.teamId, name: r.teamName, color: r.teamColor, icon: r.teamIcon, targetSize: null, order: order++, createdAt: now });
        teamIds.add(r.teamId);
      }
      s.allocations.put({ id: uid(), eventId, teamId: r.teamId, personId: r.personId, role: r.role, createdAt: now, updatedAt: now });
    }
    s.events.put({ ...event, status: 'concluido', reopenedAt: null, updatedAt: now });
  });
}

/** Tudo o que a tela de revisão precisa, incluindo a diferença em relação ao histórico já gravado. */
export async function reviewData(eventId) {
  return transaction(LIFECYCLE_STORES, 'readonly', async (s) => {
    const event = await req(s.events.get(eventId));
    if (!event) throw new AppError('not_found', 'Encontro não encontrado.');
    const [allocations, eventTeams, records, people] = await Promise.all([req(s.allocations.index('eventId').getAll(eventId)), req(s.eventTeams.index('eventId').getAll(eventId)), req(s.participationHistory.index('eventId').getAll(eventId)), req(s.people.getAll())]);
    const previous = new Map(records.map((r) => [r.id, r]));
    const current = new Set(allocations.map((a) => historyId(eventId, a.teamId, a.personId)));
    const diff = { added: [], removed: [], changed: [] };
    if (event.status === 'reaberto') {
      for (const a of allocations) {
        const before = previous.get(historyId(eventId, a.teamId, a.personId));
        if (!before) diff.added.push(a);
        else if (before.role !== a.role) diff.changed.push(a);
      }
      for (const r of records) if (!current.has(r.id)) diff.removed.push(r);
    }
    return { event, allocations, eventTeams: eventTeams.sort((a, b) => a.order - b.order), previous, people: new Map(people.map((p) => [p.id, p])), diff };
  });
}

// ---------- Tela: revisão para concluir ----------

export async function renderConclude(view, { id }) {
  const data = await reviewData(id);
  const { event, allocations, eventTeams, previous, people, diff } = data;
  if (!['planejamento', 'em_andamento', 'reaberto'].includes(event.status)) {
    navigate(`/encontros/${id}`, { replace: true });
    return;
  }
  const reopened = event.status === 'reaberto';
  /** @type {Record<string, 'confirmada'|'ausente'>} */
  const attendance = {};
  for (const a of allocations) attendance[a.id] = previous.get(historyId(id, a.teamId, a.personId))?.status ?? 'confirmada';

  const totals = h('p', { class: 'review__totals' });
  const paintTotals = () => {
    const absent = Object.values(attendance).filter((v) => v === 'ausente').length;
    const servedPeople = new Set(allocations.filter((a) => attendance[a.id] === 'confirmada').map((a) => a.personId)).size;
    totals.replaceChildren(h('strong', null, plural(servedPeople, 'pessoa serviu', 'pessoas serviram')), ` · ${plural(allocations.length - absent, 'participação confirmada', 'participações confirmadas')}`, absent ? ` · ${plural(absent, 'ausência', 'ausências')}` : '');
  };

  const teamBlocks = eventTeams.map((team) => {
    const members = allocations.filter((a) => a.teamId === team.teamId).sort((a, b) => (a.role === b.role ? (people.get(a.personId)?.name ?? '').localeCompare(people.get(b.personId)?.name ?? '', 'pt-BR') : a.role === 'coordenador' ? -1 : 1));
    return h(
      'section',
      { class: 'review-team', style: { '--team': team.color } },
      h('header', { class: 'review-team__head' }, teamChip(team), h('span', { class: 'muted' }, plural(members.length, 'pessoa', 'pessoas'))),
      members.length
        ? h(
            'ul',
            { class: 'review-list' },
            members.map((a) => {
              const person = people.get(a.personId);
              return h(
                'li',
                { class: 'review-row' },
                avatar(person, 'sm'),
                h('span', { class: 'review-row__name' }, person?.name ?? 'Pessoa removida', a.role === 'coordenador' && badge('Coordenação', 'gold')),
                segmented({
                  name: `att-${a.id}`,
                  label: `Situação de ${person?.name}`,
                  value: attendance[a.id],
                  options: [
                    { value: 'confirmada', label: 'Serviu' },
                    { value: 'ausente', label: 'Não compareceu' },
                  ],
                  onChange: (v) => {
                    attendance[a.id] = v;
                    setDirty(true);
                    paintTotals();
                  },
                }),
              );
            }),
          )
        : h('p', { class: 'muted review-team__empty' }, 'Ninguém foi colocado nesta equipe.'),
    );
  });

  const diffBlock = reopened
    ? section(
        'O que muda no histórico',
        { lead: 'Comparação entre a distribuição atual e o que estava confirmado.' },
        diff.added.length + diff.removed.length + diff.changed.length === 0
          ? h('p', { class: 'muted' }, 'Nenhuma pessoa entrou, saiu ou mudou de função. Só a situação (serviu/não compareceu) pode mudar.')
          : h(
              'ul',
              { class: 'diff-list' },
              diff.added.map((a) => h('li', { class: 'diff diff--add' }, icon('plus', { size: 16 }), `${people.get(a.personId)?.name ?? '—'} entra em ${eventTeams.find((t) => t.teamId === a.teamId)?.name}`)),
              diff.removed.map((r) => h('li', { class: 'diff diff--remove' }, icon('x', { size: 16 }), `${people.get(r.personId)?.name ?? r.personName} sai de ${r.teamName}`)),
              diff.changed.map((a) => h('li', { class: 'diff diff--change' }, icon('swap', { size: 16 }), `${people.get(a.personId)?.name ?? '—'} passa para ${ROLES[a.role].toLowerCase()} em ${eventTeams.find((t) => t.teamId === a.teamId)?.name}`)),
            ),
      )
    : null;

  const confirm = async () => {
    if (!allocations.length) {
      const ok = await confirmDialog({ title: 'Concluir sem ninguém?', message: 'Nenhuma pessoa foi distribuída neste encontro. Ele será concluído sem gerar histórico.', confirmLabel: 'Concluir assim' });
      if (!ok) return;
    }
    try {
      const result = await trackOperation('a conclusão do encontro', concludeEvent(id, attendance));
      setDirty(false);
      toast(reopened ? `Correções confirmadas. ${plural(result.confirmed, 'participação', 'participações')} no histórico.` : `Encontro concluído. ${plural(result.confirmed, 'participação foi registrada', 'participações foram registradas')}.`);
      navigate(`/encontros/${id}`);
    } catch (error) {
      toastError(error);
    }
  };

  paintTotals();
  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({
        back: { href: `/encontros/${id}`, label: event.name },
        eyebrow: reopened ? 'Confirmar correções' : 'Concluir encontro',
        title: 'Quem serviu de verdade?',
        lead: reopened ? 'O histórico deste encontro será substituído pelo que estiver marcado aqui. Até você confirmar, nada muda.' : 'Marque quem não compareceu. Ao confirmar, cada participação entra no histórico das pessoas — encontros em planejamento nunca contam.',
      }),
      h('div', { class: 'review-meta' }, h('span', null, icon('calendar', { size: 16 }), fmtRange(event.startDate, event.endDate)), totals),
      diffBlock,
      h('div', { class: 'review-grid' }, teamBlocks.length ? teamBlocks : emptyState({ icon: 'teams', title: 'Nenhuma equipe neste encontro', text: 'Você pode concluir mesmo assim; nada entra no histórico.' })),
      h('div', { class: 'savebar' }, h('div', { class: 'savebar__inner' }, h('p', { class: 'savebar__text' }, 'A conclusão grava tudo de uma vez: ou todo o histórico é salvo, ou nada muda.'), button('Voltar', { variant: 'ghost', onClick: () => navigate(`/encontros/${id}`) }), button(reopened ? 'Confirmar correções' : 'Concluir encontro', { variant: 'primary', icon: 'flag', onClick: confirm, attrs: { 'data-action': 'confirm-conclusion' } }))),
    ),
  );
}

// ---------- Tela: histórico geral ----------

const state = { mode: 'registros', query: '', teamId: '', eventId: '', status: 'confirmada' };

export async function renderHistory(view) {
  const data = await readStores(['participationHistory', 'teams', 'events', 'people']);
  const records = data.participationHistory;
  const people = new Map(data.people.map((p) => [p.id, p]));
  const events = new Map(data.events.map((e) => [e.id, e]));
  const nameOf = (r) => people.get(r.personId)?.name ?? r.personName;
  const confirmed = records.filter((r) => r.status === 'confirmada');
  const body = h('div', { class: 'stack' });

  const teamOptions = [...new Map(records.map((r) => [r.teamId, r.teamName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')).map(([value, label]) => ({ value, label }));
  const eventOptions = [...new Map(records.map((r) => [r.eventId, `${r.eventName} (${fmtRange(r.eventStart, r.eventEnd)})`])).entries()].map(([value, label]) => ({ value, label }));

  // A barra de filtros é criada uma vez: redesenhar só o resultado mantém o foco na busca.
  const filters = collapsibleFilters(
    searchBox({ value: state.query, placeholder: 'Buscar pessoa, equipe ou encontro', onInput: (v) => ((state.query = v), paint()) }),
    selectBox({ label: 'Equipe', value: state.teamId, options: withAll('Todas', teamOptions), onChange: (v) => ((state.teamId = v), paint()) }),
    selectBox({ label: 'Encontro', value: state.eventId, options: withAll('Todos', eventOptions), onChange: (v) => ((state.eventId = v), paint()) }),
    selectBox({ label: 'Situação', value: state.status, defaultValue: 'confirmada', options: [{ value: 'confirmada', label: 'Serviu' }, { value: 'ausente', label: 'Não compareceu' }, { value: '', label: 'Todas' }], onChange: (v) => ((state.status = v), paint()) }),
  );

  const paint = () => {
    filters.hidden = !records.length || state.mode !== 'registros';
    if (!records.length) {
      body.replaceChildren(emptyState({ icon: 'history', title: 'O histórico começa no primeiro encontro concluído', text: 'Monte a distribuição de um encontro e conclua-o: cada pessoa que serviu entra aqui automaticamente.', action: h('a', { class: 'btn btn--primary', href: '#/encontros' }, 'Ver encontros') }));
      return;
    }
    if (state.mode === 'equipes') return paintTeams();
    if (state.mode === 'encontros') return paintEvents();
    const rows = records.filter((r) => (!state.teamId || r.teamId === state.teamId) && (!state.eventId || r.eventId === state.eventId) && (!state.status || r.status === state.status) && matchesQuery(`${nameOf(r)} ${r.teamName} ${r.eventName}`, state.query));
    body.replaceChildren(
      h('p', { class: 'result-count' }, plural(rows.length, 'registro', 'registros')),
      rows.length
        ? dataTable({
            rows,
            sortKey: 'event',
            sortDir: 'desc',
            onRowClick: (r) => people.has(r.personId) && navigate(`/pessoas/${r.personId}?aba=historico`),
            columns: [
              { key: 'person', label: 'Pessoa', primary: true, sortValue: nameOf, render: (r) => h('span', { class: 'cell-person' }, avatar(people.get(r.personId) ?? { name: r.personName }, 'sm'), nameOf(r)) },
              { key: 'event', label: 'Encontro', sortValue: (r) => r.eventStart, render: (r) => h('span', { class: 'cell-stack' }, h('span', null, r.eventName), h('small', null, fmtRange(r.eventStart, r.eventEnd))) },
              { key: 'team', label: 'Equipe', sortValue: (r) => r.teamName, render: (r) => teamChip({ name: r.teamName, color: r.teamColor, icon: r.teamIcon }, { small: true }) },
              { key: 'role', label: 'Função', sortValue: (r) => r.role, render: (r) => (r.role === 'coordenador' ? badge('Coordenação', 'gold') : 'Integrante') },
              { key: 'status', label: 'Situação', sortValue: (r) => r.status, render: (r) => badge(PARTICIPATION_STATUS[r.status], r.status === 'confirmada' ? 'ok' : 'muted') },
              { key: 'confirmedAt', label: 'Registrado em', hideSm: true, sortValue: (r) => r.confirmedAt, render: (r) => fmtDateTime(r.confirmedAt) },
            ],
          })
        : emptyState({ icon: 'search', title: 'Nenhum registro com esses filtros' }),
    );
  };

  const paintTeams = () => {
    const byTeam = new Map();
    for (const r of confirmed) {
      const t = byTeam.get(r.teamId) ?? { teamId: r.teamId, name: r.teamName, color: r.teamColor, icon: r.teamIcon, participations: 0, people: new Set(), coordinators: new Set(), events: new Set() };
      t.participations++;
      t.people.add(r.personId);
      t.events.add(r.eventId);
      if (r.role === 'coordenador') t.coordinators.add(r.personId);
      byTeam.set(r.teamId, t);
    }
    const rows = [...byTeam.values()];
    body.replaceChildren(
      h('p', { class: 'result-count' }, 'Toque numa equipe para ver cada participação dela.'),
      dataTable({
        rows,
        sortKey: 'participations',
        sortDir: 'desc',
        onRowClick: (t) => {
          Object.assign(state, { mode: 'registros', teamId: t.teamId, eventId: '', query: '' });
          renderHistory(view);
        },
        columns: [
          { key: 'name', label: 'Equipe', primary: true, sortValue: (t) => t.name, render: (t) => teamChip(t) },
          { key: 'participations', label: 'Participações', align: 'end', defaultDir: 'desc', sortValue: (t) => t.participations, render: (t) => h('span', { class: 'num' }, t.participations) },
          { key: 'people', label: 'Pessoas diferentes', align: 'end', defaultDir: 'desc', sortValue: (t) => t.people.size, render: (t) => h('span', { class: 'num' }, t.people.size) },
          { key: 'coordinators', label: 'Coordenadores', align: 'end', defaultDir: 'desc', sortValue: (t) => t.coordinators.size, render: (t) => h('span', { class: 'num' }, t.coordinators.size) },
          { key: 'events', label: 'Encontros', align: 'end', defaultDir: 'desc', sortValue: (t) => t.events.size, render: (t) => h('span', { class: 'num' }, t.events.size) },
        ],
      }),
    );
  };

  const paintEvents = () => {
    const byEvent = new Map();
    for (const r of records) {
      const e = byEvent.get(r.eventId) ?? { eventId: r.eventId, name: r.eventName, start: r.eventStart, end: r.eventEnd, served: new Set(), absent: 0, teams: new Set() };
      if (r.status === 'confirmada') e.served.add(r.personId);
      else e.absent++;
      e.teams.add(r.teamId);
      byEvent.set(r.eventId, e);
    }
    body.replaceChildren(
      dataTable({
        rows: [...byEvent.values()],
        sortKey: 'start',
        sortDir: 'desc',
        onRowClick: (e) => events.has(e.eventId) && navigate(`/encontros/${e.eventId}`),
        columns: [
          { key: 'name', label: 'Encontro', primary: true, sortValue: (e) => e.name, render: (e) => h('span', { class: 'cell-stack' }, h('span', null, e.name), h('small', null, fmtRange(e.start, e.end))) },
          { key: 'start', label: 'Data', sortValue: (e) => e.start, hideSm: true, render: (e) => fmtRange(e.start, e.end) },
          { key: 'served', label: 'Serviram', align: 'end', sortValue: (e) => e.served.size, render: (e) => h('span', { class: 'num' }, e.served.size) },
          { key: 'teams', label: 'Equipes', align: 'end', sortValue: (e) => e.teams.size, render: (e) => h('span', { class: 'num' }, e.teams.size) },
          { key: 'absent', label: 'Ausências', align: 'end', sortValue: (e) => e.absent, render: (e) => h('span', { class: 'num' }, e.absent) },
        ],
      }),
    );
  };

  const servedPeople = new Set(confirmed.map((r) => r.personId)).size;
  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({
        eyebrow: 'Calculado a partir dos encontros concluídos',
        title: 'Histórico',
        lead: records.length ? `${plural(confirmed.length, 'participação confirmada', 'participações confirmadas')} de ${plural(servedPeople, 'pessoa', 'pessoas')} em ${plural(new Set(records.map((r) => r.eventId)).size, 'encontro', 'encontros')}.` : 'Nenhum encontro concluído ainda.',
      }),
      records.length
        ? segmented({
            name: 'history-mode',
            label: 'Modo de visualização',
            value: state.mode,
            options: [
              { value: 'registros', label: 'Participações' },
              { value: 'equipes', label: 'Por equipe' },
              { value: 'encontros', label: 'Por encontro' },
            ],
            onChange: (v) => ((state.mode = v), paint()),
          })
        : null,
      filters,
      body,
    ),
  );
  paint();
}
