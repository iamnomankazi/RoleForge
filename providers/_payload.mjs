/** Fail-closed first-page response validation shared by provider adapters. */
export function requiredArray(payload, path, provider) {
  let value = payload;
  for (const segment of path.split('.')) value = value && typeof value === 'object' ? value[segment] : undefined;
  if (!Array.isArray(value)) throw new Error(`${provider}: malformed response (expected ${path} array)`);
  return value;
}

export function requireUsableRows(rawRows, usableRows, provider) {
  if (rawRows.length > 0 && usableRows.length === 0) {
    throw new Error(`${provider}: malformed response (${rawRows.length} raw row(s), none structurally usable)`);
  }
  return usableRows;
}

export function requireHtmlContract(html, markers, provider) {
  if (typeof html !== 'string' || !markers.some((marker) => marker.test(html))) {
    throw new Error(`${provider}: malformed HTML response`);
  }
  return html;
}
