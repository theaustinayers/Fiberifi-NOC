// IP maths for IPv4 and IPv6. Everything is BigInt internally so both families share one code path.
import net from 'node:net';

export const BITS = { 4: 32, 6: 128 };
const MIN_LENGTH = { 4: 8, 6: 16 };

export class IpError extends Error {}

function v4ToBig(s) {
  return s.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
}

function v6ToBig(input) {
  let s = input;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':') + 1;
    const v4 = v4ToBig(s.slice(cut));
    s = `${s.slice(0, cut)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - left.length - right.length : 0;
  return [...left, ...Array(fill).fill('0'), ...right].reduce((acc, g) => (acc << 16n) | BigInt(`0x${g}`), 0n);
}

export function parseIp(input) {
  const s = String(input ?? '').trim();
  const family = s.includes('%') ? 0 : net.isIP(s);
  if (!family) throw new IpError(`"${s}" is not a valid IP address`);
  return { family, value: family === 4 ? v4ToBig(s) : v6ToBig(s.toLowerCase()) };
}

// RFC 5952 canonical text form for IPv6.
export function formatIp(family, value) {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => (value >> shift) & 0xffn).join('.');
  }
  const groups = [];
  for (let i = 7; i >= 0; i -= 1) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; i += 1) {
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    if (j > i) i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export function toHex(value) {
  return value.toString(16).padStart(32, '0');
}

export function fromHex(hex) {
  return BigInt(`0x${hex}`);
}

function hostMask(family, length) {
  return (1n << BigInt(BITS[family] - length)) - 1n;
}

export function makePrefix(family, network, length) {
  const last = network | hostMask(family, length);
  return { family, length, network, last, cidr: `${formatIp(family, network)}/${length}` };
}

export function parseCidr(input) {
  const s = String(input ?? '').trim();
  const slash = s.indexOf('/');
  if (slash < 0) throw new IpError(`"${s}" needs a prefix length, for example 192.0.2.0/24`);
  const { family, value } = parseIp(s.slice(0, slash));
  const lengthText = s.slice(slash + 1);
  const length = Number(lengthText);
  if (!/^\d{1,3}$/.test(lengthText) || length > BITS[family]) {
    throw new IpError(`"/${lengthText}" is not a valid prefix length for IPv${family}`);
  }
  if (length < MIN_LENGTH[family]) {
    throw new IpError(`IPv${family} prefixes must be /${MIN_LENGTH[family]} or longer`);
  }
  const mask = hostMask(family, length);
  if (value & mask) {
    const fixed = formatIp(family, value & ~mask);
    throw new IpError(`${s} has host bits set. Did you mean ${fixed}/${length}?`);
  }
  return makePrefix(family, value, length);
}

export function contains(prefix, value) {
  return value >= prefix.network && value <= prefix.last;
}

export function prefixSize(family, length) {
  return 1n << BigInt(BITS[family] - length);
}

export function netmask(length) {
  return formatIp(4, ((1n << 32n) - 1n) ^ hostMask(4, length));
}

// The addresses in a subnet that are not the customer's to use.
// A /31 or /127 is point-to-point (RFC 3021, RFC 6164): no network or broadcast address.
// IPv6 has no broadcast. Its first address is the subnet-router anycast, so it is treated as the network address.
export function subnetRoles({ family, length, network, last, gateway = null }) {
  const hostBits = BITS[family] - length;
  const roles = { network: null, gateway: null, broadcast: null };
  if (hostBits === 0) return roles;
  if (hostBits === 1) {
    roles.gateway = gateway ?? network;
    return roles;
  }
  roles.network = network;
  roles.gateway = gateway ?? network + 1n;
  if (family === 4) roles.broadcast = last;
  return roles;
}

export function ptrName(family, value) {
  if (family === 4) {
    return `${[0n, 8n, 16n, 24n].map((shift) => (value >> shift) & 0xffn).join('.')}.in-addr.arpa`;
  }
  return `${toHex(value).split('').reverse().join('.')}.ip6.arpa`;
}

// The inverse of ptrName. Returns null for anything that is not a full single-address name.
export function ipFromPtr(name) {
  const s = String(name).toLowerCase().replace(/\.$/, '');
  if (s.endsWith('.in-addr.arpa')) {
    const octets = s.slice(0, -'.in-addr.arpa'.length).split('.');
    if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) < 256)) return null;
    return { family: 4, value: v4ToBig(octets.reverse().join('.')) };
  }
  if (s.endsWith('.ip6.arpa')) {
    const nibbles = s.slice(0, -'.ip6.arpa'.length).split('.');
    if (nibbles.length !== 32 || !nibbles.every((n) => /^[0-9a-f]$/.test(n))) return null;
    return { family: 6, value: fromHex(nibbles.reverse().join('')) };
  }
  return null;
}

// Reverse zones at the delegation boundary (octet or nibble) that cover a prefix.
// 206.168.244.0/22 needs four /24 zones, 2607:9340::/32 needs one.
export function reverseZonesFor({ family, network, length }, limit = 64) {
  const step = family === 4 ? 8 : 4;
  const zoneLength = Math.ceil(length / step) * step;
  const count = 1n << BigInt(zoneLength - length);
  const zones = [];
  const stride = prefixSize(family, zoneLength);
  const labelsToDrop = (BITS[family] - zoneLength) / step;
  for (let i = 0n; i < count && zones.length < limit; i += 1n) {
    const labels = ptrName(family, network + i * stride).split('.');
    zones.push(labels.slice(labelsToDrop).join('.'));
  }
  return zones;
}

function trailingZeros(value, bits) {
  if (value === 0n) return bits;
  let n = 0;
  let v = value;
  while ((v & 1n) === 0n) {
    v >>= 1n;
    n += 1;
  }
  return n;
}

// Largest aligned CIDR blocks that exactly tile start..end.
export function rangeToCidrs(family, start, end) {
  const bits = BITS[family];
  const blocks = [];
  let cursor = start;
  while (cursor <= end) {
    let hostBits = trailingZeros(cursor, bits);
    while (1n << BigInt(hostBits) > end - cursor + 1n) hostBits -= 1;
    blocks.push(makePrefix(family, cursor, bits - hostBits));
    cursor += 1n << BigInt(hostBits);
  }
  return blocks;
}

// children must be the direct children of parent, sorted by network.
export function freeBlocks(parent, children) {
  const blocks = [];
  let cursor = parent.network;
  for (const child of children) {
    if (child.network > cursor) blocks.push(...rangeToCidrs(parent.family, cursor, child.network - 1n));
    cursor = child.last + 1n;
  }
  if (cursor <= parent.last) blocks.push(...rangeToCidrs(parent.family, cursor, parent.last));
  return blocks;
}

export function nextAvailable(parent, children, length) {
  const size = prefixSize(parent.family, length);
  let cursor = parent.network;
  for (const child of children) {
    const aligned = ((cursor + size - 1n) / size) * size;
    if (aligned + size - 1n < child.network) return makePrefix(parent.family, aligned, length);
    cursor = child.last + 1n;
  }
  const aligned = ((cursor + size - 1n) / size) * size;
  if (aligned + size - 1n <= parent.last) return makePrefix(parent.family, aligned, length);
  return null;
}

// "1,024" for IPv4. Large IPv6 blocks are counted in /64s, the unit operators actually plan in.
export function sizeLabel(family, length) {
  if (family === 6 && length <= 64) return `${(1n << BigInt(64 - length)).toLocaleString('en-US')} × /64`;
  return prefixSize(family, length).toLocaleString('en-US');
}
