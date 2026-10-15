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

const exact = new Map(Object.entries(UK_EXACT).filter(([k]) => !k.includes('@')));
// keys with "@" (a name or phrase) become patterns: "#" a number, "@" anything, translated in turn ($1, $2… in order)
const NUM_RE = '(\\d[\\d,]*(?:\\.\\d+)?)';
const named = Object.entries(UK_EXACT)
  .filter(([k]) => k.includes('@'))
  .map(([k, v]) => {
    const re = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#/g, NUM_RE).replace(/@/g, '(.+?)');
    let i = 0;
    return [re, v.replace(/[#@]/g, () => `$${++i}`)] as [string, string];
  })
  .sort((a, b) => b[0].length - a[0].length); // the most specific first
const patterns = [...named, ...UK_PATTERNS].map(([re, out]) => [new RegExp(`^${re}$`), out] as const);
/** Numbers in a text: "Produces 2/s ore" is looked up as "Produces #/s ore" and the numbers put back. */
const NUM = /\d[\d,]*(?:\.\d+)?/g;
const memo = new Map<string, string | null>();

/** The translation of a text without surrounding space, or null. */
function lookup(key: string, depth = 0): string | null {
  const hit = exact.get(key);
  if (hit !== undefined) return hit;
  const nums = key.match(NUM);
  if (nums) {
    const t = exact.get(key.replace(NUM, '#'));
    if (t !== undefined) {
      let i = 0;
      return t.replace(/#/g, () => nums[i++] ?? '#');
    }
  }
  if (depth > 3) return null;
  for (const [re, out] of patterns) {
    const m = key.match(re);
    if (!m) continue;
    return out.replace(/\$(\d)/g, (_, i) => {
      const g = m[Number(i)] ?? '';
      return /[a-z]/i.test(g) ? lookup(g, depth + 1) ?? g : g;
    });
  }
  // a list ("Infantry, Tank, Artillery") or several sentences: part by part when every part is known
  for (const sep of [/(?<=[.:!?])\s+/, /,\s+/, /\s+·\s+/]) {
    const parts = key.split(sep);
    if (parts.length < 2) continue;
    const glue = key.match(sep)![0];
    const done = parts.map((p) => lookup(p, depth + 1) ?? (p.endsWith('.') ? (lookup(p.slice(0, -1), depth + 1) ?? null)?.concat('.') ?? null : null));
    if (done.every((x) => x !== null)) return done.join(glue);
  }
  return null;
}

/** Translate one text (exact phrase, numbers template, a pattern whose captured parts are translated in turn, or part by part). */
export function tr(s: string): string {
  if (lang() !== 'uk') return s;
  const key = s.trim();
  if (!key) return s;
  let t = memo.get(key);
  if (t === undefined) {
    t = lookup(key);
    if (memo.size > 20000) memo.clear(); // panels repaint several times a second: remember what was worked out
    memo.set(key, t);
  }
  if (t !== null) return s.replace(key, t);
  if (import.meta.env.DEV && !/[а-яіїєґ]/i.test(key)) missing.add(key); // (already Ukrainian: a text it translated itself)
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
