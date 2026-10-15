import { UK_GUIDE, UK_SERVER } from './i18n.uk.guide';
import { UK_UI } from './i18n.uk.ui';
import { UK_CITIES, UK_DEFS } from './i18n.uk.world';

/**
 * The Ukrainian dictionary. In a key "#" is any number and "@" any name or phrase (translated in turn); the same
 * markers in the translation take them in the same order.
 */
export const UK_EXACT: Record<string, string> = { ...UK_CITIES, ...UK_DEFS, ...UK_UI, ...UK_GUIDE, ...UK_SERVER };

/** Texts the dictionary cannot express: regular expressions, their groups ($1…) translated in turn. */
export const UK_PATTERNS: [string, string][] = [
  // a glyph in front of a name (palette and building cards)
  ['([^\\w\\s\\d(])\\s(.+)', '$1 $2'],
  // a count in front of a unit name ("4 × Infantry")
  ['(\\d+) × (.+)', '$1 × $2'],
  // "Name: message" (placement problems, pings, statuses)
  ['([^:]{2,40}): (.+)', '$1: $2'],
];
