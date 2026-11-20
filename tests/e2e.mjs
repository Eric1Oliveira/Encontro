// Teste completo em navegador real (Edge/Chrome sem janela): cadastros, fotos, distribuição, histórico,
// correções, relatórios, backup (com e sem senha), restauração em banco vazio, falhas, PIN, uso sem
// internet, atualização controlada, telas de celular e persistência depois de fechar o navegador.
//
// Uso: npm test            (SHOTS=pasta para salvar capturas de tela)
import { mkdtemp, rm, cp, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/servidor.mjs';
import { openBrowser, sleep } from './browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5537;
const URL_APP = `http://localhost:${PORT}/`;
const work = await mkdtemp(join(tmpdir(), 'encontro-teste-'));
const site = join(work, 'site');
const profile = join(work, 'perfil');
const downloads = join(work, 'downloads');
const shotsDir = process.env.SHOTS || null;

// Cópia do site: o teste de atualização altera o sw.js sem tocar no projeto.
await cp(ROOT, site, { recursive: true, filter: (src) => !/[\\/](tests|node_modules|\.git)([\\/]|$)/.test(src.slice(ROOT.length)) });
await copyFile(join(ROOT, 'assets/icons/icon-512.png'), join(work, 'foto.png'));

let server = await startServer(PORT, site);
let b = await openBrowser({ profile, downloads, shotsDir });
const results = [];
const ignoredConsole = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function eq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
}
async function step(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`  ✔ ${name} (${Date.now() - start} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  ✘ ${name}\n    ${error.message}`);
    if (shotsDir) await b.shot(`falha-${results.length}`).catch(() => {});
    throw error;
  }
}

const IMPORTS = `
  const db = await import('/js/database.js');
  const schema = await import('/js/schema.js');
  const people = await import('/js/modules/people.js');
  const skills = await import('/js/modules/skills.js');
  const teams = await import('/js/modules/teams.js');
  const events = await import('/js/modules/events.js');
  const alloc = await import('/js/modules/allocations.js');
  const hist = await import('/js/modules/history.js');
  const assistant = await import('/js/modules/assistant.js');
  const backup = await import('/js/backup.js');
  const security = await import('/js/security.js');
  const all = async (s) => db.getAll(s);
  const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code ?? e.name ?? e.message; } };
`;
const app = (body) => b.evaluate(`(async () => { ${IMPORTS} ${body} })()`);
const ready = () => b.waitFor(`document.documentElement.dataset.ready === 'true'`, 'aplicativo pronto', 15000);
/** Vai para a rota e espera a tela NOVA terminar de desenhar (não aceita elementos da tela anterior). */
const go = async (hash, waitSelector) => {
  const sel = JSON.stringify(waitSelector ?? '*');
  const same = await b.evaluate(`location.hash === ${JSON.stringify(hash)}`);
  await b.evaluate(`document.querySelector('#view .view__inner')?.setAttribute('data-old', '')`);
  if (same) await b.evaluate(`import('/js/router.js').then((r) => r.refresh())`);
  else await b.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await b.waitFor(`(() => { const v = document.querySelector('#view .view__inner'); return v && !v.hasAttribute('data-old') && !v.querySelector('.loading') && v.querySelector(${sel}); })()`, `tela ${hash}`);
};
const setValue = (selector, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const toastSeen = (text) => b.waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, `aviso "${text}"`);
const waitDownload = async (suffix, before = new Set()) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const files = (await readdir(downloads).catch(() => [])).filter((f) => f.endsWith(suffix) && !before.has(f));
    if (files.length) {
      await sleep(300);
      return join(downloads, files[0]);
    }
    await sleep(150);
  }
  throw new Error(`download ${suffix} não apareceu`);
};
const listDownloads = async () => new Set(await readdir(downloads).catch(() => []));

const ids = {};
console.log(`\nEncontro — teste completo (${URL_APP})\n`);

try {
  // ---------------------------------------------------------------- Fase 1
  await step('O service worker guarda todos os arquivos do aplicativo (uso sem internet)', async () => {
    const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
    const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
    const files = [];
    for (const dir of ['css', 'js', 'js/modules', 'js/components', 'vendor', 'assets/fonts', 'assets/icons']) {
      for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) if (entry.isFile()) files.push(`${dir}/${entry.name}`);
    }
    // Os textos de licença das fontes (.txt) não são usados pelo app em funcionamento.
    const missing = [...files, 'index.html', 'manifest.json'].filter((f) => !listed.has(f) && !f.endsWith('.txt'));
    const ghost = [...listed].filter((f) => f !== './' && !files.includes(f) && !['index.html', 'manifest.json'].includes(f));
    eq({ missing, ghost }, { missing: [], ghost: [] }, 'lista de arquivos do sw.js');
  });

  await step('Abre o aplicativo e cria o banco com as opções iniciais', async () => {
    await b.goto(URL_APP);
    await ready();
    const counts = await app(`return { categories: (await all('categories')).length, skills: (await all('skills')).length, profile: (await all('characteristics')).length, version: (await db.getOne('metadata', 'dataVersion')).value };`);
    eq(counts.categories, 7, 'categorias iniciais');
    assert(counts.skills >= 35, 'habilidades iniciais');
    eq(counts.version, 2, 'versão dos dados');
    await b.shot('d01-primeiro-uso');
  });

  // ---------------------------------------------------------------- Equipes
  await step('Cadastra equipe pela tela (cor, ícone, quantidade)', async () => {
    await go('#/equipes', '.empty');
    await b.clickText('Nova equipe');
    await b.waitFor(`document.querySelector('dialog[open] [name=name]')`, 'formulário da equipe');
    await b.fill('dialog[open] [name=name]', 'Música');
    await b.click('dialog[open] .swatch[data-color="#2F6FB0"]');
    await b.click('dialog[open] [data-icon="music"]');
    await b.fill('dialog[open] [name=targetSize]', '6');
    await b.fill('dialog[open] [name=goal]', 'Conduzir os momentos de louvor.');
    await b.click('[data-action="save-team"]');
    await b.waitFor(`location.hash.startsWith('#/equipes/') && document.querySelector('.page-title')?.textContent.includes('Música')`, 'ficha da equipe');
    const team = await app(`return (await all('teams'))[0];`);
    eq([team.name, team.color, team.icon, team.targetSize, team.status], ['Música', '#2F6FB0', 'music', 6, 'ativa'], 'equipe gravada');
    ids.musica = team.id;
  });

  await step('Cadastra mais equipes e recusa nome repetido', async () => {
    const r = await app(`
      const a = await teams.saveTeam({ ...teams.blankTeam(), name: 'Liturgia', color: '#7A4FB3', icon: 'chalice', targetSize: 4 });
      const c = await teams.saveTeam({ ...teams.blankTeam(), name: 'Cozinha', color: '#C77A12', icon: 'pot', targetSize: 8 });
      const s = await teams.saveTeam({ ...teams.blankTeam(), name: 'Secretaria', color: '#16897F', icon: 'clipboard' });
      const dup = await code(teams.saveTeam({ ...teams.blankTeam(), name: 'música ' }));
      return { liturgia: a.record.id, cozinha: c.record.id, secretaria: s.record.id, dup };`);
    eq(r.dup, 'duplicate', 'nome de equipe repetido');
    Object.assign(ids, r);
  });

  // ---------------------------------------------------------------- Pessoas
  await step('Cadastra pessoa pela tela, com foto, habilidades, perfil e preferências', async () => {
    await go('#/pessoas/nova', '[name=name]');
    await b.fill('[name=name]', 'Maria José da Silva');
    await b.fill('[name=phone]', '11987654321');
    await b.fill('[name=email]', 'Maria@Exemplo.com');
    await b.fill('[name=instagram]', 'maria.jose');
    await b.setInputFiles('input[type=file]', [join(work, 'foto.png')]);
    await b.waitFor(`document.querySelector('.photo-field__preview img')`, 'prévia da foto');
    await b.click('#tab-habilidades');
    await b.click('label.chip:has(input[value="skl-violao"])');
    await b.click('label.chip:has(input[value="skl-voz-principal"])');
    await b.click('#tab-perfil');
    await b.click('label.chip:has(input[value="chr-comunicativo"])');
    await b.click('#tab-preferencias');
    await b.click(`label.chip:has(input[name="preferredTeamIds"][value="${ids.musica}"])`);
    await b.click('.segmented__item:has(input[name="availabilityStatus"][value="disponivel"])');
    await b.click('label.chip:has(input[value="avl-sabado"])');
    await b.click('[data-action="save-person"]');
    await b.waitFor(`location.hash.startsWith('#/pessoas/') && !location.hash.includes('nova') && document.querySelector('.page-title')?.textContent === 'Maria José da Silva'`, 'ficha salva');
    const p = await app(`
      const p = (await all('people')).find((x) => x.name === 'Maria José da Silva');
      const photo = await db.getOne('photos', p.photoId);
      const bmp = await createImageBitmap(photo.blob);
      return { ...p, photoType: photo.blob.type, photoSize: photo.blob.size, w: bmp.width, h: bmp.height };`);
    eq([p.phone, p.email, p.instagram, p.availabilityStatus], ['(11) 98765-4321', 'maria@exemplo.com', '@maria.jose', 'disponivel'], 'dados normalizados');
    eq([p.skillIds.sort(), p.characteristicIds, p.preferredTeamIds, p.availabilityIds], [['skl-violao', 'skl-voz-principal'], ['chr-comunicativo'], [ids.musica], ['avl-sabado']], 'classificações');
    assert(p.photoType === 'image/jpeg' && p.photoSize > 1000 && p.w <= 960 && p.h <= 960, `foto reduzida e guardada (${p.photoType}, ${p.photoSize} B, ${p.w}x${p.h})`);
    ids.maria = p.id;
  });

  await step('Edita a ficha e valida campos inválidos', async () => {
    await b.fill('[name=phone]', '21912345678');
    await b.click('[data-action="save-person"]');
    await toastSeen('Ficha salva.');
    eq(await app(`return (await db.getOne('people', ${JSON.stringify(ids.maria)})).phone;`), '(21) 91234-5678', 'telefone editado');
    await go('#/pessoas/nova', '[name=name]');
    await b.fill('[name=name]', 'A');
    await b.fill('[name=email]', 'email-invalido');
    await b.click('[data-action="save-person"]');
    await b.waitFor(`document.querySelectorAll('.field--error').length === 2`, 'erros nos campos');
    eq(await app(`return (await all('people')).length;`), 1, 'nada gravado com erro');
    await b.evaluate(`(async () => { (await import('/js/router.js')).setDirty(false); })()`);
  });

  await step('Cadastra 26 pessoas e encontra por busca sem acento e por filtro de habilidade', async () => {
    const r = await app(`
      const names = ['João Pedro Alves', 'Ana Beatriz Costa', 'Carlos Eduardo Lima', 'Fernanda Rocha', 'Lucas Martins', 'Juliana Prado', 'Rafael Nunes', 'Camila Duarte', 'Bruno Teixeira', 'Patrícia Gomes', 'Thiago Ribeiro', 'Larissa Moura', 'Gabriel Farias', 'Beatriz Cardoso', 'Mateus Barros', 'Aline Freitas', 'Diego Pires', 'Renata Campos', 'Felipe Araújo', 'Vanessa Lopes', 'Gustavo Melo', 'Priscila Reis', 'André Batista', 'Letícia Castro', 'Rodrigo Pinto', 'Sabrina Dias'];
      const out = {};
      for (const [i, name] of names.entries()) {
        const skillIds = i % 5 === 0 ? ['skl-violao'] : i % 3 === 0 ? ['skl-cozinha'] : ['skl-secretaria'];
        const { record } = await people.savePerson({ ...people.blankPerson(), name, phone: '1199' + String(1000000 + i).slice(1), skillIds, availabilityStatus: i % 4 === 0 ? 'limitada' : 'disponivel' });
        out[name] = record.id;
      }
      return out;`);
    ids.people = r;
    await go('#/pessoas', '.search__input');
    await b.fill('.search__input', 'joao pedro');
    await b.waitFor(`document.querySelector('.result-count')?.textContent.includes('1 pessoa encontrada')`, 'busca sem acento');
    await setValue('.search__input', '');
    await b.waitFor(`document.querySelector('.result-count')?.textContent === '27 pessoas'`, 'lista completa');
    await b.evaluate(`(() => { const s = [...document.querySelectorAll('.select-box')].find((l) => l.textContent.startsWith('Habilidade')).querySelector('select'); s.value = 'skl-violao'; s.dispatchEvent(new Event('change')); })()`);
    const expected = await app(`return (await all('people')).filter((p) => p.skillIds.includes('skl-violao')).length;`);
    await b.waitFor(`document.querySelector('.result-count')?.textContent.startsWith('${expected} pessoas encontradas')`, `filtro por habilidade (${expected})`);
    await b.clickText('Cartões');
    await b.waitFor(`document.querySelectorAll('.person-card').length === ${expected}`, 'visualização em cartões');
    await b.clickText('Limpar filtros');
    await b.clickText('Lista');
  });

  // ---------------------------------------------------------------- Habilidades
  await step('Cadastro ilimitado de habilidades (60 numa categoria + inclusão pela tela) e regras de uso', async () => {
    const r = await app(`
      const cat = await skills.saveCategory({ name: 'Oficinas', area: 'tecnica' });
      for (let i = 1; i <= 60; i++) await skills.saveOption('skills', { name: 'Oficina ' + i, categoryId: cat.id });
      const dup = await code(skills.saveOption('skills', { name: 'oficina 7', categoryId: cat.id }));
      const inUse = await code(skills.deleteOption('skills', 'skl-violao'));
      await skills.setActive('skills', 'skl-flauta', false);
      return { count: (await all('skills')).filter((s) => s.categoryId === cat.id).length, dup, inUse };`);
    eq(r, { count: 60, dup: 'duplicate', inUse: 'in_use' }, 'habilidades');
    await go('#/cadastros', '.inline-add__input');
    await b.fill('.inline-add__input', 'Ukulele');
    await b.evaluate(`document.querySelector('.inline-add').requestSubmit()`);
    await toastSeen('"Ukulele" adicionada.');
    assert(await app(`return (await all('skills')).some((s) => s.name === 'Ukulele');`), 'Ukulele gravada');
  });

  // ---------------------------------------------------------------- Coordenação
  await step('Equipe com vários coordenadores: adicionar, trocar, encerrar e histórico', async () => {
    const p = ids.people;
    const r = await app(`
      const m = ${JSON.stringify(ids.musica)};
      for (const id of ${JSON.stringify([p['Carlos Eduardo Lima'], p['Fernanda Rocha'], p['Lucas Martins']])}) await teams.addCoordinator(m, id);
      const dup = await code(teams.addCoordinator(m, ${JSON.stringify(p['Carlos Eduardo Lima'])}));
      await teams.swapCoordinator(m, ${JSON.stringify(p['Lucas Martins'])}, ${JSON.stringify(p['Juliana Prado'])});
      await teams.endCoordinator(m, ${JSON.stringify(p['Fernanda Rocha'])});
      const t = await db.getOne('teams', m);
      return { dup, current: teams.currentCoordinators(t).map((c) => c.personId), total: t.coordinators.length, ended: t.coordinators.filter((c) => c.until).length };`);
    eq(r, { dup: 'duplicate', current: [p['Carlos Eduardo Lima'], p['Juliana Prado']], total: 4, ended: 2 }, 'coordenação');
    await go(`#/equipes/${ids.musica}`, '.person-line');
    eq(await b.evaluate(`document.querySelectorAll('.person-list .person-line').length`), 2, 'coordenação atual na tela');
    await app(`await teams.saveRequirements(${JSON.stringify(ids.musica)}, [{ kind: 'skill', refId: 'skl-violao', weight: 3 }, { kind: 'skill', refId: 'skl-voz-principal', weight: 2 }, { kind: 'characteristic', refId: 'chr-comunicativo', weight: 1 }]);`);
  });

  // ---------------------------------------------------------------- Encontros
  await step('Cria encontro pela tela e adiciona as equipes (coordenação entra junto)', async () => {
    await go('#/encontros', '.empty');
    await b.clickText('Novo encontro');
    await b.waitFor(`document.querySelector('dialog[open] [name=name]')`, 'formulário do encontro');
    await b.fill('dialog[open] [name=name]', '1º Encontro de Jovens');
    await setValue('dialog[open] [name=startDate]', '2026-03-13');
    await setValue('dialog[open] [name=endDate]', '2026-03-15');
    await b.fill('dialog[open] [name=location]', 'Casa de Retiro São José');
    await b.click('[data-action="save-event"]');
    await b.waitFor(`location.hash.startsWith('#/encontros/') && document.querySelector('.page-title')?.textContent === '1º Encontro de Jovens'`, 'página do encontro');
    ids.ev1 = await b.evaluate(`location.hash.split('/')[2]`);
    await b.clickText('Adicionar equipes');
    await b.waitFor(`document.querySelector('dialog[open] input[name=team]')`, 'lista de equipes');
    await b.evaluate(`document.querySelectorAll('dialog[open] input[name=team]').forEach((i) => (i.checked = true))`);
    await b.click('[data-action="add-teams"]');
    await b.waitFor(`document.querySelectorAll('.q-col').length === 4`, 'quatro colunas no quadrante');
    eq(await b.evaluate(`document.querySelectorAll('.q-col[data-team="${ids.musica}"] .q-member--coord').length`), 2, 'coordenadores trazidos da equipe');
  });

  await step('Assistente explica a compatibilidade e a escala é feita pela tela', async () => {
    const r = await app(`
      const ctx = await alloc.loadEventContext(${JSON.stringify(ids.ev1)});
      const ranked = assistant.rankCandidates({ teamId: ${JSON.stringify(ids.musica)}, requirements: ctx.requirements.filter((x) => x.teamId === ${JSON.stringify(ids.musica)}), people: ctx.peopleList, stats: ctx.stats, eventAllocations: ctx.allocations, teamNames: new Map(ctx.eventTeams.map((t) => [t.teamId, t.name])), names: skills.optionNames(ctx.catalog), weights: db.setting('weights') });
      return ranked.slice(0, 3).map((c) => ({ name: c.person.name, score: c.score, reasons: c.reasons.map((x) => x.text) }));`);
    eq(r[0].name, 'Maria José da Silva', 'mais compatível');
    assert(r[0].score >= 80 && r[0].score > r[1].score + 20, `pontuação (${r[0].score} x ${r[1].score})`);
    for (const reason of ['Possui Violão (essencial)', 'Possui Voz principal (importante)', 'Tem interesse nesta equipe', 'Está disponível']) assert(r[0].reasons.includes(reason), `motivo "${reason}" em ${r[0].reasons.join(' | ')}`);
    await b.click(`.q-col[data-team="${ids.musica}"] .q-col__cta`);
    await b.waitFor(`document.querySelector('dialog[open] .cand')`, 'sugestões');
    eq(await b.evaluate(`document.querySelector('dialog[open] .cand .cand__name').textContent`), 'Maria José da Silva', 'primeira sugestão na tela');
    await b.shot('d05-montar-equipe');
    await b.click('dialog[open] .cand .cand__actions button');
    await b.waitFor(`document.querySelectorAll('dialog[open] .composer-row').length === 3`, 'Maria entra na equipe');
    await b.click('[data-action="close-composer"]');
    await b.waitFor(`document.querySelectorAll('.q-col[data-team="${ids.musica}"] .q-member').length === 3`, 'quadrante atualizado');
  });

  await step('Distribuição: duplicidade bloqueada, pessoa em duas equipes com aviso, ficha arquivada fora', async () => {
    const p = ids.people;
    const r = await app(`
      const ev = ${JSON.stringify(ids.ev1)};
      const add = (teamId, personId, role) => alloc.addPerson({ eventId: ev, teamId, personId, role });
      const T = ${JSON.stringify({ m: ids.musica, l: ids.liturgia, c: ids.cozinha, s: ids.secretaria })};
      const P = ${JSON.stringify(p)};
      await add(T.m, P['João Pedro Alves']);
      await add(T.l, P['Ana Beatriz Costa'], 'coordenador');
      await add(T.l, P['Rafael Nunes']);
      await add(T.l, P['Camila Duarte']);
      await add(T.c, P['Bruno Teixeira'], 'coordenador');
      await add(T.c, P['Patrícia Gomes']);
      await add(T.c, P['Thiago Ribeiro']);
      await add(T.s, P['Larissa Moura']);
      const twice = await add(T.c, P['João Pedro Alves']);
      const dup = await code(add(T.m, P['João Pedro Alves']));
      const raw = await code(db.transaction(['allocations'], 'readwrite', (s) => db.req(s.allocations.add({ id: 'x-dup', eventId: ev, teamId: T.m, personId: P['João Pedro Alves'], role: 'integrante' }))));
      await people.setPersonStatus(P['Sabrina Dias'], 'arquivado');
      const archived = await code(add(T.s, P['Sabrina Dias']));
      await people.setPersonStatus(P['Sabrina Dias'], 'ativo');
      return { twice: twice.otherTeams, dup, raw, archived, total: (await all('allocations')).length };`);
    eq(r, { twice: ['Música'], dup: 'duplicate', raw: 'duplicate', archived: 'archived', total: 12 }, 'regras de distribuição');
    await go(`#/encontros/${ids.ev1}`, '.q-col');
    await b.waitFor(`document.querySelector('.q-toolbar__warn')?.textContent.includes('1 pessoa está em mais de uma equipe')`, 'aviso de duas equipes');
    await b.shot('d06-quadrante');
    // Impresso: uma folha por equipe, com as mesmas pessoas da tela, coordenação à parte e o aviso de duas equipes.
    const sheets = await b.evaluate(`({ cols: document.querySelectorAll('.q-grid .q-col').length, members: document.querySelectorAll('.q-grid .q-member').length, sheets: [...document.querySelectorAll('.q-print .q-sheet')].map((s) => ({ coord: [...s.querySelectorAll('.q-sheet__coord tbody tr')].map((tr) => tr.children[1].textContent), rows: s.querySelectorAll('tbody tr').length, text: s.textContent })) })`);
    eq(
      { folhas: sheets.sheets.length, linhas: sheets.sheets.reduce((n, s) => n + s.rows, 0), bruno: sheets.sheets.some((s) => s.coord.includes('Bruno Teixeira')), joao: sheets.sheets.some((s) => s.text.includes('João Pedro Alvestambém em Música')) },
      { folhas: sheets.cols, linhas: sheets.members, bruno: true, joao: true },
      'quadrante impresso',
    );
    if (shotsDir) {
      const { data } = await b.page('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
      await writeFile(join(shotsDir, 'd06-quadrante-impresso.pdf'), Buffer.from(data, 'base64'));
    }
  });

  await step('Conclui pela tela marcando uma ausência; histórico conta certo', async () => {
    const p = ids.people;
    const absentAlloc = await app(`return (await all('allocations')).find((a) => a.personId === ${JSON.stringify(p['Thiago Ribeiro'])}).id;`);
    await b.click('[data-action="conclude"]');
    await b.waitFor(`document.querySelector('[data-action="confirm-conclusion"]')`, 'tela de revisão');
    await b.click(`.segmented__item:has(input[name="att-${absentAlloc}"][value="ausente"])`);
    await b.click('[data-action="confirm-conclusion"]');
    await b.waitFor(`location.hash === '#/encontros/${ids.ev1}' && document.querySelector('.badge--ok')?.textContent === 'Concluído'`, 'encontro concluído');
    const r = await app(`
      const h = await all('participationHistory');
      const stats = hist.buildStats(h);
      const P = ${JSON.stringify(p)};
      const joao = stats.get(P['João Pedro Alves']);
      const carlos = stats.get(P['Carlos Eduardo Lima']);
      return { records: h.length, absent: h.filter((x) => x.status === 'ausente').length, joao: [joao.participations, joao.events.size], carlos: [carlos.participations, carlos.coordinations], thiago: stats.has(P['Thiago Ribeiro']), locked: await code(alloc.addPerson({ eventId: ${JSON.stringify(ids.ev1)}, teamId: ${JSON.stringify(ids.secretaria)}, personId: P['Diego Pires'] })) };`);
    eq(r, { records: 12, absent: 1, joao: [2, 1], carlos: [1, 1], thiago: false, locked: 'locked' }, 'histórico após conclusão');
  });

  await step('Encontro em planejamento não entra no histórico', async () => {
    const r = await app(`
      const { record } = await events.saveEvent({ name: '2º Encontro de Jovens', startDate: '2026-09-11', endDate: '2026-09-13', location: '', description: '', notes: '' });
      await alloc.addTeamToEvent(record.id, ${JSON.stringify(ids.musica)}, { includeCoordinators: false });
      await alloc.addPerson({ eventId: record.id, teamId: ${JSON.stringify(ids.musica)}, personId: ${JSON.stringify(ids.people['João Pedro Alves'])} });
      const s = hist.buildStats(await all('participationHistory')).get(${JSON.stringify(ids.people['João Pedro Alves'])});
      return { id: record.id, participations: s.participations, events: s.events.size };`);
    ids.ev2 = r.id;
    eq([r.participations, r.events], [2, 1], 'planejamento não conta');
  });

  // ---------------------------------------------------------------- Correções
  await step('Reabrir preserva o histórico; descartar volta exatamente ao registrado', async () => {
    const snapshot = `return (await all('participationHistory')).map((h) => [h.id, h.role, h.status].join('|')).sort();`;
    const before = await app(snapshot);
    await go(`#/encontros/${ids.ev1}`, '[data-action="reopen"]');
    await b.click('[data-action="reopen"]');
    await b.click('dialog[open] [data-action="confirm"]');
    await b.waitFor(`document.querySelector('[data-action="discard"]')`, 'aviso de reabertura');
    const p = ids.people;
    await app(`
      const a = (await all('allocations')).filter((x) => x.eventId === ${JSON.stringify(ids.ev1)});
      await alloc.removeAllocation(a.find((x) => x.personId === ${JSON.stringify(p['Patrícia Gomes'])}).id);
      await alloc.setRole(a.find((x) => x.personId === ${JSON.stringify(p['Rafael Nunes'])}).id, 'coordenador');
      await alloc.addPerson({ eventId: ${JSON.stringify(ids.ev1)}, teamId: ${JSON.stringify(ids.liturgia)}, personId: ${JSON.stringify(p['Gabriel Farias'])} });`);
    eq(await app(snapshot), before, 'histórico intocado durante a correção');
    await go(`#/encontros/${ids.ev1}`, '[data-action="discard"]');
    await b.click('[data-action="discard"]');
    await b.click('dialog[open] [data-action="confirm"]');
    await b.waitFor(`document.querySelector('.badge--ok')?.textContent === 'Concluído'`, 'concluído de novo');
    const r = await app(`
      const h = (await all('participationHistory')).filter((x) => x.eventId === ${JSON.stringify(ids.ev1)}).map((x) => [x.teamId, x.personId, x.role].join('|')).sort();
      const a = (await all('allocations')).filter((x) => x.eventId === ${JSON.stringify(ids.ev1)}).map((x) => [x.teamId, x.personId, x.role].join('|')).sort();
      return { same: JSON.stringify(h) === JSON.stringify(a), n: a.length };`);
    eq(r, { same: true, n: 12 }, 'distribuição restaurada do histórico');
    eq(await app(snapshot), before, 'histórico igual ao original');
  });

  await step('Correção confirmada atualiza o histórico numa transação, sem contar duas vezes', async () => {
    const p = ids.people;
    const r = await app(`
      const ev = ${JSON.stringify(ids.ev1)};
      await hist.reopenEvent(ev);
      const a = (await all('allocations')).filter((x) => x.eventId === ev);
      await alloc.removeAllocation(a.find((x) => x.personId === ${JSON.stringify(p['Patrícia Gomes'])}).id);
      await alloc.setRole(a.find((x) => x.personId === ${JSON.stringify(p['Rafael Nunes'])}).id, 'coordenador');
      await alloc.addPerson({ eventId: ev, teamId: ${JSON.stringify(ids.liturgia)}, personId: ${JSON.stringify(p['Gabriel Farias'])} });
      const review = await hist.reviewData(ev);
      await hist.concludeEvent(ev, {});
      const h = (await all('participationHistory')).filter((x) => x.eventId === ev);
      const s = hist.buildStats(await all('participationHistory'));
      return { diff: [review.diff.added.length, review.diff.removed.length, review.diff.changed.length], records: h.length, unique: new Set(h.map((x) => x.id)).size, patricia: s.has(${JSON.stringify(p['Patrícia Gomes'])}), rafael: s.get(${JSON.stringify(p['Rafael Nunes'])}).coordinations, gabriel: s.get(${JSON.stringify(p['Gabriel Farias'])}).participations, thiagoBack: h.find((x) => x.personId === ${JSON.stringify(p['Thiago Ribeiro'])}).status, status: (await db.getOne('events', ev)).status };`);
    eq(r, { diff: [1, 1, 1], records: 12, unique: 12, patricia: false, rafael: 1, gabriel: 1, thiagoBack: 'confirmada', status: 'concluido' }, 'histórico corrigido');
  });

  await step('Alterar uma equipe não muda encontros já concluídos', async () => {
    const r = await app(`
      const t = await db.getOne('teams', ${JSON.stringify(ids.musica)});
      await teams.saveTeam({ ...t, name: 'Música e Louvor', color: '#B0306A' });
      const et = await all('eventTeams');
      const h = (await all('participationHistory')).filter((x) => x.teamId === ${JSON.stringify(ids.musica)});
      return { concluded: et.find((x) => x.eventId === ${JSON.stringify(ids.ev1)} && x.teamId === ${JSON.stringify(ids.musica)}).name, planning: et.find((x) => x.eventId === ${JSON.stringify(ids.ev2)}).name, history: [...new Set(h.map((x) => x.teamName + x.teamColor))] };`);
    eq(r, { concluded: 'Música', planning: 'Música e Louvor', history: ['Música#2F6FB0'] }, 'retrato da equipe');
  });

  // ---------------------------------------------------------------- Exclusão
  await step('Excluir pessoa: com histórico só arquiva; sem histórico apaga ficha, foto e escala', async () => {
    eq(await app(`return code(people.deletePerson(${JSON.stringify(ids.people['João Pedro Alves'])}));`), 'has_history', 'histórico protegido');
    const temp = await app(`
      const { record } = await people.savePerson({ ...people.blankPerson(), name: 'Pessoa Temporária' }, { blob: await (await fetch('/assets/icons/icon-192.png')).blob() });
      await alloc.addPerson({ eventId: ${JSON.stringify(ids.ev2)}, teamId: ${JSON.stringify(ids.musica)}, personId: record.id });
      return record;`);
    await go(`#/pessoas/${temp.id}`, '.page-title');
    await b.clickText('Excluir', '.page-head');
    await b.waitFor(`document.querySelector('dialog[open] [data-action="delete"]')`, 'escolha de exclusão');
    await b.click('dialog[open] [data-action="delete"]');
    await b.waitFor(`location.hash === '#/pessoas'`, 'volta para a lista');
    const r = await app(`return { person: Boolean(await db.getOne('people', ${JSON.stringify(temp.id)})), photo: Boolean(await db.getOne('photos', ${JSON.stringify(temp.photoId)})), allocations: (await all('allocations')).filter((a) => a.personId === ${JSON.stringify(temp.id)}).length };`);
    eq(r, { person: false, photo: false, allocations: 0 }, 'exclusão completa');
    await go(`#/pessoas/${ids.people['João Pedro Alves']}`, '.page-title');
    await b.clickText('Excluir', '.page-head');
    await b.waitFor(`document.querySelector('dialog[open]')?.textContent.includes('só pode ser arquivada')`, 'aviso de histórico');
    await b.click('dialog[open] [data-action="archive"]');
    await toastSeen('arquivada');
    eq(await app(`return (await db.getOne('people', ${JSON.stringify(ids.people['João Pedro Alves'])})).status;`), 'arquivado', 'arquivada');
    await app(`await people.setPersonStatus(${JSON.stringify(ids.people['João Pedro Alves'])}, 'ativo');`);
  });

  // ---------------------------------------------------------------- Relatórios e painel
  await step('Relatórios exportam CSV e o início mostra os números reais', async () => {
    await go('#/relatorios/pessoas-por-equipe', '.table');
    const before = await listDownloads();
    await b.click('[data-action="csv"]');
    const file = await waitDownload('.csv', before);
    const csv = await readFile(file, 'utf8');
    assert(csv.startsWith('﻿Equipe;Pessoa;Participações;Coordenações'), 'cabeçalho do CSV');
    assert(csv.includes('Maria José da Silva'), 'linha da Maria no CSV');
    await go('#/relatorios/historico-individual', '.select-box select');
    await b.evaluate(`(() => { const s = document.querySelector('.select-box select'); s.value = ${JSON.stringify(ids.people['João Pedro Alves'])}; s.dispatchEvent(new Event('change')); })()`);
    await b.waitFor(`document.querySelector('.result-count')?.textContent.startsWith('1 encontro servido · 2 participações')`, 'histórico individual');
    await go('#/', '.kpi');
    const kpis = await b.evaluate(`[...document.querySelectorAll('.kpi__value')].map((k) => k.textContent)`);
    eq(kpis, ['27', '4', '1', '12'], 'números do início');
    await b.shot('d02-inicio');
  });

  await step('Verificação de integridade do banco', async () => {
    const r = await app(`return db.checkIntegrity();`);
    eq(r.issues, [], 'sem problemas');
  });

  // ---------------------------------------------------------------- Pedidos 1.1: idade, pastorais, encontros anteriores, cartão, planilha
  await step('Ficha: idade, pastorais e encontros anteriores informados à mão (contam na experiência)', async () => {
    const statsOf = `const s = hist.buildStats(await all('participationHistory'), await all('people')).get(${JSON.stringify(ids.maria)}); return { events: s.events.size, manual: s.manualEvents.size, participations: s.participations, coordinations: s.coordinations, musica: s.byTeam.get(${JSON.stringify(ids.musica)})?.count ?? 0 };`;
    const before = await app(statsOf);
    await go(`#/pessoas/${ids.maria}`, '[name=birthDate]');
    await setValue('[name=birthDate]', '2099-01-01');
    await b.click('[data-action="save-person"]');
    await b.waitFor(`document.querySelector('[data-field="birthDate"].field--error')`, 'data de nascimento no futuro recusada');
    await setValue('[name=birthDate]', '1991-03-12');
    await b.waitFor(`/^\\d+ anos$/.test(document.querySelector('[data-field="birthDate"] .field__hint').textContent)`, 'idade calculada ao digitar');
    await b.click('label.chip:has(input[value="pst-catequese"])');
    await b.click('label.chip:has(input[value="pst-pastoral-da-juventude"])');
    await b.click('#tab-historico');
    const addPast = async ({ name, year = '', team = '', other = '', coord = false }) => {
      await b.click('[data-action="add-past"]');
      await b.waitFor(`document.querySelector('dialog[open] [name=eventName]')`, 'formulário do encontro anterior');
      await setValue('dialog[open] [name=eventName]', name);
      await setValue('dialog[open] [name=year]', year);
      await setValue('dialog[open] [name=team]', team);
      if (other) await setValue('dialog[open] [name=teamName]', other);
      if (coord) await b.click('dialog[open] .segmented__item:has(input[value="coordenador"])');
      await b.click('dialog[open] [data-action="save-past"]');
    };
    await addPast({ name: 'EJC 2019', year: '2019', team: ids.musica, coord: true });
    await b.waitFor(`document.querySelectorAll('.past-row').length === 1`, 'primeiro encontro anterior');
    await addPast({ name: 'EJC 2019', year: '2019', team: '__outra', other: 'Teatro' });
    await b.waitFor(`document.querySelectorAll('.past-row').length === 2`, 'mesmo encontro em outra equipe');
    await addPast({ name: 'ejc  2019', year: '2019', team: ids.musica });
    await b.waitFor(`document.querySelector('dialog[open] [data-field="eventName"].field--error')`, 'repetido recusado');
    await b.click('dialog[open] .modal__x');
    await addPast({ name: 'Encontro de Casais', year: '1800' });
    await b.waitFor(`document.querySelector('dialog[open] [data-field="year"].field--error')`, 'ano inválido recusado');
    await setValue('dialog[open] [name=year]', '');
    await b.click('dialog[open] [data-action="save-past"]');
    await b.waitFor(`document.querySelectorAll('.past-row').length === 3 && !document.querySelector('dialog[open]')`, 'encontro sem ano e sem equipe');
    await b.waitFor(`document.querySelector('.timeline .is-manual')`, 'linha do tempo com os informados');
    await b.click('[data-action="save-person"]');
    await toastSeen('Ficha salva.');
    const r = await app(`
      const p = await db.getOne('people', ${JSON.stringify(ids.maria)});
      return { birth: p.birthDate, pastorals: [...p.pastoralIds].sort(), past: p.pastServices.map((x) => [x.eventName, x.year, x.teamName, x.role]).sort() };`);
    eq(r, { birth: '1991-03-12', pastorals: ['pst-catequese', 'pst-pastoral-da-juventude'], past: [['EJC 2019', 2019, 'Música e Louvor', 'coordenador'], ['EJC 2019', 2019, 'Teatro', 'integrante'], ['Encontro de Casais', null, '', 'integrante']] }, 'ficha gravada');
    const after = await app(statsOf);
    eq(after, { events: before.events + 2, manual: 2, participations: before.participations + 3, coordinations: before.coordinations + 1, musica: before.musica + 1 }, 'experiência soma os informados (mesmo encontro em 2 equipes = 1 encontro)');
    await b.waitFor(`document.querySelector('#tab-historico .tabs__count')?.textContent === '${after.events}'`, 'contador da aba');
    await b.shot('d07-encontros-anteriores');
  });

  await step('Clicar na pessoa abre o cartão; planilha .xlsx da lista (com filtro de pastoral)', async () => {
    await go('#/pessoas', '.table');
    const age = await app(`const v = await import('/js/validation.js'); return v.ageOf('1991-03-12');`);
    await b.evaluate(`[...document.querySelectorAll('.cell-link')].find((a) => a.textContent === 'Maria José da Silva').click()`);
    await b.waitFor(`document.querySelector('dialog[open] [data-role="person-card"]')`, 'cartão da pessoa');
    const card = await b.evaluate(`(() => { const c = document.querySelector('dialog[open] .cracha'); return { name: c.querySelector('.cracha__name').textContent, age: c.querySelector('.cracha__age').textContent, phone: c.querySelector('.cracha__number').textContent, wa: c.querySelector('a[href^="https://wa.me/"]').getAttribute('href'), pastorals: [...c.querySelectorAll('.cracha__facts .tag')].map((t) => t.textContent), hash: location.hash }; })()`);
    eq(card, { name: 'Maria José da Silva', age: `${age} anos`, phone: '(21) 91234-5678', wa: 'https://wa.me/5521912345678', pastorals: ['Catequese', 'Pastoral da Juventude'], hash: '#/pessoas' }, 'cartão');
    await b.shot('d08-cartao');
    await b.click('dialog[open] [data-action="open-person"]');
    await b.waitFor(`location.hash === '#/pessoas/${ids.maria}' && document.querySelector('.page-title')?.textContent === 'Maria José da Silva'`, 'ficha completa pelo cartão');
    await go('#/pessoas', '.table');
    const ageCell = await b.evaluate(`[...document.querySelectorAll('.table tbody tr')].find((tr) => tr.textContent.includes('Maria José da Silva')).querySelector('td[data-label="Idade"]').textContent`);
    eq(ageCell, String(age), 'coluna de idade');
    await b.evaluate(`[...document.querySelectorAll('.table tbody tr')].find((tr) => tr.textContent.includes('Diego Pires')).querySelector('td[data-label="Situação"]').click()`);
    await b.waitFor(`document.querySelector('dialog[open] .cracha__name')?.textContent === 'Diego Pires'`, 'cartão pelo clique na linha');
    await b.click('dialog[open] .modal__x');
    await b.evaluate(`(() => { const s = [...document.querySelectorAll('.select-box')].find((l) => l.textContent.startsWith('Pastoral')).querySelector('select'); s.value = 'pst-catequese'; s.dispatchEvent(new Event('change')); })()`);
    await b.waitFor(`document.querySelector('.result-count')?.textContent.startsWith('1 pessoa encontrada')`, 'filtro por pastoral');
    const before = await listDownloads();
    await b.click('[data-action="export-people"]');
    const file = await waitDownload('.xlsx', before);
    await toastSeen('Só quem aparece com os filtros atuais');
    const sheet = await b.evaluate(`(async () => {
      const zip = await JSZip.loadAsync(${JSON.stringify((await readFile(file)).toString('base64'))}, { base64: true });
      const parts = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'];
      const docs = {};
      for (const name of parts) docs[name] = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
      const broken = parts.filter((name) => docs[name].querySelector('parsererror'));
      const rows = [...docs['xl/worksheets/sheet1.xml'].getElementsByTagName('row')].map((row) => [...row.getElementsByTagName('c')].map((c) => c.textContent));
      return { broken, rows };
    })()`);
    eq(sheet.broken, [], 'XML da planilha válido');
    eq(sheet.rows.length, 2, 'cabeçalho + 1 pessoa filtrada');
    eq(sheet.rows[0].slice(0, 4), ['Nome', 'Idade', 'Nascimento', 'Telefone'], 'cabeçalho');
    eq(sheet.rows[1].slice(0, 4), ['Maria José da Silva', String(age), '12/03/1991', '(21) 91234-5678'], 'linha da Maria');
    assert(sheet.rows[1].includes('Catequese, Pastoral da Juventude'), 'pastorais na planilha');
    assert(sheet.rows[1].some((c) => c.includes('Teatro')), 'equipes dos encontros anteriores na planilha');
    await copyFile(file, join(work, 'pessoas.xlsx'));
    await b.clickText('Limpar filtros');
  });

  await step('Backup leva os campos novos; dados da versão 1.0 são atualizados sem perda', async () => {
    const r = await app(`
      const { blob } = await backup.buildBackup();
      const parsed = await backup.readBackupFile(new File([blob], 'b.zip'));
      const maria = parsed.stores.people.find((p) => p.id === ${JSON.stringify(ids.maria)});
      // Outro aparelho instalado em outro momento: mesmas opções, datas diferentes = não é diferença.
      for (const c of parsed.stores.characteristics) c.createdAt = c.updatedAt = '2020-01-01T00:00:00.000Z';
      const plan = await backup.planMerge(parsed);
      // Backup antigo (formato 1): ganha os campos novos e as pastorais.
      const v1 = { people: [{ id: 'antiga', name: 'Ficha Antiga', skillIds: [], characteristicIds: [], preferredTeamIds: [], avoidTeamIds: [], availabilityIds: [], status: 'ativo' }], characteristics: [] };
      schema.migrateData(v1, 1);
      // Banco local da versão 1.0: some com as pastorais e os campos novos e reabre.
      const diego = await db.getOne('people', ${JSON.stringify(ids.people['Diego Pires'])});
      delete diego.birthDate; delete diego.pastoralIds; delete diego.pastServices;
      await db.putOne('people', diego);
      for (const c of (await all('characteristics')).filter((c) => c.group === 'pastoral')) await db.deleteOne('characteristics', c.id);
      await db.putOne('metadata', { key: 'dataVersion', value: 1 });
      await db.initDatabase();
      const migrated = await db.getOne('people', ${JSON.stringify(ids.people['Diego Pires'])});
      const mariaNow = await db.getOne('people', ${JSON.stringify(ids.maria)});
      return {
        backup: [maria.birthDate, maria.pastoralIds.length, maria.pastServices.length],
        conflicts: plan.conflicts.length,
        v1: [v1.people[0].birthDate, v1.people[0].pastoralIds, v1.people[0].pastServices, v1.characteristics.length, schema.DATA_VERSION],
        local: [migrated.birthDate, migrated.pastoralIds, migrated.pastServices, (await all('characteristics')).filter((c) => c.group === 'pastoral').length, (await db.getOne('metadata', 'dataVersion')).value, mariaNow.pastServices.length, mariaNow.pastoralIds.length],
        integrity: (await db.checkIntegrity()).issues,
      };`);
    eq(r, { backup: ['1991-03-12', 2, 3], conflicts: 0, v1: ['', [], [], 14, 2], local: ['', [], [], 14, 2, 3, 2], integrity: [] }, 'backup e migração');
  });

  // ---------------------------------------------------------------- Backup (arquivo)
  await step('Backup sem senha: tudo dentro do .zip e conferido', async () => {
    const r = await app(`
      const { blob, counts } = await backup.buildBackup();
      const parsed = await backup.readBackupFile(new File([blob], 'b.zip'));
      return { counts, parsed: parsed.counts, encrypted: parsed.manifest.encrypted, photoBytes: parsed.stores.photos[0]?.blob.size };`);
    eq(r.counts, r.parsed, 'contagens iguais');
    eq([r.parsed.people, r.parsed.teams, r.parsed.events, r.parsed.photos, r.encrypted], [27, 4, 2, 1, false], 'conteúdo');
    assert(r.photoBytes > 1000, 'foto no backup');
  });

  await step('Backup com senha (AES-256-GCM): pede senha, recusa senha errada e não expõe dados', async () => {
    const r = await app(`
      const { blob } = await backup.buildBackup({ password: 'senha-forte-123' });
      const file = new File([blob], 'b.zip');
      const raw = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
      const ask = await backup.readBackupFile(file);
      const wrong = await code(backup.readBackupFile(file, 'senha-errada'));
      const ok = await backup.readBackupFile(file, 'senha-forte-123');
      return { needs: ask.needsPassword, wrong, people: ok.counts.people, leaks: ['Maria', 'Jovens', 'maria@exemplo'].filter((w) => raw.includes(w)), kdf: ask.manifest.encryption };`);
    eq([r.needs, r.wrong, r.people, r.leaks], [true, 'wrong_password', 27, []], 'backup protegido');
    eq([r.kdf.kdf, r.kdf.cipher, r.kdf.iterations], ['PBKDF2-SHA256', 'AES-256-GCM', 600000], 'parâmetros de criptografia');
  });

  await step('Arquivos inválidos são recusados sem alterar nada', async () => {
    const r = await app(`
      const before = (await all('people')).length;
      const random = await code(backup.readBackupFile(new File([crypto.getRandomValues(new Uint8Array(4000))], 'x.zip')));
      const empty = await code(backup.readBackupFile(new File([], 'x.zip')));
      const other = new JSZip(); other.file('nota.txt', 'oi');
      const notBackup = await code(backup.readBackupFile(new File([await other.generateAsync({ type: 'blob' })], 'x.zip')));
      const { blob } = await backup.buildBackup();
      const z = await JSZip.loadAsync(blob);
      z.file('dados.json', (await z.file('dados.json').async('string')).replace('Maria', 'Marta'));
      const tampered = await code(backup.readBackupFile(new File([await z.generateAsync({ type: 'blob' })], 'x.zip')));
      const z2 = await JSZip.loadAsync(blob);
      const manifest = JSON.parse(await z2.file('manifest.json').async('string'));
      manifest.format = 99;
      z2.file('manifest.json', JSON.stringify(manifest));
      const future = await code(backup.readBackupFile(new File([await z2.generateAsync({ type: 'blob' })], 'x.zip')));
      return { random, empty, notBackup, tampered, future, unchanged: (await all('people')).length === before };`);
    eq(r, { random: 'invalid_zip', empty: 'empty', notBackup: 'not_backup', tampered: 'corrupted', future: 'incompatible', unchanged: true }, 'recusas');
  });

  await step('Falha no meio da restauração: dados anteriores ficam intactos (transação)', async () => {
    const r = await app(`
      const count = async () => ({ people: (await all('people')).length, history: (await all('participationHistory')).length, events: (await all('events')).length });
      const { blob } = await backup.buildBackup();
      const parsed = await backup.readBackupFile(new File([blob], 'b.zip'));
      parsed.stores.people = parsed.stores.people.slice(0, 3);
      const before = await count();
      const put = IDBObjectStore.prototype.put;
      let calls = 0;
      IDBObjectStore.prototype.put = function (...args) { if (++calls === 40) throw new DOMException('falha simulada', 'UnknownError'); return put.apply(this, args); };
      const result = await code(backup.restoreBackup(parsed));
      IDBObjectStore.prototype.put = put;
      return { result, same: JSON.stringify(before) === JSON.stringify(await count()) };`);
    eq(r, { result: 'storage', same: true }, 'restauração atômica');
  });

  await step('Falta de espaço: erro claro, nada gravado (simulado)', async () => {
    const r = await app(`
      const before = (await all('people')).length;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
      let error;
      try { await people.savePerson({ ...people.blankPerson(), name: 'Sem Espaço' }); } catch (e) { error = e; }
      IDBObjectStore.prototype.put = put;
      return { code: error?.code, message: error?.message, same: (await all('people')).length === before };`);
    eq([r.code, r.same], ['quota', true], 'falta de espaço');
    assert(r.message.includes('Não há espaço livre suficiente'), 'mensagem de espaço');
    await go('#/pessoas/nova', '[name=name]');
    await b.fill('[name=name]', 'Sem Espaço');
    ignoredConsole.push('espaço livre');
    await b.evaluate(`(() => { const put = IDBObjectStore.prototype.put; window.__put = put; IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); }; })()`);
    await b.click('[data-action="save-person"]');
    await toastSeen('Não há espaço livre suficiente');
    await b.evaluate(`IDBObjectStore.prototype.put = window.__put`);
    await b.evaluate(`(async () => { (await import('/js/router.js')).setDirty(false); })()`);
  });

  await step('Importar e mesclar: novos entram, iguais são ignorados, conflitos seguem a escolha', async () => {
    const r = await app(`
      const { blob } = await backup.buildBackup();
      const parsed = await backup.readBackupFile(new File([blob], 'b.zip'));
      const maria = await db.getOne('people', ${JSON.stringify(ids.maria)});
      await new Promise((r) => setTimeout(r, 5));
      await people.savePerson({ ...maria, phone: '(31) 99999-0000' });
      const extra = { ...parsed.stores.people.find((p) => p.id === ${JSON.stringify(ids.people['Renata Campos'])}), id: 'id-de-outro-aparelho' };
      parsed.stores.people.push(extra);
      parsed.stores.people.push({ ...people.blankPerson(), id: 'pessoa-nova-importada', name: 'Pessoa Importada', nameKey: 'pessoa importada', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const plan = await backup.planMerge(parsed);
      const keep = await backup.applyMerge(plan, 'local');
      const phoneKept = (await db.getOne('people', ${JSON.stringify(ids.maria)})).phone;
      const plan2 = await backup.planMerge(parsed);
      await backup.applyMerge(plan2, 'incoming');
      const phoneIncoming = (await db.getOne('people', ${JSON.stringify(ids.maria)})).phone;
      return { added: plan.counts.people, unified: plan.unified.map((u) => u.name), conflicts: plan.conflicts.map((c) => c.name), keep: keep.kept, phoneKept, phoneIncoming, total: (await all('people')).length, issues: (await db.checkIntegrity()).issues.length };`);
    eq(r, { added: 1, unified: ['Renata Campos'], conflicts: ['Maria José da Silva'], keep: 1, phoneKept: '(31) 99999-0000', phoneIncoming: '(21) 91234-5678', total: 28, issues: 0 }, 'mesclagem');
    await app(`await people.deletePerson('pessoa-nova-importada');`);
  });

  // ---------------------------------------------------------------- Restauração completa pela tela
  await step('Exporta com senha pela tela, apaga o banco e restaura tudo pela tela', async () => {
    const counts = `return { people: (await all('people')).length, teams: (await all('teams')).length, events: (await all('events')).length, history: (await all('participationHistory')).length, allocations: (await all('allocations')).length, skills: (await all('skills')).length, photos: (await db.transaction(['photos'], 'readonly', (s) => db.req(s.photos.count()))) };`;
    const before = await app(counts);
    await go('#/backup', '[data-action="export"]');
    await b.fill('[data-role="export-form"] [name=password]', 'transferir-2026');
    await b.fill('[data-role="export-form"] [name=confirm]', 'transferir-2026');
    const existing = await listDownloads();
    await b.click('[data-action="export"]');
    const file = await waitDownload('-protegido.zip', existing);
    await b.evaluate(`new Promise((resolve) => { const r = indexedDB.deleteDatabase('gestao-encontros'); r.onsuccess = r.onerror = r.onblocked = () => resolve(); })`);
    await b.page('Page.reload');
    await ready();
    eq(await app(`return (await all('people')).length;`), 0, 'banco vazio');
    await go('#/backup', '[data-role="backup-file"]');
    await b.setInputFiles('[data-role="backup-file"]', [file]);
    await b.waitFor(`document.querySelector('[data-role="unlock-form"] [name=password]')`, 'pedido de senha');
    await b.fill('[data-role="unlock-form"] [name=password]', 'errada-123');
    await b.click('[data-action="unlock-backup"]');
    await b.waitFor(`document.querySelector('[data-role="unlock-form"] .field__error')?.textContent.includes('Senha incorreta')`, 'senha errada recusada');
    await b.fill('[data-role="unlock-form"] [name=password]', 'transferir-2026');
    await b.click('[data-action="unlock-backup"]');
    await b.waitFor(`document.querySelector('[data-role="backup-preview"]')`, 'resumo do backup');
    const preview = await b.evaluate(`[...document.querySelectorAll('[data-role="backup-preview"] .tile__value')].map((t) => t.textContent)`);
    eq(preview, [String(before.people), String(before.teams), String(before.events), String(before.photos), String(before.history)], 'resumo antes de restaurar');
    await b.shot('d09-backup-resumo');
    await b.click('[data-action="restore"]');
    await b.click('dialog[open] [data-action="confirm"]');
    await b.waitFor(`location.hash === '#/' || location.hash === ''`, 'volta ao início');
    await toastSeen('Backup restaurado');
    eq(await app(counts), before, 'tudo restaurado');
    assert(await app(`const p = await db.getOne('people', ${JSON.stringify(ids.maria)}); const f = await db.getOne('photos', p.photoId); return (await createImageBitmap(f.blob)).width > 0;`), 'foto restaurada e legível');
  });

  await step('Importação inválida pela tela mostra o motivo e não altera nada', async () => {
    await writeFile(join(work, 'invalido.zip'), 'isto não é um zip');
    await go('#/backup', '[data-role="backup-file"]');
    await b.setInputFiles('[data-role="backup-file"]', [join(work, 'invalido.zip')]);
    await b.waitFor(`document.querySelector('[data-role="import-error"]')?.textContent.includes('não é um .zip válido')`, 'erro visível');
  });

  // ---------------------------------------------------------------- PIN
  await step('PIN: cria pela tela, bloqueia ao abrir, recusa PIN errado e libera com o certo', async () => {
    await go('#/ajustes', '[data-action="create-pin"]');
    await b.click('[data-action="create-pin"]');
    await b.fill('dialog[open] [name=pin]', '2468');
    await b.fill('dialog[open] [name=confirm]', '2468');
    await b.click('[data-action="save-pin"]');
    await toastSeen('PIN criado');
    await b.page('Page.reload');
    await b.waitFor(`document.getElementById('lock-screen')`, 'tela de bloqueio');
    assert(!(await b.evaluate(`document.documentElement.dataset.ready === 'true'`)), 'dados não aparecem antes do PIN');
    await b.shot('d10-bloqueio');
    await b.fill('.lock__input', '1111');
    await b.click('.lock__key--ok');
    await b.waitFor(`document.querySelector('.lock__message')?.textContent.includes('PIN incorreto')`, 'PIN errado');
    await b.fill('.lock__input', '2468');
    await b.click('.lock__key--ok');
    await ready();
    await app(`await security.clearPin();`);
  });

  // ---------------------------------------------------------------- Offline
  await step('Funciona sem internet depois do primeiro acesso', async () => {
    await b.waitFor(`navigator.serviceWorker.controller`, 'service worker ativo', 15000);
    await b.evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    server.close();
    server.closeAllConnections?.();
    await sleep(300);
    ignoredConsole.push('ERR_CONNECTION_REFUSED', 'Failed to fetch', 'ServiceWorker', 'Failed to load resource', 'Failed to update');
    await b.page('Page.reload');
    await ready();
    await go('#/pessoas', '.table');
    await go(`#/encontros/${ids.ev1}`, '.q-col');
    await go('#/backup', '[data-action="export"]');
    assert(await b.evaluate(`typeof JSZip === 'function'`), 'JSZip local disponível sem internet');
    server = await startServer(PORT, site);
  });

  // ---------------------------------------------------------------- Atualização
  await step('Atualização controlada: avisa, respeita formulário aberto e só aplica quando o usuário pede', async () => {
    const sw = await readFile(join(site, 'sw.js'), 'utf8');
    await writeFile(join(site, 'sw.js'), sw.replace(/const VERSION = '[^']+'/, "const VERSION = 'encontro-teste-2'"));
    await b.evaluate(`window.__marca = 'antes'`);
    await b.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.update())`);
    await b.waitFor(`document.getElementById('notices').textContent.includes('nova versão')`, 'aviso de nova versão', 15000);
    await go('#/pessoas/nova', '[name=name]');
    await b.fill('[name=name]', 'Rascunho em andamento');
    await b.clickText('Atualizar', '#notices');
    await b.waitFor(`document.querySelector('dialog[open]')?.textContent.includes('Atualizar agora?')`, 'aviso de trabalho em andamento');
    await b.clickText('Depois', 'dialog[open]');
    await sleep(300);
    eq(await b.evaluate(`window.__marca`), 'antes', 'não atualizou sozinho');
    await b.evaluate(`(async () => { (await import('/js/router.js')).setDirty(false); })()`);
    await b.clickText('Atualizar', '#notices');
    await b.waitFor(`window.__marca === undefined`, 'recarregou na nova versão', 15000);
    await ready();
    assert((await b.evaluate(`caches.keys()`)).includes('encontro-teste-2'), 'cache da nova versão');
  });

  // ---------------------------------------------------------------- Telas
  await step('Responsivo: celular, tablet e computador sem rolagem lateral', async () => {
    const pages = ['#/', '#/pessoas', `#/pessoas/${ids.maria}`, `#/pessoas/${ids.maria}?aba=historico`, '#/equipes', `#/equipes/${ids.musica}`, '#/encontros', `#/encontros/${ids.ev1}`, `#/encontros/${ids.ev2}/concluir`, '#/historico', '#/relatorios', '#/relatorios/distribuicao', '#/cadastros', '#/backup', '#/ajustes', '#/instalar'];
    for (const [w, h, mobile, label] of [[390, 844, true, 'celular'], [820, 1180, true, 'tablet'], [1440, 900, false, 'computador']]) {
      await b.setViewport(w, h, mobile);
      for (const hash of pages) {
        await go(hash);
        await sleep(350);
        const overflow = await b.evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
        assert(overflow <= 1, `${label} ${hash}: rolagem lateral de ${overflow}px`);
        if (label === 'celular' && ['#/', `#/encontros/${ids.ev1}`, '#/pessoas', `#/pessoas/${ids.maria}?aba=historico`].includes(hash)) await b.shot(`m-${hash.replace(/[#/?=]+/g, '-').replace(/^-|-$/g, '') || 'inicio'}`);
      }
      if (label === 'celular') {
        await go('#/pessoas');
        await b.evaluate(`[...document.querySelectorAll('.cell-link, .person-card')].find((a) => a.textContent.includes('Maria José da Silva')).click()`);
        await b.waitFor(`document.querySelector('dialog[open] .cracha__photo img')`, 'cartão com foto no celular');
        const fit = await b.evaluate(`(() => { const r = document.querySelector('dialog[open] .cracha__photo').getBoundingClientRect(); return r.width > 300 && r.height > r.width; })()`);
        assert(fit, 'foto do cartão grande e em pé no celular');
        await sleep(400);
        await b.shot('m-cartao');
        await b.click('dialog[open] .modal__x');
      }
      if (mobile && w < 900) assert(await b.evaluate(`getComputedStyle(document.getElementById('tabbar')).display === 'grid' && getComputedStyle(document.getElementById('sidebar')).display === 'none'`), 'barra inferior no celular');
    }
    await go(`#/encontros/${ids.ev1}`, '.q-col');
    await b.shot('d06-quadrante-concluido');
    await go(`#/pessoas/${ids.maria}?aba=historico`, '.timeline');
    await b.shot('d03-ficha-historico');
  });

  // ---------------------------------------------------------------- Persistência
  await step('Dados continuam depois de fechar e abrir o navegador', async () => {
    const counts = `return { people: (await all('people')).length, events: (await all('events')).length, history: (await all('participationHistory')).length, photo: Boolean(await db.getOne('photos', (await db.getOne('people', ${JSON.stringify(ids.maria)})).photoId)) };`;
    const before = await app(counts);
    const errors = [...b.consoleErrors];
    const http = [...b.httpErrors];
    await b.close();
    b = await openBrowser({ profile, downloads, shotsDir });
    b.consoleErrors.push(...errors);
    b.httpErrors.push(...http);
    await b.goto(URL_APP);
    await ready();
    eq(await app(counts), before, 'mesmos dados depois de reabrir');
    eq(before.people, 27, 'pessoas');
  });

  await step('Sem erros inesperados no console e sem respostas HTTP com falha', async () => {
    const unexpected = b.consoleErrors.filter((e) => !ignoredConsole.some((ok) => e.includes(ok)));
    eq(unexpected, [], 'erros de console');
    eq(b.httpErrors, [], 'respostas HTTP');
    eq(b.dialogs, [], 'diálogos nativos');
  });
} catch {
  // o erro já foi mostrado na etapa
} finally {
  await b.close().catch(() => {});
  server.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} etapas passaram.`);
process.exit(failed.length ? 1 : 0);
