// Normalização de texto e validação de cadastros e de registros importados.

/** Minúsculas, sem acentos e com espaços simples — base de busca e de comparação de nomes. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const digits = (text) => String(text ?? '').replace(/\D/g, '');

export const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

export const isEmail = (value) => EMAIL.test(value);
export const isDate = (value) => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
export const isColor = (value) => COLOR.test(value);

/** Telefone brasileiro: 10 ou 11 dígitos (DDD + número), com ou sem 55 na frente. */
export function isPhone(value) {
  let d = digits(value);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11;
}

export function formatPhone(value) {
  let d = digits(value);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return clean(value);
}

export function normalizeInstagram(value) {
  const v = clean(value).replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '').replace(/^@+/, '');
  return v ? `@${v}` : '';
}

/** @returns {Record<string,string>} campo → mensagem (vazio = válido) */
export function validatePerson(p) {
  const errors = {};
  if (clean(p.name).length < 2) errors.name = 'Informe o nome completo.';
  if (p.phone && !isPhone(p.phone)) errors.phone = 'Use DDD + número, por exemplo (11) 98765-4321.';
  if (p.email && !isEmail(p.email)) errors.email = 'Confira o e-mail, por exemplo nome@exemplo.com.';
  if (p.instagram && !/^@[A-Za-z0-9._]{1,30}$/.test(p.instagram)) errors.instagram = 'Use só letras, números, ponto e sublinhado.';
  const both = (p.preferredTeamIds ?? []).filter((id) => (p.avoidTeamIds ?? []).includes(id));
  if (both.length) errors.avoidTeamIds = 'Uma equipe não pode estar nas duas listas ao mesmo tempo.';
  return errors;
}

export function validateTeam(t) {
  const errors = {};
  if (clean(t.name).length < 2) errors.name = 'Dê um nome à equipe.';
  if (!isColor(t.color)) errors.color = 'Escolha uma cor.';
  if (t.targetSize != null && (!Number.isInteger(t.targetSize) || t.targetSize < 1 || t.targetSize > 500)) errors.targetSize = 'Use um número entre 1 e 500.';
  return errors;
}

export function validateEvent(e) {
  const errors = {};
  if (clean(e.name).length < 2) errors.name = 'Dê um nome ao encontro.';
  if (!isDate(e.startDate)) errors.startDate = 'Informe a data de início.';
  if (!isDate(e.endDate)) errors.endDate = 'Informe a data de término.';
  else if (isDate(e.startDate) && e.endDate < e.startDate) errors.endDate = 'O término não pode vir antes do início.';
  return errors;
}

export function validatePin(pin) {
  if (!/^\d{4,8}$/.test(pin)) return 'O PIN precisa ter de 4 a 8 números.';
  return '';
}

export function validateBackupPassword(password) {
  if (password.length < 8) return 'Use pelo menos 8 caracteres.';
  return '';
}

// ---------- Registros vindos de arquivo (importação) ----------

const str = (v) => typeof v === 'string';
const optStr = (v) => v == null || typeof v === 'string';
const arr = (v) => Array.isArray(v) && v.every(str);
const num = (v) => v == null || (typeof v === 'number' && Number.isFinite(v));

/** Regras mínimas por loja: o que precisa existir para o registro ser utilizável. */
const RECORD_RULES = {
  people: (r) => str(r.name) && r.name.trim() && arr(r.skillIds) && arr(r.characteristicIds) && arr(r.preferredTeamIds) && arr(r.avoidTeamIds) && arr(r.availabilityIds) && optStr(r.photoId) && ['ativo', 'arquivado'].includes(r.status),
  photos: (r) => str(r.personId) && str(r.type),
  categories: (r) => str(r.name) && str(r.area) && typeof r.active === 'boolean',
  skills: (r) => str(r.name) && str(r.categoryId) && typeof r.active === 'boolean',
  characteristics: (r) => str(r.name) && ['perfil', 'disponibilidade'].includes(r.group) && typeof r.active === 'boolean',
  teams: (r) => str(r.name) && isColor(r.color) && Array.isArray(r.coordinators) && arr(r.referenceMemberIds) && num(r.targetSize),
  teamRequirements: (r) => str(r.teamId) && ['skill', 'characteristic'].includes(r.kind) && str(r.refId) && [1, 2, 3].includes(r.weight),
  events: (r) => str(r.name) && isDate(r.startDate) && isDate(r.endDate) && ['planejamento', 'em_andamento', 'concluido', 'reaberto', 'cancelado'].includes(r.status),
  eventTeams: (r) => str(r.eventId) && str(r.teamId) && str(r.name) && isColor(r.color),
  allocations: (r) => str(r.eventId) && str(r.teamId) && str(r.personId) && ['coordenador', 'integrante'].includes(r.role),
  participationHistory: (r) => str(r.eventId) && str(r.teamId) && str(r.personId) && ['coordenador', 'integrante'].includes(r.role) && ['confirmada', 'ausente'].includes(r.status),
  settings: (r) => str(r.key),
};

/** @returns {string} vazio quando o registro é aceitável */
export function validateRecord(store, record) {
  if (!record || typeof record !== 'object') return 'registro vazio';
  const key = store === 'settings' ? record.key : record.id;
  if (!str(key) || !key) return 'sem identificador';
  const rule = RECORD_RULES[store];
  if (!rule) return 'tipo de registro desconhecido';
  return rule(record) ? '' : 'campos obrigatórios ausentes ou inválidos';
}
