// Assistente de distribuição: pontuação local, explicável e configurável. Sem IA externa.
// A pontuação só ordena sugestões — quem decide é sempre o usuário.
import { DEFAULT_WEIGHTS } from '../schema.js';
import { emptyStats } from './history.js';

export const CRITERIA = [
  { key: 'skills', label: 'Habilidades pedidas pela equipe' },
  { key: 'experience', label: 'Experiência anterior na equipe' },
  { key: 'preference', label: 'Preferências declaradas' },
  { key: 'availability', label: 'Disponibilidade' },
  { key: 'characteristics', label: 'Perfil pedido pela equipe' },
  { key: 'load', label: 'Ainda não está em outra equipe do encontro' },
];

const WEIGHT_LABEL = { 1: 'desejável', 2: 'importante', 3: 'essencial' };

/**
 * @param {{
 *   teamId: string,
 *   requirements: { kind: 'skill'|'characteristic', refId: string, weight: number }[],
 *   referenceMemberIds?: string[],
 *   people: any[],
 *   stats: Map<string, ReturnType<typeof emptyStats>>,
 *   eventAllocations: { personId: string, teamId: string }[],
 *   teamNames: Map<string, string>,
 *   names: Map<string, string>,
 *   weights?: Record<string, number>,
 * }} input
 * @returns {{ person: any, score: number, reasons: { kind: 'plus'|'minus'|'note', text: string }[], otherTeams: string[] }[]}
 */
export function rankCandidates({ teamId, requirements, referenceMemberIds = [], people, stats, eventAllocations, teamNames, names, weights = DEFAULT_WEIGHTS }) {
  const inTeam = new Set(eventAllocations.filter((a) => a.teamId === teamId).map((a) => a.personId));
  const elsewhere = new Map();
  for (const a of eventAllocations) {
    if (a.teamId === teamId) continue;
    elsewhere.set(a.personId, [...(elsewhere.get(a.personId) ?? []), teamNames.get(a.teamId) ?? 'outra equipe']);
  }
  const skillReqs = requirements.filter((r) => r.kind === 'skill');
  const traitReqs = requirements.filter((r) => r.kind === 'characteristic');
  const references = new Set(referenceMemberIds);
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  return people
    .filter((p) => p.status === 'ativo' && !inTeam.has(p.id))
    .map((person) => {
      const reasons = [];
      const parts = [];
      const personStats = stats.get(person.id) ?? emptyStats();

      // 1. Habilidades exigidas
      if (skillReqs.length) {
        const owned = new Set(person.skillIds);
        const matched = skillReqs.filter((r) => owned.has(r.refId));
        const total = skillReqs.reduce((sum, r) => sum + r.weight, 0);
        parts.push(['skills', matched.reduce((sum, r) => sum + r.weight, 0) / total]);
        matched.sort((a, b) => b.weight - a.weight).forEach((r) => reasons.push({ kind: 'plus', text: `Possui ${names.get(r.refId) ?? 'habilidade pedida'}${r.weight > 1 ? ` (${WEIGHT_LABEL[r.weight]})` : ''}` }));
        const missingEssential = skillReqs.filter((r) => r.weight === 3 && !owned.has(r.refId));
        if (missingEssential.length) reasons.push({ kind: 'minus', text: `Não tem ${missingEssential.map((r) => names.get(r.refId)).join(', ')} (essencial)` });
        else if (!matched.length) reasons.push({ kind: 'minus', text: 'Não tem as habilidades pedidas pela equipe' });
      }

      // 2. Experiência na equipe
      const team = personStats.byTeam.get(teamId);
      let experience = !team ? 0 : team.count === 1 ? 0.6 : team.count === 2 ? 0.85 : 1;
      if (team) reasons.push({ kind: 'plus', text: team.count === 1 ? 'Já trabalhou nesta equipe' : `Já trabalhou nesta equipe ${team.count} vezes` });
      if (team?.coordinations) reasons.push({ kind: 'plus', text: team.coordinations === 1 ? 'Já coordenou esta equipe' : `Coordenou esta equipe ${team.coordinations} vezes` });
      if (references.has(person.id)) {
        experience = Math.max(experience, 0.7);
        reasons.push({ kind: 'plus', text: 'É integrante de referência da equipe' });
      }
      if (!personStats.events.size) reasons.push({ kind: 'note', text: 'Ainda não serviu em nenhum encontro' });
      parts.push(['experience', experience]);

      // 3. Preferências
      if (person.avoidTeamIds.includes(teamId)) {
        parts.push(['preference', 0]);
        reasons.push({ kind: 'minus', text: 'Prefere não integrar esta equipe' });
      } else if (person.preferredTeamIds.includes(teamId)) {
        parts.push(['preference', 1]);
        reasons.push({ kind: 'plus', text: 'Tem interesse nesta equipe' });
      } else parts.push(['preference', 0.5]);

      // 4. Disponibilidade
      const availability = { disponivel: 1, limitada: 0.5, indisponivel: 0 }[person.availabilityStatus] ?? 0.5;
      parts.push(['availability', availability]);
      if (person.availabilityStatus === 'disponivel') reasons.push({ kind: 'plus', text: 'Está disponível' });
      else if (person.availabilityStatus === 'limitada') reasons.push({ kind: 'note', text: 'Disponibilidade limitada' });
      else if (person.availabilityStatus === 'indisponivel') reasons.push({ kind: 'minus', text: 'Marcou que está indisponível' });
      else reasons.push({ kind: 'note', text: 'Disponibilidade não informada' });

      // 5. Perfil pedido
      if (traitReqs.length) {
        const owned = new Set(person.characteristicIds);
        const matched = traitReqs.filter((r) => owned.has(r.refId));
        parts.push(['characteristics', matched.reduce((sum, r) => sum + r.weight, 0) / traitReqs.reduce((sum, r) => sum + r.weight, 0)]);
        matched.forEach((r) => reasons.push({ kind: 'plus', text: `Perfil ${names.get(r.refId)?.toLowerCase() ?? 'pedido'}` }));
      }

      // 6. Carga no encontro
      const otherTeams = elsewhere.get(person.id) ?? [];
      parts.push(['load', otherTeams.length ? 0.2 : 1]);
      if (otherTeams.length) reasons.push({ kind: 'minus', text: `Já está em ${otherTeams.join(', ')} neste encontro` });

      const weightSum = parts.reduce((sum, [key]) => sum + (Number(w[key]) || 0), 0);
      const score = weightSum ? Math.round((parts.reduce((sum, [key, value]) => sum + (Number(w[key]) || 0) * value, 0) / weightSum) * 100) : 0;
      const order = { plus: 0, minus: 1, note: 2 };
      reasons.sort((a, b) => order[a.kind] - order[b.kind]);
      return { person, score, reasons, otherTeams };
    })
    .sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name, 'pt-BR'));
}
