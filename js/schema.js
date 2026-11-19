// Estrutura do banco local (IndexedDB), versões, rótulos fixos e valores iniciais.
import { normalize } from './validation.js';

export const APP_VERSION = '1.1.0';
export const DB_NAME = 'gestao-encontros';
/** Versão estrutural do IndexedDB (lojas e índices). */
export const DB_VERSION = 1;
/** Versão do formato dos registros — vai dentro dos backups. */
export const DATA_VERSION = 2;

const uniq = (keyPath) => ({ keyPath, unique: true });

/** Lojas do banco. `indexes`: nome → keyPath (ou { keyPath, unique }). */
export const STORES = {
  people: { indexes: { nameKey: 'nameKey', status: 'status' } },
  photos: { indexes: { personId: 'personId' } },
  categories: { indexes: {} },
  skills: { indexes: { categoryId: 'categoryId' } },
  characteristics: { indexes: { group: 'group' } },
  teams: { indexes: { nameKey: 'nameKey' } },
  teamRequirements: { indexes: { teamId: 'teamId', unique: uniq(['teamId', 'kind', 'refId']) } },
  events: { indexes: { status: 'status', startDate: 'startDate' } },
  eventTeams: { indexes: { eventId: 'eventId', teamId: 'teamId', unique: uniq(['eventId', 'teamId']) } },
  allocations: { indexes: { eventId: 'eventId', personId: 'personId', teamId: 'teamId', unique: uniq(['eventId', 'teamId', 'personId']) } },
  participationHistory: { indexes: { personId: 'personId', eventId: 'eventId', teamId: 'teamId', unique: uniq(['eventId', 'teamId', 'personId']) } },
  settings: { keyPath: 'key', indexes: {} },
  metadata: { keyPath: 'key', indexes: {} },
};
export const STORE_NAMES = Object.keys(STORES);
/** Lojas com dados do usuário (entram no backup). `metadata` é do aparelho. */
export const DATA_STORES = STORE_NAMES.filter((name) => name !== 'metadata');

function createStore(db, name) {
  const def = STORES[name];
  const store = db.createObjectStore(name, { keyPath: def.keyPath ?? 'id' });
  for (const [indexName, spec] of Object.entries(def.indexes)) {
    if (typeof spec === 'string' || Array.isArray(spec)) store.createIndex(indexName, spec);
    else store.createIndex(indexName, spec.keyPath, { unique: spec.unique });
  }
}

/** Passos de atualização estrutural: a chave é a versão de destino. */
const UPGRADES = {
  1(db) {
    for (const name of STORE_NAMES) createStore(db, name);
  },
};

export function upgradeDatabase(db, oldVersion, newVersion) {
  for (let v = oldVersion + 1; v <= newVersion; v++) {
    if (!UPGRADES[v]) throw new Error(`Falta o passo de atualização do banco para a versão ${v}.`);
    UPGRADES[v](db);
  }
}

/** Migrações de registros vindos de backups de versões anteriores do formato. */
const DATA_MIGRATIONS = {
  /** 1.1: data de nascimento, pastorais e encontros anteriores informados na ficha. */
  2(stores) {
    for (const p of stores.people ?? []) {
      p.birthDate ??= '';
      p.pastoralIds ??= [];
      p.pastServices ??= [];
    }
    if (!stores.characteristics) return;
    const known = new Set(stores.characteristics.map((c) => c.id));
    for (const c of defaultRecords().characteristics) if (c.group === 'pastoral' && !known.has(c.id)) stores.characteristics.push(c);
  },
};

export function migrateData(stores, fromVersion) {
  for (let v = fromVersion + 1; v <= DATA_VERSION; v++) DATA_MIGRATIONS[v]?.(stores);
  return stores;
}

// ---------- Rótulos fixos ----------

export const AREAS = [
  { id: 'musical', label: 'Musical' },
  { id: 'tecnica', label: 'Técnica' },
  { id: 'religiosa', label: 'Religiosa' },
  { id: 'administrativa', label: 'Administrativa' },
  { id: 'comunicacao', label: 'Comunicação' },
  { id: 'outra', label: 'Outra' },
];
export const areaLabel = (id) => AREAS.find((a) => a.id === id)?.label ?? 'Outra';

export const CHARACTERISTIC_GROUPS = {
  perfil: { label: 'Perfil pessoal', hint: 'Jeito de ser da pessoa. Não é competência.' },
  disponibilidade: { label: 'Disponibilidade', hint: 'Dias e formatos em que a pessoa costuma poder servir.' },
  pastoral: { label: 'Pastorais', hint: 'Pastorais e movimentos da paróquia em que a pessoa serve ou já serviu.' },
};

export const EVENT_STATUS = {
  planejamento: { label: 'Em planejamento', tone: 'neutral' },
  em_andamento: { label: 'Em andamento', tone: 'primary' },
  concluido: { label: 'Concluído', tone: 'ok' },
  reaberto: { label: 'Reaberto para correção', tone: 'warn' },
  cancelado: { label: 'Cancelado', tone: 'muted' },
};
/** Status em que a distribuição pode ser alterada. */
export const EDITABLE_EVENT_STATUS = ['planejamento', 'em_andamento', 'reaberto'];

export const ROLES = { coordenador: 'Coordenação', integrante: 'Integrante' };

export const AVAILABILITY_STATUS = {
  '': 'Não informada',
  disponivel: 'Disponível',
  limitada: 'Disponibilidade limitada',
  indisponivel: 'Indisponível no momento',
};

export const PARTICIPATION_STATUS = { confirmada: 'Serviu', ausente: 'Não compareceu' };

export const TEAM_COLORS = ['#1D5A45', '#2F6FB0', '#7A4FB3', '#B0306A', '#C2412D', '#C77A12', '#9C8A12', '#4E8A2E', '#16897F', '#3D5A80', '#6B4E3D', '#5B6770'];

export const DEFAULT_WEIGHTS = { skills: 35, experience: 20, preference: 20, availability: 15, characteristics: 10, load: 10 };

/** Configurações que pertencem ao aparelho: não vão no backup e não são trocadas na restauração. */
export const DEVICE_SETTINGS = ['pin', 'autoLockMinutes', 'lastBackupAt'];

export const DEFAULT_SETTINGS = {
  autoLockMinutes: 0,
  backupReminderDays: 7,
  weights: DEFAULT_WEIGHTS,
  lastBackupAt: null,
};

// ---------- Valores iniciais (configuração, não são dados de pessoas) ----------

const slug = (text) => normalize(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const DEFAULT_SKILLS = [
  ['Música', 'musical', ['Direção musical', 'Leitura de partitura', 'Composição', 'Ministério de louvor']],
  ['Instrumentos', 'musical', ['Violão', 'Guitarra', 'Contrabaixo', 'Teclado', 'Bateria', 'Percussão', 'Flauta', 'Violino']],
  ['Canto', 'musical', ['Voz principal', 'Segunda voz', 'Coral']],
  ['Religiosas', 'religiosa', ['Oração e intercessão', 'Pregação', 'Leitura litúrgica', 'Catequese', 'Animação de oração', 'Aconselhamento']],
  ['Administrativas', 'administrativa', ['Secretaria', 'Finanças', 'Planejamento', 'Compras', 'Inscrições']],
  ['Comunicação', 'comunicacao', ['Apresentação', 'Fotografia', 'Vídeo', 'Redes sociais', 'Design gráfico']],
  ['Técnicas', 'tecnica', ['Som e áudio', 'Iluminação', 'Informática', 'Cozinha', 'Decoração', 'Primeiros socorros', 'Motorista', 'Manutenção']],
];
const DEFAULT_PROFILE = ['Comunicativo', 'Tímido', 'Organizado', 'Proativo', 'Criativo', 'Liderança', 'Paciente', 'Acolhedor'];
const DEFAULT_AVAILABILITY = ['Sexta-feira', 'Sábado', 'Domingo', 'Pode pernoitar', 'Apenas meio período', 'Reuniões de preparação'];
const DEFAULT_PASTORALS = ['Catequese', 'Liturgia', 'Ministério de Música', 'Pastoral da Juventude', 'Pastoral Familiar', 'Pastoral do Batismo', 'Pastoral da Criança', 'Pastoral do Dízimo', 'Pastoral da Saúde', 'Pastoral da Acolhida', 'Coroinhas e acólitos', 'Ministros da Eucaristia', 'Renovação Carismática', 'Legião de Maria'];

/**
 * Identificadores fixos: dois aparelhos instalados separadamente geram os mesmos
 * códigos, então a importação reconhece "Violão" como o mesmo registro.
 */
export function defaultRecords(now = new Date().toISOString()) {
  const categories = [];
  const skills = [];
  DEFAULT_SKILLS.forEach(([name, area, items], i) => {
    const id = `cat-${slug(name)}`;
    categories.push({ id, name, nameKey: normalize(name), area, active: true, order: i, createdAt: now, updatedAt: now });
    items.forEach((item, j) => skills.push({ id: `skl-${slug(item)}`, categoryId: id, name: item, nameKey: normalize(item), active: true, order: j, createdAt: now, updatedAt: now }));
  });
  const characteristics = [
    ...DEFAULT_PROFILE.map((name, i) => ({ id: `chr-${slug(name)}`, group: 'perfil', name, nameKey: normalize(name), active: true, order: i, createdAt: now, updatedAt: now })),
    ...DEFAULT_AVAILABILITY.map((name, i) => ({ id: `avl-${slug(name)}`, group: 'disponibilidade', name, nameKey: normalize(name), active: true, order: i, createdAt: now, updatedAt: now })),
    ...DEFAULT_PASTORALS.map((name, i) => ({ id: `pst-${slug(name)}`, group: 'pastoral', name, nameKey: normalize(name), active: true, order: i, createdAt: now, updatedAt: now })),
  ];
  return { categories, skills, characteristics };
}
