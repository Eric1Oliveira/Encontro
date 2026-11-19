// Habilidades (por categoria), características pessoais e opções de disponibilidade.
// Opções em uso nunca são apagadas: são desativadas e continuam nas fichas.
import { transaction, req, readStores, uid, nowISO, AppError } from '../database.js';
import { AREAS, areaLabel, CHARACTERISTIC_GROUPS } from '../schema.js';
import { normalize, clean } from '../validation.js';
import { h, button, pageHeader, badge, plural, section } from '../components/ui.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { field, readForm, showErrors, segmented } from '../components/forms.js';
import { toast, toastError } from '../components/toast.js';
import { refresh } from '../router.js';

// ---------- Leitura ----------

/** Catálogo completo em ordem, com mapas por id. */
export async function loadCatalog() {
  const { categories, skills, characteristics } = await readStores(['categories', 'skills', 'characteristics']);
  const byOrder = (a, b) => a.order - b.order || a.name.localeCompare(b.name, 'pt-BR');
  categories.sort(byOrder);
  skills.sort(byOrder);
  characteristics.sort(byOrder);
  return {
    categories,
    skills,
    characteristics,
    profile: characteristics.filter((c) => c.group === 'perfil'),
    availability: characteristics.filter((c) => c.group === 'disponibilidade'),
    pastorals: characteristics.filter((c) => c.group === 'pastoral'),
    skillsById: new Map(skills.map((s) => [s.id, s])),
    categoriesById: new Map(categories.map((c) => [c.id, c])),
    characteristicsById: new Map(characteristics.map((c) => [c.id, c])),
  };
}

/** Nome legível de qualquer opção (habilidade ou característica). */
export function optionNames(catalog) {
  return new Map([...catalog.skills, ...catalog.characteristics].map((o) => [o.id, o.name]));
}

// ---------- Escrita ----------

function assertName(name) {
  const value = clean(name);
  if (value.length < 2) throw new AppError('invalid', 'Use pelo menos 2 letras.');
  if (value.length > 60) throw new AppError('invalid', 'Use no máximo 60 caracteres.');
  return value;
}

export async function saveCategory({ id, name, area }) {
  const value = assertName(name);
  if (!AREAS.some((a) => a.id === area)) throw new AppError('invalid', 'Escolha a área da categoria.');
  return transaction(['categories'], 'readwrite', async (s) => {
    const all = await req(s.categories.getAll());
    if (all.some((c) => c.id !== id && c.nameKey === normalize(value))) throw new AppError('duplicate', `Já existe a categoria "${value}".`);
    const now = nowISO();
    const before = id ? all.find((c) => c.id === id) : null;
    const record = before ? { ...before, name: value, nameKey: normalize(value), area, updatedAt: now } : { id: uid(), name: value, nameKey: normalize(value), area, active: true, order: all.length, createdAt: now, updatedAt: now };
    s.categories.put(record);
    return record;
  });
}

/** Cria ou renomeia uma habilidade (store 'skills', com categoryId) ou característica (store 'characteristics', com group). */
export async function saveOption(store, { id, name, categoryId, group }) {
  const value = assertName(name);
  return transaction([store, 'categories'], 'readwrite', async (s) => {
    const all = await req(s[store].getAll());
    const before = id ? all.find((o) => o.id === id) : null;
    const scope = store === 'skills' ? (o) => o.categoryId === (categoryId ?? before?.categoryId) : (o) => o.group === (group ?? before?.group);
    if (store === 'skills' && !(await req(s.categories.get(categoryId ?? before?.categoryId)))) throw new AppError('invalid', 'Categoria não encontrada.');
    const twin = all.find((o) => o.id !== id && scope(o) && o.nameKey === normalize(value));
    if (twin) throw new AppError('duplicate', `"${twin.name}" já existe aqui${twin.active ? '' : ' (desativada — reative em vez de criar outra)'}.`);
    const now = nowISO();
    const record = before
      ? { ...before, name: value, nameKey: normalize(value), updatedAt: now }
      : { id: uid(), ...(store === 'skills' ? { categoryId } : { group }), name: value, nameKey: normalize(value), active: true, order: all.filter(scope).length, createdAt: now, updatedAt: now };
    s[store].put(record);
    return record;
  });
}

export async function setActive(store, id, active) {
  return transaction([store], 'readwrite', async (s) => {
    const record = await req(s[store].get(id));
    if (!record) throw new AppError('not_found', 'Opção não encontrada.');
    s[store].put({ ...record, active, updatedAt: nowISO() });
  });
}

/** Quantas fichas e equipes usam cada opção. */
export async function optionUsage() {
  const { people, teamRequirements } = await readStores(['people', 'teamRequirements']);
  const usage = new Map();
  const bump = (id, key) => {
    const u = usage.get(id) ?? { people: 0, teams: 0 };
    u[key]++;
    usage.set(id, u);
  };
  for (const p of people) for (const id of [...p.skillIds, ...p.characteristicIds, ...p.availabilityIds, ...(p.pastoralIds ?? [])]) bump(id, 'people');
  for (const r of teamRequirements) bump(r.refId, 'teams');
  return usage;
}

/** Exclui só o que ninguém usa. */
export async function deleteOption(store, id) {
  return transaction([store, 'people', 'teamRequirements', 'skills'], 'readwrite', async (s) => {
    if (store === 'categories') {
      const children = await req(s.skills.index('categoryId').count(id));
      if (children) throw new AppError('in_use', 'Esta categoria ainda tem habilidades. Exclua ou desative as habilidades primeiro.');
    } else {
      const people = await req(s.people.getAll());
      const field = store === 'skills' ? 'skillIds' : null;
      const used = people.some((p) => (field ? p[field].includes(id) : p.characteristicIds.includes(id) || p.availabilityIds.includes(id) || (p.pastoralIds ?? []).includes(id)));
      const required = (await req(s.teamRequirements.getAll())).some((r) => r.refId === id);
      if (used || required) throw new AppError('in_use', 'Esta opção está em uso em fichas ou equipes. Desative-a: ela some das novas escolhas e continua onde já foi marcada.');
    }
    s[store].delete(id);
  });
}

// ---------- Diálogos reutilizados pela ficha ----------

/** Pede um nome e cria a opção. Resolve com o registro criado (ou null). */
export function quickAddOption({ store, categoryId, group, title }) {
  return new Promise((resolve) => {
    let created = null;
    const form = h('form', { class: 'form', novalidate: true, onsubmit: (e) => (e.preventDefault(), modal.dialog.querySelector('[data-action="save"]')?.click()) }, field({ label: 'Nome', name: 'name', required: true, attrs: { maxlength: '60', autofocus: true } }));
    const modal = openModal({
      title,
      size: 'sm',
      body: form,
      onClose: () => resolve(created),
      actions: [
        { label: 'Cancelar', variant: 'ghost' },
        {
          label: 'Adicionar',
          variant: 'primary',
          id: 'save',
          onClick: async () => {
            const { name } = readForm(form);
            try {
              created = await saveOption(store, { name, categoryId, group });
            } catch (error) {
              showErrors(form, { name: error.message });
              return false;
            }
          },
        },
      ],
    });
  });
}

function categoryDialog(category) {
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    field({ label: 'Nome da categoria', name: 'name', value: category?.name, required: true, attrs: { maxlength: '60' } }),
    h('div', { class: 'field', dataset: { field: 'area' } }, h('span', { class: 'field__label' }, 'Área'), segmented({ name: 'area', label: 'Área', value: category?.area ?? 'outra', options: AREAS.map((a) => ({ value: a.id, label: a.label })) }), h('p', { class: 'field__hint' }, 'A área separa habilidades musicais, técnicas, religiosas, administrativas e de comunicação.'), h('p', { class: 'field__error', hidden: true })),
  );
  openModal({
    title: category ? 'Editar categoria' : 'Nova categoria de habilidades',
    body: form,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: category ? 'Salvar categoria' : 'Criar categoria',
        variant: 'primary',
        onClick: async () => {
          const data = readForm(form);
          try {
            await saveCategory({ id: category?.id, name: data.name, area: data.area });
          } catch (error) {
            showErrors(form, { name: error.message });
            return false;
          }
          toast(category ? 'Categoria salva.' : 'Categoria criada.');
          refresh();
        },
      },
    ],
  });
}

function renameDialog(store, option) {
  const form = h('form', { class: 'form', novalidate: true }, field({ label: 'Nome', name: 'name', value: option.name, required: true, attrs: { maxlength: '60' } }));
  openModal({
    title: 'Renomear opção',
    lead: 'O novo nome aparece em todas as fichas que já usam esta opção.',
    size: 'sm',
    body: form,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: 'Salvar nome',
        variant: 'primary',
        onClick: async () => {
          try {
            await saveOption(store, { id: option.id, name: readForm(form).name });
          } catch (error) {
            showErrors(form, { name: error.message });
            return false;
          }
          toast('Nome atualizado.');
          refresh();
        },
      },
    ],
  });
}

// ---------- Tela ----------

let tab = 'habilidades';

export async function renderCatalog(view) {
  const [catalog, usage] = await Promise.all([loadCatalog(), optionUsage()]);

  const run = async (work, message) => {
    try {
      await work();
      if (message) toast(message);
      refresh();
    } catch (error) {
      toastError(error);
    }
  };

  const optionRow = (store, option) => {
    const used = usage.get(option.id) ?? { people: 0, teams: 0 };
    const usageText = [used.people && plural(used.people, 'ficha', 'fichas'), used.teams && plural(used.teams, 'equipe', 'equipes')].filter(Boolean).join(' · ') || 'Sem uso';
    return h(
      'li',
      { class: ['option-row', !option.active && 'is-inactive'] },
      h('span', { class: 'option-row__name' }, option.name, !option.active && badge('Desativada', 'muted')),
      h('span', { class: 'option-row__usage' }, usageText),
      h(
        'span',
        { class: 'option-row__actions' },
        button('', { variant: 'ghost', small: true, icon: 'edit', title: `Renomear ${option.name}`, onClick: () => renameDialog(store, option) }),
        button(option.active ? 'Desativar' : 'Reativar', { variant: 'ghost', small: true, onClick: () => run(() => setActive(store, option.id, !option.active), option.active ? `"${option.name}" desativada.` : `"${option.name}" reativada.`) }),
        !used.people && !used.teams && button('', { variant: 'ghost', small: true, icon: 'trash', title: `Excluir ${option.name}`, onClick: async () => (await confirmDialog({ title: `Excluir "${option.name}"?`, message: 'Ninguém usa esta opção. Ela será apagada.', confirmLabel: 'Excluir', danger: true })) && run(() => deleteOption(store, option.id), 'Opção excluída.') }),
      ),
    );
  };

  const inlineAdd = (store, extra, placeholder) => {
    const input = h('input', { type: 'text', class: 'inline-add__input', placeholder, maxlength: '60', 'aria-label': placeholder });
    const submit = async (event) => {
      event.preventDefault();
      if (!clean(input.value)) return input.focus();
      try {
        const created = await saveOption(store, { name: input.value, ...extra });
        toast(`"${created.name}" adicionada.`);
        refresh();
      } catch (error) {
        toastError(error);
      }
    };
    return h('form', { class: 'inline-add', novalidate: true, onsubmit: submit }, input, button('Adicionar', { type: 'submit', small: true, icon: 'plus' }));
  };

  const skillsPanel = () =>
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, `${plural(catalog.categories.length, 'categoria', 'categorias')} · ${plural(catalog.skills.length, 'habilidade', 'habilidades')}`), button('Nova categoria', { variant: 'primary', icon: 'plus', onClick: () => categoryDialog() })),
      h(
        'div',
        { class: 'catalog-grid' },
        catalog.categories.map((category) => {
          const items = catalog.skills.filter((s) => s.categoryId === category.id);
          return section(
            category.name,
            {
              className: ['catalog-card', !category.active && 'is-inactive'].filter(Boolean).join(' '),
              lead: `${areaLabel(category.area)} · ${plural(items.length, 'opção', 'opções')}${category.active ? '' : ' · categoria desativada'}`,
              actions: [
                button('', { variant: 'ghost', small: true, icon: 'edit', title: `Editar ${category.name}`, onClick: () => categoryDialog(category) }),
                button(category.active ? 'Desativar' : 'Reativar', { variant: 'ghost', small: true, onClick: () => run(() => setActive('categories', category.id, !category.active), category.active ? 'Categoria desativada.' : 'Categoria reativada.') }),
                !items.length && button('', { variant: 'ghost', small: true, icon: 'trash', title: `Excluir ${category.name}`, onClick: () => run(() => deleteOption('categories', category.id), 'Categoria excluída.') }),
              ],
            },
            items.length ? h('ul', { class: 'option-list' }, items.map((s) => optionRow('skills', s))) : h('p', { class: 'muted' }, 'Nenhuma habilidade nesta categoria ainda.'),
            inlineAdd('skills', { categoryId: category.id }, `Nova habilidade em ${category.name}`),
          );
        }),
      ),
    );

  const groupPanel = (group) => {
    const items = catalog.characteristics.filter((c) => c.group === group);
    return section(
      CHARACTERISTIC_GROUPS[group].label,
      { lead: CHARACTERISTIC_GROUPS[group].hint, className: 'catalog-card catalog-card--wide' },
      items.length ? h('ul', { class: 'option-list' }, items.map((c) => optionRow('characteristics', c))) : h('p', { class: 'muted' }, 'Nenhuma opção ainda.'),
      inlineAdd('characteristics', { group }, { perfil: 'Nova característica (ex.: Paciente)', disponibilidade: 'Nova opção (ex.: Domingo à tarde)', pastoral: 'Nova pastoral (ex.: Pastoral Carcerária)' }[group]),
    );
  };

  const panel = h('div');
  const paint = () => panel.replaceChildren(tab === 'habilidades' ? skillsPanel() : groupPanel(tab));
  paint();

  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({
        eyebrow: 'Configuração',
        title: 'Habilidades e perfis',
        lead: 'As opções que aparecem nas fichas e nos requisitos das equipes. Não há limite de opções. Desativar tira a opção das novas escolhas sem apagar nada das fichas.',
      }),
      segmented({
        name: 'catalog-tab',
        label: 'Tipo de opção',
        value: tab,
        options: [
          { value: 'habilidades', label: 'Habilidades' },
          { value: 'perfil', label: 'Perfil pessoal' },
          { value: 'disponibilidade', label: 'Disponibilidade' },
          { value: 'pastoral', label: 'Pastorais' },
        ],
        onChange: (v) => ((tab = v), paint()),
      }),
      panel,
    ),
  );
}
