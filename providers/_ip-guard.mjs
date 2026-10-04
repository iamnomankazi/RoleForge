import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';

export const BLOCKED_ADDRESS_CODE = 'ECAREEROPS_BLOCKED_ADDRESS';

const providerHttpContext = new AsyncLocalStorage();

const IPV4_BLOCKED_RANGES = [
  [[0, 0, 0, 0], 8],       // unspecified / current network
  [[10, 0, 0, 0], 8],      // private
  [[100, 64, 0, 0], 10],   // shared carrier-grade NAT
  [[127, 0, 0, 0], 8],     // loopback
  [[169, 254, 0, 0], 16],  // link-local
  [[172, 16, 0, 0], 12],   // private
  [[192, 0, 0, 0], 24],    // IETF protocol assignments
  [[192, 0, 2, 0], 24],    // documentation
  [[192, 88, 99, 0], 24],  // deprecated 6to4 relay anycast
  [[192, 168, 0, 0], 16],  // private
  [[198, 18, 0, 0], 15],   // benchmark testing
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24],  // documentation
  [[224, 0, 0, 0], 4],     // multicast
  [[240, 0, 0, 0], 4],     // reserved / limited broadcast
];

function hasPrefix(bytes, prefix, bitLength) {
  const fullBytes = Math.floor(bitLength / 8);
  const remainingBits = bitLength % 8;
  for (let index = 0; index < fullBytes; index++) {
    if (bytes[index] !== prefix[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

function parseIpv4(address) {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

function parseIpv6(address) {
  if (isIP(address) !== 6) return null;

  let normalized = address;
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex);

  const ipv4Match = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return null;
    const replacement = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    normalized = normalized.slice(0, normalized.length - ipv4Match[1].length) + replacement;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8 || words.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;

  return words.flatMap((word) => [word >>> 8, word & 0xff]);
}

function isPublicIpv4Bytes(bytes) {
  return !IPV4_BLOCKED_RANGES.some(([prefix, bits]) => hasPrefix(bytes, prefix, bits));
}

function isIpv4Compatible(bytes) {
  return bytes.slice(0, 12).every((byte) => byte === 0);
}

function isIpv4Mapped(bytes) {
  return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

function isIpv4Translated(bytes) {
  return bytes.slice(0, 8).every((byte) => byte === 0)
    && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0;
}

function isPublicIpv6Bytes(bytes) {
  if (isIpv4Compatible(bytes) || isIpv4Mapped(bytes) || isIpv4Translated(bytes)) {
    return isPublicIpv4Bytes(bytes.slice(12));
  }

  // The well-known NAT64 prefix embeds an IPv4 destination in the final 32
  // bits. Validate that destination so private IPv4 cannot be smuggled through
  // an otherwise global-looking IPv6 answer.
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    return isPublicIpv4Bytes(bytes.slice(12));
  }

  const blocked = [
    [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48], // local-use NAT64
    [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64],      // discard-only
    [[0x20, 0x01, 0x00, 0x00], 32],             // Teredo
    [[0x20, 0x01, 0x00, 0x02, 0, 0], 48],       // benchmark testing
    [[0x20, 0x01, 0x00, 0x10], 28],             // ORCHID
    [[0x20, 0x01, 0x00, 0x20], 28],             // ORCHIDv2
    [[0x20, 0x01, 0x0d, 0xb8], 32],             // documentation
    [[0x20, 0x02], 16],                         // deprecated 6to4
    [[0x3f, 0xff, 0x00], 20],                   // documentation
    [[0x5f, 0x00], 16],                         // segment-routing SIDs
    [[0xfc], 7],                                // unique local
    [[0xfe, 0x80], 10],                         // link-local
    [[0xfe, 0xc0], 10],                         // deprecated site-local
    [[0xff], 8],                                // multicast
  ];
  return !blocked.some(([prefix, bits]) => hasPrefix(bytes, prefix, bits));
}

function normalizeAddress(address) {
  if (typeof address !== 'string') return '';
  let normalized = address.trim();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  return normalized;
}

/** Return true only for a syntactically valid, publicly routable IP address. */
export function isPublicIpAddress(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  const version = isIP(normalized);
  if (version === 4) return isPublicIpv4Bytes(parseIpv4(normalized));
  if (version === 6) {
    const bytes = parseIpv6(normalized);
    return Boolean(bytes && isPublicIpv6Bytes(bytes));
  }
  return false;
}

export class BlockedProviderAddressError extends Error {
  constructor(hostname, address, metadata = {}) {
    const printableAddress = typeof address === 'string' && address ? address : '<invalid>';
    super(`Provider request blocked non-public resolved address ${printableAddress} for ${hostname || '<unknown host>'}`);
    this.name = 'BlockedProviderAddressError';
    this.code = BLOCKED_ADDRESS_CODE;
    this.hostname = hostname || '';
    this.address = typeof address === 'string' ? address : '';
    if (metadata.requestUrl) this.requestUrl = metadata.requestUrl;
  }
}

export function assertPublicIpAddress(address, { hostname = '', context = null } = {}) {
  if (!isPublicIpAddress(address)) throw new BlockedProviderAddressError(hostname, address, context || {});
  return address;
}

export function getProviderIpGuardContext() {
  return providerHttpContext.getStore() || null;
}

/** Keep the provider-only guard active for every async operation in callback. */
export function withProviderIpGuard(callback, metadata = {}) {
  if (typeof callback !== 'function') throw new TypeError('withProviderIpGuard requires a callback');
  return providerHttpContext.run(Object.freeze({ providerHttp: true, ...metadata }), callback);
}

export const runWithProviderIpGuard = withProviderIpGuard;

/** Validate normal and `{ all: true }` dns.lookup callback result shapes. */
export function validateLookupResult(hostname, resultArgs, context = getProviderIpGuardContext()) {
  if (!context?.providerHttp) return;
  const first = resultArgs?.[0];
  const addresses = Array.isArray(first) ? first.map((entry) => entry?.address) : [first];
  if (addresses.length === 0) throw new BlockedProviderAddressError(hostname, '', context);
  for (const address of addresses) assertPublicIpAddress(address, { hostname, context });
}

/** Block literal private IP URLs, which bypass dns.lookup entirely. */
export function assertProviderUrlIpLiteral(url, context = getProviderIpGuardContext()) {
  if (!context?.providerHttp) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return; // Preserve fetch's existing invalid-URL error behavior.
  }
  const hostname = normalizeAddress(parsed.hostname);
  if (isIP(hostname)) assertPublicIpAddress(hostname, { hostname, context });
}
