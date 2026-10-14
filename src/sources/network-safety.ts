/**
 * DNS/SSRF network guards shared by the HTTP and headless-browser clients.
 *
 * Hostname allowlists alone are not sufficient: a public-looking name can
 * resolve to loopback, private, link-local, metadata, or other special-use
 * address space. Resolve all answers and reject the hostname if any answer is
 * not globally routable; Node then connects only to the checked address set.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const BLOCKED_IPV4 = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_IPV4.addSubnet(subnet, prefix, 'ipv4');
}

// IPv6 is allowed only from Global Unicast (2000::/3), with special-purpose,
// documentation, transition, and benchmarking ranges denied explicitly.
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_IPV6 = new BlockList();
for (const [subnet, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  BLOCKED_IPV6.addSubnet(subnet, prefix, 'ipv6');
}

/** True only for public unicast IPv4/IPv6 addresses. */
export function isPublicRoutableAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_IPV4.check(address, 'ipv4');
  if (family === 6) {
    return GLOBAL_UNICAST_IPV6.check(address, 'ipv6') && !BLOCKED_IPV6.check(address, 'ipv6');
  }
  return false;
}

export type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

type ResolveAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A Node `lookup` callback suitable for `net.connect`, `tls.connect`, and
 * Undici. It resolves all A/AAAA records first, rejects mixed public/private
 * sets, and returns only addresses that were checked in this callback.
 */
export function createPublicOnlyLookup(resolver: ResolveAll = dnsLookup) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const resolveOptions: LookupAllOptions = {
      all: true,
      order: 'verbatim',
      ...(options.family !== undefined ? { family: options.family } : {}),
      ...(options.hints !== undefined ? { hints: options.hints } : {}),
    };

    resolver(hostname, resolveOptions, (error, addresses) => {
      if (error) {
        callback(error, options.all ? [] : '', 0);
        return;
      }
      if (addresses.length === 0 || addresses.some(({ address }) => !isPublicRoutableAddress(address))) {
        const blocked = Object.assign(new Error(`DNS result for ${hostname} is not globally routable.`), {
          code: 'EACCES',
        });
        callback(blocked, options.all ? [] : '', 0);
        return;
      }

      const requestedFamily =
        options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : (options.family ?? 0);
      const matching =
        requestedFamily === 0 ? addresses : addresses.filter(({ family }) => family === requestedFamily);
      if (matching.length === 0) {
        const unavailable = Object.assign(
          new Error(`No public DNS address for requested family: ${hostname}.`),
          {
            code: 'EAI_ADDRFAMILY',
          },
        );
        callback(unavailable, options.all ? [] : '', 0);
        return;
      }

      if (options.all) {
        callback(null, matching);
        return;
      }
      const first = matching[0]!;
      callback(null, first.address, first.family);
    });
  };
}

const publicOnlyLookup = createPublicOnlyLookup();

/** Resolve public addresses for a pinned browser host-resolver rule. */
export function resolvePublicAddresses(hostname: string, family?: 4 | 6): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    publicOnlyLookup(
      hostname,
      { all: true, order: 'verbatim', ...(family ? { family } : {}) },
      (error, addresses) => {
        if (error) {
          reject(error);
        } else if (Array.isArray(addresses)) {
          resolve(addresses);
        } else {
          reject(new Error(`Could not resolve an address list for ${hostname}.`));
        }
      },
    );
  });
}
