// Ponto de entrada: abre o banco, aplica o bloqueio, monta o menu e registra as telas.
import { initDatabase, toAppError } from './database.js';
import { route, startRouter } from './router.js';
import { renderNavigation } from './components/navigation.js';
import { toast } from './components/toast.js';
import { initSecurity, whenUnlocked } from './security.js';
import { registerServiceWorker, mountNoticeBar } from './notifications.js';
import { renderDashboard } from './modules/dashboard.js';
import { renderPeople, renderPerson } from './modules/people.js';
import { renderCatalog } from './modules/skills.js';
import { renderTeams, renderTeam } from './modules/teams.js';
import { renderEvents, renderEvent } from './modules/events.js';
import { renderHistory, renderConclude } from './modules/history.js';
import { renderReportIndex, renderReport } from './modules/reports.js';
import { renderSettings, renderInstall } from './modules/settings.js';
import { renderBackup } from './backup.js';

route('/', renderDashboard);
route('/pessoas', renderPeople);
route('/pessoas/:id', renderPerson);
route('/equipes', renderTeams);
route('/equipes/:id', renderTeam);
route('/encontros', renderEvents);
route('/encontros/:id', renderEvent);
route('/encontros/:id/concluir', renderConclude);
route('/historico', renderHistory);
route('/relatorios', renderReportIndex);
route('/relatorios/:id', renderReport);
route('/cadastros', renderCatalog);
route('/backup', renderBackup);
route('/ajustes', renderSettings);
route('/instalar', renderInstall);

function showFatal(error) {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('boot--error');
  boot.querySelector('.boot__status').textContent = error.message;
  const hint = boot.querySelector('.boot__hint');
  hint.textContent = 'Seus dados não foram alterados. Recarregue a página; se o problema continuar, verifique se o navegador não está em modo anônimo e se há espaço livre no aparelho.';
  hint.style.opacity = '1';
  hint.style.animation = 'none';
  const retry = document.createElement('button');
  retry.className = 'btn btn--primary';
  retry.textContent = 'Tentar de novo';
  retry.addEventListener('click', () => location.reload());
  boot.append(retry);
}

// Falhas que escapam das telas não podem passar em silêncio.
window.addEventListener('unhandledrejection', (event) => {
  const error = toAppError(event.reason);
  console.error(event.reason);
  toast(error.message, { type: 'error' });
});
window.addEventListener('error', (event) => {
  if (event.error) {
    console.error(event.error);
    toast('Algo deu errado nesta tela. Recarregue se algo parecer estranho.', { type: 'error' });
  }
});

async function boot() {
  try {
    await initDatabase();
  } catch (error) {
    showFatal(toAppError(error));
    return;
  }
  initSecurity();
  await whenUnlocked();
  document.getElementById('boot')?.remove();
  document.getElementById('app').hidden = false;
  renderNavigation();
  mountNoticeBar(document.getElementById('notices'));
  startRouter(document.getElementById('view'));
  registerServiceWorker();
  document.documentElement.dataset.ready = 'true';
}

boot();
