import type { FlowSecurityTarget } from '../../../types/security.js';
import { FlowSecurityError } from '../FlowSecurityError.js';

/*** Validates target syntax before the host transport verifies every resolved network peer. */
export const validateFlowSecurityTarget = (
  target: FlowSecurityTarget | undefined,
): string | undefined => {
  if (!target) return undefined;
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new FlowSecurityError('invalid_target', 'External targets must be absolute HTTPS URLs.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !uniqueStrings(target.allowedHosts) ||
    !target.allowedHosts.includes(host) ||
    isUnsafeLiteralHost(host)
  )
    throw new FlowSecurityError(
      'invalid_target',
      'External targets must use an explicitly allowlisted public HTTPS host.',
    );
  return host;
};

/*** Rejects normalized loopback, local, private, and special-use IP literals before transport access. */
const isUnsafeLiteralHost = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || isUnsafeIpv4(host) || isUnsafeIpv6(host);

/*** Identifies IPv4 ranges that must never be an outbound target. */
const isUnsafeIpv4 = (host: string): boolean => {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

/*** Identifies IPv6 loopback, unspecified, unique-local, link-local, and mapped literal forms. */
const isUnsafeIpv6 = (host: string): boolean => {
  const normalized = host.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:')
  );
};

/*** Checks unique non-empty authority strings. */
const uniqueStrings = (values: readonly string[]): boolean =>
  values.length > 0 &&
  values.every((value) => value.length > 0) &&
  new Set(values).size === values.length;
