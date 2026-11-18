import { isIP } from 'node:net';

/*** Validate an explicit numeric listener address without allowing DNS-dependent bind behavior. */
export const validateFlowApiHostname = (
  hostname: string,
): { readonly hostname: string; readonly loopback: boolean } => {
  const family = isIP(hostname);
  if (family === 0) throw new Error('FLOW_API_HOSTNAME_INVALID');
  return {
    hostname,
    loopback: family === 4 ? hostname.startsWith('127.') : isIpv6LoopbackAddress(hostname),
  };
};

/** Classify IPv4, IPv6, and canonical IPv4-mapped IPv6 loopback listeners before composition. */
const isIpv6LoopbackAddress = (hostname: string): boolean =>
  hostname === '::1' || isIpv4MappedIpv6Loopback(hostname);

/** Recognize every compressed or expanded IPv4-mapped spelling whose embedded IPv4 address is loopback. */
const isIpv4MappedIpv6Loopback = (hostname: string): boolean => {
  const canonicalHostname = new URL(`http://[${hostname}]`).hostname.slice(1, -1);
  const match = /^::ffff:([\da-f]{1,4}):[\da-f]{1,4}$/u.exec(canonicalHostname);
  return match !== null && Number.parseInt(match[1] ?? '', 16) >>> 8 === 127;
};
