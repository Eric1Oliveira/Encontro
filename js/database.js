// Acesso ao IndexedDB: abertura, migrações, transações, configurações e integridade.
// Toda leitura e escrita do aplicativo passa por aqui.
import { DB_NAME, DB_VERSION, DATA_VERSION, STORE_NAMES, DATA_STORES, DEFAULT_SETTINGS, upgradeDatabase, migrateData, defaultRecords } from './schema.js';

export class AppError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
  }
}

/** Converte erros do navegador em mensagens que dizem o que aconteceu e o que fazer. */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  const name = error?.name ?? '';
  const message = error?.message ?? '';
  if (name === 'QuotaExceededError' || /quota/i.test(message)) {
    return new AppError('quota', 'Não há espaço livre suficiente no aparelho para salvar. Nada foi alterado. Libere espaço no aparelho ou exporte um backup e remova fotos que não usa.', error);
  }
  if (name === 'ConstraintError') return new AppError('duplicate', 'Esse registro já existe.', error);
  if (name === 'VersionError') return new AppError('version', 'Este navegador guarda dados de uma versão mais nova do aplicativo. Recarregue a página para usar a versão mais recente.', error);
  if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'AbortError') {
    return new AppError('storage', 'O armazenamento do navegador não respondeu. Recarregue a página. Em modo anônimo os dados não podem ser guardados.', error);
  }
  return new AppError('unknown', message || 'Erro inesperado ao acessar os dados.', error);
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const nowISO = () => new Date().toISOString();

// ---------- Eventos de mudança ----------

const listeners = new Set();
/** @param {(event: {type: string, stores?: string[]}) => void} fn */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (error) {
      console.error(error);
    }
  }
}

let changeTimer = 0;
function notifyChange(storeNames) {
  emit({ type: 'change', stores: storeNames });
  if (storeNames.some((name) => name !== 'metadata' && name !== 'settings')) {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => putOne('metadata', { key: 'lastChangeAt', value: nowISO() }).catch(() => {}), 400);
  }
}

// ---------- Abertura ----------

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new AppError('unsupported', 'Este navegador não oferece armazenamento local. Use uma versão atual do Chrome, Edge, Safari ou Firefox, fora do modo anônimo.'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(toAppError(error));
      return;
    }
    request.onupgradeneeded = (event) => {
      try {
        upgradeDatabase(request.result, event.oldVersion, event.newVersion ?? DB_VERSION);
      } catch (error) {
        request.transaction?.abort();
        reject(new AppError('migration', `Não foi possível atualizar a estrutura do banco: ${error.message}. Os dados anteriores foram mantidos.`, error));
      }
    };
    request.onblocked = () => emit({ type: 'blocked' });
    request.onerror = () => reject(toAppError(request.error));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        emit({ type: 'versionchange' });
      };
      db.onclose = () => {
        dbPromise = null;
        emit({ type: 'closed' });
      };
      resolve(db);
    };
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Executa `work` dentro de UMA transação: ou tudo é gravado, ou nada.
 * Dentro de `work` só se pode aguardar requisições do próprio IndexedDB (via `req`).
 * @template T
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {(stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => T | Promise<T>} work
 * @returns {Promise<T>}
 */
export async function transaction(storeNames, mode, work) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    } catch (error) {
      reject(toAppError(error));
      return;
    }
    const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
    let result;
    let failure = null;
    let settled = false;
    tx.oncomplete = () => {
      if (!settled) {
        reject(new AppError('internal', 'A operação foi interrompida antes de terminar. Tente novamente.'));
        return;
      }
      if (mode === 'readwrite') notifyChange(storeNames);
      resolve(result);
    };
    tx.onabort = () => reject(failure ?? toAppError(tx.error ?? new DOMException('Operação cancelada.', 'AbortError')));
    let pending;
    try {
      pending = Promise.resolve(work(stores, tx));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => {
        result = value;
        settled = true;
      },
      (error) => {
        failure = toAppError(error);
        settled = true;
        try {
          tx.abort();
        } catch {
          /* a transação já terminou */
        }
      },
    );
  });
}

export const getAll = (store, index, query) => transaction([store], 'readonly', (s) => req(index ? s[store].index(index).getAll(query) : s[store].getAll()));
export const getOne = (store, key) => transaction([store], 'readonly', (s) => req(s[store].get(key)));
export const putOne = (store, record) => transaction([store], 'readwrite', (s) => req(s[store].put(record)));
export const deleteOne = (store, key) => transaction([store], 'readwrite', (s) => req(s[store].delete(key)));
export const countAll = (store) => transaction([store], 'readonly', (s) => req(s[store].count()));

/** Lê várias lojas inteiras numa só transação (fotos ficam de fora: são pesadas). */
export async function readStores(names) {
  return transaction(names, 'readonly', async (s) => {
    const out = {};
    for (const name of names) out[name] = await req(s[name].getAll());
    return out;
  });
}

// ---------- Inicialização e migração ----------

export async function initDatabase() {
  await openDB();
  const version = await getOne('metadata', 'dataVersion');
  if (!version) {
    const now = nowISO();
    const defaults = defaultRecords(now);
    await transaction(['categories', 'skills', 'characteristics', 'metadata'], 'readwrite', (s) => {
      for (const name of ['categories', 'skills', 'characteristics']) for (const record of defaults[name]) s[name].put(record);
      s.metadata.put({ key: 'dataVersion', value: DATA_VERSION });
      s.metadata.put({ key: 'createdAt', value: now });
    });
  } else if (version.value > DATA_VERSION) {
    throw new AppError('version', 'Os dados deste aparelho foram gravados por uma versão mais nova do aplicativo. Recarregue a página para atualizar.');
  } else if (version.value < DATA_VERSION) {
    await transaction([...DATA_STORES, 'metadata'], 'readwrite', async (s) => {
      const data = {};
      for (const name of DATA_STORES) data[name] = await req(s[name].getAll());
      migrateData(data, version.value);
      for (const name of DATA_STORES) {
        s[name].clear();
        for (const record of data[name]) s[name].put(record);
      }
      s.metadata.put({ key: 'dataVersion', value: DATA_VERSION });
    });
  }
  await loadSettings();
}

// ---------- Configurações ----------

let settingsCache = { ...DEFAULT_SETTINGS };

export async function loadSettings() {
  const rows = await getAll('settings');
  settingsCache = { ...DEFAULT_SETTINGS };
  for (const row of rows) settingsCache[row.key] = row.value;
  return settingsCache;
}

export const setting = (key) => settingsCache[key] ?? DEFAULT_SETTINGS[key];

export async function saveSetting(key, value) {
  await putOne('settings', { key, value });
  settingsCache[key] = value;
}

export async function removeSetting(key) {
  await deleteOne('settings', key);
  delete settingsCache[key];
}

// ---------- Integridade ----------

/** Procura referências quebradas. Não altera nada. */
export async function checkIntegrity() {
  const data = await readStores(STORE_NAMES.filter((n) => n !== 'photos'));
  const photoKeys = await transaction(['photos'], 'readonly', (s) => req(s.photos.getAllKeys()));
  const ids = (list) => new Set(list.map((r) => r.id));
  const people = ids(data.people);
  const events = ids(data.events);
  const teams = ids(data.teams);
  const skills = ids(data.skills);
  const characteristics = ids(data.characteristics);
  const categories = ids(data.categories);
  const eventTeamKeys = new Set(data.eventTeams.map((t) => `${t.eventId}|${t.teamId}`));
  const photos = new Set(photoKeys);
  const usedPhotos = new Set(data.people.map((p) => p.photoId).filter(Boolean));
  const issues = [];
  const add = (key, count, message, fixable = true) => count && issues.push({ key, count, message, fixable });

  add('allocations', data.allocations.filter((a) => !events.has(a.eventId) || !people.has(a.personId) || !eventTeamKeys.has(`${a.eventId}|${a.teamId}`)).length, 'distribuições ligadas a encontro, equipe ou pessoa que não existe mais');
  add('eventTeams', data.eventTeams.filter((t) => !events.has(t.eventId)).length, 'equipes ligadas a encontros apagados');
  add('requirements', data.teamRequirements.filter((r) => !teams.has(r.teamId) || !(r.kind === 'skill' ? skills : characteristics).has(r.refId)).length, 'requisitos de equipe apontando para itens apagados');
  add('skills', data.skills.filter((s) => !categories.has(s.categoryId)).length, 'habilidades sem categoria');
  add('photoRefs', data.people.filter((p) => p.photoId && !photos.has(p.photoId)).length, 'fichas apontando para fotos que não existem');
  add('orphanPhotos', photoKeys.filter((key) => !usedPhotos.has(key)).length, 'fotos sem ficha');
  add('history', data.participationHistory.filter((h) => !events.has(h.eventId)).length, 'participações de encontros que não existem mais', false);
  const version = data.metadata.find((m) => m.key === 'dataVersion')?.value;
  if (version !== DATA_VERSION) issues.push({ key: 'version', count: 1, message: `versão dos dados (${version}) diferente da esperada (${DATA_VERSION})`, fixable: false });
  const checkedAt = nowISO();
  await putOne('metadata', { key: 'lastIntegrityCheck', value: checkedAt });
  return { issues, checkedAt, totals: { people: data.people.length, events: data.events.length, teams: data.teams.length, history: data.participationHistory.length, photos: photoKeys.length } };
}

/** Remove apenas referências órfãs. O histórico nunca é tocado. */
export async function repairIntegrity() {
  return transaction([...STORE_NAMES], 'readwrite', async (s) => {
    const all = {};
    for (const name of ['people', 'events', 'teams', 'skills', 'characteristics', 'categories', 'eventTeams', 'allocations', 'teamRequirements']) all[name] = await req(s[name].getAll());
    const photoKeys = await req(s.photos.getAllKeys());
    const has = (list) => new Set(list.map((r) => r.id));
    const people = has(all.people);
    const events = has(all.events);
    const teams = has(all.teams);
    const skills = has(all.skills);
    const characteristics = has(all.characteristics);
    const categories = has(all.categories);
    const photos = new Set(photoKeys);
    let fixed = 0;
    const liveEventTeams = all.eventTeams.filter((t) => {
      if (events.has(t.eventId)) return true;
      s.eventTeams.delete(t.id);
      fixed++;
      return false;
    });
    const eventTeamKeys = new Set(liveEventTeams.map((t) => `${t.eventId}|${t.teamId}`));
    for (const a of all.allocations) {
      if (!events.has(a.eventId) || !people.has(a.personId) || !eventTeamKeys.has(`${a.eventId}|${a.teamId}`)) {
        s.allocations.delete(a.id);
        fixed++;
      }
    }
    for (const r of all.teamRequirements) {
      if (!teams.has(r.teamId) || !(r.kind === 'skill' ? skills : characteristics).has(r.refId)) {
        s.teamRequirements.delete(r.id);
        fixed++;
      }
    }
    for (const skill of all.skills) {
      if (!categories.has(skill.categoryId)) {
        s.skills.put({ ...skill, active: false, categoryId: all.categories[0]?.id ?? skill.categoryId });
        fixed++;
      }
    }
    const used = new Set();
    for (const p of all.people) {
      if (p.photoId && !photos.has(p.photoId)) {
        s.people.put({ ...p, photoId: null });
        fixed++;
      } else if (p.photoId) used.add(p.photoId);
    }
    for (const key of photoKeys) {
      if (!used.has(key)) {
        s.photos.delete(key);
        fixed++;
      }
    }
    return fixed;
  });
}
