import { isIP } from 'node:net';

/*** Validate an explicit numeric listener address without allowing DNS-dependent bind behavior. */
export const validateFlowApiHostname = (
  hostname: string,
): { readonly hostname: string; readonly loopback: boolean } => {
  if (isIP(hostname) === 0) throw new Error('FLOW_API_HOSTNAME_INVALID');
  return { hostname, loopback: hostname === '::1' || hostname.startsWith('127.') };
};
