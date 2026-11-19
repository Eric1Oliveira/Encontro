// Relatórios com filtros, exportação CSV (abre no Excel) e versão para impressão.
import { readStores } from '../database.js';
import { EVENT_STATUS, ROLES, PARTICIPATION_STATUS, AVAILABILITY_STATUS } from '../schema.js';
import { h, button, pageHeader, emptyState, badge, teamChip, plural, fmtRange, fmtDate, fmtDateTime, downloadFile, stamp } from '../components/ui.js';
import { icon } from '../components/icons.js';
import { dataTable } from '../components/tables.js';
import { selectBox, filterBar, withAll } from '../components/filters.js';
import { navigate } from '../router.js';
import { buildStats, emptyStats, pastRecords, recordWhen } from './history.js';
import { loadCatalog } from './skills.js';

/** CSV com ; e BOM: abre com acentos corretos no Excel em português. */
export function toCSV(columns, rows) {
  const cell = (value) => {
    const text = String(value ?? '').replace(/\r?\n/g, ' ');
    return /[;"]/.test(text) || /^[=+\-@]/.test(text) ? `"${text.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : text;
  };
  return '﻿' + [columns.map((c) => cell(c.label)).join(';'), ...rows.map((r) => columns.map((c) => cell(c.text(r))).join(';'))].join('\r\n');
}

/**
 * Planilha .xlsx (Excel, Google Planilhas, celular) gerada no aparelho com o JSZip local.
 * Cabeçalho em negrito, fixo no topo e com filtro. `columns`: { label, text, width?, number? }.
 * @returns {Promise<Blob>}
 */
export async function toXLSX(columns, rows, sheetName = 'Planilha') {
  if (!globalThis.JSZip) throw new Error('O componente de planilha não carregou. Recarregue a página e tente de novo.');
  const xml = (text) => String(text ?? '').replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const col = (i) => (i >= 26 ? col(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
  const cell = (ref, value, style) => {
    const s = style ? ` s="${style}"` : '';
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
    const text = xml(value);
    return text ? `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>` : '';
  };
  const lines = [columns.map((c, i) => cell(`${col(i)}1`, c.label, 1)).join('')];
  const value = (c, row) => {
    const v = c.text(row);
    return c.number && v !== '' && v != null ? Number(v) : v;
  };
  rows.forEach((row, r) => lines.push(columns.map((c, i) => cell(`${col(i)}${r + 2}`, value(c, row))).join('')));
  const last = `${col(columns.length - 1)}${rows.length + 1}`;
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`).join('')}</cols><sheetData>${lines.map((cells, i) => `<row r="${i + 1}">${cells}</row>`).join('')}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  const zip = new globalThis.JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${col(columns.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D5A45"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  zip.file('xl/worksheets/sheet1.xml', sheet);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}

const by = (key) => (a, b) => String(key(a) ?? '').localeCompare(String(key(b) ?? ''), 'pt-BR', { numeric: true });

/**
 * Cada relatório declara filtros e devolve colunas (com `text` para o CSV) e linhas.
 * `ctx` traz os dados já carregados.
 */
const REPORTS = [
  {
    id: 'pessoas-por-equipe',
    title: 'Pessoas por equipe',
    description: 'Quem já serviu em cada equipe, com o número de participações e coordenações.',
    filters: ['team'],
    build(ctx, f) {
      const rows = [];
      for (const [personId, s] of ctx.stats) for (const [teamId, t] of s.byTeam) if (!f.team || f.team === teamId) rows.push({ person: ctx.people.get(personId), personName: ctx.people.get(personId)?.name ?? s.records[0].personName, team: { name: ctx.teams.get(teamId)?.name ?? t.name, color: ctx.teams.get(teamId)?.color ?? t.color, icon: ctx.teams.get(teamId)?.icon ?? t.icon }, count: t.count, coordinations: t.coordinations });
      rows.sort((a, b) => by((r) => r.team.name)(a, b) || b.count - a.count || by((r) => r.personName)(a, b));
      return {
        rows,
        columns: [
          { key: 'team', label: 'Equipe', text: (r) => r.team.name, render: (r) => teamChip(r.team, { small: true }), sortValue: (r) => r.team.name },
          { key: 'person', label: 'Pessoa', primary: true, text: (r) => r.personName, sortValue: (r) => r.personName },
          { key: 'count', label: 'Participações', align: 'end', text: (r) => r.count, sortValue: (r) => r.count, defaultDir: 'desc' },
          { key: 'coord', label: 'Coordenações', align: 'end', text: (r) => r.coordinations, sortValue: (r) => r.coordinations, defaultDir: 'desc' },
        ],
      };
    },
  },
  {
    id: 'pessoas-por-habilidade',
    title: 'Pessoas por habilidade',
    description: 'Quem tem cada habilidade, com contato e experiência.',
    filters: ['skill', 'category', 'status'],
    build(ctx, f) {
      const rows = [];
      for (const p of ctx.peopleList) {
        if (f.status && p.status !== f.status) continue;
        for (const skillId of p.skillIds) {
          const skill = ctx.catalog.skillsById.get(skillId);
          if (!skill || (f.skill && f.skill !== skillId) || (f.category && f.category !== skill.categoryId)) continue;
          rows.push({ p, skill, category: ctx.catalog.categoriesById.get(skill.categoryId)?.name ?? '—', events: ctx.statOf(p.id).events.size });
        }
      }
      rows.sort((a, b) => by((r) => r.skill.name)(a, b) || by((r) => r.p.name)(a, b));
      return {
        rows,
        columns: [
          { key: 'skill', label: 'Habilidade', text: (r) => r.skill.name, sortValue: (r) => r.skill.name },
          { key: 'category', label: 'Categoria', hideSm: true, text: (r) => r.category, sortValue: (r) => r.category },
          { key: 'name', label: 'Pessoa', primary: true, text: (r) => r.p.name, sortValue: (r) => r.p.name },
          { key: 'phone', label: 'Telefone', text: (r) => r.p.phone },
          { key: 'events', label: 'Encontros servidos', align: 'end', text: (r) => r.events, sortValue: (r) => r.events, defaultDir: 'desc' },
        ],
      };
    },
  },
  {
    id: 'historico-individual',
    title: 'Histórico individual',
    description: 'Todas as participações de uma pessoa, encontro por encontro.',
    filters: ['person'],
    required: 'person',
    build(ctx, f) {
      const rows = ctx.history.filter((r) => r.personId === f.person).sort(by((r) => r.eventStart)).reverse();
      return {
        rows,
        summary: (() => {
          const s = ctx.statOf(f.person);
          return `${plural(s.events.size, 'encontro servido', 'encontros servidos')} · ${plural(s.participations, 'participação em equipe', 'participações em equipes')} · ${plural(s.coordinations, 'coordenação', 'coordenações')}`;
        })(),
        columns: eventRows(),
      };
    },
  },
  {
    id: 'historico-por-encontro',
    title: 'Histórico por encontro',
    description: 'Quem serviu em cada equipe de um encontro concluído.',
    filters: ['event'],
    required: 'event',
    build(ctx, f) {
      const rows = ctx.history.filter((r) => r.eventId === f.event).sort((a, b) => by((r) => r.teamName)(a, b) || (a.role === b.role ? by((r) => ctx.nameOf(r))(a, b) : a.role === 'coordenador' ? -1 : 1));
      const served = new Set(rows.filter((r) => r.status === 'confirmada').map((r) => r.personId)).size;
      return {
        rows,
        summary: `${plural(served, 'pessoa serviu', 'pessoas serviram')} · ${plural(new Set(rows.map((r) => r.teamId)).size, 'equipe', 'equipes')}`,
        columns: [
          { key: 'team', label: 'Equipe', text: (r) => r.teamName, render: (r) => teamChip({ name: r.teamName, color: r.teamColor, icon: r.teamIcon }, { small: true }), sortValue: (r) => r.teamName },
          { key: 'person', label: 'Pessoa', primary: true, text: (r) => ctx.nameOf(r), sortValue: (r) => ctx.nameOf(r) },
          { key: 'role', label: 'Função', text: (r) => ROLES[r.role], render: (r) => (r.role === 'coordenador' ? badge(ROLES.coordenador, 'gold') : ROLES.integrante), sortValue: (r) => r.role },
          { key: 'status', label: 'Situação', text: (r) => PARTICIPATION_STATUS[r.status], sortValue: (r) => r.status },
        ],
      };
    },
  },
  {
    id: 'coordenacao',
    title: 'Histórico de coordenação',
    description: 'Coordenações confirmadas nos encontros e períodos de coordenação no cadastro de cada equipe.',
    filters: ['team'],
    build(ctx, f) {
      const rows = [
        ...ctx.history.filter((r) => r.role === 'coordenador' && r.status === 'confirmada' && (!f.team || r.teamId === f.team)).map((r) => ({ source: r.manual ? 'Informado na ficha' : 'Encontro', teamName: r.teamName || 'Equipe não informada', team: { name: r.teamName || 'Equipe não informada', color: r.teamColor, icon: r.teamIcon }, person: ctx.nameOf(r), period: `${r.eventName} (${recordWhen(r)})`, sort: r.eventStart })),
        ...ctx.teamList.filter((t) => !f.team || t.id === f.team).flatMap((t) => t.coordinators.map((c) => ({ source: 'Cadastro da equipe', teamName: t.name, team: t, person: ctx.people.get(c.personId)?.name ?? 'Ficha removida', period: `${fmtDate(c.since)} – ${c.until ? fmtDate(c.until) : 'atual'}`, sort: c.since }))),
      ].sort((a, b) => by((r) => r.teamName)(a, b) || String(b.sort).localeCompare(String(a.sort)));
      return {
        rows,
        columns: [
          { key: 'team', label: 'Equipe', text: (r) => r.teamName, render: (r) => teamChip(r.team, { small: true }), sortValue: (r) => r.teamName },
          { key: 'person', label: 'Pessoa', primary: true, text: (r) => r.person, sortValue: (r) => r.person },
          { key: 'period', label: 'Quando', text: (r) => r.period, sortValue: (r) => r.sort },
          { key: 'source', label: 'Origem', hideSm: true, text: (r) => r.source, sortValue: (r) => r.source },
        ],
      };
    },
  },
  {
    id: 'nunca-serviram',
    title: 'Pessoas que ainda não serviram',
    description: 'Pessoas ativas sem nenhuma participação confirmada — bom ponto de partida para convidar.',
    filters: ['skill'],
    build(ctx, f) {
      const rows = ctx.peopleList.filter((p) => p.status === 'ativo' && !ctx.statOf(p.id).events.size && (!f.skill || p.skillIds.includes(f.skill))).sort(by((p) => p.name));
      return {
        rows,
        columns: [
          { key: 'name', label: 'Pessoa', primary: true, text: (p) => p.name, sortValue: (p) => p.name },
          { key: 'phone', label: 'Telefone', text: (p) => p.phone },
          { key: 'skills', label: 'Habilidades', text: (p) => p.skillIds.map((id) => ctx.catalog.skillsById.get(id)?.name).filter(Boolean).join(', ') },
          { key: 'pref', label: 'Equipes de interesse', hideSm: true, text: (p) => p.preferredTeamIds.map((id) => ctx.teams.get(id)?.name).filter(Boolean).join(', ') },
          { key: 'availability', label: 'Disponibilidade', hideSm: true, text: (p) => AVAILABILITY_STATUS[p.availabilityStatus ?? ''] },
          { key: 'created', label: 'Cadastro', hideSm: true, text: (p) => fmtDate(p.createdAt), sortValue: (p) => p.createdAt },
        ],
      };
    },
  },
  {
    id: 'distribuicao',
    title: 'Distribuição de voluntários',
    description: 'Composição de cada equipe num encontro (inclusive em planejamento), com quem está em mais de uma equipe.',
    filters: ['anyEvent'],
    required: 'anyEvent',
    build(ctx, f) {
      const list = ctx.allocations.filter((a) => a.eventId === f.anyEvent);
      const eventTeams = ctx.eventTeams.filter((t) => t.eventId === f.anyEvent);
      const count = new Map();
      for (const a of list) count.set(a.personId, (count.get(a.personId) ?? 0) + 1);
      const rows = list.map((a) => ({ a, team: eventTeams.find((t) => t.teamId === a.teamId), person: ctx.people.get(a.personId) })).sort((x, y) => (x.team?.order ?? 0) - (y.team?.order ?? 0) || (x.a.role === y.a.role ? by((r) => r.person?.name)(x, y) : x.a.role === 'coordenador' ? -1 : 1));
      const event = ctx.events.get(f.anyEvent);
      const target = eventTeams.reduce((s, t) => s + (t.targetSize ?? 0), 0);
      return {
        rows,
        summary: `${EVENT_STATUS[event.status].label} · ${plural(eventTeams.length, 'equipe', 'equipes')} · ${plural(count.size, 'pessoa', 'pessoas')}${target ? ` para ${target} vagas` : ''} · ${plural([...count.values()].filter((n) => n > 1).length, 'pessoa em mais de uma equipe', 'pessoas em mais de uma equipe')}`,
        columns: [
          { key: 'team', label: 'Equipe', text: (r) => r.team?.name, render: (r) => teamChip(r.team, { small: true }), sortValue: (r) => r.team?.name },
          { key: 'person', label: 'Pessoa', primary: true, text: (r) => r.person?.name ?? '—', sortValue: (r) => r.person?.name },
          { key: 'role', label: 'Função', text: (r) => ROLES[r.a.role], render: (r) => (r.a.role === 'coordenador' ? badge(ROLES.coordenador, 'gold') : ROLES.integrante), sortValue: (r) => r.a.role },
          { key: 'phone', label: 'Telefone', hideSm: true, text: (r) => r.person?.phone ?? '' },
          { key: 'multi', label: 'Outras equipes', text: (r) => (count.get(r.a.personId) > 1 ? `Sim (${count.get(r.a.personId)})` : ''), render: (r) => (count.get(r.a.personId) > 1 ? badge(`${count.get(r.a.personId)} equipes`, 'warn') : '—') },
        ],
      };
    },
  },
];

function eventRows() {
  return [
    { key: 'event', label: 'Encontro', primary: true, text: (r) => r.eventName, sortValue: (r) => r.eventStart },
    { key: 'date', label: 'Data', text: (r) => recordWhen(r), sortValue: (r) => r.eventStart },
    { key: 'team', label: 'Equipe', text: (r) => r.teamName || 'Não informada', render: (r) => (r.teamName ? teamChip({ name: r.teamName, color: r.teamColor, icon: r.teamIcon }, { small: true }) : h('span', { class: 'muted' }, 'Não informada')), sortValue: (r) => r.teamName },
    { key: 'role', label: 'Função', text: (r) => ROLES[r.role], render: (r) => (r.role === 'coordenador' ? badge(ROLES.coordenador, 'gold') : ROLES.integrante), sortValue: (r) => r.role },
    { key: 'status', label: 'Situação', text: (r) => (r.manual ? 'Serviu (informado na ficha)' : PARTICIPATION_STATUS[r.status]), sortValue: (r) => r.status },
  ];
}

async function loadContext() {
  const [stores, catalog] = await Promise.all([readStores(['people', 'teams', 'events', 'eventTeams', 'allocations', 'participationHistory']), loadCatalog()]);
  const stats = buildStats(stores.participationHistory, stores.people);
  const people = new Map(stores.people.map((p) => [p.id, p]));
  return {
    catalog,
    stats,
    statOf: (id) => stats.get(id) ?? emptyStats(),
    people,
    peopleList: stores.people,
    teams: new Map(stores.teams.map((t) => [t.id, t])),
    teamList: stores.teams,
    events: new Map(stores.events.map((e) => [e.id, e])),
    eventList: stores.events,
    eventTeams: stores.eventTeams,
    allocations: stores.allocations,
    /** Histórico dos encontros + encontros anteriores informados nas fichas (`manual: true`). */
    history: [...stores.participationHistory, ...pastRecords(stores.people)],
    nameOf: (r) => people.get(r.personId)?.name ?? r.personName,
  };
}

// ---------- Telas ----------

export function renderReportIndex(view) {
  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({ eyebrow: 'Exportação em CSV e impressão', title: 'Relatórios', lead: 'Todos os números vêm do histórico confirmado e da distribuição dos encontros.' }),
      h('div', { class: 'report-grid' }, REPORTS.map((r) => h('a', { class: 'report-card', href: `#/relatorios/${r.id}` }, h('span', { class: 'report-card__title' }, r.title), h('span', { class: 'report-card__text' }, r.description), h('span', { class: 'report-card__go' }, 'Abrir', icon('chevron-right', { size: 16 }))))),
    ),
  );
}

const filterState = new Map();

export async function renderReport(view, { id }) {
  const report = REPORTS.find((r) => r.id === id);
  if (!report) {
    navigate('/relatorios', { replace: true });
    return;
  }
  const ctx = await loadContext();
  const f = filterState.get(id) ?? {};
  filterState.set(id, f);

  const concluded = ctx.eventList.filter((e) => ctx.history.some((r) => r.eventId === e.id)).sort(by((e) => e.startDate)).reverse();
  const options = {
    team: () => selectBox({ label: 'Equipe', value: f.team ?? '', options: withAll('Todas', ctx.teamList.map((t) => ({ value: t.id, label: t.name })).sort(by((o) => o.label))), onChange: set('team') }),
    skill: () => selectBox({ label: 'Habilidade', value: f.skill ?? '', options: withAll('Todas', ctx.catalog.skills.map((s) => ({ value: s.id, label: s.name, group: ctx.catalog.categoriesById.get(s.categoryId)?.name ?? 'Outras' }))), onChange: set('skill') }),
    category: () => selectBox({ label: 'Categoria', value: f.category ?? '', options: withAll('Todas', ctx.catalog.categories.map((c) => ({ value: c.id, label: c.name }))), onChange: set('category') }),
    status: () => selectBox({ label: 'Situação', value: f.status ?? 'ativo', options: [{ value: 'ativo', label: 'Ativas' }, { value: 'arquivado', label: 'Arquivadas' }, { value: '', label: 'Todas' }], onChange: set('status') }),
    person: () => selectBox({ label: 'Pessoa', value: f.person ?? '', options: withAll('Escolha uma pessoa', ctx.peopleList.map((p) => ({ value: p.id, label: p.name })).sort(by((o) => o.label))), onChange: set('person') }),
    event: () => selectBox({ label: 'Encontro', value: f.event ?? '', options: withAll('Escolha um encontro', concluded.map((e) => ({ value: e.id, label: `${e.name} (${fmtRange(e.startDate, e.endDate)})` }))), onChange: set('event') }),
    anyEvent: () => selectBox({ label: 'Encontro', value: f.anyEvent ?? '', options: withAll('Escolha um encontro', [...ctx.eventList].sort(by((e) => e.startDate)).reverse().map((e) => ({ value: e.id, label: `${e.name} · ${EVENT_STATUS[e.status].label}` }))), onChange: set('anyEvent') }),
  };
  if (report.filters.includes('status') && f.status === undefined) f.status = 'ativo';

  const body = h('div', { class: 'stack' });
  const printMeta = h('p', { class: 'print-head__meta' });
  let current = null;

  function set(key) {
    return (value) => {
      f[key] = value;
      paint();
    };
  }

  function filterText() {
    const labels = { team: (v) => ctx.teams.get(v)?.name, skill: (v) => ctx.catalog.skillsById.get(v)?.name, category: (v) => ctx.catalog.categoriesById.get(v)?.name, person: (v) => ctx.people.get(v)?.name, event: (v) => ctx.events.get(v)?.name, anyEvent: (v) => ctx.events.get(v)?.name, status: (v) => ({ ativo: 'ativas', arquivado: 'arquivadas' })[v] };
    return report.filters.filter((k) => f[k]).map((k) => labels[k](f[k])).filter(Boolean).join(' · ');
  }

  function paint() {
    printMeta.textContent = [filterText(), `Gerado em ${fmtDateTime(new Date().toISOString())}`].filter(Boolean).join(' · ');
    if (report.required && !f[report.required]) {
      current = null;
      body.replaceChildren(emptyState({ icon: 'search', title: report.required === 'person' ? 'Escolha uma pessoa' : 'Escolha um encontro', text: 'Use o filtro acima para montar o relatório.' }));
      return;
    }
    current = report.build(ctx, f);
    body.replaceChildren(
      h('p', { class: 'result-count' }, current.summary ?? plural(current.rows.length, 'linha', 'linhas')),
      current.rows.length ? dataTable({ rows: current.rows, columns: current.columns.map((c) => ({ ...c, render: c.render ?? ((row) => String(c.text(row) ?? '') || '—') })) }) : emptyState({ icon: 'search', title: 'Nada para mostrar com esses filtros' }),
    );
  }

  const exportCsv = () => {
    if (!current?.rows.length) return;
    downloadFile(new Blob([toCSV(current.columns, current.rows)], { type: 'text/csv;charset=utf-8' }), `${report.id}-${stamp()}.csv`);
  };

  view.replaceChildren(
    h(
      'div',
      { class: 'page report-page' },
      h('div', { class: 'print-head' }, h('p', { class: 'print-head__eyebrow' }, 'Encontro · Relatório'), h('h2', { class: 'print-head__title' }, report.title), printMeta),
      pageHeader({
        back: { href: '/relatorios', label: 'Relatórios' },
        eyebrow: 'Relatório',
        title: report.title,
        lead: report.description,
        actions: [button('Exportar CSV', { icon: 'download', onClick: exportCsv, attrs: { 'data-action': 'csv' } }), button('Imprimir', { icon: 'printer', onClick: () => window.print() })],
      }),
      report.filters.length ? filterBar(...report.filters.map((k) => options[k]())) : null,
      body,
    ),
  );
  paint();
}
