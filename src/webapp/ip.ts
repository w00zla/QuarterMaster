// Rate limit keys for client addresses.

/**
 * IPv4 as is; IPv6 by its /64, since one subscriber usually holds a whole /64 and could otherwise
 * rotate addresses to dodge the limit. IPv4-mapped IPv6 counts as IPv4. Anything unparsable is
 * returned unchanged.
 */
export function rateKey(ip: string): string {
  const addr = ip.replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1]!;
  if (!addr.includes(':')) return addr;
  const halves = addr.split('::');
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return ip;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.slice(0, 4).every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
