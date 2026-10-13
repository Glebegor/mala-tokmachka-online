/** Built-in 16×16 icons. Mods reference them by name in `resources.json`; any other value is shown as a text glyph. */
const PATHS: Record<string, string> = {
  coin: '<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.2v7.6M10.2 6.2H7.2a1.3 1.3 0 000 2.6h1.6a1.3 1.3 0 010 2.6H5.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  bolt: '<path d="M9.3 1 3.2 9h3.9l-.9 6 6.6-8.4H8.5z" fill="currentColor"/>',
  person: '<circle cx="8" cy="4.8" r="2.7" fill="currentColor"/><path d="M2.6 14.4c0-3.1 2.4-5.1 5.4-5.1s5.4 2 5.4 5.1z" fill="currentColor"/>',
  rock: '<path d="M2.5 11.5 4 6l4-3.2 4.3 2L13.6 11 9.3 13.6z" fill="currentColor"/>',
  ingot: '<path d="M4 6h8l2.4 4H1.6z" fill="currentColor"/><path d="M1 11h14v2.5H1z" fill="currentColor" opacity=".7"/>',
  drop: '<path d="M8 1.4S3.4 6.4 3.4 9.6a4.6 4.6 0 009.2 0C12.6 6.4 8 1.4 8 1.4z" fill="currentColor"/>',
};

export function iconHtml(name: string | undefined, color: string): string {
  if (name && PATHS[name]) return `<svg class="ico-svg" viewBox="0 0 16 16" style="color:${color}">${PATHS[name]}</svg>`;
  if (name) return `<span class="ico-svg glyph-ico" style="color:${color}">${name.slice(0, 2)}</span>`;
  return `<span class="ico-svg dot-ico" style="background:${color}"></span>`;
}
