import { staticMessages } from './messages-static.js';

const STORAGE_KEY = 'workdesk.language';
const messages = new Map();
const patterns = new Map();
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveLanguage(stored, preferred = []) {
  if (stored === 'en' || stored === 'zh-CN') return stored;
  for (const locale of preferred) {
    if (/^zh(?:-|$)/i.test(locale)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(locale)) return 'en';
  }
  return 'en';
}

function initialLanguage() {
  let stored;
  try { stored = globalThis.localStorage?.getItem(STORAGE_KEY); } catch { /* Storage can be disabled. */ }
  const preferences = globalThis.navigator?.languages || [globalThis.navigator?.language].filter(Boolean);
  return resolveLanguage(stored, preferences);
}

let language = initialLanguage();

export function registerMessages(entries) {
  for (const [source, translation] of Object.entries(entries)) {
    if (typeof translation !== 'string') throw new TypeError('Translations must be strings');
    messages.set(source, translation);
    const fields = [...source.matchAll(/\{([a-zA-Z_]\w*)\}/g)];
    if (!fields.length) continue;
    let expression = '', offset = 0;
    for (const field of fields) {
      expression += escapePattern(source.slice(offset, field.index)) + '([\\s\\S]*?)';
      offset = field.index + field[0].length;
    }
    expression += escapePattern(source.slice(offset));
    patterns.set(source, { expression:new RegExp('^' + expression + '$'), fields:fields.map(field=>field[1]) });
  }
}

export function getLanguage() { return language; }

export function setLanguage(next) {
  if (next !== 'en' && next !== 'zh-CN') throw new RangeError('Unsupported interface language');
  language = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch { /* Keep the session language even without storage. */ }
  if (globalThis.document) localizeStatic(globalThis.document);
  return language;
}

export function hasTranslation(source) { return messages.has(source); }

export function t(source, vars = {}) {
  let value = language === 'en' ? messages.get(source) ?? source : source;
  if (language === 'en' && source === '{count} 张卡片' && Number(vars.count) === 1) value = '{count} card';
  return String(value).replace(/\{([a-zA-Z_]\w*)\}/g, (placeholder, key) => Object.hasOwn(vars, key) ? String(vars[key]) : placeholder);
}

export function formatNumber(number, options) {
  return new Intl.NumberFormat(language, options).format(number);
}

export function formatDate(value, options) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(language, options);
}

export function translateSystemMessage(message) {
  const source = String(message ?? '');
  if (language !== 'en') return source;
  if (messages.has(source)) return t(source);
  for (const [template, { expression, fields }] of patterns) {
    const match = expression.exec(source);
    if (!match) continue;
    const vars = Object.fromEntries(fields.map((field, index) => [field, match[index + 1]]));
    return t(template, vars);
  }
  return source;
}

const attributes = ['title', 'aria-label', 'aria-description', 'placeholder', 'content', 'label', 'alt'];
const selector = ['[data-i18n]', ...attributes.map(attribute => '[data-i18n-' + attribute + ']')].join(',');

export function localizeStatic(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const elements = [...root.querySelectorAll(selector)];
  if (root.matches?.(selector)) elements.unshift(root);
  for (const element of elements) {
    if (element.hasAttribute('data-i18n')) element.textContent = t(element.getAttribute('data-i18n'));
    for (const attribute of attributes) {
      const source = element.getAttribute('data-i18n-' + attribute);
      if (source !== null) element.setAttribute(attribute, t(source));
    }
  }
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  if (doc?.documentElement) doc.documentElement.lang = language;
  const select = root.querySelector('#language-select');
  if (select) select.value = language;
}

registerMessages(staticMessages);
if (globalThis.document?.readyState === 'loading') {
  globalThis.document.addEventListener('DOMContentLoaded', () => localizeStatic(globalThis.document), {once:true});
} else if (globalThis.document) localizeStatic(globalThis.document);
