// Backup em .zip: exportação (opcionalmente com senha), validação completa, restauração e mesclagem.
// Nada é gravado antes de o arquivo inteiro ser validado, e toda gravação é uma transação só.
import { transaction, req, readStores, nowISO, setting, saveSetting, loadSettings, AppError } from './database.js';
import { STORE_NAMES, DATA_STORES, DATA_VERSION, APP_VERSION, DEVICE_SETTINGS, migrateData } from './schema.js';
import { validateRecord, validateBackupPassword, normalize, digits } from './validation.js';
import { encryptBytes, decryptBytes, sha256Hex } from './security.js';
import { h, button, pageHeader, plural, fmtDateTime, relativeDays, fmtBytes, downloadFile, stamp, section, forgetAllPhotos, badge } from './components/ui.js';
import { icon } from './components/icons.js';
import { field, segmented, showErrors } from './components/forms.js';
import { openModal, confirmDialog } from './components/modal.js';
import { toast, toastError } from './components/toast.js';
import { trackOperation, refresh } from './router.js';
import { refreshNotices } from './notifications.js';
import { historyId } from './modules/history.js';

const APP_ID = 'gestao-encontros';
export const BACKUP_FORMAT = 1;
const RECORD_STORES = DATA_STORES.filter((name) => name !== 'photos');
const ENTITY_STORES = ['categories', 'skills', 'characteristics', 'teams', 'people'];
const BUNDLE_STORES = ['eventTeams', 'allocations', 'participationHistory'];
const MAX_FILE = 1024 ** 3;

export class BackupError extends AppError {
  constructor(code, message, details = []) {
    super(code, message);
    this.details = details;
  }
}

function zipLib() {
  if (!globalThis.JSZip) throw new BackupError('unavailable', 'O componente de compactação não carregou. Recarregue a página e tente de novo.');
  return globalThis.JSZip;
}

const extension = (type) => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[type] ?? 'jpg';

/** Comparação estável (independe da ordem das chaves). */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
const same = (a, b) => stable(a) === stable(b);

// ---------- Exportação ----------

/** @returns {Promise<{ blob: Blob, filename: string, counts: Record<string, number> }>} */
export async function buildBackup({ password = '' } = {}) {
  const JSZip = zipLib();
  const data = await readStores(DATA_STORES);
  const photos = data.photos;
  delete data.photos;
  data.settings = data.settings.filter((s) => !DEVICE_SETTINGS.includes(s.key));
  const used = new Set(data.people.map((p) => p.photoId).filter(Boolean));
  const zip = new JSZip();
  const files = {};
  const photoMeta = [];
  for (const photo of photos) {
    if (!used.has(photo.id) || !photo.blob) continue;
    const bytes = new Uint8Array(await photo.blob.arrayBuffer());
    const path = `fotos/${photo.id}.${extension(photo.type)}`;
    zip.file(path, bytes);
    files[path] = await sha256Hex(bytes);
    photoMeta.push({ id: photo.id, personId: photo.personId, type: photo.type, size: bytes.length, updatedAt: photo.updatedAt, path });
  }
  const dataBytes = new TextEncoder().encode(JSON.stringify({ stores: data, photos: photoMeta }));
  zip.file('dados.json', dataBytes);
  files['dados.json'] = await sha256Hex(dataBytes);
  const counts = { people: data.people.length, teams: data.teams.length, events: data.events.length, photos: photoMeta.length, participations: data.participationHistory.length, allocations: data.allocations.length };
  const exportedAt = nowISO();
  zip.file('manifest.json', JSON.stringify({ app: APP_ID, format: BACKUP_FORMAT, dataVersion: DATA_VERSION, appVersion: APP_VERSION, exportedAt, encrypted: false, counts, files }, null, 2));
  const base = `encontro-backup-${stamp()}`;
  if (!password) return { blob: await zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' }), filename: `${base}.zip`, counts };

  const inner = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const { data: cipher, params } = await encryptBytes(inner, password);
  const outer = new JSZip();
  outer.file('manifest.json', JSON.stringify({ app: APP_ID, format: BACKUP_FORMAT, appVersion: APP_VERSION, exportedAt, encrypted: true, encryption: params, payload: 'dados.protegidos' }, null, 2));
  outer.file('dados.protegidos', cipher);
  outer.file('LEIA-ME.txt', 'Backup do aplicativo Encontro protegido por senha (AES-256-GCM).\nPara abrir: aplicativo Encontro > Backup e transferência > Importar arquivo.\n');
  return { blob: await outer.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'STORE' }), filename: `${base}-protegido.zip`, counts };
}

// ---------- Leitura e validação ----------

/**
 * Lê e valida o arquivo inteiro sem tocar no banco.
 * @returns {Promise<{ needsPassword: true, manifest: any } | { needsPassword: false, manifest: any, stores: Record<string, any[]>, counts: Record<string, number>, warnings: string[] }>}
 */
export async function readBackupFile(file, password = '') {
  const JSZip = zipLib();
  if (!file || file.size === 0) throw new BackupError('empty', 'O arquivo está vazio.');
  if (file.size > MAX_FILE) throw new BackupError('too_big', 'O arquivo é grande demais para ser um backup deste aplicativo.');
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new BackupError('invalid_zip', 'Este arquivo não é um .zip válido ou está danificado. Confira se escolheu o arquivo de backup certo.');
  }
  let manifest = await readJson(zip, 'manifest.json', 'Este .zip não é um backup do aplicativo Encontro (falta o manifesto).');
  if (manifest.app !== APP_ID) throw new BackupError('not_backup', 'Este .zip não é um backup do aplicativo Encontro.');
  if (!Number.isInteger(manifest.format) || manifest.format > BACKUP_FORMAT) throw new BackupError('incompatible', 'Este backup foi feito por uma versão mais nova do aplicativo. Atualize o aplicativo neste aparelho e tente de novo.');

  const encrypted = Boolean(manifest.encrypted);
  if (encrypted) {
    if (!password) return { needsPassword: true, manifest };
    const payload = zip.file(manifest.payload ?? '');
    if (!payload || !manifest.encryption?.salt || !manifest.encryption?.iv) throw new BackupError('corrupted', 'O backup protegido está incompleto: falta o conteúdo criptografado.');
    const plain = await decryptBytes(await payload.async('uint8array'), password, manifest.encryption).catch((error) => {
      throw new BackupError(error.code === 'wrong_password' ? 'wrong_password' : 'corrupted', error.message);
    });
    try {
      zip = await JSZip.loadAsync(plain);
    } catch {
      throw new BackupError('corrupted', 'O conteúdo do backup foi aberto, mas está danificado.');
    }
    manifest = await readJson(zip, 'manifest.json', 'O conteúdo do backup protegido está incompleto.');
  }
  if (!Number.isInteger(manifest.dataVersion) || manifest.dataVersion > DATA_VERSION) throw new BackupError('incompatible', 'Este backup usa um formato de dados mais novo. Atualize o aplicativo neste aparelho.');

  // Integridade: cada arquivo listado precisa existir e bater com o SHA-256 do manifesto.
  const files = manifest.files ?? {};
  if (!files['dados.json']) throw new BackupError('corrupted', 'O manifesto não lista os dados do backup.');
  const bytesByPath = new Map();
  for (const [path, hash] of Object.entries(files)) {
    const entry = zip.file(path);
    if (!entry) throw new BackupError('corrupted', `O backup está incompleto: falta "${path}".`);
    const bytes = await entry.async('uint8array');
    if ((await sha256Hex(bytes)) !== hash) throw new BackupError('corrupted', `"${path}" foi alterado ou está danificado. O backup não pode ser usado.`);
    bytesByPath.set(path, bytes);
  }
  let content;
  try {
    content = JSON.parse(new TextDecoder().decode(bytesByPath.get('dados.json')));
  } catch {
    throw new BackupError('corrupted', 'Os dados do backup estão ilegíveis.');
  }
  if (!content?.stores || typeof content.stores !== 'object') throw new BackupError('corrupted', 'Os dados do backup estão em formato desconhecido.');

  const stores = {};
  for (const name of RECORD_STORES) {
    const list = content.stores[name] ?? [];
    if (!Array.isArray(list)) throw new BackupError('corrupted', `A lista "${name}" do backup está danificada.`);
    stores[name] = list;
  }
  migrateData(stores, manifest.dataVersion);

  const problems = [];
  for (const name of RECORD_STORES) {
    const ids = new Set();
    stores[name].forEach((record, i) => {
      const issue = validateRecord(name, record);
      const key = name === 'settings' ? record?.key : record?.id;
      if (issue) problems.push(`${name} nº ${i + 1}: ${issue}`);
      else if (ids.has(key)) problems.push(`${name}: código repetido (${key})`);
      ids.add(key);
    });
  }
  const photos = [];
  for (const meta of Array.isArray(content.photos) ? content.photos : []) {
    const bytes = bytesByPath.get(meta?.path);
    if (!meta?.id || !bytes) {
      problems.push(`foto sem arquivo (${meta?.path ?? '?'})`);
      continue;
    }
    photos.push({ id: meta.id, personId: meta.personId, type: meta.type || 'image/jpeg', size: bytes.length, updatedAt: meta.updatedAt ?? manifest.exportedAt, blob: new Blob([bytes], { type: meta.type || 'image/jpeg' }) });
  }
  if (problems.length) throw new BackupError('invalid_records', `O backup tem ${plural(problems.length, 'registro inválido', 'registros inválidos')}. Nada foi alterado.`, problems.slice(0, 12));
  stores.photos = photos;
  stores.settings = stores.settings.filter((s) => !DEVICE_SETTINGS.includes(s.key));

  const warnings = dropBrokenReferences(stores);
  return {
    needsPassword: false,
    manifest: { ...manifest, encrypted },
    stores,
    warnings,
    counts: { people: stores.people.length, teams: stores.teams.length, events: stores.events.length, photos: stores.photos.length, participations: stores.participationHistory.length, allocations: stores.allocations.length },
  };
}

async function readJson(zip, path, missing) {
  const entry = zip.file(path);
  if (!entry) throw new BackupError('not_backup', missing);
  try {
    return JSON.parse(await entry.async('string'));
  } catch {
    throw new BackupError('corrupted', `"${path}" está ilegível.`);
  }
}

/** Registros que apontam para algo ausente no próprio arquivo ficam de fora — e isso é mostrado antes de confirmar. */
function dropBrokenReferences(stores) {
  const warnings = [];
  const ids = (name) => new Set(stores[name].map((r) => r.id));
  const events = ids('events');
  const people = ids('people');
  const teams = ids('teams');
  const categories = ids('categories');
  const options = { skill: ids('skills'), characteristic: ids('characteristics') };
  const filter = (name, keep, label) => {
    const before = stores[name].length;
    stores[name] = stores[name].filter(keep);
    const removed = before - stores[name].length;
    if (removed) warnings.push(`${plural(removed, label.one, label.many)} sem referência no arquivo ${removed === 1 ? 'será ignorada' : 'serão ignoradas'}.`);
  };
  filter('skills', (s) => categories.has(s.categoryId), { one: 'habilidade', many: 'habilidades' });
  filter('teamRequirements', (r) => teams.has(r.teamId) && options[r.kind].has(r.refId), { one: 'exigência de equipe', many: 'exigências de equipe' });
  filter('eventTeams', (t) => events.has(t.eventId), { one: 'equipe de encontro', many: 'equipes de encontro' });
  const eventTeams = new Set(stores.eventTeams.map((t) => `${t.eventId}|${t.teamId}`));
  filter('allocations', (a) => people.has(a.personId) && eventTeams.has(`${a.eventId}|${a.teamId}`), { one: 'distribuição', many: 'distribuições' });
  filter('participationHistory', (r) => events.has(r.eventId), { one: 'participação', many: 'participações' });
  const photoIds = new Set(stores.photos.map((p) => p.id));
  for (const p of stores.people) if (p.photoId && !photoIds.has(p.photoId)) p.photoId = null;
  const usedPhotos = new Set(stores.people.map((p) => p.photoId).filter(Boolean));
  stores.photos = stores.photos.filter((p) => usedPhotos.has(p.id));
  return warnings;
}

// ---------- Restauração (substitui tudo) ----------

export async function restoreBackup(parsed) {
  await transaction([...STORE_NAMES], 'readwrite', async (s) => {
    const deviceSettings = (await req(s.settings.getAll())).filter((r) => DEVICE_SETTINGS.includes(r.key));
    for (const name of DATA_STORES) s[name].clear();
    for (const name of DATA_STORES) for (const record of parsed.stores[name]) s[name].put(record);
    for (const record of deviceSettings) s.settings.put(record);
    const now = nowISO();
    s.metadata.put({ key: 'dataVersion', value: DATA_VERSION });
    s.metadata.put({ key: 'lastRestoreAt', value: now });
    s.metadata.put({ key: 'lastChangeAt', value: now });
  });
  forgetAllPhotos();
  await loadSettings();
}

// ---------- Mesclagem ----------

/** Monta o plano de importação sem gravar nada. */
export async function planMerge(parsed) {
  const local = await readStores(RECORD_STORES.filter((n) => n !== 'settings'));
  const inc = {};
  for (const name of Object.keys(local)) inc[name] = parsed.stores[name].map((r) => ({ ...r }));
  const maps = Object.fromEntries(['categories', 'skills', 'characteristics', 'teams', 'people', 'events'].map((n) => [n, new Map()]));
  const m = (store, id) => maps[store].get(id) ?? id;
  const unified = [];

  // 1. Mesmo cadastro com códigos diferentes (ex.: criado nos dois aparelhos) vira um só.
  const unify = (store, keyOf) => {
    const localIds = new Set(local[store].map((r) => r.id));
    const byKey = new Map();
    for (const r of local[store]) {
      const key = keyOf(r, 'local');
      if (key && !byKey.has(key)) byKey.set(key, r.id);
    }
    for (const r of inc[store]) {
      if (localIds.has(r.id)) continue;
      const target = byKey.get(keyOf(r, 'incoming'));
      if (target) {
        maps[store].set(r.id, target);
        unified.push({ store, name: r.name });
      }
    }
  };
  unify('categories', (r) => normalize(r.name));
  unify('skills', (r, side) => `${side === 'incoming' ? m('categories', r.categoryId) : r.categoryId}|${normalize(r.name)}`);
  unify('characteristics', (r) => `${r.group}|${normalize(r.name)}`);
  unify('teams', (r) => normalize(r.name));
  unify('people', (r) => {
    const contact = digits(r.phone) || normalize(r.email);
    return contact ? `${normalize(r.name)}|${contact}` : null;
  });
  unify('events', (r) => `${normalize(r.name)}|${r.startDate}`);

  // 2. Reescreve as referências do arquivo para os códigos deste aparelho.
  for (const r of inc.categories) r.id = m('categories', r.id);
  for (const r of inc.skills) Object.assign(r, { id: m('skills', r.id), categoryId: m('categories', r.categoryId) });
  for (const r of inc.characteristics) r.id = m('characteristics', r.id);
  for (const r of inc.teams) Object.assign(r, { id: m('teams', r.id), coordinators: r.coordinators.map((c) => ({ ...c, personId: m('people', c.personId) })), referenceMemberIds: r.referenceMemberIds.map((id) => m('people', id)) });
  for (const r of inc.people) Object.assign(r, { id: m('people', r.id), skillIds: r.skillIds.map((id) => m('skills', id)), characteristicIds: r.characteristicIds.map((id) => m('characteristics', id)), availabilityIds: r.availabilityIds.map((id) => m('characteristics', id)), preferredTeamIds: r.preferredTeamIds.map((id) => m('teams', id)), avoidTeamIds: r.avoidTeamIds.map((id) => m('teams', id)) });
  for (const r of inc.teamRequirements) Object.assign(r, { teamId: m('teams', r.teamId), refId: m(r.kind === 'skill' ? 'skills' : 'characteristics', r.refId) });
  for (const r of inc.events) r.id = m('events', r.id);
  for (const r of inc.eventTeams) Object.assign(r, { eventId: m('events', r.eventId), teamId: m('teams', r.teamId) });
  for (const r of inc.allocations) Object.assign(r, { eventId: m('events', r.eventId), teamId: m('teams', r.teamId), personId: m('people', r.personId) });
  for (const r of inc.participationHistory) {
    Object.assign(r, { eventId: m('events', r.eventId), teamId: m('teams', r.teamId), personId: m('people', r.personId) });
    r.id = historyId(r.eventId, r.teamId, r.personId);
  }
  const photos = parsed.stores.photos.map((p) => ({ ...p, personId: m('people', p.personId) }));

  // Depois de unificar, dois registros do arquivo podem ter virado o mesmo: fica o primeiro.
  const dedupe = (list, keyOf) => {
    const seen = new Set();
    return list.filter((r) => {
      const key = keyOf(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  for (const name of [...ENTITY_STORES, 'events']) inc[name] = dedupe(inc[name], (r) => r.id);
  inc.teamRequirements = dedupe(inc.teamRequirements, (r) => `${r.teamId}|${r.kind}|${r.refId}`);
  inc.eventTeams = dedupe(inc.eventTeams, (r) => `${r.eventId}|${r.teamId}`);
  inc.allocations = dedupe(inc.allocations, (r) => `${r.eventId}|${r.teamId}|${r.personId}`);
  inc.participationHistory = dedupe(inc.participationHistory, (r) => r.id);

  // 3. Diferenças.
  const plan = { adds: Object.fromEntries(Object.keys(inc).map((n) => [n, []])), conflicts: [], same: 0, unified, possibleDuplicates: [], photos, skippedRequirements: 0 };
  for (const store of ENTITY_STORES) {
    const byId = new Map(local[store].map((r) => [r.id, r]));
    for (const r of inc[store]) {
      const mine = byId.get(r.id);
      if (!mine) plan.adds[store].push(r);
      else if (same(mine, r)) plan.same++;
      else plan.conflicts.push({ store, id: r.id, name: r.name, local: mine, incoming: r });
    }
  }
  const localNames = new Map(local.people.map((p) => [normalize(p.name), p]));
  for (const p of plan.adds.people) if (localNames.has(normalize(p.name))) plan.possibleDuplicates.push(p.name);

  const reqKeys = new Set(local.teamRequirements.map((r) => `${r.teamId}|${r.kind}|${r.refId}`));
  const reqIds = new Set(local.teamRequirements.map((r) => r.id));
  for (const r of inc.teamRequirements) {
    if (reqKeys.has(`${r.teamId}|${r.kind}|${r.refId}`)) plan.skippedRequirements++;
    else plan.adds.teamRequirements.push(reqIds.has(r.id) ? { ...r, id: `${r.id}-imp` } : r);
  }

  // Encontros andam junto com as equipes, a distribuição e o histórico deles.
  const bundleOf = (src, eventId) => ({ eventTeams: src.eventTeams.filter((t) => t.eventId === eventId), allocations: src.allocations.filter((a) => a.eventId === eventId), participationHistory: src.participationHistory.filter((r) => r.eventId === eventId) });
  const signature = (b) => [...b.eventTeams.map((t) => `T${t.teamId}|${t.name}|${t.color}|${t.targetSize}`), ...b.allocations.map((a) => `A${a.teamId}|${a.personId}|${a.role}`), ...b.participationHistory.map((r) => `H${r.id}|${r.role}|${r.status}`)].sort().join('\n');
  const localEvents = new Map(local.events.map((e) => [e.id, e]));
  const localAllocationIds = new Set(local.allocations.map((a) => a.id));
  const localEventTeamIds = new Set(local.eventTeams.map((t) => t.id));
  for (const event of inc.events) {
    const incoming = bundleOf(inc, event.id);
    // Códigos aleatórios iguais em encontros diferentes são improváveis, mas não podem sobrescrever nada.
    incoming.allocations = incoming.allocations.map((a) => (localAllocationIds.has(a.id) ? { ...a, id: `${a.id}-imp` } : a));
    incoming.eventTeams = incoming.eventTeams.map((t) => (localEventTeamIds.has(t.id) ? { ...t, id: `${t.id}-imp` } : t));
    const mine = localEvents.get(event.id);
    if (!mine) {
      plan.adds.events.push(event);
      for (const name of BUNDLE_STORES) plan.adds[name].push(...incoming[name]);
      continue;
    }
    const localBundle = bundleOf(local, event.id);
    if (same(mine, event) && signature(localBundle) === signature(incoming)) plan.same++;
    else plan.conflicts.push({ store: 'events', id: event.id, name: event.name, local: mine, incoming: event, localBundle, incomingBundle: incoming });
  }
  plan.counts = Object.fromEntries(Object.entries(plan.adds).map(([n, list]) => [n, list.length]));
  return plan;
}

const lastTouch = (record, bundle) => [record.updatedAt ?? '', ...(bundle?.allocations ?? []).map((a) => a.updatedAt ?? ''), ...(bundle?.participationHistory ?? []).map((r) => r.confirmedAt ?? '')].sort().pop();

/**
 * Aplica o plano numa transação só.
 * @param {'local'|'incoming'|'newest'} strategy  como resolver conflitos
 */
export async function applyMerge(plan, strategy = 'local') {
  const winner = (c) => (strategy === 'incoming' ? 'incoming' : strategy === 'newest' ? (lastTouch(c.incoming, c.incomingBundle) > lastTouch(c.local, c.localBundle) ? 'incoming' : 'local') : 'local');
  return transaction([...STORE_NAMES], 'readwrite', async (s) => {
    let written = 0;
    for (const [name, list] of Object.entries(plan.adds)) {
      for (const record of list) {
        s[name].put(record);
        written++;
      }
    }
    let overwritten = 0;
    const replacedPeople = [];
    for (const c of plan.conflicts) {
      if (winner(c) !== 'incoming') continue;
      overwritten++;
      if (c.store === 'events') {
        for (const name of BUNDLE_STORES) for (const r of c.localBundle[name]) s[name].delete(r.id);
        s.events.put(c.incoming);
        for (const name of BUNDLE_STORES) for (const r of c.incomingBundle[name]) s[name].put(r);
      } else {
        s[c.store].put(c.incoming);
        if (c.store === 'people') replacedPeople.push(c);
      }
    }
    // Fotos: entram as que as fichas finais usam; saem as que deixaram de ser usadas por fichas substituídas.
    const people = await req(s.people.getAll());
    const used = new Set(people.map((p) => p.photoId).filter(Boolean));
    const existing = new Set(await req(s.photos.getAllKeys()));
    let photos = 0;
    for (const photo of plan.photos) {
      if (used.has(photo.id) && !existing.has(photo.id)) {
        s.photos.put(photo);
        photos++;
      }
    }
    for (const c of replacedPeople) if (c.local.photoId && !used.has(c.local.photoId)) s.photos.delete(c.local.photoId);
    s.metadata.put({ key: 'lastChangeAt', value: nowISO() });
    return { written, overwritten, kept: plan.conflicts.length - overwritten, photos };
  }).finally(forgetAllPhotos);
}

// ---------- Tela ----------

const STORE_LABEL = { categories: 'categorias', skills: 'habilidades', characteristics: 'características', teams: 'equipes', people: 'pessoas', teamRequirements: 'exigências de equipe', events: 'encontros', eventTeams: 'equipes em encontros', allocations: 'distribuições', participationHistory: 'participações' };

export async function renderBackup(view) {
  const data = await readStores(['people', 'teams', 'events', 'participationHistory']);
  const photoCount = await transaction(['photos'], 'readonly', (s) => req(s.photos.count()));
  const lastBackup = setting('lastBackupAt');
  const canShareFiles = typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'teste.zip', { type: 'application/zip' })] });

  // ---- Exportar ----
  const protect = h('input', { type: 'checkbox', class: 'toggle__input', checked: true });
  const passwordFields = h('div', { class: 'form-grid' }, field({ label: 'Senha do backup', name: 'password', type: 'password', hint: 'Pelo menos 8 caracteres. Sem ela o arquivo não abre — não há como recuperar.', attrs: { autocomplete: 'new-password' } }), field({ label: 'Repita a senha', name: 'confirm', type: 'password', attrs: { autocomplete: 'new-password' } }));
  protect.addEventListener('change', () => (passwordFields.hidden = !protect.checked));
  const exportForm = h('form', { class: 'stack', novalidate: true, dataset: { role: 'export-form' }, onsubmit: (e) => e.preventDefault() }, h('label', { class: 'toggle' }, protect, h('span', { class: 'toggle__track', 'aria-hidden': 'true' }), h('span', { class: 'toggle__label' }, 'Proteger com senha (recomendado)')), passwordFields);

  async function generate() {
    let password = '';
    if (protect.checked) {
      password = exportForm.querySelector('[name=password]').value;
      const confirm = exportForm.querySelector('[name=confirm]').value;
      const problem = validateBackupPassword(password);
      if (!showErrors(exportForm, { password: problem, confirm: !problem && confirm !== password ? 'As senhas não conferem.' : '' })) return null;
    }
    const result = await trackOperation('a geração do backup', buildBackup({ password }));
    await saveSetting('lastBackupAt', nowISO());
    refreshNotices();
    return result;
  }

  const download = async () => {
    try {
      const result = await generate();
      if (!result) return;
      downloadFile(result.blob, result.filename);
      toast(`Backup gerado: ${result.filename} (${fmtBytes(result.blob.size)}). Guarde-o fora deste aparelho.`, { duration: 9000 });
      refresh();
    } catch (error) {
      toastError(error);
    }
  };
  const share = async () => {
    try {
      const result = await generate();
      if (!result) return;
      const file = new File([result.blob], result.filename, { type: 'application/zip' });
      await navigator.share({ files: [file], title: 'Backup do Encontro', text: 'Backup do aplicativo Encontro' });
      toast('Backup compartilhado.');
      refresh();
    } catch (error) {
      if (error?.name !== 'AbortError') toastError(error);
    }
  };

  const exportPanel = section(
    'Exportar backup',
    { lead: 'Um único arquivo .zip com pessoas, fotos, habilidades, equipes, coordenação, encontros, distribuições, histórico e configurações.' },
    h('div', { class: 'tiles tiles--compact' }, tile('Pessoas', data.people.length), tile('Equipes', data.teams.length), tile('Encontros', data.events.length), tile('Fotos', photoCount), tile('Participações', data.participationHistory.length)),
    h('p', { class: 'muted' }, lastBackup ? `Último backup neste aparelho: ${fmtDateTime(lastBackup)} (${relativeDays(lastBackup)}).` : 'Nenhum backup feito neste aparelho ainda.'),
    exportForm,
    h('div', { class: 'row-actions' }, button('Baixar backup', { variant: 'primary', icon: 'download', onClick: download, attrs: { 'data-action': 'export' } }), canShareFiles ? button('Enviar para o Drive ou outro app', { icon: 'share', onClick: share }) : null),
  );

  // ---- Importar ----
  const importBody = h('div', { class: 'stack' });
  const fileInput = h('input', { type: 'file', accept: '.zip,application/zip,application/x-zip-compressed', class: 'file-input', 'aria-label': 'Arquivo de backup', dataset: { role: 'backup-file' } });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) inspect(file);
  });

  async function inspect(file, password = '') {
    importBody.replaceChildren(h('p', { class: 'muted' }, `Conferindo ${file.name}…`));
    try {
      const parsed = await trackOperation('a leitura do backup', readBackupFile(file, password));
      if (parsed.needsPassword) return askPassword(file, '');
      showPreview(file, parsed);
    } catch (error) {
      if (error.code === 'wrong_password') return askPassword(file, error.message);
      importBody.replaceChildren(failure(error));
    }
  }

  function askPassword(file, message) {
    const form = h('form', { class: 'stack', novalidate: true, dataset: { role: 'unlock-form' } }, h('p', { class: 'with-icon' }, icon('lock', { size: 16 }), 'Este backup é protegido por senha.'), field({ label: 'Senha do backup', name: 'password', type: 'password', attrs: { autocomplete: 'current-password', autofocus: true } }), h('div', { class: 'row-actions' }, button('Abrir backup', { variant: 'primary', type: 'submit', attrs: { 'data-action': 'unlock-backup' } })));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = form.querySelector('[name=password]').value;
      if (!value) return showErrors(form, { password: 'Digite a senha.' });
      inspect(file, value);
    });
    importBody.replaceChildren(form);
    if (message) showErrors(form, { password: message });
    form.querySelector('input')?.focus();
  }

  function failure(error) {
    return h('div', { class: 'notice notice--danger notice--block', role: 'alert', dataset: { role: 'import-error' } }, icon('alert', { size: 18 }), h('div', { class: 'notice__text' }, h('strong', null, 'Não foi possível usar este arquivo. '), error.message, error.details?.length ? h('ul', { class: 'error-details' }, error.details.map((d) => h('li', null, d))) : null, h('p', { class: 'muted' }, 'Nenhum dado deste aparelho foi alterado.')));
  }

  function showPreview(file, parsed) {
    const { manifest, counts, warnings } = parsed;
    importBody.replaceChildren(
      h(
        'div',
        { class: 'preview', dataset: { role: 'backup-preview' } },
        h('div', { class: 'preview__head' }, icon('archive', { size: 20 }), h('div', null, h('p', { class: 'preview__name' }, file.name), h('p', { class: 'muted' }, `Exportado em ${fmtDateTime(manifest.exportedAt)} · versão ${manifest.appVersion ?? '—'} (dados v${manifest.dataVersion})`)), manifest.encrypted ? badge('Protegido por senha', 'ok', 'lock') : badge('Sem senha', 'muted')),
        h('div', { class: 'tiles tiles--compact' }, tile('Pessoas', counts.people), tile('Equipes', counts.teams), tile('Encontros', counts.events), tile('Fotos', counts.photos), tile('Participações', counts.participations)),
        h('p', { class: 'ok-line' }, icon('check', { size: 16 }), ' Arquivo íntegro: todos os arquivos conferem com a assinatura do backup.'),
        warnings.length ? h('div', { class: 'notice notice--warn' }, icon('alert', { size: 18 }), h('div', { class: 'notice__text' }, warnings.map((w) => h('p', null, w)))) : null,
        h(
          'div',
          { class: 'choice-cards' },
          h('div', { class: 'choice-card' }, h('h3', null, 'Restaurar backup'), h('p', null, 'Substitui todos os dados deste aparelho pelos do arquivo. Use em aparelho novo ou para voltar a uma cópia.'), button('Restaurar…', { variant: 'danger', icon: 'upload', attrs: { 'data-action': 'restore' }, onClick: () => restoreFlow(parsed) })),
          h('div', { class: 'choice-card' }, h('h3', null, 'Importar dados'), h('p', null, 'Junta o arquivo com o que já existe aqui, sem apagar nada. Você decide o que fazer com registros diferentes.'), button('Importar e mesclar…', { icon: 'swap', attrs: { 'data-action': 'merge' }, onClick: () => mergeFlow(parsed) })),
        ),
      ),
    );
  }

  async function restoreFlow(parsed) {
    const keepCopy = h('input', { type: 'checkbox', checked: data.people.length > 0 || data.events.length > 0 });
    const message = h('div', { class: 'stack-sm' }, h('p', null, `Os dados atuais deste aparelho (${plural(data.people.length, 'pessoa', 'pessoas')}, ${plural(data.events.length, 'encontro', 'encontros')}) serão substituídos por ${plural(parsed.counts.people, 'pessoa', 'pessoas')} e ${plural(parsed.counts.events, 'encontro', 'encontros')} do arquivo.`), h('p', null, 'A troca é feita de uma vez: se algo falhar, os dados atuais continuam como estão. O PIN e o bloqueio deste aparelho não mudam.'), h('label', { class: 'check-row check-row--plain' }, keepCopy, h('span', null, 'Baixar antes uma cópia (sem senha) do que está neste aparelho')));
    const ok = await confirmDialog({ title: 'Substituir os dados deste aparelho?', message, confirmLabel: 'Substituir dados', danger: true });
    if (!ok) return;
    try {
      if (keepCopy.checked) {
        const copy = await trackOperation('a cópia de segurança', buildBackup());
        downloadFile(copy.blob, copy.filename.replace('backup', 'antes-da-restauracao'));
      }
      await trackOperation('a restauração', restoreBackup(parsed));
      toast(`Backup restaurado: ${plural(parsed.counts.people, 'pessoa', 'pessoas')}, ${plural(parsed.counts.events, 'encontro', 'encontros')}, ${plural(parsed.counts.photos, 'foto', 'fotos')}.`, { duration: 8000 });
      refreshNotices();
      location.hash = '#/';
    } catch (error) {
      toastError(error);
    }
  }

  async function mergeFlow(parsed) {
    let plan;
    try {
      plan = await planMerge(parsed);
    } catch (error) {
      return toastError(error);
    }
    let strategy = 'local';
    const totalNew = Object.values(plan.counts).reduce((a, b) => a + b, 0);
    const body = h(
      'div',
      { class: 'stack' },
      h('div', { class: 'merge-summary' }, h('p', null, h('strong', null, plural(totalNew, 'registro novo', 'registros novos')), ' serão adicionados.'), totalNew ? h('ul', { class: 'plain-list' }, Object.entries(plan.counts).filter(([, n]) => n).map(([name, n]) => h('li', null, `${n} ${STORE_LABEL[name] ?? name}`))) : null, h('p', { class: 'muted' }, `${plural(plan.same + plan.skippedRequirements, 'registro já existia igual', 'registros já existiam iguais')} e ${plan.same + plan.skippedRequirements === 1 ? 'será ignorado' : 'serão ignorados'}.`)),
      plan.unified.length ? h('div', { class: 'notice notice--info' }, icon('info', { size: 18 }), h('p', { class: 'notice__text' }, `${plural(plan.unified.length, 'cadastro do arquivo foi reconhecido', 'cadastros do arquivo foram reconhecidos')} como já existente aqui (mesmo nome${plan.unified.some((u) => u.store === 'people') ? ' e telefone/e-mail' : ''}) e ${plan.unified.length === 1 ? 'será unificado' : 'serão unificados'}: ${plan.unified.slice(0, 8).map((u) => u.name).join(', ')}${plan.unified.length > 8 ? '…' : ''}.`)) : null,
      plan.possibleDuplicates.length ? h('div', { class: 'notice notice--warn' }, icon('alert', { size: 18 }), h('p', { class: 'notice__text' }, `Possíveis duplicidades (mesmo nome, sem telefone ou e-mail igual), que entram como fichas separadas: ${plan.possibleDuplicates.slice(0, 8).join(', ')}. Confira depois na lista de pessoas.`)) : null,
      plan.conflicts.length
        ? h(
            'div',
            { class: 'stack-sm' },
            h('p', null, h('strong', null, plural(plan.conflicts.length, 'registro está diferente', 'registros estão diferentes')), ' entre este aparelho e o arquivo:'),
            h('ul', { class: 'plain-list conflict-list' }, plan.conflicts.slice(0, 12).map((c) => h('li', null, `${c.name} (${STORE_LABEL[c.store]})`))),
            plan.conflicts.length > 12 ? h('p', { class: 'muted' }, `…e mais ${plan.conflicts.length - 12}.`) : null,
            segmented({ name: 'merge-strategy', label: 'O que fazer com os diferentes', value: strategy, options: [{ value: 'local', label: 'Manter os deste aparelho' }, { value: 'incoming', label: 'Usar os do arquivo' }, { value: 'newest', label: 'Ficar com o mais recente' }], onChange: (v) => (strategy = v) }),
            h('p', { class: 'muted' }, 'Encontros diferentes são trocados por inteiro (equipes, distribuição e histórico juntos), para o histórico continuar coerente.'),
          )
        : null,
      h('p', { class: 'muted' }, 'Configurações, PIN e preferências deste aparelho não são alterados pela importação.'),
    );
    openModal({
      title: 'Importar dados do arquivo',
      size: 'lg',
      body,
      actions: [
        { label: 'Cancelar', variant: 'ghost' },
        {
          label: 'Importar',
          variant: 'primary',
          id: 'confirm-merge',
          onClick: async () => {
            const result = await trackOperation('a importação', applyMerge(plan, strategy));
            toast(`Importação concluída: ${plural(result.written, 'registro adicionado', 'registros adicionados')}${result.overwritten ? `, ${plural(result.overwritten, 'substituído', 'substituídos')}` : ''}${result.kept ? `, ${plural(result.kept, 'mantido', 'mantidos')} como estava` : ''}.`, { duration: 8000 });
            refreshNotices();
            location.hash = '#/';
          },
        },
      ],
    });
  }

  const importPanel = section('Importar arquivo', { lead: 'Escolha um backup .zip deste aplicativo. Ele é conferido por inteiro antes de qualquer alteração.' }, h('label', { class: 'file-drop' }, icon('upload', { size: 22 }), h('span', null, 'Escolher arquivo de backup'), fileInput), importBody);

  const guide = section(
    'Como passar os dados do celular para o computador',
    { lead: 'Os dados ficam no navegador de cada aparelho. A passagem é feita por este arquivo.' },
    h(
      'ol',
      { class: 'steps' },
      h('li', null, h('strong', null, 'No celular: '), 'Exportar backup (com senha) e tocar em “Enviar para o Drive ou outro app” → Google Drive. Ou baixe e envie o arquivo manualmente.'),
      h('li', null, h('strong', null, 'No computador: '), 'baixe o arquivo do Google Drive.'),
      h('li', null, h('strong', null, 'Abra este aplicativo no computador '), '(mesmo endereço), vá em Backup e transferência → Importar arquivo.'),
      h('li', null, h('strong', null, 'Restaurar '), 'se o computador está vazio ou deve ficar igual ao celular; ', h('strong', null, 'Importar dados '), 'para juntar com o que já existe lá.'),
    ),
  );

  view.replaceChildren(h('div', { class: 'page' }, pageHeader({ eyebrow: 'Seus dados, seus arquivos', title: 'Backup e transferência', lead: 'Nada sai deste aparelho sozinho. Faça backups com frequência e guarde-os fora do aparelho (Google Drive, e-mail, pen drive).' }), h('div', { class: 'two-col two-col--panels' }, exportPanel, importPanel), guide));
}

function tile(label, value) {
  return h('div', { class: 'tile' }, h('span', { class: 'tile__value' }, String(value)), h('span', { class: 'tile__label' }, label));
}
