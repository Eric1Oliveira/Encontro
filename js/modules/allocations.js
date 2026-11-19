// Distribuição de pessoas num encontro: o Quadrante, o painel "Montar equipe" e as operações de escala.
import { transaction, req, readStores, uid, nowISO, setting, AppError } from '../database.js';
import { EDITABLE_EVENT_STATUS, ROLES } from '../schema.js';
import { h, button, avatar, badge, teamChip, plural, emptyState, fmtRange } from '../components/ui.js';
import { icon } from '../components/icons.js';
import { searchBox, selectBox, toggle, filterBar, withAll, matchesQuery } from '../components/filters.js';
import { field, readForm, showErrors } from '../components/forms.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { refresh } from '../router.js';
import { pickPeople } from './people.js';
import { buildStats } from './history.js';
import { rankCandidates } from './assistant.js';
import { loadCatalog, optionNames } from './skills.js';
import { currentCoordinators } from './teams.js';

// ---------- Regras ----------

export function assertEditable(event) {
  if (!event) throw new AppError('not_found', 'Encontro não encontrado.');
  if (!EDITABLE_EVENT_STATUS.includes(event.status)) {
    throw new AppError('locked', event.status === 'concluido' ? 'Este encontro está concluído. Use "Reabrir para correção" para mudar a distribuição.' : 'Este encontro está cancelado. Retome o planejamento para mudar a distribuição.');
  }
}

const STORES = ['events', 'teams', 'eventTeams', 'allocations', 'people'];

export async function addTeamToEvent(eventId, teamId, { includeCoordinators = true } = {}) {
  return transaction(STORES, 'readwrite', async (s) => {
    assertEditable(await req(s.events.get(eventId)));
    const team = await req(s.teams.get(teamId));
    if (!team) throw new AppError('not_found', 'Equipe não encontrada.');
    if (await req(s.eventTeams.index('unique').get([eventId, teamId]))) throw new AppError('duplicate', `${team.name} já faz parte deste encontro.`);
    const now = nowISO();
    const order = await req(s.eventTeams.index('eventId').count(eventId));
    const eventTeam = { id: uid(), eventId, teamId, name: team.name, color: team.color, icon: team.icon, targetSize: team.targetSize ?? null, order, createdAt: now };
    s.eventTeams.add(eventTeam);
    let coordinators = 0;
    if (includeCoordinators) {
      for (const c of currentCoordinators(team)) {
        const person = await req(s.people.get(c.personId));
        if (person?.status !== 'ativo') continue;
        s.allocations.add({ id: uid(), eventId, teamId, personId: c.personId, role: 'coordenador', createdAt: now, updatedAt: now });
        coordinators++;
      }
    }
    return { eventTeam, coordinators };
  });
}

export async function removeTeamFromEvent(eventTeamId) {
  return transaction(STORES, 'readwrite', async (s) => {
    const eventTeam = await req(s.eventTeams.get(eventTeamId));
    if (!eventTeam) throw new AppError('not_found', 'Equipe não encontrada neste encontro.');
    assertEditable(await req(s.events.get(eventTeam.eventId)));
    const members = (await req(s.allocations.index('eventId').getAll(eventTeam.eventId))).filter((a) => a.teamId === eventTeam.teamId);
    for (const a of members) s.allocations.delete(a.id);
    s.eventTeams.delete(eventTeamId);
    return members.length;
  });
}

export async function setEventTeamTarget(eventTeamId, targetSize) {
  return transaction(STORES, 'readwrite', async (s) => {
    const eventTeam = await req(s.eventTeams.get(eventTeamId));
    assertEditable(await req(s.events.get(eventTeam?.eventId)));
    s.eventTeams.put({ ...eventTeam, targetSize });
  });
}

/**
 * Coloca uma pessoa numa equipe do encontro. Mesma pessoa duas vezes na mesma equipe é recusado
 * (também pelo índice único do banco). Em outra equipe do mesmo encontro é permitido, com aviso.
 * @returns {Promise<{ allocation: any, otherTeams: string[] }>}
 */
export async function addPerson({ eventId, teamId, personId, role = 'integrante' }) {
  return transaction(STORES, 'readwrite', async (s) => {
    assertEditable(await req(s.events.get(eventId)));
    const eventTeams = await req(s.eventTeams.index('eventId').getAll(eventId));
    if (!eventTeams.some((t) => t.teamId === teamId)) throw new AppError('not_found', 'Esta equipe não faz parte do encontro.');
    const person = await req(s.people.get(personId));
    if (!person) throw new AppError('not_found', 'Pessoa não encontrada.');
    if (person.status !== 'ativo') throw new AppError('archived', `${person.name} está com a ficha arquivada. Reative a ficha para escalar.`);
    if (await req(s.allocations.index('unique').get([eventId, teamId, personId]))) throw new AppError('duplicate', `${person.name} já está nesta equipe neste encontro.`);
    const others = (await req(s.allocations.index('personId').getAll(personId))).filter((a) => a.eventId === eventId);
    const now = nowISO();
    const allocation = { id: uid(), eventId, teamId, personId, role, createdAt: now, updatedAt: now };
    s.allocations.add(allocation);
    return { allocation, otherTeams: others.map((a) => eventTeams.find((t) => t.teamId === a.teamId)?.name).filter(Boolean) };
  });
}

async function updateAllocation(allocationId, change) {
  return transaction(STORES, 'readwrite', async (s) => {
    const allocation = await req(s.allocations.get(allocationId));
    if (!allocation) throw new AppError('not_found', 'Esta pessoa já não está na equipe.');
    assertEditable(await req(s.events.get(allocation.eventId)));
    return change(allocation, s);
  });
}

export const setRole = (allocationId, role) => updateAllocation(allocationId, (a, s) => s.allocations.put({ ...a, role, updatedAt: nowISO() }));
export const removeAllocation = (allocationId) => updateAllocation(allocationId, (a, s) => s.allocations.delete(a.id));

/** Substitui uma pessoa por outra, mantendo a função, numa gravação só. */
export function replacePerson(allocationId, newPersonId) {
  return updateAllocation(allocationId, async (a, s) => {
    const person = await req(s.people.get(newPersonId));
    if (!person || person.status !== 'ativo') throw new AppError('not_found', 'Escolha uma pessoa ativa.');
    if (await req(s.allocations.index('unique').get([a.eventId, a.teamId, newPersonId]))) throw new AppError('duplicate', `${person.name} já está nesta equipe.`);
    s.allocations.delete(a.id);
    const now = nowISO();
    s.allocations.add({ id: uid(), eventId: a.eventId, teamId: a.teamId, personId: newPersonId, role: a.role, createdAt: now, updatedAt: now });
  });
}

// ---------- Dados do encontro ----------

export async function loadEventContext(eventId) {
  const [stores, catalog] = await Promise.all([readStores(['events', 'eventTeams', 'allocations', 'people', 'teams', 'participationHistory', 'teamRequirements']), loadCatalog()]);
  const event = stores.events.find((e) => e.id === eventId);
  if (!event) return null;
  return {
    event,
    eventTeams: stores.eventTeams.filter((t) => t.eventId === eventId).sort((a, b) => a.order - b.order),
    allocations: stores.allocations.filter((a) => a.eventId === eventId),
    people: new Map(stores.people.map((p) => [p.id, p])),
    peopleList: stores.people,
    teams: new Map(stores.teams.map((t) => [t.id, t])),
    teamList: stores.teams,
    stats: buildStats(stores.participationHistory, stores.people),
    requirements: stores.teamRequirements,
    catalog,
    editable: EDITABLE_EVENT_STATUS.includes(event.status),
  };
}

const byRoleThenName = (people) => (a, b) => (a.role === b.role ? (people.get(a.personId)?.name ?? '').localeCompare(people.get(b.personId)?.name ?? '', 'pt-BR') : a.role === 'coordenador' ? -1 : 1);

/** Pessoas em mais de uma equipe neste encontro → nomes das equipes. */
function multiTeamMap(ctx) {
  const map = new Map();
  for (const a of ctx.allocations) map.set(a.personId, [...(map.get(a.personId) ?? []), ctx.eventTeams.find((t) => t.teamId === a.teamId)?.name ?? '']);
  for (const [k, v] of map) if (v.length < 2) map.delete(k);
  return map;
}

// ---------- Quadrante ----------

export function renderBoard(ctx) {
  const { event, eventTeams, allocations, people, editable } = ctx;
  const multi = multiTeamMap(ctx);
  const distinct = new Set(allocations.map((a) => a.personId)).size;

  const memberRow = (a, team) => {
    const person = people.get(a.personId);
    const others = (multi.get(a.personId) ?? []).filter((name) => name !== team.name);
    return h(
      'li',
      { class: ['q-member', a.role === 'coordenador' && 'q-member--coord'] },
      avatar(person ?? { name: '?' }, 'xs'),
      h('a', { class: 'q-member__name', href: `#/pessoas/${a.personId}` }, person?.name ?? 'Ficha removida'),
      others.length ? h('span', { class: 'q-member__flag', title: `Também em ${others.join(', ')}` }, icon('alert', { size: 14, label: `Também em ${others.join(', ')}` })) : null,
      editable && h('button', { type: 'button', class: 'q-member__menu', 'aria-label': `Opções para ${person?.name ?? 'pessoa'}`, onclick: () => memberMenu(ctx, a, team) }, icon('more', { size: 16 })),
    );
  };

  const column = (team) => {
    const members = allocations.filter((a) => a.teamId === team.teamId).sort(byRoleThenName(people));
    const coords = members.filter((a) => a.role === 'coordenador');
    const others = members.filter((a) => a.role !== 'coordenador');
    const target = team.targetSize;
    const ratio = target ? Math.min(1, members.length / target) : 0;
    return h(
      'section',
      { class: 'q-col', style: { '--team': team.color }, dataset: { team: team.teamId } },
      h(
        'header',
        { class: 'q-col__head' },
        h('span', { class: 'q-col__icon' }, icon(team.icon, { size: 18 })),
        h('h3', { class: 'q-col__name' }, team.name),
        h('span', { class: ['q-col__count', target && members.length > target && 'is-over'], title: target ? `Meta de ${target} pessoas` : 'Sem meta definida' }, target ? `${members.length}/${target}` : String(members.length)),
        editable && h('button', { type: 'button', class: 'q-col__menu', 'aria-label': `Opções da equipe ${team.name}`, onclick: () => teamMenu(ctx, team, members.length) }, icon('more', { size: 16 })),
      ),
      target ? h('span', { class: 'q-meter', 'aria-hidden': 'true' }, h('span', { class: 'q-meter__fill', style: { '--fill': String(ratio) } })) : null,
      h('p', { class: 'q-label' }, 'Coordenação'),
      coords.length ? h('ul', { class: 'q-list' }, coords.map((a) => memberRow(a, team))) : h('p', { class: 'q-empty' }, 'Sem coordenação'),
      h('p', { class: 'q-label' }, 'Integrantes'),
      others.length ? h('ul', { class: 'q-list' }, others.map((a) => memberRow(a, team))) : h('p', { class: 'q-empty' }, 'Ninguém ainda'),
      editable && button('Montar equipe', { small: true, icon: 'spark', className: 'q-col__cta', onClick: () => openComposer(ctx, team) }),
    );
  };

  return h(
    'div',
    { class: 'quadrante' },
    h('div', { class: 'print-head' }, h('p', { class: 'print-head__eyebrow' }, 'Quadrante'), h('h2', { class: 'print-head__title' }, event.name), h('p', null, [fmtRange(event.startDate, event.endDate), event.location].filter(Boolean).join(' · '))),
    h(
      'div',
      { class: 'q-toolbar' },
      h('p', { class: 'q-toolbar__stats' }, `${plural(eventTeams.length, 'equipe', 'equipes')} · ${plural(distinct, 'pessoa', 'pessoas')}`, multi.size ? h('span', { class: 'q-toolbar__warn' }, icon('alert', { size: 14 }), `${plural(multi.size, 'pessoa está', 'pessoas estão')} em mais de uma equipe`) : null),
      editable && button('Adicionar equipes', { variant: 'primary', icon: 'plus', small: true, onClick: () => addTeamsDialog(ctx) }),
    ),
    eventTeams.length ? h('div', { class: 'q-grid' }, eventTeams.map(column)) : emptyState({ icon: 'teams', title: 'Nenhuma equipe neste encontro', text: editable ? 'Adicione as equipes que vão servir. Cada uma ganha a própria composição neste encontro.' : 'Este encontro não teve equipes.', action: editable && button('Adicionar equipes', { variant: 'primary', icon: 'plus', onClick: () => addTeamsDialog(ctx) }) }),
  );
}

async function act(work, message) {
  try {
    const result = await work();
    if (message) toast(typeof message === 'function' ? message(result) : message);
    refresh();
    return result;
  } catch (error) {
    toastError(error);
    return undefined;
  }
}

function addTeamsDialog(ctx) {
  const inEvent = new Set(ctx.eventTeams.map((t) => t.teamId));
  const available = ctx.teamList.filter((t) => t.status === 'ativa' && !inEvent.has(t.id)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (!available.length) {
    openModal({ title: 'Adicionar equipes', size: 'sm', body: h('p', { class: 'modal__text' }, ctx.teamList.length ? 'Todas as equipes ativas já estão neste encontro.' : 'Nenhuma equipe cadastrada ainda.'), actions: [{ label: 'Entendi', variant: 'ghost' }, ...(ctx.teamList.length ? [] : [{ label: 'Cadastrar equipes', variant: 'primary', onClick: () => (location.hash = '#/equipes') }])] });
    return;
  }
  const list = h(
    'ul',
    { class: 'check-list' },
    available.map((t) => {
      const coords = currentCoordinators(t).length;
      return h('li', null, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', value: t.id, name: 'team' }), teamChip(t), h('small', { class: 'muted' }, coords ? plural(coords, 'coordenador', 'coordenadores') : 'sem coordenação')));
    }),
  );
  const withCoords = h('input', { type: 'checkbox', checked: true });
  openModal({
    title: 'Adicionar equipes ao encontro',
    lead: 'A composição de cada equipe neste encontro é independente das outras edições.',
    body: h('div', { class: 'stack' }, h('div', { class: 'row-actions' }, button('Marcar todas', { small: true, variant: 'ghost', onClick: () => list.querySelectorAll('input').forEach((i) => (i.checked = true)) })), list, h('label', { class: 'check-row check-row--plain' }, withCoords, h('span', null, 'Já incluir a coordenação atual de cada equipe'))),
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Adicionar',
        variant: 'primary',
        id: 'add-teams',
        onClick: async (modal) => {
          const ids = [...list.querySelectorAll('input:checked')].map((i) => i.value);
          if (!ids.length) {
            modal.setError('Marque pelo menos uma equipe.');
            return false;
          }
          let coordinators = 0;
          for (const teamId of ids) coordinators += (await addTeamToEvent(ctx.event.id, teamId, { includeCoordinators: withCoords.checked })).coordinators;
          toast(`${plural(ids.length, 'equipe adicionada', 'equipes adicionadas')}${coordinators ? ` com ${plural(coordinators, 'coordenador', 'coordenadores')}` : ''}.`);
          refresh();
        },
      },
    ],
  });
}

function teamMenu(ctx, team, memberCount) {
  const modal = openModal({
    title: team.name,
    size: 'sm',
    className: 'sheet',
    body: h(
      'div',
      { class: 'menu-list' },
      button('Montar equipe', { icon: 'spark', onClick: () => (modal.close(), openComposer(ctx, team)) }),
      button('Meta de pessoas neste encontro', { icon: 'people', onClick: () => (modal.close(), targetDialog(team)) }),
      button('Remover do encontro', {
        icon: 'trash',
        variant: 'danger',
        onClick: async () => {
          modal.close();
          const ok = await confirmDialog({ title: `Remover ${team.name}?`, message: memberCount ? `${plural(memberCount, 'pessoa sai', 'pessoas saem')} da distribuição deste encontro. O cadastro da equipe não muda.` : 'A equipe sai deste encontro. O cadastro dela não muda.', confirmLabel: 'Remover', danger: true });
          if (ok) act(() => removeTeamFromEvent(team.id), `${team.name} removida do encontro.`);
        },
      }),
    ),
  });
}

function targetDialog(team) {
  const form = h('form', { class: 'form', novalidate: true }, field({ label: 'Quantidade desejada', name: 'target', type: 'number', value: team.targetSize ?? '', attrs: { min: '1', max: '500', inputmode: 'numeric' }, hint: 'Deixe vazio para não ter meta.' }));
  openModal({
    title: `Meta de ${team.name}`,
    size: 'sm',
    body: form,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Salvar meta',
        variant: 'primary',
        onClick: async () => {
          const raw = readForm(form).target;
          const value = raw === '' ? null : Number(raw);
          if (value !== null && (!Number.isInteger(value) || value < 1 || value > 500)) {
            showErrors(form, { target: 'Use um número entre 1 e 500.' });
            return false;
          }
          await setEventTeamTarget(team.id, value);
          toast('Meta salva.');
          refresh();
        },
      },
    ],
  });
}

function memberMenu(ctx, allocation, team) {
  const person = ctx.people.get(allocation.personId);
  const coordinator = allocation.role === 'coordenador';
  const modal = openModal({
    title: person?.name ?? 'Pessoa',
    lead: `${ROLES[allocation.role]} em ${team.name}`,
    size: 'sm',
    className: 'sheet',
    body: h(
      'div',
      { class: 'menu-list' },
      button(coordinator ? 'Passar para integrante' : 'Passar para coordenação', { icon: 'star', onClick: () => (modal.close(), act(() => setRole(allocation.id, coordinator ? 'integrante' : 'coordenador'), coordinator ? 'Agora é integrante.' : 'Agora está na coordenação.')) }),
      button('Substituir por outra pessoa', {
        icon: 'swap',
        onClick: async () => {
          modal.close();
          const inTeam = ctx.allocations.filter((a) => a.teamId === team.teamId).map((a) => a.personId);
          const ids = await pickPeople({ title: `Quem entra no lugar de ${person?.name ?? 'esta pessoa'}?`, lead: `Mesma função: ${ROLES[allocation.role].toLowerCase()}.`, excludeIds: inTeam });
          if (ids?.[0]) act(() => replacePerson(allocation.id, ids[0]), 'Substituição feita.');
        },
      }),
      button('Ver ficha', { icon: 'people', onClick: () => (modal.close(), (location.hash = `#/pessoas/${allocation.personId}`)) }),
      button('Remover da equipe', {
        icon: 'trash',
        variant: 'danger',
        onClick: async () => {
          modal.close();
          const ok = await confirmDialog({ title: `Remover ${person?.name ?? 'esta pessoa'}?`, message: `Sai de ${team.name} neste encontro. A ficha e o histórico não mudam.`, confirmLabel: 'Remover', danger: true });
          if (ok) act(() => removeAllocation(allocation.id), `${person?.name ?? 'Pessoa'} removida de ${team.name}.`);
        },
      }),
    ),
  });
}

// ---------- Montar equipe (com o assistente) ----------

function openComposer(ctx, team) {
  const filters = { query: '', skill: '', onlyAvailable: false, hideAllocated: false, limit: 30 };
  const names = optionNames(ctx.catalog);
  const teamRecord = ctx.teams.get(team.teamId);
  const requirements = ctx.requirements.filter((r) => r.teamId === team.teamId);
  let changed = false;

  const membersBox = h('div', { class: 'composer__members' });
  const candidatesBox = h('div', { class: 'composer__candidates' });
  const header = h('p', { class: 'composer__count' });

  const members = () => ctx.allocations.filter((a) => a.teamId === team.teamId).sort(byRoleThenName(ctx.people));

  const paintMembers = () => {
    const list = members();
    header.textContent = team.targetSize ? `${list.length} de ${team.targetSize} pessoas` : plural(list.length, 'pessoa', 'pessoas');
    membersBox.replaceChildren(
      h('h3', { class: 'composer__title' }, 'Na equipe'),
      list.length
        ? h(
            'ul',
            { class: 'composer-list' },
            list.map((a) => {
              const p = ctx.people.get(a.personId);
              return h(
                'li',
                { class: 'composer-row' },
                avatar(p ?? { name: '?' }, 'sm'),
                h('span', { class: 'composer-row__name' }, p?.name ?? 'Ficha removida', a.role === 'coordenador' ? badge('Coordenação', 'gold') : null),
                button('', { small: true, variant: 'ghost', icon: 'star', title: a.role === 'coordenador' ? 'Passar para integrante' : 'Passar para coordenação', onClick: () => mutate(() => setRole(a.id, a.role === 'coordenador' ? 'integrante' : 'coordenador'), () => (a.role = a.role === 'coordenador' ? 'integrante' : 'coordenador')) }),
                button('', { small: true, variant: 'ghost', icon: 'x', title: `Remover ${p?.name ?? ''}`, onClick: () => mutate(() => removeAllocation(a.id), () => ctx.allocations.splice(ctx.allocations.indexOf(a), 1)) }),
              );
            }),
          )
        : h('p', { class: 'muted' }, 'Ninguém ainda. Use as sugestões ao lado.'),
    );
  };

  const paintCandidates = () => {
    const ranked = rankCandidates({
      teamId: team.teamId,
      requirements,
      referenceMemberIds: teamRecord?.referenceMemberIds ?? [],
      people: ctx.peopleList,
      stats: ctx.stats,
      eventAllocations: ctx.allocations,
      teamNames: new Map(ctx.eventTeams.map((t) => [t.teamId, t.name])),
      names,
      weights: setting('weights'),
    }).filter((c) => (!filters.skill || c.person.skillIds.includes(filters.skill)) && (!filters.onlyAvailable || c.person.availabilityStatus === 'disponivel') && (!filters.hideAllocated || !c.otherTeams.length) && matchesQuery(`${c.person.name} ${c.person.phone}`, filters.query));
    const shown = ranked.slice(0, filters.limit);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((c) =>
            h(
              'li',
              { class: 'cand' },
              avatar(c.person, 'sm'),
              h(
                'div',
                { class: 'cand__body' },
                h(
                  'div',
                  { class: 'cand__top' },
                  h('span', { class: 'cand__name' }, c.person.name),
                  h('span', { class: ['score', c.score >= 70 ? 'score--high' : c.score >= 45 ? 'score--mid' : 'score--low'], title: 'Compatibilidade calculada pelo assistente' }, `${c.score}%`),
                  ctx.stats.get(c.person.id)?.events.size ? h('span', { class: 'cand__exp' }, plural(ctx.stats.get(c.person.id).events.size, 'encontro servido', 'encontros servidos')) : null,
                ),
                h('ul', { class: 'reasons' }, c.reasons.slice(0, 4).map((r) => h('li', { class: `reason reason--${r.kind}` }, icon(r.kind === 'plus' ? 'check' : r.kind === 'minus' ? 'alert' : 'info', { size: 13 }), r.text))),
                c.reasons.length > 4 ? h('details', { class: 'reasons-more' }, h('summary', null, `Mais ${c.reasons.length - 4} motivos`), h('ul', { class: 'reasons' }, c.reasons.slice(4).map((r) => h('li', { class: `reason reason--${r.kind}` }, r.text)))) : null,
              ),
              h('div', { class: 'cand__actions' }, button('Integrante', { small: true, icon: 'plus', onClick: () => add(c.person, 'integrante') }), button('Coordenação', { small: true, variant: 'ghost', onClick: () => add(c.person, 'coordenador') })),
            ),
          )
        : [h('li', { class: 'muted pick-empty' }, ctx.peopleList.some((p) => p.status === 'ativo') ? 'Ninguém com esses filtros.' : 'Nenhuma pessoa ativa cadastrada.')]),
      ranked.length > shown.length ? h('li', null, button(`Mostrar mais (${ranked.length - shown.length})`, { variant: 'ghost', small: true, onClick: () => ((filters.limit += 30), paintCandidates()) })) : null,
    );
  };

  const list = h('ul', { class: 'cand-list' });
  const skillOptions = ctx.catalog.skills.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name, group: ctx.catalog.categoriesById.get(s.categoryId)?.name ?? 'Outras' }));
  candidatesBox.append(
    h('h3', { class: 'composer__title' }, icon('spark', { size: 16 }), 'Sugestões do assistente'),
    h('p', { class: 'muted composer__hint' }, requirements.length ? 'Ordenadas pela compatibilidade com os requisitos da equipe, experiência, preferências e disponibilidade. A decisão é sua.' : 'A equipe não tem requisitos cadastrados: as sugestões usam experiência, preferências e disponibilidade.'),
    filterBar(
      searchBox({ placeholder: 'Buscar pessoa', onInput: (v) => ((filters.query = v), paintCandidates()) }),
      selectBox({ label: 'Habilidade', value: '', options: withAll('Todas', skillOptions), onChange: (v) => ((filters.skill = v), paintCandidates()) }),
      toggle({ label: 'Só disponíveis', onChange: (v) => ((filters.onlyAvailable = v), paintCandidates()) }),
      toggle({ label: 'Esconder quem já está em outra equipe', onChange: (v) => ((filters.hideAllocated = v), paintCandidates()) }),
    ),
    list,
  );

  async function mutate(work, applyLocally) {
    try {
      await work();
      applyLocally();
      changed = true;
      paintMembers();
      paintCandidates();
    } catch (error) {
      toastError(error);
    }
  }

  async function add(person, role) {
    try {
      const { allocation, otherTeams } = await addPerson({ eventId: ctx.event.id, teamId: team.teamId, personId: person.id, role });
      ctx.allocations.push(allocation);
      changed = true;
      toast(otherTeams.length ? `${person.name} entrou. Atenção: também está em ${otherTeams.join(', ')} neste encontro.` : `${person.name} entrou em ${team.name}.`, { type: otherTeams.length ? 'warn' : 'ok' });
      paintMembers();
      paintCandidates();
    } catch (error) {
      toastError(error);
    }
  }

  openModal({
    title: h('span', { class: 'composer__heading', style: { '--team': team.color } }, teamChip(team), ' Montar equipe'),
    size: 'full',
    className: 'composer',
    body: h('div', { class: 'composer__grid', style: { '--team': team.color } }, h('div', null, header, membersBox), candidatesBox),
    onClose: () => changed && refresh(),
    actions: [{ label: 'Concluir', variant: 'primary', id: 'close-composer' }],
  });
  paintMembers();
  paintCandidates();
}
