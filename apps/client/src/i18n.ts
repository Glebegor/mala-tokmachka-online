import { h } from './dom';
import { UK_EXACT, UK_PATTERNS } from './i18n.uk';

/**
 * Interface language. The game is written in English; for Ukrainian every text, tooltip and placeholder is translated as
 * it appears on the page (a MutationObserver), from a dictionary of exact phrases plus patterns for texts with numbers
 * or names in them. Server messages and mod texts (unit and building descriptions) are covered the same way.
 */
export type Lang = 'en' | 'uk';
const KEY = 'mto.lang';

export function lang(): Lang {
  try {
    return localStorage.getItem(KEY) === 'uk' ? 'uk' : 'en';
  } catch {
    return 'en';
  }
}

export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* private mode */
  }
  location.reload(); // simplest way to redraw every panel in the new language (a running match is rejoined)
}

const exact = new Map(Object.entries(UK_EXACT));
const patterns = UK_PATTERNS.map(([re, out]) => [new RegExp(`^${re}$`), out] as const);

/** Translate one text (exact phrase, or a pattern whose captured parts are translated in turn). */
export function tr(s: string): string {
  if (lang() !== 'uk') return s;
  const key = s.trim();
  if (!key) return s;
  const hit = exact.get(key);
  if (hit !== undefined) return s.replace(key, hit);
  for (const [re, out] of patterns) {
    const m = key.match(re);
    if (!m) continue;
    const res = out.replace(/\$(\d)/g, (_, i) => {
      const g = m[Number(i)] ?? '';
      return exact.get(g) ?? (g.length > 2 && /[a-z]/i.test(g) ? tr(g) : g);
    });
    return s.replace(key, res);
  }
  // a list of sentences (descriptions): translate sentence by sentence when every one is known
  if (key.includes('. ')) {
    const parts = key.split(/(?<=\.)\s+/);
    const done = parts.map((p) => exact.get(p) ?? exact.get(p.replace(/\.$/, '')) ?? null);
    if (done.every((x) => x !== null)) return s.replace(key, done.join(' '));
  }
  if (import.meta.env.DEV) missing.add(key);
  return s;
}

/** Texts seen without a translation (DEV: window.__i18nMissing) to complete the dictionary. */
const missing = new Set<string>();
if (import.meta.env.DEV) (window as any).__i18nMissing = missing;

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
function translateNode(n: Node) {
  if (n.nodeType === Node.TEXT_NODE) {
    const parent = n.parentElement;
    if (!parent || SKIP.has(parent.tagName) || parent.closest('[data-notr]')) return;
    const v = n.nodeValue ?? '';
    if (/[A-Za-z]{2}/.test(v)) {
      const t = tr(v);
      if (t !== v) n.nodeValue = t;
    }
    return;
  }
  if (n.nodeType !== Node.ELEMENT_NODE) return;
  const el = n as Element;
  if (SKIP.has(el.tagName) || el.closest('[data-notr]')) return;
  for (const attr of ['title', 'placeholder']) {
    const v = el.getAttribute(attr);
    if (v && /[A-Za-z]{2}/.test(v)) {
      const t = tr(v);
      if (t !== v) el.setAttribute(attr, t);
    }
  }
  el.childNodes.forEach(translateNode);
}

/** Start translating the page (Ukrainian only). */
export function startTranslation() {
  document.documentElement.lang = lang();
  if (lang() !== 'uk') return;
  translateNode(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') translateNode(m.target);
      else if (m.type === 'attributes') translateNode(m.target);
      else m.addedNodes.forEach(translateNode);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder'] });
}

/** EN / UA switch. */
export function langControl(className = '') {
  const b = (l: Lang, label: string) => h('button', { class: `lang-btn ${lang() === l ? 'active' : ''} ${className}`, title: l === 'uk' ? 'Українська' : 'English', onClick: () => lang() !== l && setLang(l) }, label);
  const box = h('span', { class: 'lang-switch' }, b('en', 'EN'), b('uk', 'UA'));
  box.setAttribute('data-notr', '');
  return box;
}
