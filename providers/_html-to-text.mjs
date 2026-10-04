import { decodeEntities } from './_html-entities.mjs';

export const DESCRIPTION_MAX_CHARS = 4_000;

function findTagEnd(value, start) {
  let quote = '';
  for (let index = start + 1; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function stripMarkup(value) {
  let output = '';
  let index = 0;

  while (index < value.length) {
    if (value[index] !== '<') {
      output += value[index++];
      continue;
    }

    if (value.startsWith('<!--', index)) {
      const commentEnd = value.indexOf('-->', index + 4);
      if (commentEnd === -1) break;
      output += ' ';
      index = commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(value, index);
    if (tagEnd === -1) {
      output += value[index++];
      continue;
    }

    const tagBody = value.slice(index + 1, tagEnd);
    const match = /^\s*(\/?)\s*([a-zA-Z][\w:-]*)/.exec(tagBody);
    if (!match) {
      output += value[index++];
      continue;
    }

    const closing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    output += ' ';
    index = tagEnd + 1;

    if (!closing && (tagName === 'script' || tagName === 'style')) {
      const closePattern = new RegExp(`<\\/\\s*${tagName}\\s*>`, 'ig');
      closePattern.lastIndex = index;
      const close = closePattern.exec(value);
      index = close ? close.index + close[0].length : value.length;
      output += ' ';
    }
  }

  return output;
}

/**
 * Convert provider-supplied HTML to compact plain text suitable for a job
 * description. The first decode exposes entity-escaped markup for stripping;
 * the second resolves entities that were themselves escaped.
 */
export function htmlToText(content) {
  if (typeof content !== 'string' || content.length === 0) return '';
  const decodedMarkup = decodeEntities(content);
  const withoutMarkup = stripMarkup(decodedMarkup);
  return decodeEntities(withoutMarkup)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_MAX_CHARS);
}
