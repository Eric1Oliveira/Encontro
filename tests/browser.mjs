// Navegador real (Edge/Chrome sem janela) controlado pelo DevTools Protocol, sem dependências.
// Registra erros de console e respostas HTTP com falha. O perfil pode ser reaproveitado
// entre aberturas para testar se os dados persistem depois de fechar o navegador.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  const path = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
  if (!path) throw new Error('Nenhum Edge/Chrome encontrado. Defina BROWSER_PATH.');
  return path;
}

/** @param {{ profile: string, shotsDir?: string, width?: number, height?: number, downloads?: string }} options */
export async function openBrowser({ profile, shotsDir, width = 1440, height = 900, downloads }) {
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const proc = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-features=Translate', `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    proc.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    setTimeout(() => reject(new Error('O navegador não abriu a porta de depuração.')), 20000);
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else listeners.forEach((fn) => fn(msg));
  });
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params = {}) => send(method, params, sessionId);

  const consoleErrors = [];
  const httpErrors = [];
  const dialogs = [];
  listeners.push((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleErrors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) httpErrors.push(`${msg.params.response.status} ${msg.params.response.url}`);
    if (msg.method === 'Page.javascriptDialogOpening') {
      dialogs.push(msg.params.message);
      page('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });
  await page('Runtime.enable');
  await page('Log.enable');
  await page('Page.enable');
  await page('Network.enable');
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  if (downloads) await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

  async function evaluate(expression) {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitFor(expression, label, timeout = 8000) {
    const end = Date.now() + timeout;
    let lastError = '';
    while (Date.now() < end) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        lastError = error.message;
      }
      await sleep(50);
    }
    throw new Error(`tempo esgotado esperando: ${label}${lastError ? ` (${lastError.split('\n')[0]})` : ''}`);
  }
  const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('não achei ${selector.replace(/'/g, '')}'); el.click(); })()`);
  /** Clica no botão/link visível cujo texto contém `text` (dentro de `scope`). */
  const clickText = (text, scope = 'body') =>
    evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)});
      const items = [...root.querySelectorAll('button, a, label, [role=tab], summary')].filter((el) => el.offsetParent !== null || el.closest('dialog[open]'));
      const el = items.find((el) => el.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)}) ?? items.find((el) => el.textContent.includes(${JSON.stringify(text)}));
      if (!el) throw new Error('não achei o texto: ' + ${JSON.stringify(text)});
      el.click();
    })()`);
  async function fill(selector, value) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('campo não encontrado: ${selector.replace(/'/g, '')}'); el.focus(); el.select?.(); })()`);
    await page('Input.insertText', { text: value });
  }
  async function setViewport(w, h, mobile = false) {
    await page('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  }
  async function shot(name, { full = false } = {}) {
    if (!shotsDir) return;
    const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
    await writeFile(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
  }
  async function goto(url) {
    await page('Page.navigate', { url });
  }
  async function setInputFiles(selector, files) {
    const { root } = await page('DOM.getDocument', { depth: 0 });
    const { nodeId } = await page('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`input de arquivo não encontrado: ${selector}`);
    await page('DOM.setFileInputFiles', { nodeId, files });
  }
  async function close() {
    await send('Browser.close').catch(() => {});
    socket.close();
    await new Promise((resolve) => (proc.exitCode !== null ? resolve() : proc.once('exit', resolve)));
    await sleep(300);
  }

  return { page, send, evaluate, waitFor, click, clickText, fill, setViewport, shot, goto, setInputFiles, close, consoleErrors, httpErrors, dialogs };
}
