// Início: próximo encontro, números gerais, experiência, quem ainda não serviu e distribuições.
import { readStores } from '../database.js';
import { EVENT_STATUS } from '../schema.js';
import { h, button, avatar, badge, plural, fmtRange, emptyState, section } from '../components/ui.js';
import { icon } from '../components/icons.js';
import { buildStats } from './history.js';
import { beads } from './people.js';
import { loadCatalog } from './skills.js';
import { eventDialog } from './events.js';

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86400000);
}

function barList(rows, { empty }) {
  if (!rows.length) return h('p', { class: 'muted' }, empty);
  const max = Math.max(...rows.map((r) => r.value), 1);
  return h(
    'ul',
    { class: 'bars' },
    rows.map((r) => h('li', { class: 'bars__row', style: { '--bar': r.color ?? 'var(--primary)', '--size': String(r.value / max) } }, h('span', { class: 'bars__label' }, r.label), h('span', { class: 'bars__track', 'aria-hidden': 'true' }, h('span', { class: 'bars__fill' })), h('span', { class: 'bars__value num' }, r.value))),
  );
}

export async function renderDashboard(view) {
  const [stores, catalog] = await Promise.all([readStores(['people', 'teams', 'events', 'eventTeams', 'allocations', 'participationHistory']), loadCatalog()]);
  const { people, teams, events, eventTeams, allocations, participationHistory } = stores;
  const stats = buildStats(participationHistory);
  const active = people.filter((p) => p.status === 'ativo');
  const realized = events.filter((e) => ['concluido', 'reaberto'].includes(e.status));
  const open = events.filter((e) => ['planejamento', 'em_andamento'].includes(e.status)).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const confirmed = participationHistory.filter((r) => r.status === 'confirmada');
  const never = active.filter((p) => !stats.get(p.id)?.events.size);
  const experienced = active.filter((p) => stats.get(p.id)?.events.size).sort((a, b) => stats.get(b.id).events.size - stats.get(a.id).events.size || stats.get(b.id).participations - stats.get(a.id).participations).slice(0, 6);
  const now = new Date();
  const greeting = `${WEEKDAYS[now.getDay()]}, ${now.getDate()} de ${MONTHS[now.getMonth()]}`;

  // Primeiro uso: um caminho claro em vez de um painel vazio.
  if (!people.length && !teams.length && !events.length) {
    const step = (done, title, text, href, label) => h('li', { class: ['first-step', done && 'is-done'] }, h('span', { class: 'first-step__mark' }, done ? icon('check', { size: 16 }) : null), h('div', null, h('h3', null, title), h('p', null, text)), h('a', { class: 'btn btn--secondary btn--sm', href }, label));
    view.replaceChildren(
      h(
        'div',
        { class: 'page' },
        h('header', { class: 'welcome' }, h('p', { class: 'eyebrow' }, greeting), h('h1', { class: 'welcome__title' }, 'Bem-vindo ao Encontro'), h('p', { class: 'page-lead' }, 'Cadastre as pessoas e as equipes uma única vez. Em cada encontro, monte o quadrante; ao concluir, o histórico de quem serviu se forma sozinho.')),
        h('ol', { class: 'first-steps' }, step(false, 'Cadastre as equipes', 'Música, Liturgia, Cozinha, Secretaria… com cor, ícone e o que cada uma procura.', '#/equipes', 'Ir para equipes'), step(false, 'Cadastre as pessoas', 'Dados, habilidades, perfil e preferências de cada voluntário.', '#/pessoas/nova', 'Cadastrar pessoa'), step(false, 'Crie o encontro', 'Adicione as equipes e distribua as pessoas com ajuda do assistente.', '#/encontros', 'Ver encontros'), step(false, 'Faça um backup', 'Os dados ficam só neste aparelho. Guarde uma cópia fora dele.', '#/backup', 'Abrir backup')),
      ),
    );
    return;
  }

  // ---- Próximo encontro (a peça principal) ----
  const next = open[0];
  let hero;
  if (next) {
    const teamsOf = eventTeams.filter((t) => t.eventId === next.id).sort((a, b) => a.order - b.order);
    const allocated = allocations.filter((a) => a.eventId === next.id);
    const target = teamsOf.reduce((sum, t) => sum + (t.targetSize ?? 0), 0);
    const filled = teamsOf.reduce((sum, t) => sum + Math.min(t.targetSize ?? 0, allocated.filter((a) => a.teamId === t.teamId).length), 0);
    const days = daysUntil(next.startDate);
    const ended = daysUntil(next.endDate) < 0;
    const when = days > 1 ? `em ${days} dias` : days === 1 ? 'amanhã' : days === 0 ? 'começa hoje' : ended ? 'já terminou' : 'acontecendo agora';
    const withoutCoord = teamsOf.filter((t) => !allocated.some((a) => a.teamId === t.teamId && a.role === 'coordenador')).length;
    const distributed = new Set(allocated.map((a) => a.personId)).size;
    hero = h(
      'a',
      { class: 'hero', href: `#/encontros/${next.id}` },
      h('span', { class: 'hero__eyebrow' }, 'Próximo encontro · ', when),
      h('span', { class: 'hero__title' }, next.name),
      h('span', { class: 'hero__meta' }, [fmtRange(next.startDate, next.endDate), next.location].filter(Boolean).join(' · ')),
      h('span', { class: 'hero__ribbon', 'aria-hidden': 'true' }, teamsOf.map((t) => h('span', { class: 'hero__band', style: { '--team': t.color, '--grow': String(Math.max(1, allocated.filter((a) => a.teamId === t.teamId).length)) }, title: t.name }))),
      h(
        'span',
        { class: 'hero__facts' },
        h('span', null, h('strong', null, plural(teamsOf.length, 'equipe', 'equipes'))),
        h('span', null, h('strong', null, String(distributed)), distributed === 1 ? ' pessoa distribuída' : ' pessoas distribuídas', target ? ` · ${Math.round((filled / target) * 100)}% das vagas` : ''),
        withoutCoord ? h('span', { class: 'hero__warn' }, icon('alert', { size: 14 }), plural(withoutCoord, 'equipe sem coordenação', 'equipes sem coordenação')) : null,
        ended ? h('span', { class: 'hero__warn' }, icon('flag', { size: 14 }), 'Conclua para registrar o histórico') : null,
        badge(EVENT_STATUS[next.status].label, EVENT_STATUS[next.status].tone),
      ),
      h('span', { class: 'hero__cta' }, 'Abrir quadrante', icon('chevron-right', { size: 18 })),
    );
  } else {
    hero = h('div', { class: 'hero hero--empty' }, h('span', { class: 'hero__eyebrow' }, 'Nenhum encontro em planejamento'), h('span', { class: 'hero__title' }, 'Qual é o próximo encontro?'), h('span', { class: 'hero__meta' }, 'Crie o encontro, adicione as equipes e distribua as pessoas.'), button('Criar encontro', { variant: 'primary', icon: 'plus', onClick: () => eventDialog() }));
  }

  const kpi = (label, value, href, note) => h('a', { class: 'kpi', href }, h('span', { class: 'kpi__value' }, value.toLocaleString('pt-BR')), h('span', { class: 'kpi__label' }, label), note ? h('span', { class: 'kpi__note' }, note) : null);

  const byTeam = new Map();
  for (const r of confirmed) {
    const t = byTeam.get(r.teamId) ?? { label: r.teamName, color: r.teamColor, value: 0 };
    t.value++;
    byTeam.set(r.teamId, t);
  }
  const currentTeams = new Map(teams.map((t) => [t.id, t]));
  const teamBars = [...byTeam.entries()].map(([id, t]) => ({ ...t, label: currentTeams.get(id)?.name ?? t.label, color: currentTeams.get(id)?.color ?? t.color })).sort((a, b) => b.value - a.value).slice(0, 10);
  const skillCount = new Map();
  for (const p of active) for (const id of p.skillIds) skillCount.set(id, (skillCount.get(id) ?? 0) + 1);
  const skillBars = [...skillCount.entries()].map(([id, value]) => ({ label: catalog.skillsById.get(id)?.name ?? '—', value })).sort((a, b) => b.value - a.value).slice(0, 8);
  const later = open.slice(1, 4);

  view.replaceChildren(
    h(
      'div',
      { class: 'page dashboard' },
      h('header', { class: 'page-head' }, h('p', { class: 'eyebrow' }, greeting), h('h1', { class: 'page-title' }, 'Início')),
      hero,
      h('div', { class: 'kpis' }, kpi('Pessoas cadastradas', active.length, '#/pessoas', people.length > active.length ? `+${people.length - active.length} arquivadas` : null), kpi('Equipes cadastradas', teams.filter((t) => t.status === 'ativa').length, '#/equipes'), kpi('Encontros realizados', realized.length, '#/encontros'), kpi('Participações confirmadas', confirmed.length, '#/historico')),
      later.length ? section('Depois deste', null, h('ul', { class: 'plain-list upcoming' }, later.map((e) => h('li', null, h('a', { href: `#/encontros/${e.id}` }, e.name), h('span', { class: 'muted' }, ` · ${fmtRange(e.startDate, e.endDate)}`))))) : null,
      h(
        'div',
        { class: 'two-col two-col--panels' },
        section(
          'Mais experiência',
          { lead: 'Encontros servidos, contando só encontros concluídos.' },
          experienced.length
            ? h('ol', { class: 'rank' }, experienced.map((p) => h('li', null, h('a', { class: 'rank__row', href: `#/pessoas/${p.id}?aba=historico` }, avatar(p, 'sm'), h('span', { class: 'rank__name' }, p.name, beads(stats.get(p.id).records, 10)), h('span', { class: 'rank__value' }, h('strong', null, String(stats.get(p.id).events.size)), ' enc.')))))
            : emptyState({ icon: 'history', title: 'Sem histórico ainda', text: 'Aparece depois do primeiro encontro concluído.' }),
        ),
        section(
          'Ainda não serviram',
          { lead: never.length ? `${plural(never.length, 'pessoa ativa', 'pessoas ativas')} sem nenhuma participação confirmada.` : null, actions: never.length ? h('a', { class: 'btn btn--ghost btn--sm', href: '#/relatorios/nunca-serviram' }, 'Ver relatório') : null },
          never.length ? h('div', { class: 'people-chips' }, never.slice(0, 12).map((p) => h('a', { class: 'person-chip', href: `#/pessoas/${p.id}` }, avatar(p, 'xs'), p.name)), never.length > 12 ? h('span', { class: 'muted' }, `+${never.length - 12}`) : null) : h('p', { class: 'muted' }, active.length ? 'Todas as pessoas ativas já serviram pelo menos uma vez.' : 'Nenhuma pessoa ativa cadastrada.'),
        ),
      ),
      h('div', { class: 'two-col two-col--panels' }, section('Participações por equipe', null, barList(teamBars, { empty: 'Sem participações confirmadas ainda.' })), section('Habilidades mais frequentes', { lead: 'Entre as pessoas ativas.' }, barList(skillBars, { empty: 'Nenhuma habilidade marcada nas fichas.' }))),
    ),
  );
}
