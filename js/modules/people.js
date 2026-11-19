// Pessoas: cadastro permanente, foto, classificações, preferências e histórico (somente leitura).
import { transaction, req, readStores, uid, nowISO, AppError } from '../database.js';
import { AVAILABILITY_STATUS, EVENT_STATUS, ROLES, areaLabel } from '../schema.js';
import { validatePerson, validatePastService, ageOf, normalize, clean, formatPhone, normalizeInstagram, digits } from '../validation.js';
import { h, button, pageHeader, emptyState, avatar, badge, teamChip, plural, fmtRange, fmtDate, forgetPhoto, photoUrl, section, todayISO, downloadFile, stamp } from '../components/ui.js';
import { icon } from '../components/icons.js';
import { dataTable } from '../components/tables.js';
import { searchBox, selectBox, collapsibleFilters, withAll, matchesQuery } from '../components/filters.js';
import { field, chipGroup, checkedValues, segmented, readForm, showErrors, trackDirty, markSaved } from '../components/forms.js';
import { openModal, confirmDialog, choiceDialog } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { navigate, refresh } from '../router.js';
import { requestPersistence } from '../notifications.js';
import { buildStats, emptyStats, personTimeline, pastRecords, PAST_COLOR } from './history.js';
import { loadCatalog, quickAddOption } from './skills.js';
import { toXLSX } from './reports.js';

// ---------- Dados ----------

export function blankPerson() {
  return { id: null, name: '', birthDate: '', phone: '', email: '', instagram: '', notes: '', photoId: null, skillIds: [], characteristicIds: [], pastoralIds: [], preferredTeamIds: [], avoidTeamIds: [], availabilityIds: [], availabilityStatus: '', preferenceNotes: '', pastServices: [], status: 'ativo' };
}

/** Encontros anteriores informados à mão: textos limpos, ano numérico, retrato da equipe. */
function cleanPastServices(list) {
  return (list ?? []).map((s) => ({
    id: s.id || uid(),
    eventName: clean(s.eventName),
    year: s.year == null || s.year === '' ? null : Number(s.year),
    teamId: s.teamId || null,
    teamName: clean(s.teamName),
    teamColor: s.teamColor || null,
    teamIcon: s.teamIcon || null,
    role: s.role,
  }));
}

export const ageText = (birthDate) => {
  const age = ageOf(birthDate);
  return age == null ? '' : plural(age, 'ano', 'anos');
};

/**
 * Salva a ficha e a foto na mesma transação.
 * @param {any} input
 * @param {{ blob: Blob } | 'remove' | undefined} photo
 */
export async function savePerson(input, photo) {
  const data = { ...input, instagram: normalizeInstagram(input.instagram), email: clean(input.email).toLowerCase(), name: clean(input.name) };
  if ('birthDate' in input) data.birthDate = clean(input.birthDate);
  if ('pastServices' in input) data.pastServices = cleanPastServices(input.pastServices);
  const errors = validatePerson(data);
  if (Object.keys(errors).length) throw Object.assign(new AppError('invalid', 'Confira os campos destacados.'), { fields: errors });
  const now = nowISO();
  return transaction(['people', 'photos'], 'readwrite', async (s) => {
    const before = data.id ? await req(s.people.get(data.id)) : null;
    if (data.id && !before) throw new AppError('not_found', 'Esta ficha não existe mais. Ela pode ter sido excluída em outra aba.');
    const record = {
      ...blankPerson(),
      ...before,
      ...data,
      id: before?.id ?? uid(),
      nameKey: normalize(data.name),
      phone: data.phone ? formatPhone(data.phone) : '',
      notes: String(data.notes ?? '').trim(),
      preferenceNotes: String(data.preferenceNotes ?? '').trim(),
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
    };
    let replacedPhoto = null;
    if (photo && photo !== 'remove') {
      replacedPhoto = before?.photoId ?? null;
      record.photoId = uid();
      s.photos.put({ id: record.photoId, personId: record.id, blob: photo.blob, type: photo.blob.type || 'image/jpeg', size: photo.blob.size, updatedAt: now });
      if (replacedPhoto) s.photos.delete(replacedPhoto);
    } else if (photo === 'remove' && before?.photoId) {
      replacedPhoto = before.photoId;
      s.photos.delete(before.photoId);
      record.photoId = null;
    }
    s.people.put(record);
    return { record, replacedPhoto, created: !before };
  });
}

/** O que liga a pessoa ao resto do sistema. */
export async function personUsage(id) {
  return transaction(['participationHistory', 'allocations', 'teams', 'events'], 'readonly', async (s) => {
    const history = await req(s.participationHistory.index('personId').count(id));
    const allocations = await req(s.allocations.index('personId').getAll(id));
    const teams = await req(s.teams.getAll());
    const coordinated = teams.filter((t) => t.coordinators.some((c) => c.personId === id));
    const reference = teams.filter((t) => t.referenceMemberIds.includes(id));
    return { history, allocations: allocations.length, coordinated, reference, keepsHistory: history > 0 || coordinated.length > 0 };
  });
}

export async function setPersonStatus(id, status) {
  return transaction(['people'], 'readwrite', async (s) => {
    const person = await req(s.people.get(id));
    if (!person) throw new AppError('not_found', 'Ficha não encontrada.');
    s.people.put({ ...person, status, updatedAt: nowISO() });
  });
}

/** Exclusão definitiva — só para quem não tem histórico. Quem tem histórico é arquivado. */
export async function deletePerson(id) {
  return transaction(['people', 'photos', 'allocations', 'participationHistory', 'teams'], 'readwrite', async (s) => {
    const person = await req(s.people.get(id));
    if (!person) throw new AppError('not_found', 'Ficha não encontrada.');
    const history = await req(s.participationHistory.index('personId').count(id));
    const teams = await req(s.teams.getAll());
    if (history > 0 || teams.some((t) => t.coordinators.some((c) => c.personId === id))) {
      throw new AppError('has_history', `${person.name} tem histórico de serviço. Para não perder esse histórico, a ficha só pode ser arquivada.`);
    }
    const allocations = await req(s.allocations.index('personId').getAll(id));
    for (const a of allocations) s.allocations.delete(a.id);
    const now = nowISO();
    for (const t of teams) if (t.referenceMemberIds.includes(id)) s.teams.put({ ...t, referenceMemberIds: t.referenceMemberIds.filter((x) => x !== id), updatedAt: now });
    if (person.photoId) s.photos.delete(person.photoId);
    s.people.delete(id);
    return { photoId: person.photoId, allocations: allocations.length };
  });
}

/** Reduz a foto para no máximo 640 px (JPEG) antes de guardar: economiza espaço e deixa o backup leve. */
export async function preparePhoto(file) {
  if (!file.type.startsWith('image/')) throw new AppError('invalid', 'Escolha um arquivo de imagem (JPG, PNG, WebP ou HEIC).');
  if (file.size > 25 * 1024 * 1024) throw new AppError('invalid', 'Imagem muito grande. Use uma foto de até 25 MB.');
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => (URL.revokeObjectURL(url), resolve(img));
      img.onerror = () => (URL.revokeObjectURL(url), reject(new AppError('invalid', 'Não foi possível ler esta imagem. Use JPG, PNG ou WebP.')));
      img.src = url;
    });
  }
  const scale = Math.min(1, 640 / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new AppError('invalid', 'Não foi possível preparar a foto.');
  return blob;
}

// ---------- Peças visuais reutilizadas ----------

/** Contas coloridas: uma por participação confirmada, na cor da equipe. */
export function beads(records, max = 12) {
  const sorted = [...records].sort((a, b) => (b.eventStart ?? '').localeCompare(a.eventStart ?? ''));
  const shown = sorted.slice(0, max);
  return h(
    'span',
    { class: 'beads', role: 'img', 'aria-label': plural(records.length, 'participação', 'participações') },
    shown.map((r) => h('span', { class: ['bead', r.role === 'coordenador' && 'bead--coord'], style: { '--team': r.teamColor }, title: `${r.teamName} · ${r.eventName}` })),
    sorted.length > max && h('span', { class: 'beads__more' }, `+${sorted.length - max}`),
  );
}

const optionList = (ids, byId) => (ids ?? []).map((id) => byId.get(id)?.name).filter(Boolean);

function optionTags(ids, byId, max = 3) {
  const names = optionList(ids, byId);
  if (!names.length) return h('span', { class: 'muted' }, '—');
  return h('span', { class: 'tags' }, names.slice(0, max).map((n) => h('span', { class: 'tag' }, n)), names.length > max && h('span', { class: 'tag tag--more' }, `+${names.length - max}`));
}

const skillChips = (person, catalog, max = 3) => optionTags(person.skillIds, catalog.skillsById, max);

/** Equipes em que serviu, da mais frequente para a menos: "Música (2), Cozinha". */
const teamsServed = (st) => [...st.byTeam.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR')).map((t) => (t.count > 1 ? `${t.name} (${t.count})` : t.name)).join(', ');

/** Clique simples (sem Ctrl/⌘/Shift): abre o cartão; com modificador, o link segue normal (nova aba). */
const plainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Cartão rápido da pessoa, no formato de crachá: foto, nome, idade, telefone, pastorais e onde serviu.
 * @param {any} person
 * @param {{ stats: ReturnType<typeof emptyStats>, catalog: any }} ctx
 */
export function openPersonCard(person, { stats, catalog }) {
  const st = stats ?? emptyStats();
  const phone = digits(person.phone);
  const pastorals = optionList(person.pastoralIds, catalog.characteristicsById);
  const age = ageText(person.birthDate);
  const served = st.events.size
    ? h('div', { class: 'cracha__served' }, beads(st.records, 16), h('span', null, `${plural(st.events.size, 'encontro', 'encontros')}${st.byTeam.size ? ` · ${teamsServed(st)}` : ''}`))
    : h('span', { class: 'muted' }, 'Ainda não serviu');
  const body = h(
    'article',
    { class: 'cracha', dataset: { role: 'person-card' } },
    h('div', { class: 'cracha__band' }, h('span', { class: 'cracha__slot', 'aria-hidden': 'true' })),
    h('div', { class: 'cracha__photo' }, avatar(person, 'xl')),
    h('p', { class: 'cracha__name' }, person.name),
    h('p', { class: 'cracha__age' }, age || 'Idade não informada', person.status === 'arquivado' ? ' · ficha arquivada' : ''),
    person.phone
      ? h(
          'div',
          { class: 'cracha__phone' },
          h('a', { class: 'cracha__number', href: `tel:+55${phone}` }, person.phone),
          h('div', { class: 'cracha__call' }, h('a', { class: 'btn btn--secondary btn--sm', href: `tel:+55${phone}` }, icon('phone', { size: 16 }), h('span', null, 'Ligar')), h('a', { class: 'btn btn--secondary btn--sm', href: `https://wa.me/55${phone}`, target: '_blank', rel: 'noopener' }, icon('message', { size: 16 }), h('span', null, 'WhatsApp'))),
        )
      : h('p', { class: 'cracha__phone muted' }, 'Sem telefone cadastrado'),
    h(
      'dl',
      { class: 'cracha__facts' },
      h('div', null, h('dt', null, 'Pastorais'), h('dd', null, pastorals.length ? h('span', { class: 'tags' }, pastorals.map((n) => h('span', { class: 'tag' }, n))) : h('span', { class: 'muted' }, 'Nenhuma informada'))),
      h('div', null, h('dt', null, 'Serviu em'), h('dd', null, served)),
    ),
  );
  openModal({
    title: person.name,
    size: 'sm',
    className: 'modal--cracha',
    body,
    actions: [{ label: 'Ver ficha completa', variant: 'primary', icon: 'chevron-right', id: 'open-person', onClick: () => navigate(`/pessoas/${person.id}`) }],
  });
  // Foco no próprio cartão (leitores de tela leem o conteúdo; Tab leva aos botões).
  body.tabIndex = -1;
  body.focus({ preventScroll: true });
}

/** Planilha .xlsx com os dados principais (sem fotos), na ordem e com os filtros da lista. */
async function exportPeople(rows, { statOf, catalog, filtered }) {
  const columns = [
    { label: 'Nome', width: 32, text: (p) => p.name },
    { label: 'Idade', width: 8, number: true, text: (p) => ageOf(p.birthDate) ?? '' },
    { label: 'Nascimento', width: 13, text: (p) => (p.birthDate ? fmtDate(p.birthDate) : '') },
    { label: 'Telefone', width: 17, text: (p) => p.phone },
    { label: 'E-mail', width: 28, text: (p) => p.email },
    { label: 'Instagram', width: 18, text: (p) => p.instagram },
    { label: 'Pastorais', width: 34, text: (p) => optionList(p.pastoralIds, catalog.characteristicsById).join(', ') },
    { label: 'Habilidades', width: 34, text: (p) => optionList(p.skillIds, catalog.skillsById).join(', ') },
    { label: 'Encontros servidos', width: 18, number: true, text: (p) => statOf(p).events.size },
    { label: 'Equipes em que serviu', width: 34, text: (p) => teamsServed(statOf(p)) },
    { label: 'Coordenações', width: 14, number: true, text: (p) => statOf(p).coordinations },
    { label: 'Disponibilidade', width: 22, text: (p) => (p.availabilityStatus ? AVAILABILITY_STATUS[p.availabilityStatus] : '') },
    { label: 'Situação', width: 11, text: (p) => (p.status === 'arquivado' ? 'Arquivada' : 'Ativa') },
  ];
  try {
    downloadFile(await toXLSX(columns, rows, 'Pessoas'), `pessoas-${stamp()}.xlsx`);
    toast(`Planilha com ${plural(rows.length, 'pessoa', 'pessoas')} baixada.${filtered ? ' Só quem aparece com os filtros atuais.' : ''}`);
  } catch (error) {
    toastError(error);
  }
}

/**
 * Escolher pessoas cadastradas (uma ou várias).
 * @returns {Promise<string[]|null>}
 */
export async function pickPeople({ title, lead, multiple = false, selected = [], excludeIds = [], confirmLabel = 'Confirmar' }) {
  const people = (await readStores(['people'])).people.filter((p) => p.status === 'ativo' && !excludeIds.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return new Promise((resolve) => {
    const chosen = new Set(selected);
    let answered = false;
    let query = '';
    const list = h('ul', { class: 'pick-list', role: 'listbox', 'aria-multiselectable': multiple ? 'true' : 'false' });
    const counter = h('p', { class: 'muted pick-count' });
    const paint = () => {
      const rows = people.filter((p) => matchesQuery(`${p.name} ${p.phone} ${p.email}`, query));
      counter.textContent = multiple ? `${plural(chosen.size, 'pessoa escolhida', 'pessoas escolhidas')}` : plural(rows.length, 'pessoa', 'pessoas');
      list.replaceChildren(
        ...(rows.length
          ? rows.slice(0, 200).map((p) =>
              h(
                'li',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    class: ['pick-row', chosen.has(p.id) && 'is-selected'],
                    role: 'option',
                    'aria-selected': chosen.has(p.id) ? 'true' : 'false',
                    onclick: () => {
                      if (!multiple) {
                        answered = true;
                        resolve([p.id]);
                        modal.close();
                        return;
                      }
                      chosen.has(p.id) ? chosen.delete(p.id) : chosen.add(p.id);
                      paint();
                    },
                  },
                  avatar(p, 'sm'),
                  h('span', { class: 'pick-row__text' }, h('span', null, p.name), p.phone && h('small', null, p.phone)),
                  multiple && h('span', { class: 'pick-row__check' }, icon('check', { size: 16 })),
                ),
              ),
            )
          : [h('li', { class: 'muted pick-empty' }, people.length ? 'Ninguém encontrado com essa busca.' : 'Nenhuma pessoa ativa cadastrada.')]),
      );
    };
    const modal = openModal({
      title,
      lead,
      size: 'md',
      body: h('div', { class: 'pick' }, searchBox({ placeholder: 'Buscar pelo nome ou telefone', onInput: (v) => ((query = v), paint()) }), counter, list),
      onClose: () => !answered && resolve(null),
      actions: multiple
        ? [
            { label: 'Cancelar', variant: 'ghost' },
            { label: confirmLabel, variant: 'primary', id: 'confirm-pick', onClick: () => ((answered = true), resolve([...chosen])) },
          ]
        : [],
    });
    paint();
  });
}

// ---------- Lista ----------

const listState = { query: '', skill: '', trait: '', pastoral: '', team: '', availability: '', status: 'ativo', experience: '', sort: 'name', view: readView() };

function readView() {
  try {
    return localStorage.getItem('pessoas.visualizacao') === 'cartoes' ? 'cartoes' : 'lista';
  } catch {
    return 'lista';
  }
}
function saveView(value) {
  try {
    localStorage.setItem('pessoas.visualizacao', value);
  } catch {
    /* preferência só desta sessão */
  }
}

export async function renderPeople(view) {
  const [{ people, teams, participationHistory }, catalog] = await Promise.all([readStores(['people', 'teams', 'participationHistory']), loadCatalog()]);
  const stats = buildStats(participationHistory, people);
  const statOf = (p) => stats.get(p.id) ?? emptyStats();
  const results = h('div', { class: 'stack' });
  const count = h('p', { class: 'result-count', role: 'status' });
  const showCard = (p) => openPersonCard(p, { stats: statOf(p), catalog });
  const cardOnClick = (p) => (event) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    showCard(p);
  };

  const activeFilters = () => ['query', 'skill', 'trait', 'pastoral', 'team', 'availability', 'experience'].some((k) => listState[k]) || listState.status !== 'ativo';
  const clearFilters = () => {
    Object.assign(listState, { query: '', skill: '', trait: '', pastoral: '', team: '', availability: '', experience: '', status: 'ativo' });
    renderPeople(view);
  };

  const filtered = () =>
    people
      .filter((p) => {
        const st = statOf(p);
        if (listState.status && p.status !== listState.status) return false;
        if (listState.skill && !p.skillIds.includes(listState.skill)) return false;
        if (listState.trait && !p.characteristicIds.includes(listState.trait) && !p.availabilityIds.includes(listState.trait)) return false;
        if (listState.pastoral && !(p.pastoralIds ?? []).includes(listState.pastoral)) return false;
        if (listState.team && !st.byTeam.has(listState.team)) return false;
        if (listState.availability && (listState.availability === 'none' ? p.availabilityStatus : p.availabilityStatus !== listState.availability)) return false;
        if (listState.experience === 'never' && st.events.size) return false;
        if (listState.experience === 'served' && !st.events.size) return false;
        if (listState.experience === 'coordinated' && !st.coordinations) return false;
        return matchesQuery(`${p.name} ${p.phone} ${digits(p.phone)} ${p.email} ${p.instagram} ${p.notes} ${optionList(p.pastoralIds, catalog.characteristicsById).join(' ')}`, listState.query);
      })
      .sort((a, b) => {
        if (listState.sort === 'experience') return statOf(b).events.size - statOf(a).events.size || statOf(b).participations - statOf(a).participations || a.name.localeCompare(b.name, 'pt-BR');
        if (listState.sort === 'recent') return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
        return a.name.localeCompare(b.name, 'pt-BR');
      });

  const clearButton = button('Limpar filtros', { variant: 'ghost', small: true, icon: 'x', onClick: clearFilters });
  const paint = () => {
    const rows = filtered();
    clearButton.hidden = !activeFilters();
    count.textContent =rows.length === people.length ? plural(rows.length, 'pessoa', 'pessoas') : `${plural(rows.length, 'pessoa encontrada', 'pessoas encontradas')} de ${people.length}`;
    if (!people.length) {
      results.replaceChildren(emptyState({ icon: 'people', title: 'Nenhuma pessoa cadastrada', text: 'Cada pessoa é cadastrada uma única vez e reaproveitada em todos os encontros.', action: h('a', { class: 'btn btn--primary', href: '#/pessoas/nova' }, 'Cadastrar a primeira pessoa') }));
      return;
    }
    if (!rows.length) {
      results.replaceChildren(emptyState({ icon: 'search', title: 'Ninguém com esses filtros', text: 'Remova algum filtro ou busque por outro nome.', action: button('Limpar filtros', { onClick: clearFilters }) }));
      return;
    }
    if (listState.view === 'cartoes') {
      results.replaceChildren(
        h(
          'div',
          { class: 'person-grid' },
          rows.map((p) => {
            const st = statOf(p);
            return h(
              'a',
              { class: ['person-card', p.status === 'arquivado' && 'is-archived'], href: `#/pessoas/${p.id}`, onclick: cardOnClick(p) },
              avatar(p, 'lg'),
              h('span', { class: 'person-card__name' }, p.name),
              h('span', { class: 'person-card__contact' }, [ageText(p.birthDate), p.phone].filter(Boolean).join(' · ') || 'Sem contato'),
              skillChips(p, catalog),
              h('span', { class: 'person-card__stats' }, st.events.size ? beads(st.records, 10) : null, h('span', null, st.events.size ? `${plural(st.events.size, 'encontro', 'encontros')} · ${plural(st.byTeam.size, 'equipe', 'equipes')}` : 'Ainda não serviu')),
              p.status === 'arquivado' && badge('Arquivada', 'muted'),
            );
          }),
        ),
      );
      return;
    }
    results.replaceChildren(
      dataTable({
        rows,
        onRowClick: showCard,
        columns: [
          { key: 'name', label: 'Pessoa', primary: true, render: (p) => h('span', { class: 'cell-person' }, avatar(p, 'sm'), h('span', { class: 'cell-stack' }, h('a', { href: `#/pessoas/${p.id}`, class: 'cell-link', onclick: cardOnClick(p) }, p.name), h('small', null, [p.phone, p.instagram].filter(Boolean).join(' · ') || 'Sem contato'))) },
          { key: 'age', label: 'Idade', align: 'end', render: (p) => (ageOf(p.birthDate) == null ? h('span', { class: 'muted cell-empty' }, '—') : h('span', { class: 'num' }, ageOf(p.birthDate))) },
          { key: 'pastorals', label: 'Pastorais', render: (p) => (optionList(p.pastoralIds, catalog.characteristicsById).length ? optionTags(p.pastoralIds, catalog.characteristicsById, 2) : h('span', { class: 'muted cell-empty' }, '—')) },
          { key: 'skills', label: 'Habilidades', hideSm: true, render: (p) => skillChips(p, catalog) },
          { key: 'events', label: 'Encontros', align: 'end', render: (p) => h('span', { class: 'num' }, statOf(p).events.size) },
          { key: 'teams', label: 'Equipes em que serviu', hideSm: true, render: (p) => (statOf(p).records.length ? beads(statOf(p).records, 8) : h('span', { class: 'muted' }, '—')) },
          { key: 'availability', label: 'Disponibilidade', hideSm: true, render: (p) => (p.availabilityStatus ? AVAILABILITY_STATUS[p.availabilityStatus] : h('span', { class: 'muted' }, 'Não informada')) },
          { key: 'status', label: 'Situação', render: (p) => (p.status === 'arquivado' ? badge('Arquivada', 'muted') : badge('Ativa', 'ok')) },
        ],
      }),
    );
  };

  const set = (key) => (value) => {
    listState[key] = value;
    paint();
  };
  const skillOptions = catalog.skills.filter((s) => s.active || people.some((p) => p.skillIds.includes(s.id))).map((s) => ({ value: s.id, label: s.name, group: catalog.categoriesById.get(s.categoryId)?.name ?? 'Outras' }));
  const traitOptions = [...catalog.profile, ...catalog.availability].filter((c) => c.active).map((c) => ({ value: c.id, label: c.name, group: c.group === 'perfil' ? 'Perfil pessoal' : 'Disponibilidade' }));
  const pastoralOptions = catalog.pastorals.filter((c) => c.active || people.some((p) => (p.pastoralIds ?? []).includes(c.id))).map((c) => ({ value: c.id, label: c.name }));
  const viewToggle = segmented({
    name: 'people-view',
    label: 'Visualização',
    value: listState.view,
    options: [
      { value: 'lista', label: 'Lista' },
      { value: 'cartoes', label: 'Cartões' },
    ],
    onChange: (v) => {
      listState.view = v;
      saveView(v);
      paint();
    },
  });
  const served = people.filter((p) => statOf(p).events.size).length;

  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({
        eyebrow: 'Cadastro permanente',
        title: 'Pessoas',
        lead: people.length ? `${plural(people.filter((p) => p.status === 'ativo').length, 'pessoa ativa', 'pessoas ativas')} · ${plural(served, 'já serviu', 'já serviram')} em algum encontro` : 'Cadastre as pessoas uma vez; elas ficam disponíveis para todos os encontros.',
        actions: [
          people.length ? button('Baixar planilha', { icon: 'download', title: 'Planilha (.xlsx) com os dados principais de quem está na lista, sem fotos', onClick: () => exportPeople(filtered(), { statOf, catalog, filtered: activeFilters() }), attrs: { 'data-action': 'export-people' } }) : null,
          h('a', { class: 'btn btn--primary', href: '#/pessoas/nova' }, icon('plus', { size: 18 }), h('span', null, 'Nova pessoa')),
        ],
      }),
      people.length
        ? [
            collapsibleFilters(
              searchBox({ value: listState.query, placeholder: 'Buscar por nome, telefone, e-mail ou pastoral', onInput: set('query') }),
              selectBox({ label: 'Habilidade', value: listState.skill, options: withAll('Todas', skillOptions), onChange: set('skill') }),
              selectBox({ label: 'Pastoral', value: listState.pastoral, options: withAll('Todas', pastoralOptions), onChange: set('pastoral') }),
              selectBox({ label: 'Perfil', value: listState.trait, options: withAll('Todos', traitOptions), onChange: set('trait') }),
              selectBox({ label: 'Serviu em', value: listState.team, options: withAll('Qualquer equipe', teams.map((t) => ({ value: t.id, label: t.name })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))), onChange: set('team') }),
              selectBox({ label: 'Experiência', value: listState.experience, options: withAll('Todas', [{ value: 'never', label: 'Nunca serviu' }, { value: 'served', label: 'Já serviu' }, { value: 'coordinated', label: 'Já coordenou' }]), onChange: set('experience') }),
              selectBox({ label: 'Disponibilidade', value: listState.availability, options: withAll('Todas', [...Object.entries(AVAILABILITY_STATUS).filter(([k]) => k).map(([value, label]) => ({ value, label })), { value: 'none', label: 'Não informada' }]), onChange: set('availability') }),
              selectBox({ label: 'Situação', value: listState.status, defaultValue: 'ativo', options: [{ value: 'ativo', label: 'Ativas' }, { value: 'arquivado', label: 'Arquivadas' }, { value: '', label: 'Todas' }], onChange: set('status') }),
            ),
            h('div', { class: 'list-toolbar' }, count, clearButton, h('span', { class: 'spacer' }), selectBox({ label: 'Ordenar', value: listState.sort, defaultValue: 'name', options: [{ value: 'name', label: 'Nome (A–Z)' }, { value: 'experience', label: 'Mais experiência' }, { value: 'recent', label: 'Cadastradas por último' }], onChange: set('sort') }), viewToggle),
          ]
        : null,
      results,
    ),
  );
  paint();
}

// ---------- Ficha ----------

const TABS = [
  { id: 'dados', label: 'Dados pessoais' },
  { id: 'habilidades', label: 'Habilidades' },
  { id: 'perfil', label: 'Perfil' },
  { id: 'preferencias', label: 'Preferências' },
  { id: 'historico', label: 'Histórico' },
];
const FIELD_TAB = { name: 'dados', birthDate: 'dados', phone: 'dados', email: 'dados', instagram: 'dados', avoidTeamIds: 'preferencias', pastServices: 'historico' };
const ROLE_OPTIONS = [
  { value: 'integrante', label: 'Integrante' },
  { value: 'coordenador', label: 'Coordenação' },
];
const OTHER_TEAM = '__outra';

/**
 * Inclui ou edita um encontro anterior (antes do aplicativo ou não cadastrado aqui).
 * @returns {Promise<any|null>} o encontro anterior pronto para a ficha
 */
function pastServiceDialog(entry, { teams, siblings, suggestions }) {
  return new Promise((resolve) => {
    let result = null;
    const listId = `sugestoes-encontro-${Date.now()}`;
    const knownTeam = entry?.teamId && teams.find((t) => t.id === entry.teamId);
    const teamValue = knownTeam ? knownTeam.id : entry?.teamName ? OTHER_TEAM : '';
    const otherField = field({ label: 'Nome da equipe', name: 'teamName', value: knownTeam ? '' : entry?.teamName, placeholder: 'Ex.: Teatro', attrs: { maxlength: '60' } });
    otherField.hidden = teamValue !== OTHER_TEAM;
    const teamField = field({
      label: 'Equipe',
      name: 'team',
      type: 'select',
      value: teamValue,
      options: [{ value: '', label: 'Não lembro / não informar' }, ...teams.map((t) => ({ value: t.id, label: t.status === 'ativa' ? t.name : `${t.name} (inativa)` })), { value: OTHER_TEAM, label: 'Outra equipe (escrever o nome)…' }],
    });
    teamField.querySelector('select').addEventListener('change', (event) => {
      otherField.hidden = event.target.value !== OTHER_TEAM;
      if (!otherField.hidden) otherField.querySelector('input').focus();
    });
    const form = h(
      'form',
      { class: 'form form-grid', novalidate: true, onsubmit: (e) => (e.preventDefault(), modal.dialog.querySelector('[data-action="save-past"]')?.click()) },
      field({ label: 'Encontro', name: 'eventName', value: entry?.eventName, required: true, wide: true, placeholder: 'Ex.: EJC 2019, Encontro de Casais', hint: 'Escreva como o encontro é conhecido. Os já usados aparecem como sugestão.', attrs: { maxlength: '80', list: listId, autocomplete: 'off' } }),
      h('datalist', { id: listId }, suggestions.map((name) => h('option', { value: name }))),
      field({ label: 'Ano', name: 'year', type: 'number', value: entry?.year ?? '', placeholder: String(new Date().getFullYear() - 1), hint: 'Se não lembrar, deixe em branco.', attrs: { inputmode: 'numeric', min: '1950', max: String(new Date().getFullYear()), step: '1' } }),
      teamField,
      otherField,
      h('div', { class: 'field field--wide', dataset: { field: 'role' } }, h('span', { class: 'field__label' }, 'Função'), segmented({ name: 'role', label: 'Função', value: entry?.role ?? 'integrante', options: ROLE_OPTIONS }), h('p', { class: 'field__error', hidden: true })),
    );
    const modal = openModal({
      title: entry ? 'Editar encontro anterior' : 'Encontro anterior',
      lead: 'Para encontros que não estão cadastrados aqui. Os encontros concluídos no aplicativo entram no histórico sozinhos.',
      size: 'md',
      body: form,
      onClose: () => resolve(result),
      actions: [
        { label: 'Cancelar', variant: 'ghost' },
        {
          label: entry ? 'Salvar alteração' : 'Incluir na ficha',
          variant: 'primary',
          id: 'save-past',
          onClick: () => {
            const v = readForm(form);
            const typed = clean(v.teamName);
            const team = v.team === OTHER_TEAM ? teams.find((t) => t.nameKey === normalize(typed)) : teams.find((t) => t.id === v.team);
            const year = clean(v.year);
            const candidate = {
              id: entry?.id ?? uid(),
              eventName: clean(v.eventName),
              year: year ? Number(year) : null,
              teamId: team?.id ?? null,
              teamName: team ? team.name : v.team === OTHER_TEAM ? typed : '',
              teamColor: team?.color ?? null,
              teamIcon: team?.icon ?? null,
              role: v.role || 'integrante',
            };
            const errors = validatePastService(candidate, siblings);
            if (v.team === OTHER_TEAM && !typed) errors.teamName = 'Escreva o nome da equipe ou escolha "Não lembro".';
            if (Object.keys(errors).length) {
              showErrors(form, errors);
              return false;
            }
            result = candidate;
          },
        },
      ],
    });
  });
}

export async function renderPerson(view, { id }, query) {
  const isNew = id === 'nova';
  const [stores, catalog] = await Promise.all([readStores(['people', 'teams', 'participationHistory', 'allocations', 'events']), loadCatalog()]);
  const existing = isNew ? null : stores.people.find((p) => p.id === id);
  if (!isNew && !existing) {
    view.replaceChildren(emptyState({ icon: 'people', title: 'Ficha não encontrada', text: 'Ela pode ter sido excluída.', action: h('a', { class: 'btn btn--primary', href: '#/pessoas' }, 'Voltar para pessoas') }));
    return;
  }
  const person = existing ? structuredClone(existing) : blankPerson();
  const records = stores.participationHistory.filter((r) => r.personId === person.id);
  /** Encontros anteriores em edição: entram na ficha ao salvar. */
  let pastDraft = structuredClone(person.pastServices ?? []);
  const draftPerson = () => ({ ...person, pastServices: pastDraft });
  const currentStats = () => buildStats(records, [draftPerson()]).get(person.id) ?? emptyStats();
  const stats = currentStats();
  let tab = TABS.some((t) => t.id === query.get('aba')) ? query.get('aba') : 'dados';
  /** @type {{ blob: Blob } | 'remove' | undefined} */
  let photoChange;
  let previewUrl = null;

  // ---- Aba 1: dados pessoais ----
  const photoBox = h('div', { class: 'photo-field__preview' });
  const paintPhoto = async () => {
    if (photoChange && photoChange !== 'remove') photoBox.replaceChildren(h('img', { src: previewUrl, alt: 'Foto escolhida' }));
    else if (photoChange !== 'remove' && person.photoId) {
      const url = await photoUrl(person.photoId);
      photoBox.replaceChildren(url ? h('img', { src: url, alt: `Foto de ${person.name}` }) : avatar(person, 'xl'));
    } else photoBox.replaceChildren(avatar({ name: person.name || '?' }, 'xl'));
    removePhotoBtn.hidden = !(photoChange && photoChange !== 'remove') && (photoChange === 'remove' || !person.photoId);
  };
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Escolher foto' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const blob = await preparePhoto(file);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      photoChange = { blob };
      form.dispatchEvent(new Event('change'));
      paintPhoto();
    } catch (error) {
      toastError(error);
    }
  });
  const removePhotoBtn = button('Remover foto', { variant: 'ghost', small: true, icon: 'trash', onClick: () => ((photoChange = 'remove'), form.dispatchEvent(new Event('change')), paintPhoto()) });

  const ageHint = (value) => ageText(value) || 'A idade é calculada sozinha a partir da data.';
  const birthField = field({ label: 'Data de nascimento', name: 'birthDate', type: 'date', value: person.birthDate, hint: ageHint(person.birthDate), attrs: { max: todayISO(), min: '1900-01-01', autocomplete: 'bday' } });
  birthField.querySelector('input').addEventListener('input', (event) => {
    birthField.querySelector('.field__hint').textContent = ageHint(event.target.value);
  });

  const pastoralGroup = h('div', { class: 'field--wide' });
  const paintPastorals = (selected = currentList('pastoralIds')) => {
    const owned = new Set(selected);
    const options = catalog.pastorals.filter((c) => c.active || owned.has(c.id));
    pastoralGroup.replaceChildren(
      h('fieldset', { class: 'choice-group' }, h('legend', { class: 'choice-group__title' }, 'Pastorais'), h('p', { class: 'field__hint' }, 'Pastorais e movimentos em que serve ou já serviu.'), options.length ? chipGroup({ name: 'pastoralIds', label: 'Pastorais', options: options.map((c) => ({ id: c.id, label: c.name, muted: !c.active })), selected: [...owned] }) : h('p', { class: 'muted' }, 'Nenhuma pastoral cadastrada.'), button('Nova pastoral', { variant: 'quiet', small: true, icon: 'plus', onClick: () => addOption('characteristics', { group: 'pastoral', title: 'Nova pastoral' }, 'pastoralIds') })),
    );
  };

  const panelDados = h(
    'div',
    { class: 'form-grid' },
    h('div', { class: 'photo-field field--wide' }, photoBox, h('div', { class: 'photo-field__actions' }, button(person.photoId ? 'Trocar foto' : 'Escolher foto', { icon: 'camera', onClick: () => fileInput.click() }), removePhotoBtn, h('p', { class: 'field__hint' }, 'A foto é reduzida e guardada só neste aparelho.')), fileInput),
    field({ label: 'Nome completo', name: 'name', value: person.name, required: true, wide: true, attrs: { autocomplete: 'name', maxlength: '120' } }),
    field({ label: 'Telefone', name: 'phone', type: 'tel', value: person.phone, placeholder: '(11) 98765-4321', attrs: { autocomplete: 'tel', inputmode: 'tel' } }),
    birthField,
    field({ label: 'E-mail', name: 'email', type: 'email', value: person.email, attrs: { autocomplete: 'email', inputmode: 'email' } }),
    field({ label: 'Instagram', name: 'instagram', value: person.instagram, placeholder: '@usuario', attrs: { autocapitalize: 'off' } }),
    pastoralGroup,
    field({ label: 'Observações', name: 'notes', type: 'textarea', value: person.notes, wide: true, rows: 3 }),
  );

  // ---- Aba 2: habilidades ----
  const skillGroups = h('div', { class: 'stack' });
  const paintSkills = (selected = currentList('skillIds')) => {
    const owned = new Set(selected);
    skillGroups.replaceChildren(
      ...catalog.categories
        .filter((c) => c.active || catalog.skills.some((s) => s.categoryId === c.id && owned.has(s.id)))
        .map((c) => {
          const options = catalog.skills.filter((s) => s.categoryId === c.id && (s.active || owned.has(s.id)));
          return h(
            'fieldset',
            { class: 'choice-group' },
            h('legend', { class: 'choice-group__title' }, c.name, h('span', { class: 'choice-group__area' }, areaLabel(c.area))),
            options.length ? chipGroup({ name: 'skillIds', label: c.name, options: options.map((s) => ({ id: s.id, label: s.name, muted: !s.active, title: s.active ? undefined : 'Opção desativada' })), selected: [...owned] }) : h('p', { class: 'muted' }, 'Sem opções ativas.'),
            c.active && button('Nova habilidade', { variant: 'quiet', small: true, icon: 'plus', onClick: () => addOption('skills', { categoryId: c.id, title: `Nova habilidade em ${c.name}` }, 'skillIds') }),
          );
        }),
    );
  };

  // ---- Aba 3: perfil ----
  const profileGroup = h('div');
  const paintProfile = (selected = currentList('characteristicIds')) => {
    const owned = new Set(selected);
    const options = catalog.profile.filter((c) => c.active || owned.has(c.id));
    profileGroup.replaceChildren(
      h('fieldset', { class: 'choice-group' }, h('legend', { class: 'choice-group__title' }, 'Características pessoais'), h('p', { class: 'field__hint' }, 'Jeito de ser — não confundir com habilidade. Marque quantas fizerem sentido.'), chipGroup({ name: 'characteristicIds', label: 'Características pessoais', options: options.map((c) => ({ id: c.id, label: c.name, muted: !c.active })), selected: [...owned] }), button('Nova característica', { variant: 'quiet', small: true, icon: 'plus', onClick: () => addOption('characteristics', { group: 'perfil', title: 'Nova característica pessoal' }, 'characteristicIds') })),
    );
  };

  // ---- Aba 4: preferências ----
  const teamOptions = (selected) => stores.teams.filter((t) => t.status === 'ativa' || selected.includes(t.id)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((t) => ({ id: t.id, label: t.name, muted: t.status !== 'ativa' }));
  const availabilityGroup = h('div');
  const paintAvailability = (selected = currentList('availabilityIds')) => {
    const owned = new Set(selected);
    availabilityGroup.replaceChildren(chipGroup({ name: 'availabilityIds', label: 'Dias e formatos', options: catalog.availability.filter((c) => c.active || owned.has(c.id)).map((c) => ({ id: c.id, label: c.name, muted: !c.active })), selected: [...owned] }), button('Nova opção', { variant: 'quiet', small: true, icon: 'plus', onClick: () => addOption('characteristics', { group: 'disponibilidade', title: 'Nova opção de disponibilidade' }, 'availabilityIds') }));
  };
  const panelPreferences = h(
    'div',
    { class: 'stack' },
    h('fieldset', { class: 'choice-group' }, h('legend', { class: 'choice-group__title' }, 'Equipes de interesse'), stores.teams.length ? chipGroup({ name: 'preferredTeamIds', label: 'Equipes de interesse', options: teamOptions(person.preferredTeamIds), selected: person.preferredTeamIds }) : h('p', { class: 'muted' }, 'Cadastre equipes para marcar preferências.')),
    h('fieldset', { class: 'choice-group', dataset: { field: 'avoidTeamIds' } }, h('legend', { class: 'choice-group__title' }, 'Prefere não integrar'), stores.teams.length ? chipGroup({ name: 'avoidTeamIds', label: 'Equipes que prefere não integrar', options: teamOptions(person.avoidTeamIds), selected: person.avoidTeamIds }) : h('p', { class: 'muted' }, '—'), h('p', { class: 'field__error', hidden: true })),
    h('fieldset', { class: 'choice-group' }, h('legend', { class: 'choice-group__title' }, 'Disponibilidade'), segmented({ name: 'availabilityStatus', label: 'Disponibilidade geral', value: person.availabilityStatus, options: Object.entries(AVAILABILITY_STATUS).map(([value, label]) => ({ value, label })) }), h('p', { class: 'field__hint' }, 'Dias e formatos em que costuma poder servir:'), availabilityGroup),
    field({ label: 'Observações sobre preferências', name: 'preferenceNotes', type: 'textarea', value: person.preferenceNotes, wide: true, rows: 3 }),
  );

  // ---- Aba 5: histórico (calculado dos encontros concluídos + encontros anteriores informados) ----
  const openAllocations = stores.allocations.filter((a) => a.personId === person.id).map((a) => ({ a, event: stores.events.find((e) => e.id === a.eventId), team: stores.teams.find((t) => t.id === a.teamId) })).filter((x) => x.event && ['planejamento', 'em_andamento', 'reaberto'].includes(x.event.status));
  const absences = records.filter((r) => r.status === 'ausente').length;
  const teamsForPast = [...stores.teams].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const eventSuggestions = [...new Set([...stores.events.map((e) => e.name), ...stores.people.flatMap((p) => (p.pastServices ?? []).map((s) => s.eventName))])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const historyPanel = h('div', { class: 'tab-panel', id: 'aba-historico', role: 'tabpanel', dataset: { tab: 'historico' } });
  const tabCount = h('span', { class: 'tabs__count' });

  async function editPast(entry) {
    const result = await pastServiceDialog(entry, { teams: teamsForPast, siblings: pastDraft, suggestions: eventSuggestions });
    if (!result) return;
    pastDraft = entry ? pastDraft.map((s) => (s.id === entry.id ? result : s)) : [...pastDraft, result];
    pastChanged();
  }

  function removePast(entry) {
    pastDraft = pastDraft.filter((s) => s.id !== entry.id);
    pastChanged();
  }

  /** A lista mudou: marca a ficha como alterada e mostra o botão de salvar também nesta aba. */
  function pastChanged() {
    form.dispatchEvent(new Event('change'));
    saveBar.hidden = false;
    paintHistory();
  }

  function pastSection() {
    const sorted = [...pastDraft].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.eventName.localeCompare(b.eventName, 'pt-BR'));
    return section(
      'Encontros anteriores',
      { lead: 'Encontros em que serviu antes do aplicativo ou que não estão cadastrados aqui. Contam na experiência, marcados como informados.', actions: button('Incluir encontro', { small: true, icon: 'plus', onClick: () => editPast(null), attrs: { 'data-action': 'add-past' } }) },
      sorted.length
        ? h(
            'ul',
            { class: 'past-list' },
            sorted.map((s) =>
              h(
                'li',
                { class: 'past-row' },
                h('span', { class: 'past-row__year num' }, s.year ?? '—'),
                h('span', { class: 'past-row__main' }, h('span', { class: 'past-row__name' }, s.eventName), h('span', { class: 'tags' }, s.teamName ? teamChip({ name: s.teamName, color: s.teamColor ?? PAST_COLOR, icon: s.teamIcon ?? 'teams' }, { small: true }) : h('span', { class: 'muted' }, 'Equipe não informada'), s.role === 'coordenador' ? badge('Coordenação', 'gold') : null)),
                h('span', { class: 'past-row__actions' }, button('', { variant: 'ghost', small: true, icon: 'edit', title: `Editar ${s.eventName}`, onClick: () => editPast(s) }), button('', { variant: 'ghost', small: true, icon: 'trash', title: `Remover ${s.eventName}`, onClick: () => removePast(s) })),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'Nenhum encontro anterior informado.'),
    );
  }

  function paintHistory() {
    const st = currentStats();
    const all = [...records, ...pastRecords([draftPerson()])];
    const teamRows = [...st.byTeam.entries()].map(([teamId, t]) => ({ teamId, ...t })).sort((a, b) => b.count - a.count);
    tabCount.textContent = String(st.events.size);
    tabCount.hidden = !st.events.size;
    historyPanel.replaceChildren(
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'tiles' }, tile('Encontros servidos', st.events.size, st.manualEvents.size ? `${plural(st.manualEvents.size, 'informado', 'informados')} na ficha` : null), tile('Participações em equipes', st.participations), tile('Coordenações', st.coordinations), tile('Ausências', absences)),
        st.records.length ? h('div', { class: 'beads-line' }, beads(st.records, 40), h('span', { class: 'muted' }, 'Cada conta é uma participação, na cor da equipe. Contorno dourado = coordenação.')) : null,
        openAllocations.length ? section('Distribuições em aberto', { lead: 'Ainda não contam no histórico: o encontro não foi concluído.' }, h('ul', { class: 'plain-list' }, openAllocations.map(({ a, event, team }) => h('li', null, h('a', { href: `#/encontros/${event.id}` }, event.name), ' · ', team ? teamChip(team, { small: true }) : 'Equipe', ' · ', ROLES[a.role], ' · ', badge(EVENT_STATUS[event.status].label, EVENT_STATUS[event.status].tone))))) : null,
        pastSection(),
        all.length
          ? [
              teamRows.length ? section('Equipes em que trabalhou', null, dataTable({ rows: teamRows, sortKey: 'count', sortDir: 'desc', columns: [{ key: 'name', label: 'Equipe', primary: true, sortValue: (t) => t.name, render: (t) => teamChip(t) }, { key: 'count', label: 'Participações', align: 'end', defaultDir: 'desc', sortValue: (t) => t.count, render: (t) => h('span', { class: 'num' }, t.count) }, { key: 'coordinations', label: 'Coordenou', align: 'end', defaultDir: 'desc', sortValue: (t) => t.coordinations, render: (t) => (t.coordinations ? badge(plural(t.coordinations, 'vez', 'vezes'), 'gold') : h('span', { class: 'muted' }, '—')) }] })) : null,
              section(
                'Linha do tempo',
                null,
                h(
                  'ol',
                  { class: 'timeline' },
                  personTimeline(all).map((item) =>
                    h(
                      'li',
                      { class: ['timeline__item', item.manual && 'is-manual'] },
                      h('span', { class: 'timeline__date' }, item.manual ? (item.year ? String(item.year) : 'Ano não informado') : fmtRange(item.eventStart, item.eventEnd)),
                      h(
                        'div',
                        { class: 'timeline__body' },
                        item.manual ? h('span', { class: 'timeline__title' }, item.eventName, ' ', badge('Informado na ficha', 'muted')) : h('a', { class: 'timeline__title', href: `#/encontros/${item.eventId}` }, item.eventName),
                        h('div', { class: 'tags' }, item.entries.map((r) => h('span', { class: ['timeline__entry', r.status === 'ausente' && 'is-absent'] }, r.teamName ? teamChip({ name: r.teamName, color: r.teamColor, icon: r.teamIcon }, { small: true }) : h('span', { class: 'muted' }, 'Equipe não informada'), r.role === 'coordenador' ? badge('Coordenação', 'gold') : null, r.status === 'ausente' ? badge('Não compareceu', 'muted') : null))),
                      ),
                    ),
                  ),
                ),
              ),
            ]
          : emptyState({ icon: 'history', title: isNew ? 'O histórico aparece depois do primeiro encontro' : 'Ainda não serviu em nenhum encontro concluído', text: 'Os números vêm dos encontros concluídos aqui e dos encontros anteriores informados acima.' }),
      ),
    );
  }

  // ---- Montagem ----
  const panels = { dados: panelDados, habilidades: skillGroups, perfil: profileGroup, preferencias: panelPreferences };
  const form = h('form', { class: 'person-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), save()) }, Object.entries(panels).map(([k, node]) => h('div', { class: 'tab-panel', id: `aba-${k}`, role: 'tabpanel', dataset: { tab: k } }, node)));
  /** Esta ficha tem alteração ainda não salva (vale para esta tela, não para a anterior). */
  let changed = false;
  for (const type of ['input', 'change']) form.addEventListener(type, () => (changed = true));
  const tabList = h(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Seções da ficha' },
    TABS.map((t) => h('button', { type: 'button', role: 'tab', class: 'tabs__tab', id: `tab-${t.id}`, 'aria-controls': `aba-${t.id}`, dataset: { tab: t.id }, onclick: () => showTab(t.id) }, t.label, t.id === 'historico' ? tabCount : null)),
  );
  const saveBar = h('div', { class: 'savebar' }, h('div', { class: 'savebar__inner' }, h('p', { class: 'savebar__text' }, isNew ? 'Preencha pelo menos o nome. O resto pode ser completado depois.' : 'Alterações ficam guardadas só depois de salvar.'), button('Cancelar', { variant: 'ghost', onClick: () => navigate('/pessoas') }), button(isNew ? 'Cadastrar pessoa' : 'Salvar ficha', { variant: 'primary', icon: 'check', type: 'submit', attrs: { form: 'person-form', 'data-action': 'save-person' } })));
  form.id = 'person-form';

  function showTab(next) {
    tab = next;
    for (const btn of tabList.querySelectorAll('[role=tab]')) {
      const active = btn.getAttribute('data-tab') === next;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    }
    for (const panel of [...form.querySelectorAll('.tab-panel'), historyPanel]) panel.hidden = panel.getAttribute('data-tab') !== next;
    // No histórico só se edita a lista de encontros anteriores: o botão aparece quando há o que salvar.
    saveBar.hidden = next === 'historico' && !changed;
    history.replaceState(null, '', `#/pessoas/${isNew ? 'nova' : person.id}${next === 'dados' ? '' : `?aba=${next}`}`);
  }

  /** Valores marcados (ou os da ficha, antes da aba ser desenhada). */
  function currentList(name) {
    return form?.querySelector(`input[name="${name}"]`) ? checkedValues(form, name) : (person[name] ?? []);
  }

  async function addOption(store, options, listName) {
    const created = await quickAddOption({ store, ...options });
    if (!created) return;
    const selected = [...currentList(listName), created.id];
    Object.assign(catalog, await loadCatalog());
    if (listName === 'skillIds') paintSkills(selected);
    else if (listName === 'characteristicIds') paintProfile(selected);
    else if (listName === 'pastoralIds') paintPastorals(selected);
    else paintAvailability(selected);
    form.dispatchEvent(new Event('change'));
    toast(`"${created.name}" criada e marcada na ficha.`);
  }

  async function save() {
    const values = readForm(form);
    const input = {
      ...person,
      name: values.name,
      birthDate: values.birthDate ?? '',
      phone: values.phone,
      email: values.email,
      instagram: values.instagram,
      notes: values.notes,
      preferenceNotes: values.preferenceNotes,
      availabilityStatus: values.availabilityStatus ?? '',
      skillIds: checkedValues(form, 'skillIds'),
      characteristicIds: checkedValues(form, 'characteristicIds'),
      pastoralIds: checkedValues(form, 'pastoralIds'),
      availabilityIds: checkedValues(form, 'availabilityIds'),
      preferredTeamIds: checkedValues(form, 'preferredTeamIds'),
      avoidTeamIds: checkedValues(form, 'avoidTeamIds'),
      pastServices: pastDraft,
    };
    const errors = validatePerson({ ...input, instagram: normalizeInstagram(input.instagram), email: clean(input.email) });
    const firstField = Object.keys(errors)[0];
    if (firstField) {
      showTab(FIELD_TAB[firstField] ?? 'dados');
      showErrors(form, errors);
      if (errors.pastServices) toastError(new AppError('invalid', errors.pastServices));
      return;
    }
    showErrors(form, {});
    const twins = stores.people.filter((p) => p.id !== person.id && p.nameKey === normalize(input.name));
    if (twins.length) {
      const ok = await confirmDialog({ title: 'Nome já cadastrado', message: `Já existe ${twins.map((p) => `${p.name}${p.phone ? ` (${p.phone})` : ''}`).join(', ')}. É outra pessoa com o mesmo nome?`, confirmLabel: 'Sim, é outra pessoa', cancelLabel: 'Voltar e conferir' });
      if (!ok) return;
    }
    try {
      const result = await savePerson(input, photoChange);
      if (result.replacedPhoto) forgetPhoto(result.replacedPhoto);
      markSaved();
      if (result.created) requestPersistence();
      toast(result.created ? `${result.record.name} cadastrada.` : 'Ficha salva.');
      if (result.created) navigate(`/pessoas/${result.record.id}`);
      else refresh();
    } catch (error) {
      if (error.fields) showErrors(form, error.fields);
      else toastError(error);
    }
  }

  const actions = isNew
    ? null
    : [
        person.status === 'arquivado'
          ? button('Reativar', { icon: 'undo', onClick: async () => { try { await setPersonStatus(person.id, 'ativo'); toast(`${person.name} reativada.`); refresh(); } catch (e) { toastError(e); } } })
          : button('Arquivar', { variant: 'ghost', icon: 'archive', onClick: () => archiveFlow(person) }),
        button('Excluir', { variant: 'ghost', icon: 'trash', onClick: () => deleteFlow(person) }),
      ];

  view.replaceChildren(
    h(
      'div',
      { class: 'page page--form' },
      pageHeader({
        back: { href: '/pessoas', label: 'Pessoas' },
        eyebrow: isNew ? 'Nova ficha' : person.status === 'arquivado' ? 'Ficha arquivada' : stats.events.size ? `${plural(stats.events.size, 'encontro servido', 'encontros servidos')}` : 'Ficha',
        title: isNew ? 'Nova pessoa' : person.name,
        lead: isNew ? null : [ageText(person.birthDate), person.createdAt && `Cadastrada em ${fmtDate(person.createdAt)}`].filter(Boolean).join(' · ') || null,
        actions,
      }),
      person.status === 'arquivado' ? h('div', { class: 'notice notice--info' }, icon('info', { size: 18 }), h('p', { class: 'notice__text' }, 'Ficha arquivada: não aparece nas listas nem nas sugestões de distribuição. O histórico continua intacto.')) : null,
      tabList,
      form,
      historyPanel,
      saveBar,
    ),
  );
  paintPhoto();
  paintPastorals();
  paintSkills();
  paintProfile();
  paintAvailability();
  paintHistory();
  showTab(tab);
  trackDirty(form);
}

function tile(label, value, note) {
  return h('div', { class: 'tile' }, h('span', { class: 'tile__value' }, String(value)), h('span', { class: 'tile__label' }, label), note && h('span', { class: 'tile__note' }, note));
}

async function archiveFlow(person) {
  const ok = await confirmDialog({ title: `Arquivar ${person.name}?`, message: 'A ficha sai das listas e das sugestões de distribuição. O histórico continua intacto e você pode reativar quando quiser.', confirmLabel: 'Arquivar' });
  if (!ok) return;
  try {
    await setPersonStatus(person.id, 'arquivado');
    toast(`${person.name} arquivada.`);
    refresh();
  } catch (error) {
    toastError(error);
  }
}

async function deleteFlow(person) {
  try {
    const usage = await personUsage(person.id);
    if (usage.keepsHistory) {
      const parts = [usage.history && plural(usage.history, 'registro de participação', 'registros de participação'), usage.coordinated.length && `coordenação em ${usage.coordinated.map((t) => t.name).join(', ')}`].filter(Boolean).join(' e ');
      const choice = await choiceDialog({
        title: 'Esta ficha tem histórico',
        message: `${person.name} tem ${parts}. Excluir apagaria parte da memória dos encontros, então a ficha só pode ser arquivada.`,
        choices: person.status === 'arquivado' ? [] : [{ value: 'archive', label: 'Arquivar ficha', variant: 'primary' }],
      });
      if (choice === 'archive') {
        await setPersonStatus(person.id, 'arquivado');
        toast(`${person.name} arquivada.`);
        refresh();
      }
      return;
    }
    const extra = [usage.allocations && `sai de ${plural(usage.allocations, 'distribuição', 'distribuições')} em encontros não concluídos`, usage.reference.length && `deixa de ser referência em ${usage.reference.map((t) => t.name).join(', ')}`].filter(Boolean);
    const choice = await choiceDialog({
      title: `Excluir ${person.name}?`,
      message: h('div', { class: 'stack-sm' }, h('p', null, 'A ficha e a foto serão apagadas deste aparelho. Isso não pode ser desfeito.'), extra.length ? h('p', null, `Também: ${extra.join('; ')}.`) : null, h('p', { class: 'muted' }, 'Se a pessoa só deixou de servir por um tempo, prefira arquivar.')),
      choices: [
        { value: 'archive', label: 'Arquivar' },
        { value: 'delete', label: 'Excluir definitivamente', variant: 'danger' },
      ],
    });
    if (choice === 'archive') {
      await setPersonStatus(person.id, 'arquivado');
      toast(`${person.name} arquivada.`);
      refresh();
    } else if (choice === 'delete') {
      const result = await deletePerson(person.id);
      if (result.photoId) forgetPhoto(result.photoId);
      markSaved();
      toast(`${person.name} excluída.`);
      navigate('/pessoas');
    }
  } catch (error) {
    toastError(error);
  }
}
