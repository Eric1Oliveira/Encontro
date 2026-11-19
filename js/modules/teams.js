// Equipes: cadastro permanente, coordenação (com histórico de trocas), requisitos e integrantes de referência.
// A composição oficial de cada encontro fica na distribuição do encontro, não aqui.
import { transaction, req, readStores, uid, nowISO, AppError } from '../database.js';
import { TEAM_COLORS, areaLabel } from '../schema.js';
import { validateTeam, normalize, clean } from '../validation.js';
import { h, button, pageHeader, emptyState, avatar, badge, teamChip, plural, fmtDate, fmtRange, todayISO, section } from '../components/ui.js';
import { icon, TEAM_ICONS } from '../components/icons.js';
import { dataTable } from '../components/tables.js';
import { searchBox, selectBox, filterBar, matchesQuery } from '../components/filters.js';
import { field, readForm, showErrors } from '../components/forms.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { navigate, refresh } from '../router.js';
import { pickPeople } from './people.js';
import { buildStats } from './history.js';
import { loadCatalog } from './skills.js';

export const WEIGHTS = [
  { value: 1, label: 'Desejável' },
  { value: 2, label: 'Importante' },
  { value: 3, label: 'Essencial' },
];

export function blankTeam() {
  return { id: null, name: '', description: '', goal: '', color: TEAM_COLORS[0], icon: 'teams', status: 'ativa', targetSize: null, notes: '', coordinators: [], referenceMemberIds: [] };
}

export const currentCoordinators = (team) => team.coordinators.filter((c) => !c.until);

// ---------- Escrita ----------

export async function saveTeam(input) {
  const data = { ...input, name: clean(input.name) };
  const errors = validateTeam(data);
  if (Object.keys(errors).length) throw Object.assign(new AppError('invalid', 'Confira os campos destacados.'), { fields: errors });
  return transaction(['teams', 'eventTeams', 'events'], 'readwrite', async (s) => {
    const all = await req(s.teams.getAll());
    if (all.some((t) => t.id !== data.id && t.nameKey === normalize(data.name))) throw Object.assign(new AppError('duplicate', 'Já existe uma equipe com esse nome.'), { fields: { name: 'Já existe uma equipe com esse nome.' } });
    const before = data.id ? all.find((t) => t.id === data.id) : null;
    if (data.id && !before) throw new AppError('not_found', 'Equipe não encontrada.');
    const now = nowISO();
    const record = { ...blankTeam(), ...before, ...data, id: before?.id ?? uid(), nameKey: normalize(data.name), createdAt: before?.createdAt ?? now, updatedAt: now };
    s.teams.put(record);
    // Encontros ainda não realizados acompanham o novo nome/cor. Concluídos e reabertos ficam como estavam.
    if (before) {
      for (const et of await req(s.eventTeams.index('teamId').getAll(record.id))) {
        const event = await req(s.events.get(et.eventId));
        if (event && ['planejamento', 'em_andamento'].includes(event.status)) s.eventTeams.put({ ...et, name: record.name, color: record.color, icon: record.icon });
      }
    }
    return { record, created: !before };
  });
}

async function updateTeam(id, change) {
  return transaction(['teams', 'people'], 'readwrite', async (s) => {
    const team = await req(s.teams.get(id));
    if (!team) throw new AppError('not_found', 'Equipe não encontrada.');
    const next = await change(team, s);
    s.teams.put({ ...next, updatedAt: nowISO() });
    return next;
  });
}

export const setTeamStatus = (id, status) => updateTeam(id, (t) => ({ ...t, status }));

export function addCoordinator(teamId, personId) {
  return updateTeam(teamId, async (team, s) => {
    const person = await req(s.people.get(personId));
    if (!person) throw new AppError('not_found', 'Pessoa não encontrada.');
    if (currentCoordinators(team).some((c) => c.personId === personId)) throw new AppError('duplicate', `${person.name} já coordena esta equipe.`);
    return { ...team, coordinators: [...team.coordinators, { personId, since: todayISO(), until: null }] };
  });
}

export function endCoordinator(teamId, personId) {
  return updateTeam(teamId, (team) => ({ ...team, coordinators: team.coordinators.map((c) => (c.personId === personId && !c.until ? { ...c, until: todayISO() } : c)) }));
}

/** Troca na mesma gravação: um sai, outro entra. */
export function swapCoordinator(teamId, outgoingId, incomingId) {
  return updateTeam(teamId, async (team, s) => {
    const person = await req(s.people.get(incomingId));
    if (!person) throw new AppError('not_found', 'Pessoa não encontrada.');
    if (currentCoordinators(team).some((c) => c.personId === incomingId)) throw new AppError('duplicate', `${person.name} já coordena esta equipe.`);
    const today = todayISO();
    return { ...team, coordinators: [...team.coordinators.map((c) => (c.personId === outgoingId && !c.until ? { ...c, until: today } : c)), { personId: incomingId, since: today, until: null }] };
  });
}

export const saveReferenceMembers = (teamId, ids) => updateTeam(teamId, (team) => ({ ...team, referenceMemberIds: [...new Set(ids)] }));

export async function saveRequirements(teamId, list) {
  return transaction(['teamRequirements', 'teams'], 'readwrite', async (s) => {
    if (!(await req(s.teams.get(teamId)))) throw new AppError('not_found', 'Equipe não encontrada.');
    for (const old of await req(s.teamRequirements.index('teamId').getAll(teamId))) s.teamRequirements.delete(old.id);
    const seen = new Set();
    for (const item of list) {
      const key = `${item.kind}:${item.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      s.teamRequirements.add({ id: uid(), teamId, kind: item.kind, refId: item.refId, weight: Number(item.weight) || 1 });
    }
  });
}

export async function teamUsage(id) {
  return transaction(['eventTeams', 'participationHistory'], 'readonly', async (s) => ({
    events: await req(s.eventTeams.index('teamId').count(id)),
    history: await req(s.participationHistory.index('teamId').count(id)),
  }));
}

/** Só equipes que nunca foram usadas em encontros podem ser apagadas. As demais são desativadas. */
export async function deleteTeam(id) {
  return transaction(['teams', 'teamRequirements', 'eventTeams', 'participationHistory', 'people'], 'readwrite', async (s) => {
    const used = (await req(s.eventTeams.index('teamId').count(id))) + (await req(s.participationHistory.index('teamId').count(id)));
    if (used) throw new AppError('in_use', 'Esta equipe já participou de encontros. Desative-a para tirá-la das escolhas sem perder o histórico.');
    for (const r of await req(s.teamRequirements.index('teamId').getAll(id))) s.teamRequirements.delete(r.id);
    const now = nowISO();
    for (const p of await req(s.people.getAll())) {
      if (p.preferredTeamIds.includes(id) || p.avoidTeamIds.includes(id)) s.people.put({ ...p, preferredTeamIds: p.preferredTeamIds.filter((x) => x !== id), avoidTeamIds: p.avoidTeamIds.filter((x) => x !== id), updatedAt: now });
    }
    s.teams.delete(id);
  });
}

// ---------- Formulário ----------

export function teamDialog(team = blankTeam()) {
  let color = team.color;
  let iconName = team.icon;
  const preview = h('div', { class: 'team-preview' });
  const paintPreview = () => {
    const name = form.querySelector('[name=name]').value || 'Nome da equipe';
    preview.replaceChildren(teamChip({ name, color, icon: iconName }));
    preview.style.setProperty('--team', color);
  };
  const swatches = h(
    'div',
    { class: 'swatches', role: 'radiogroup', 'aria-label': 'Cor da equipe' },
    [...new Set([...TEAM_COLORS, color])].map((c) => h('button', { type: 'button', class: ['swatch', c === color && 'is-selected'], role: 'radio', 'aria-checked': c === color ? 'true' : 'false', 'aria-label': `Cor ${c}`, style: { '--swatch': c }, dataset: { color: c } })),
    h('label', { class: 'swatch swatch--custom', title: 'Outra cor' }, icon('plus', { size: 16 }), h('input', { type: 'color', value: color, 'aria-label': 'Escolher outra cor' })),
  );
  swatches.addEventListener('click', (event) => {
    const btn = event.target instanceof Element && event.target.closest('[data-color]');
    if (!btn) return;
    color = btn.getAttribute('data-color');
    paintSwatches();
  });
  swatches.querySelector('input[type=color]').addEventListener('input', (event) => {
    color = event.target.value;
    paintSwatches();
  });
  const paintSwatches = () => {
    for (const b of swatches.querySelectorAll('[data-color]')) {
      const on = b.getAttribute('data-color') === color;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    paintPreview();
  };
  const icons = h(
    'div',
    { class: 'icon-picker', role: 'radiogroup', 'aria-label': 'Ícone da equipe' },
    TEAM_ICONS.map((name) => h('button', { type: 'button', class: ['icon-pick', name === iconName && 'is-selected'], role: 'radio', 'aria-checked': name === iconName ? 'true' : 'false', 'aria-label': `Ícone ${name}`, dataset: { icon: name } }, icon(name, { size: 20 }))),
  );
  icons.addEventListener('click', (event) => {
    const btn = event.target instanceof Element && event.target.closest('[data-icon]');
    if (!btn) return;
    iconName = btn.getAttribute('data-icon');
    for (const b of icons.querySelectorAll('[data-icon]')) {
      const on = b.getAttribute('data-icon') === iconName;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    paintPreview();
  });

  const form = h(
    'form',
    { class: 'form-grid', novalidate: true },
    field({ label: 'Nome da equipe', name: 'name', value: team.name, required: true, attrs: { maxlength: '60' } }),
    field({ label: 'Quantidade desejada de pessoas', name: 'targetSize', type: 'number', value: team.targetSize ?? '', attrs: { min: '1', max: '500', inputmode: 'numeric' }, hint: 'Usada para mostrar quanto falta em cada encontro.' }),
    h('div', { class: 'field field--wide', dataset: { field: 'color' } }, h('span', { class: 'field__label' }, 'Cor de identificação'), swatches, h('p', { class: 'field__error', hidden: true })),
    h('div', { class: 'field field--wide' }, h('span', { class: 'field__label' }, 'Ícone'), icons),
    h('div', { class: 'field field--wide' }, h('span', { class: 'field__label' }, 'Como vai aparecer'), preview),
    field({ label: 'Objetivo', name: 'goal', type: 'textarea', value: team.goal, wide: true, rows: 2, hint: 'Para que a equipe existe no encontro.' }),
    field({ label: 'Descrição', name: 'description', type: 'textarea', value: team.description, wide: true, rows: 3, hint: 'O que a equipe faz, rotina, cuidados.' }),
    field({ label: 'Observações', name: 'notes', type: 'textarea', value: team.notes, wide: true, rows: 2 }),
  );
  form.querySelector('[name=name]').addEventListener('input', paintPreview);
  paintPreview();

  openModal({
    title: team.id ? `Editar ${team.name}` : 'Nova equipe',
    size: 'lg',
    body: form,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: team.id ? 'Salvar equipe' : 'Criar equipe',
        variant: 'primary',
        id: 'save-team',
        onClick: async () => {
          const values = readForm(form);
          const target = values.targetSize === '' ? null : Number(values.targetSize);
          try {
            const { record, created } = await saveTeam({ ...team, name: values.name, goal: values.goal.trim(), description: values.description.trim(), notes: values.notes.trim(), color, icon: iconName, targetSize: target });
            toast(created ? `Equipe ${record.name} criada.` : 'Equipe salva.');
            if (created) navigate(`/equipes/${record.id}`);
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

function requirementsDialog(team, requirements, catalog) {
  const current = new Map(requirements.map((r) => [`${r.kind}:${r.refId}`, r.weight]));
  const row = (kind, option) => {
    const key = `${kind}:${option.id}`;
    const weight = h('select', { class: 'req-row__weight', 'aria-label': `Importância de ${option.name}`, disabled: !current.has(key) }, WEIGHTS.map((w) => h('option', { value: w.value, selected: (current.get(key) ?? 1) === w.value }, w.label)));
    const check = h('input', { type: 'checkbox', checked: current.has(key), dataset: { kind, ref: option.id } });
    check.addEventListener('change', () => (weight.disabled = !check.checked));
    return h('li', { class: 'req-row' }, h('label', { class: 'req-row__label' }, check, h('span', null, option.name, !option.active && h('small', { class: 'muted' }, ' (desativada)'))), weight);
  };
  const body = h(
    'div',
    { class: 'stack' },
    h('p', { class: 'muted' }, 'Os requisitos só orientam o assistente de distribuição. Ninguém é excluído por não cumpri-los.'),
    ...catalog.categories.map((c) => {
      const options = catalog.skills.filter((s) => s.categoryId === c.id && (s.active || current.has(`skill:${s.id}`)));
      return options.length ? h('fieldset', { class: 'choice-group' }, h('legend', { class: 'choice-group__title' }, c.name, h('span', { class: 'choice-group__area' }, areaLabel(c.area))), h('ul', { class: 'req-list' }, options.map((s) => row('skill', s)))) : null;
    }),
    h('fieldset', { class: 'choice-group' }, h('legend', { class: 'choice-group__title' }, 'Características relevantes'), h('ul', { class: 'req-list' }, catalog.profile.filter((c) => c.active || current.has(`characteristic:${c.id}`)).map((c) => row('characteristic', c)))),
  );
  openModal({
    title: `O que ${team.name} procura`,
    size: 'lg',
    body,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Salvar requisitos',
        variant: 'primary',
        onClick: async () => {
          const list = [...body.querySelectorAll('input[type=checkbox]:checked')].map((input) => ({ kind: input.getAttribute('data-kind'), refId: input.getAttribute('data-ref'), weight: Number(input.closest('.req-row').querySelector('select').value) }));
          await saveRequirements(team.id, list);
          toast('Requisitos salvos.');
          refresh();
        },
      },
    ],
  });
}

// ---------- Lista ----------

const listState = { query: '', status: 'ativa' };

export async function renderTeams(view) {
  const { teams, participationHistory, teamRequirements, people } = await readStores(['teams', 'participationHistory', 'teamRequirements', 'people']);
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const grid = h('div', { class: 'team-grid' });
  const count = h('p', { class: 'result-count' });
  const served = new Map();
  for (const r of participationHistory) if (r.status === 'confirmada') served.set(r.teamId, (served.get(r.teamId) ?? new Set()).add(r.eventId));

  const paint = () => {
    const rows = teams.filter((t) => (!listState.status || t.status === listState.status) && matchesQuery(`${t.name} ${t.description} ${t.goal}`, listState.query)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    count.textContent = plural(rows.length, 'equipe', 'equipes');
    if (!rows.length) {
      grid.replaceChildren(teams.length ? emptyState({ icon: 'search', title: 'Nenhuma equipe com esses filtros' }) : emptyState({ icon: 'teams', title: 'Nenhuma equipe cadastrada', text: 'Cadastre as equipes uma vez (Música, Cozinha, Liturgia…) e reaproveite em cada encontro.', action: button('Criar a primeira equipe', { variant: 'primary', icon: 'plus', onClick: () => teamDialog() }) }));
      return;
    }
    grid.replaceChildren(
      ...rows.map((t) => {
        const coords = currentCoordinators(t).map((c) => peopleById.get(c.personId)).filter(Boolean);
        const reqs = teamRequirements.filter((r) => r.teamId === t.id).length;
        return h(
          'a',
          { class: ['team-card', t.status !== 'ativa' && 'is-inactive'], href: `#/equipes/${t.id}`, style: { '--team': t.color } },
          h('span', { class: 'team-card__icon' }, icon(t.icon, { size: 22 })),
          h('span', { class: 'team-card__name' }, t.name),
          h('span', { class: 'team-card__goal' }, t.goal || t.description || 'Sem objetivo descrito.'),
          h('span', { class: 'team-card__coords' }, coords.length ? [h('span', { class: 'avatar-stack' }, coords.slice(0, 3).map((p) => avatar(p, 'xs'))), coords.length === 1 ? coords[0].name : plural(coords.length, 'coordenador', 'coordenadores')] : h('span', { class: 'muted' }, 'Sem coordenação definida')),
          h('span', { class: 'team-card__meta' }, [t.targetSize ? `${t.targetSize} pessoas` : null, reqs ? plural(reqs, 'requisito', 'requisitos') : null, served.get(t.id)?.size ? `serviu em ${plural(served.get(t.id).size, 'encontro', 'encontros')}` : 'ainda não serviu'].filter(Boolean).join(' · ')),
          t.status !== 'ativa' && badge('Inativa', 'muted'),
        );
      }),
    );
  };

  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({ eyebrow: 'Cadastro permanente', title: 'Equipes', lead: 'Cada equipe é cadastrada uma vez. Em cada encontro ela ganha a própria composição.', actions: button('Nova equipe', { variant: 'primary', icon: 'plus', onClick: () => teamDialog() }) }),
      teams.length
        ? [
            filterBar(
              searchBox({ value: listState.query, placeholder: 'Buscar equipe', onInput: (v) => ((listState.query = v), paint()) }),
              selectBox({ label: 'Situação', value: listState.status, options: [{ value: 'ativa', label: 'Ativas' }, { value: 'inativa', label: 'Inativas' }, { value: '', label: 'Todas' }], onChange: (v) => ((listState.status = v), paint()) }),
            ),
            count,
          ]
        : null,
      grid,
    ),
  );
  paint();
}

// ---------- Ficha da equipe ----------

export async function renderTeam(view, { id }) {
  const [stores, catalog] = await Promise.all([readStores(['teams', 'people', 'teamRequirements', 'participationHistory', 'eventTeams', 'events']), loadCatalog()]);
  const team = stores.teams.find((t) => t.id === id);
  if (!team) {
    view.replaceChildren(emptyState({ icon: 'teams', title: 'Equipe não encontrada', action: h('a', { class: 'btn btn--primary', href: '#/equipes' }, 'Ver equipes') }));
    return;
  }
  const people = new Map(stores.people.map((p) => [p.id, p]));
  const requirements = stores.teamRequirements.filter((r) => r.teamId === id);
  const history = stores.participationHistory.filter((r) => r.teamId === id);
  const stats = buildStats(history);
  const run = async (work, message) => {
    try {
      await work();
      toast(message);
      refresh();
    } catch (error) {
      toastError(error);
    }
  };

  const coords = currentCoordinators(team);
  const coordination = section(
    'Coordenação atual',
    {
      lead: 'Sem limite de coordenadores. Ao adicionar a equipe a um encontro, eles já entram como coordenação.',
      actions: button('Adicionar', {
        icon: 'plus',
        small: true,
        onClick: async () => {
          const ids = await pickPeople({ title: 'Adicionar coordenação', multiple: true, excludeIds: coords.map((c) => c.personId), confirmLabel: 'Adicionar' });
          if (!ids?.length) return;
          run(async () => {
            for (const personId of ids) await addCoordinator(id, personId);
          }, ids.length === 1 ? 'Coordenador adicionado.' : 'Coordenadores adicionados.');
        },
      }),
    },
    coords.length
      ? h(
          'ul',
          { class: 'person-list' },
          coords.map((c) => {
            const p = people.get(c.personId);
            return h(
              'li',
              { class: 'person-line' },
              avatar(p ?? { name: '?' }, 'md'),
              h('span', { class: 'person-line__text' }, h('a', { href: `#/pessoas/${c.personId}` }, p?.name ?? 'Ficha removida'), h('small', null, `Desde ${fmtDate(c.since)}`, p?.status === 'arquivado' ? ' · ficha arquivada' : '')),
              h(
                'span',
                { class: 'person-line__actions' },
                button('Trocar', {
                  small: true,
                  icon: 'swap',
                  onClick: async () => {
                    const ids = await pickPeople({ title: `Quem assume no lugar de ${p?.name ?? 'esta pessoa'}?`, excludeIds: coords.map((x) => x.personId) });
                    if (ids?.[0]) run(() => swapCoordinator(id, c.personId, ids[0]), 'Coordenação trocada. A troca fica no histórico.');
                  },
                }),
                button('', { small: true, variant: 'ghost', icon: 'x', title: `Encerrar coordenação de ${p?.name ?? ''}`, onClick: async () => (await confirmDialog({ title: 'Encerrar coordenação?', message: `${p?.name ?? 'Esta pessoa'} deixa a coordenação hoje. O período fica registrado no histórico de coordenação.`, confirmLabel: 'Encerrar' })) && run(() => endCoordinator(id, c.personId), 'Coordenação encerrada.') }),
              ),
            );
          }),
        )
      : h('p', { class: 'muted' }, 'Ninguém coordena esta equipe no cadastro.'),
  );

  const reqsBySkill = requirements.filter((r) => r.kind === 'skill');
  const reqsByTrait = requirements.filter((r) => r.kind === 'characteristic');
  const reqTags = (list, map) => h('div', { class: 'tags' }, list.sort((a, b) => b.weight - a.weight).map((r) => h('span', { class: ['tag', `tag--w${r.weight}`] }, map.get(r.refId)?.name ?? 'Opção removida', h('small', null, ` · ${WEIGHTS.find((w) => w.value === r.weight)?.label.toLowerCase()}`))));
  const requirementsPanel = section(
    'O que a equipe procura',
    { lead: 'Orienta o assistente de distribuição. Não exclui ninguém.', actions: button('Editar', { icon: 'edit', small: true, onClick: () => requirementsDialog(team, requirements, catalog) }) },
    requirements.length
      ? h('div', { class: 'stack-sm' }, reqsBySkill.length ? [h('p', { class: 'mini-label' }, 'Habilidades desejáveis'), reqTags(reqsBySkill, catalog.skillsById)] : null, reqsByTrait.length ? [h('p', { class: 'mini-label' }, 'Características relevantes'), reqTags(reqsByTrait, catalog.characteristicsById)] : null)
      : h('p', { class: 'muted' }, 'Sem requisitos. O assistente vai considerar experiência, preferências e disponibilidade.'),
  );

  const refs = team.referenceMemberIds.map((pid) => people.get(pid)).filter(Boolean);
  const referencePanel = section(
    'Integrantes de referência',
    {
      lead: 'Pessoas que costumam fazer parte desta equipe. Ganham prioridade nas sugestões; a escala oficial é feita em cada encontro.',
      actions: button('Editar', {
        icon: 'edit',
        small: true,
        onClick: async () => {
          const ids = await pickPeople({ title: 'Integrantes de referência', multiple: true, selected: team.referenceMemberIds, confirmLabel: 'Salvar lista' });
          if (ids) run(() => saveReferenceMembers(id, ids), 'Integrantes de referência salvos.');
        },
      }),
    },
    refs.length ? h('div', { class: 'people-chips' }, refs.map((p) => h('a', { class: 'person-chip', href: `#/pessoas/${p.id}` }, avatar(p, 'xs'), p.name))) : h('p', { class: 'muted' }, 'Nenhum integrante de referência.'),
  );

  const eventCoordinations = history.filter((r) => r.role === 'coordenador' && r.status === 'confirmada').sort((a, b) => (b.eventStart ?? '').localeCompare(a.eventStart ?? ''));
  const coordHistory = section(
    'Histórico de coordenação',
    null,
    team.coordinators.length || eventCoordinations.length
      ? h(
          'div',
          { class: 'two-col' },
          h('div', null, h('p', { class: 'mini-label' }, 'No cadastro da equipe'), team.coordinators.length ? h('ul', { class: 'plain-list' }, [...team.coordinators].reverse().map((c) => h('li', null, h('strong', null, people.get(c.personId)?.name ?? 'Ficha removida'), ` · ${fmtDate(c.since)} – ${c.until ? fmtDate(c.until) : 'atual'}`))) : h('p', { class: 'muted' }, '—')),
          h('div', null, h('p', { class: 'mini-label' }, 'Nos encontros concluídos'), eventCoordinations.length ? h('ul', { class: 'plain-list' }, eventCoordinations.map((r) => h('li', null, h('strong', null, people.get(r.personId)?.name ?? r.personName), ` · ${r.eventName} (${fmtRange(r.eventStart, r.eventEnd)})`))) : h('p', { class: 'muted' }, '—')),
        )
      : h('p', { class: 'muted' }, 'Nenhuma coordenação registrada ainda.'),
  );

  const servedRows = [...stats.entries()].map(([personId, s]) => ({ personId, person: people.get(personId), count: s.byTeam.get(id)?.count ?? 0, coordinations: s.byTeam.get(id)?.coordinations ?? 0, name: people.get(personId)?.name ?? s.records[0]?.personName }));
  const servedPanel = section(
    'Quem já serviu nesta equipe',
    { lead: servedRows.length ? `${plural(servedRows.length, 'pessoa', 'pessoas')} em ${plural(new Set(history.filter((r) => r.status === 'confirmada').map((r) => r.eventId)).size, 'encontro', 'encontros')}` : null },
    servedRows.length
      ? dataTable({
          rows: servedRows,
          sortKey: 'count',
          sortDir: 'desc',
          onRowClick: (r) => r.person && navigate(`/pessoas/${r.personId}`),
          columns: [
            { key: 'name', label: 'Pessoa', primary: true, sortValue: (r) => r.name, render: (r) => h('span', { class: 'cell-person' }, avatar(r.person ?? { name: r.name }, 'sm'), r.name) },
            { key: 'count', label: 'Participações', align: 'end', defaultDir: 'desc', sortValue: (r) => r.count, render: (r) => h('span', { class: 'num' }, r.count) },
            { key: 'coordinations', label: 'Coordenou', align: 'end', defaultDir: 'desc', sortValue: (r) => r.coordinations, render: (r) => (r.coordinations ? badge(plural(r.coordinations, 'vez', 'vezes'), 'gold') : '—') },
          ],
        })
      : h('p', { class: 'muted' }, 'Ninguém serviu nesta equipe em encontros concluídos ainda.'),
  );

  const usedIn = stores.eventTeams.filter((et) => et.teamId === id).length;
  view.replaceChildren(
    h(
      'div',
      { class: 'page team-page', style: { '--team': team.color } },
      pageHeader({
        back: { href: '/equipes', label: 'Equipes' },
        eyebrow: team.status === 'ativa' ? `Equipe${team.targetSize ? ` · ${team.targetSize} pessoas desejadas` : ''}` : 'Equipe inativa',
        title: h('span', { class: 'team-title' }, h('span', { class: 'team-title__icon' }, icon(team.icon, { size: 26 })), team.name),
        lead: team.goal || null,
        actions: [
          button('Editar', { icon: 'edit', onClick: () => teamDialog(team) }),
          button(team.status === 'ativa' ? 'Desativar' : 'Reativar', { variant: 'ghost', onClick: () => run(() => setTeamStatus(id, team.status === 'ativa' ? 'inativa' : 'ativa'), team.status === 'ativa' ? 'Equipe desativada. Ela não aparece mais para novos encontros.' : 'Equipe reativada.') }),
          !usedIn && !history.length && button('Excluir', { variant: 'ghost', icon: 'trash', onClick: async () => (await confirmDialog({ title: `Excluir ${team.name}?`, message: 'A equipe nunca foi usada em encontros e será apagada, junto com os requisitos.', confirmLabel: 'Excluir', danger: true })) && deleteTeam(id).then(() => (toast('Equipe excluída.'), navigate('/equipes')), toastError) }),
        ],
      }),
      team.description || team.notes ? section('Sobre a equipe', null, team.description && h('p', { class: 'prose' }, team.description), team.notes && h('p', { class: 'prose muted' }, team.notes)) : null,
      h('div', { class: 'two-col two-col--panels' }, coordination, requirementsPanel),
      referencePanel,
      coordHistory,
      servedPanel,
    ),
  );
}
