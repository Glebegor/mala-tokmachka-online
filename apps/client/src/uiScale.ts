import { h } from './dom';

/** Interface size: panels, menus and text scale together (the map does not). Remembered per browser. */
const KEY = 'mto.uiScale';
export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

export function uiScale(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return UI_SCALES.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function setUiScale(v: number) {
  document.documentElement.style.setProperty('--ui', String(v));
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* private mode: only for this page */
  }
}

/** A small selector for the interface size. */
export function uiScaleControl(className = '') {
  const sel = h('select', { class: `ui-scale ${className}`, title: 'Interface size' }, ...UI_SCALES.map((v) => h('option', { value: String(v), selected: v === uiScale() || undefined }, `UI ${Math.round(v * 100)}%`)));
  sel.addEventListener('change', () => setUiScale(Number(sel.value)));
  return sel;
}
