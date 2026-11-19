// Ajustes: segurança (PIN e bloqueio), lembrete de backup, pesos do assistente, armazenamento,
// integridade do banco, atualização e a tela de instalação.
import { setting, saveSetting, getOne, checkIntegrity, repairIntegrity } from '../database.js';
import { APP_VERSION, DATA_VERSION, DEFAULT_WEIGHTS } from '../schema.js';
import { validatePin } from '../validation.js';
import { hasPin, setPin, verifyPin, clearPin, lockNow, refreshIdleTimer } from '../security.js';
import { h, button, pageHeader, badge, fmtBytes, fmtDateTime, section, plural } from '../components/ui.js';
import { icon } from '../components/icons.js';
import { field, readForm, showErrors } from '../components/forms.js';
import { selectBox } from '../components/filters.js';
import { openModal } from '../components/modal.js';
import { toast, toastError } from '../components/toast.js';
import { refresh } from '../router.js';
import { refreshNavigation } from '../components/navigation.js';
import { storageInfo, requestPersistence, isStandalone, canPromptInstall, promptInstall, updateReady, applyUpdate, refreshNotices } from '../notifications.js';
import { CRITERIA } from './assistant.js';

function pinDialog(mode) {
  const needsCurrent = mode !== 'create';
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    needsCurrent && field({ label: 'PIN atual', name: 'current', type: 'password', attrs: { inputmode: 'numeric', autocomplete: 'off', maxlength: '8' } }),
    mode !== 'remove' && field({ label: 'Novo PIN', name: 'pin', type: 'password', hint: 'De 4 a 8 números.', attrs: { inputmode: 'numeric', autocomplete: 'off', maxlength: '8' } }),
    mode !== 'remove' && field({ label: 'Repita o novo PIN', name: 'confirm', type: 'password', attrs: { inputmode: 'numeric', autocomplete: 'off', maxlength: '8' } }),
  );
  openModal({
    title: { create: 'Criar PIN de acesso', change: 'Trocar PIN', remove: 'Remover PIN' }[mode],
    lead: mode === 'create' ? 'O PIN impede que outra pessoa abra o aplicativo neste aparelho. Ele não criptografa os dados guardados — para isso, use backups com senha.' : null,
    size: 'sm',
    body: form,
    actions: [
      { label: 'Cancelar', variant: 'ghost' },
      {
        label: { create: 'Criar PIN', change: 'Trocar PIN', remove: 'Remover PIN' }[mode],
        variant: mode === 'remove' ? 'danger' : 'primary',
        id: 'save-pin',
        onClick: async () => {
          const v = readForm(form);
          if (needsCurrent && !(await verifyPin(v.current ?? ''))) {
            showErrors(form, { current: 'PIN atual incorreto.' });
            return false;
          }
          if (mode === 'remove') {
            await clearPin();
            toast('PIN removido. O aplicativo abre sem bloqueio.');
          } else {
            const problem = validatePin(v.pin ?? '');
            if (!showErrors(form, { pin: problem, confirm: !problem && v.pin !== v.confirm ? 'Os PINs não conferem.' : '' })) return false;
            await setPin(v.pin);
            toast(mode === 'create' ? 'PIN criado. Use "Travar agora" no menu quando sair de perto.' : 'PIN trocado.');
          }
          refreshNavigation();
          refreshIdleTimer();
          refresh();
        },
      },
    ],
  });
}

export async function renderSettings(view) {
  const [storage, createdAt, lastCheck] = await Promise.all([storageInfo(), getOne('metadata', 'createdAt'), getOne('metadata', 'lastIntegrityCheck')]);
  const pin = hasPin();
  const save = async (key, value, message) => {
    try {
      await saveSetting(key, value);
      if (message) toast(message);
      refreshIdleTimer();
      refreshNotices();
    } catch (error) {
      toastError(error);
    }
  };

  const security = section(
    'Acesso e bloqueio',
    { lead: 'O PIN é uma barreira de acesso a este aparelho. A criptografia forte fica nos backups com senha.' },
    h('div', { class: 'setting-row' }, h('div', null, h('p', { class: 'setting-row__title' }, 'PIN de acesso'), h('p', { class: 'muted' }, pin ? 'Ativo: o aplicativo pede o PIN ao abrir.' : 'Desligado: qualquer pessoa com este aparelho abre o aplicativo.')), h('div', { class: 'row-actions' }, pin ? [button('Trocar PIN', { small: true, onClick: () => pinDialog('change') }), button('Remover', { small: true, variant: 'ghost', onClick: () => pinDialog('remove') })] : button('Criar PIN', { small: true, variant: 'primary', icon: 'lock', onClick: () => pinDialog('create'), attrs: { 'data-action': 'create-pin' } }))),
    h(
      'div',
      { class: 'setting-row' },
      h('div', null, h('p', { class: 'setting-row__title' }, 'Bloqueio automático'), h('p', { class: 'muted' }, pin ? 'Trava sozinho depois de um tempo sem uso (também ao voltar para o app depois desse tempo).' : 'Crie um PIN para usar o bloqueio automático.')),
      selectBox({ label: 'Travar após', value: String(setting('autoLockMinutes') || 0), options: [{ value: '0', label: 'Nunca' }, { value: '1', label: '1 minuto' }, { value: '5', label: '5 minutos' }, { value: '15', label: '15 minutos' }, { value: '30', label: '30 minutos' }], onChange: (v) => (pin ? save('autoLockMinutes', Number(v), 'Bloqueio automático atualizado.') : toast('Crie um PIN primeiro.', { type: 'warn' })) }),
    ),
    pin ? h('div', { class: 'row-actions' }, button('Travar agora', { icon: 'lock', small: true, onClick: lockNow })) : null,
  );

  const reminder = section(
    'Lembrete de backup',
    { lead: 'Avisa no início quando há alterações que ainda não estão em nenhum backup.' },
    h('div', { class: 'setting-row' }, h('p', { class: 'setting-row__title' }, 'Avisar depois de'), selectBox({ label: 'Lembrar a cada', value: String(setting('backupReminderDays') ?? 7), options: [{ value: '0', label: 'Nunca' }, { value: '3', label: '3 dias' }, { value: '7', label: '7 dias' }, { value: '15', label: '15 dias' }, { value: '30', label: '30 dias' }], onChange: (v) => save('backupReminderDays', Number(v), 'Lembrete atualizado.') })),
  );

  const weights = { ...DEFAULT_WEIGHTS, ...setting('weights') };
  const weightOutputs = new Map();
  const weightRows = CRITERIA.map((c) => {
    const output = h('output', { class: 'weight__value num' }, String(weights[c.key]));
    weightOutputs.set(c.key, output);
    const range = h('input', { type: 'range', min: '0', max: '50', step: '5', value: String(weights[c.key]), 'aria-label': c.label, dataset: { key: c.key } });
    range.addEventListener('input', () => (output.textContent = range.value));
    range.addEventListener('change', () => {
      weights[c.key] = Number(range.value);
      save('weights', { ...weights }, 'Pesos do assistente salvos.');
    });
    return h('li', { class: 'weight' }, h('span', { class: 'weight__label' }, c.label), range, output);
  });
  const assistant = section(
    'Assistente de distribuição',
    { lead: 'Quanto cada critério pesa na pontuação de compatibilidade. Zero desliga o critério.', actions: button('Restaurar padrão', { small: true, variant: 'ghost', onClick: async () => (await save('weights', { ...DEFAULT_WEIGHTS }, 'Pesos restaurados.'), refresh()) }) },
    h('ul', { class: 'weights' }, weightRows),
  );

  const used = storage.usage ?? 0;
  const quota = storage.quota ?? 0;
  const storagePanel = section(
    'Armazenamento neste aparelho',
    { lead: 'Os dados ficam no navegador deste aparelho e não são enviados para nenhum servidor.' },
    quota ? h('div', { class: 'meter' }, h('span', { class: 'meter__fill', style: { '--fill': String(Math.min(1, used / quota)) } })) : null,
    h('p', null, quota ? `${fmtBytes(used)} usados de ${fmtBytes(quota)} disponíveis para o aplicativo.` : 'O navegador não informa o espaço disponível.'),
    h('div', { class: 'setting-row' }, h('div', null, h('p', { class: 'setting-row__title' }, 'Proteção contra limpeza automática'), h('p', { class: 'muted' }, storage.persisted ? 'Ativa: o navegador não apaga estes dados para liberar espaço.' : 'Sem proteção: com pouco espaço, o navegador pode apagar dados de sites. Instalar o aplicativo ajuda.')), storage.persisted ? badge('Protegido', 'ok', 'shield') : button('Proteger', { small: true, icon: 'shield', onClick: async () => { const ok = await requestPersistence(); toast(ok ? 'Dados protegidos contra limpeza automática.' : 'O navegador não concedeu a proteção agora. Instalar o aplicativo costuma resolver.', { type: ok ? 'ok' : 'warn' }); refresh(); } })),
  );

  const integrityBody = h('div', { class: 'stack-sm' }, h('p', { class: 'muted' }, lastCheck?.value ? `Última verificação: ${fmtDateTime(lastCheck.value)}.` : 'Ainda não verificado.'));
  const integrity = section(
    'Integridade do banco',
    {
      lead: 'Procura referências quebradas (por exemplo, distribuição apontando para algo que não existe mais). O histórico nunca é alterado.',
      actions: button('Verificar agora', {
        small: true,
        icon: 'database',
        attrs: { 'data-action': 'check-integrity' },
        onClick: async () => {
          try {
            const result = await checkIntegrity();
            const fixable = result.issues.filter((i) => i.fixable);
            integrityBody.replaceChildren(
              result.issues.length
                ? h('ul', { class: 'plain-list' }, result.issues.map((i) => h('li', null, icon('alert', { size: 14 }), ` ${i.count} ${i.message}`)))
                : h('p', { class: 'ok-line', dataset: { role: 'integrity-ok' } }, icon('check', { size: 16 }), ` Tudo certo: ${plural(result.totals.people, 'pessoa', 'pessoas')}, ${plural(result.totals.events, 'encontro', 'encontros')}, ${plural(result.totals.history, 'participação', 'participações')} e ${plural(result.totals.photos, 'foto', 'fotos')} conferidos.`),
              fixable.length ? button('Corrigir referências órfãs', { small: true, variant: 'primary', onClick: async () => { try { const n = await repairIntegrity(); toast(`${plural(n, 'referência corrigida', 'referências corrigidas')}.`); refresh(); } catch (e) { toastError(e); } } }) : null,
            );
          } catch (error) {
            toastError(error);
          }
        },
      }),
    },
    integrityBody,
  );

  const app = section(
    'Aplicativo',
    null,
    h('dl', { class: 'details' }, h('div', { class: 'detail' }, h('dt', null, 'Versão'), h('dd', null, APP_VERSION)), h('div', { class: 'detail' }, h('dt', null, 'Formato dos dados'), h('dd', null, `v${DATA_VERSION}`)), h('div', { class: 'detail' }, h('dt', null, 'Banco criado em'), h('dd', null, createdAt?.value ? fmtDateTime(createdAt.value) : '—')), h('div', { class: 'detail' }, h('dt', null, 'Modo'), h('dd', null, isStandalone() ? 'Instalado' : 'No navegador'))),
    h('div', { class: 'row-actions' }, updateReady() ? button('Atualizar para a nova versão', { variant: 'primary', icon: 'download', onClick: applyUpdate }) : null, !isStandalone() ? h('a', { class: 'btn btn--secondary btn--sm', href: '#/instalar' }, icon('install', { size: 16 }), h('span', null, 'Instalar aplicativo')) : null),
  );

  view.replaceChildren(h('div', { class: 'page' }, pageHeader({ eyebrow: 'Configuração', title: 'Ajustes e segurança' }), h('div', { class: 'two-col two-col--panels' }, security, reminder), assistant, h('div', { class: 'two-col two-col--panels' }, storagePanel, integrity), app));
}

export function renderInstall(view) {
  const standalone = isStandalone();
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  const steps = ios
    ? ['Abra este endereço no Safari.', 'Toque em Compartilhar (quadrado com seta para cima).', 'Escolha “Adicionar à Tela de Início” e confirme.']
    : android
      ? ['Abra este endereço no Chrome.', 'Toque no menu ⋮ (canto superior direito).', 'Escolha “Instalar aplicativo” ou “Adicionar à tela inicial”.']
      : ['Abra este endereço no Chrome ou no Edge.', 'Clique no ícone de instalar na barra de endereço (monitor com seta) ou no menu ⋮ → “Instalar Encontro”.', 'O aplicativo abre em janela própria e aparece no menu Iniciar.'];
  view.replaceChildren(
    h(
      'div',
      { class: 'page' },
      pageHeader({ back: { href: '/ajustes', label: 'Ajustes' }, eyebrow: 'Funciona sem internet', title: 'Instalar o aplicativo', lead: 'Instalado, o Encontro abre como um aplicativo, funciona sem internet depois do primeiro acesso e o navegador protege melhor os dados.' }),
      standalone
        ? h('div', { class: 'notice notice--info' }, icon('check', { size: 18 }), h('p', { class: 'notice__text' }, 'Você já está usando o aplicativo instalado.'))
        : section(
            canPromptInstall() ? 'Pronto para instalar' : 'Como instalar neste aparelho',
            null,
            canPromptInstall() ? h('div', { class: 'row-actions' }, button('Instalar agora', { variant: 'primary', icon: 'install', onClick: async () => { const ok = await promptInstall(); if (ok) refresh(); } })) : null,
            h('ol', { class: 'steps' }, steps.map((s) => h('li', null, s))),
          ),
      section(
        'Importante sobre os dados',
        null,
        h('ul', { class: 'plain-list' }, h('li', null, 'Cada aparelho (e cada navegador) tem o próprio banco de dados. O celular e o computador não se sincronizam sozinhos.'), h('li', null, 'Para levar os dados de um aparelho para outro, use ', h('a', { href: '#/backup' }, 'Backup e transferência'), '.'), h('li', null, 'Desinstalar o aplicativo ou limpar os dados do navegador apaga os dados deste aparelho. Mantenha backups em dia.')),
      ),
    ),
  );
}
