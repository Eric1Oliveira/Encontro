// Bloqueio por PIN, bloqueio por inatividade e criptografia (PBKDF2 + AES-256-GCM).
// O PIN é uma barreira de acesso a este aparelho; ele não criptografa o banco local.
import { setting, saveSetting, removeSetting } from './database.js';
import { h } from './components/ui.js';
import { icon } from './components/icons.js';

const PIN_ITERATIONS = 150000;
export const BACKUP_ITERATIONS = 600000;
const enc = new TextEncoder();

export class CryptoUnavailableError extends Error {
  constructor() {
    super('A criptografia do navegador só funciona em endereço seguro (https:// ou localhost). Abra o aplicativo pelo endereço publicado.');
  }
}

function subtle() {
  if (!globalThis.crypto?.subtle) throw new CryptoUnavailableError();
  return crypto.subtle;
}

export const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const digest = await subtle().digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const importSecret = (secret) => subtle().importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits', 'deriveKey']);

export async function deriveAesKey(password, salt, iterations = BACKUP_ITERATIONS) {
  const key = await importSecret(password);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Criptografa bytes com senha. Retorna os parâmetros necessários para abrir depois. */
export async function encryptBytes(bytes, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(password, salt);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { data, params: { kdf: 'PBKDF2-SHA256', iterations: BACKUP_ITERATIONS, salt: toBase64(salt), cipher: 'AES-256-GCM', iv: toBase64(iv) } };
}

/** Lança erro com código 'wrong_password' quando a senha não confere (o GCM detecta). */
export async function decryptBytes(bytes, password, params) {
  const key = await deriveAesKey(password, fromBase64(params.salt), params.iterations);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(params.iv) }, key, bytes));
  } catch {
    const error = new Error('Senha incorreta, ou o arquivo foi alterado depois de exportado.');
    error.code = 'wrong_password';
    throw error;
  }
}

// ---------- PIN ----------

async function hashPin(pin, salt, iterations = PIN_ITERATIONS) {
  const key = await importSecret(pin);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toBase64(bits);
}

export const hasPin = () => Boolean(setting('pin')?.hash);

export async function setPin(pin) {
  const salt = randomBytes(16);
  await saveSetting('pin', { hash: await hashPin(pin, salt), salt: toBase64(salt), iterations: PIN_ITERATIONS, updatedAt: new Date().toISOString() });
}

export async function verifyPin(pin) {
  const stored = setting('pin');
  if (!stored?.hash) return true;
  const candidate = await hashPin(pin, fromBase64(stored.salt), stored.iterations);
  // Comparação em tempo constante.
  let diff = candidate.length ^ stored.hash.length;
  for (let i = 0; i < Math.min(candidate.length, stored.hash.length); i++) diff |= candidate.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

export async function clearPin() {
  await removeSetting('pin');
  await saveSetting('autoLockMinutes', 0);
}

// ---------- Tela de bloqueio ----------

let locked = false;
let failures = 0;
let blockedUntil = 0;
let idleTimer = 0;
const unlockWaiters = [];

export const isLocked = () => locked;

/** Resolve quando o aparelho estiver liberado (imediatamente se não há PIN). */
export function whenUnlocked() {
  return locked ? new Promise((resolve) => unlockWaiters.push(resolve)) : Promise.resolve();
}

export function lockNow() {
  if (!hasPin() || locked) return;
  locked = true;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  document.getElementById('app')?.setAttribute('inert', '');
  document.body.append(lockScreen());
}

function unlock() {
  locked = false;
  failures = 0;
  document.getElementById('lock-screen')?.remove();
  document.getElementById('app')?.removeAttribute('inert');
  while (unlockWaiters.length) unlockWaiters.shift()();
  resetIdle();
}

function lockScreen() {
  let value = '';
  const dots = h('div', { class: 'lock__dots', 'aria-hidden': 'true' });
  const message = h('p', { class: 'lock__message', role: 'alert' });
  const input = h('input', { class: 'lock__input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', 'aria-label': 'PIN de acesso' });
  const paint = () => {
    dots.replaceChildren(...Array.from({ length: Math.max(4, value.length) }, (_, i) => h('span', { class: ['lock__dot', i < value.length && 'is-filled'] })));
    input.value = value;
  };
  const submit = async () => {
    if (!value) return;
    const wait = blockedUntil - Date.now();
    if (wait > 0) {
      message.textContent = `Muitas tentativas. Aguarde ${Math.ceil(wait / 1000)} segundos.`;
      return;
    }
    if (await verifyPin(value)) return unlock();
    failures++;
    value = '';
    paint();
    if (failures >= 5) {
      blockedUntil = Date.now() + 30000;
      failures = 0;
      message.textContent = 'PIN incorreto 5 vezes. Aguarde 30 segundos para tentar de novo.';
    } else message.textContent = 'PIN incorreto. Tente de novo.';
    screen.classList.remove('is-shaking');
    void screen.offsetWidth;
    screen.classList.add('is-shaking');
  };
  const press = (digit) => {
    if (value.length >= 8) return;
    value += digit;
    message.textContent = '';
    paint();
  };
  input.addEventListener('input', () => {
    value = input.value.replace(/\D/g, '').slice(0, 8);
    paint();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'].map((k) =>
    k === 'back'
      ? h('button', { type: 'button', class: 'lock__key lock__key--fn', 'aria-label': 'Apagar', onclick: () => ((value = value.slice(0, -1)), paint()) }, icon('chevron-left'))
      : k === 'ok'
        ? h('button', { type: 'button', class: 'lock__key lock__key--ok', 'aria-label': 'Entrar', onclick: submit }, icon('check'))
        : h('button', { type: 'button', class: 'lock__key', onclick: () => press(k) }, k),
  );
  const screen = h(
    'div',
    { class: 'lock', id: 'lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Aplicativo bloqueado' },
    h('div', { class: 'lock__card' }, h('p', { class: 'lock__brand' }, 'Encontro'), h('h1', { class: 'lock__title' }, 'Digite seu PIN'), h('p', { class: 'lock__hint' }, 'Os dados ficam guardados só neste aparelho.'), dots, input, message, h('div', { class: 'lock__pad' }, keys)),
  );
  paint();
  setTimeout(() => input.focus(), 50);
  return screen;
}

// ---------- Inatividade ----------

function resetIdle() {
  clearTimeout(idleTimer);
  const minutes = Number(setting('autoLockMinutes')) || 0;
  if (!minutes || !hasPin() || locked) return;
  idleTimer = setTimeout(lockNow, minutes * 60000);
}

export function initSecurity() {
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, resetIdle, { passive: true });
  // Celular: o cronômetro para em segundo plano, então conferimos o tempo ao voltar.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    const minutes = Number(setting('autoLockMinutes')) || 0;
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (minutes && hasPin() && hiddenAt && Date.now() - hiddenAt >= minutes * 60000) lockNow();
  });
  if (hasPin()) lockNow();
  resetIdle();
}

export const refreshIdleTimer = resetIdle;
