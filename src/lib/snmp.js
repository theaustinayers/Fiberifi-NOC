// Reads a router's health and interfaces over SNMPv3 (authPriv, SHA and AES).
import snmp from 'net-snmp';

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  // sysUpTime restarts with snmpd on every commit. This one is the machine's real uptime.
  hrSystemUptime: '1.3.6.1.2.1.25.1.1.0',
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  ssCpuIdle: '1.3.6.1.4.1.2021.11.11.0',
  ssCpuRawUser: '1.3.6.1.4.1.2021.11.50.0',
  ssCpuRawNice: '1.3.6.1.4.1.2021.11.51.0',
  ssCpuRawSystem: '1.3.6.1.4.1.2021.11.52.0',
  ssCpuRawIdle: '1.3.6.1.4.1.2021.11.53.0',
  memTotalReal: '1.3.6.1.4.1.2021.4.5.0',
  memAvailReal: '1.3.6.1.4.1.2021.4.6.0',
  memBuffer: '1.3.6.1.4.1.2021.4.14.0',
  memCached: '1.3.6.1.4.1.2021.4.15.0',
  load1: '1.3.6.1.4.1.2021.10.1.3.1',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifInDiscards: '1.3.6.1.2.1.2.2.1.13',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutDiscards: '1.3.6.1.2.1.2.2.1.19',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
};

// Internal to the router, and never carry traffic worth watching.
const HIDDEN_INTERFACES = new Set(['lo', 'pimreg', 'pim6reg']);

const BGP_PEER_TABLE = '1.3.6.1.2.1.15.3.1';
const BGP_COLUMN = { state: 2, admin: 3, localIp: 5, peerIp: 7, remoteAs: 9, inUpdates: 10, outUpdates: 11, inMessages: 12, outMessages: 13, lastError: 14, transitions: 15, stateSeconds: 16 };
const BGP_STATE = { 1: 'idle', 2: 'connect', 3: 'active', 4: 'opensent', 5: 'openconfirm', 6: 'established' };
const BGP_ERROR = { 1: 'Message header error', 2: 'OPEN message error', 3: 'UPDATE message error', 4: 'Hold timer expired', 5: 'Finite state machine error', 6: 'Cease' };

const IF_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

// Counter64 arrives as a big-endian Buffer, and a 64-bit value does not fit in a Number.
export function toBigInt(value) {
  if (Buffer.isBuffer(value)) return value.length ? BigInt(`0x${value.toString('hex')}`) : 0n;
  return BigInt(value ?? 0);
}

function text(value) {
  return value === undefined || value === null ? '' : value.toString().trim();
}

function open(host, credentials, port) {
  return snmp.createV3Session(
    host,
    {
      name: credentials.user,
      level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha,
      authKey: credentials.authPassword,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: credentials.privPassword,
    },
    { port, retries: 1, timeout: 4000 },
  );
}

function getScalars(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) return reject(error);
      const values = {};
      varbinds.forEach((varbind, i) => {
        values[oids[i]] = snmp.isVarbindError(varbind) ? undefined : varbind.value;
      });
      resolve(values);
    });
  });
}

// Returns index -> value for one column of a table.
function walk(session, base) {
  return new Promise((resolve, reject) => {
    const column = new Map();
    session.subtree(
      base,
      20,
      (varbinds) => {
        for (const varbind of varbinds) {
          if (!snmp.isVarbindError(varbind)) column.set(varbind.oid.slice(base.length + 1), varbind.value);
        }
      },
      (error) => (error ? reject(error) : resolve(column)),
    );
  });
}

function bgpError(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.alloc(0);
  if (bytes.length < 2 || !bytes[0]) return '';
  return `${BGP_ERROR[bytes[0]] ?? `Error ${bytes[0]}`} (${bytes[0]}/${bytes[1]})`;
}

// The whole peer table in one walk. Routers without FRR's SNMP module simply return nothing.
async function readBgp(session) {
  const cells = await walk(session, BGP_PEER_TABLE);
  const peers = new Map();
  for (const [key, value] of cells) {
    const dot = key.indexOf('.');
    const column = Number(key.slice(0, dot));
    const peer = key.slice(dot + 1);
    if (!peers.has(peer)) peers.set(peer, new Map());
    peers.get(peer).set(column, value);
  }
  return [...peers.entries()].map(([peerIp, cols]) => ({
    peerIp,
    localIp: text(cols.get(BGP_COLUMN.localIp)),
    remoteAs: Number(cols.get(BGP_COLUMN.remoteAs) ?? 0),
    state: BGP_STATE[cols.get(BGP_COLUMN.state)] ?? 'unknown',
    admin: cols.get(BGP_COLUMN.admin) === 2 ? 'start' : 'stop',
    inUpdates: Number(cols.get(BGP_COLUMN.inUpdates) ?? 0),
    outUpdates: Number(cols.get(BGP_COLUMN.outUpdates) ?? 0),
    inMessages: Number(cols.get(BGP_COLUMN.inMessages) ?? 0),
    outMessages: Number(cols.get(BGP_COLUMN.outMessages) ?? 0),
    transitions: Number(cols.get(BGP_COLUMN.transitions) ?? 0),
    stateSeconds: Number(cols.get(BGP_COLUMN.stateSeconds) ?? 0),
    lastError: bgpError(cols.get(BGP_COLUMN.lastError)),
  }));
}

function memoryPercent(values) {
  const total = Number(values[OID.memTotalReal] ?? 0);
  if (!total) return null;
  const free = Number(values[OID.memAvailReal] ?? 0) + Number(values[OID.memBuffer] ?? 0) + Number(values[OID.memCached] ?? 0);
  return Math.max(0, Math.min(100, ((total - free) / total) * 100));
}

// Everything a live page needs, in one short read. CPU comes back as raw ticks because the usual
// CPU figures are one-minute averages, which would look frozen at this speed.
export async function readLive(host, credentials, { port = 161, includeBgp = true } = {}) {
  const session = open(host, credentials, port);
  try {
    const values = await getScalars(session, [
      OID.memTotalReal,
      OID.memAvailReal,
      OID.memBuffer,
      OID.memCached,
      OID.ssCpuRawUser,
      OID.ssCpuRawNice,
      OID.ssCpuRawSystem,
      OID.ssCpuRawIdle,
    ]);
    const inOctets = await walk(session, OID.ifHCInOctets);
    const outOctets = await walk(session, OID.ifHCOutOctets);
    const oper = await walk(session, OID.ifOperStatus);
    const idle = values[OID.ssCpuRawIdle];
    const busy = [OID.ssCpuRawUser, OID.ssCpuRawNice, OID.ssCpuRawSystem].map((oid) => values[oid]);
    return {
      cpuTicks: idle === undefined || busy.includes(undefined) ? null : { idle: Number(idle), total: Number(idle) + busy.reduce((sum, ticks) => sum + Number(ticks), 0) },
      memory: memoryPercent(values),
      bgp: includeBgp ? await readBgp(session) : undefined,
      interfaces: [...inOctets.keys()].map((index) => ({
        index: Number(index),
        oper: IF_STATUS[oper.get(index)] ?? 'unknown',
        inOctets: toBigInt(inOctets.get(index)),
        outOctets: toBigInt(outOctets.get(index)),
      })),
    };
  } finally {
    session.close();
  }
}

// Per-core load is the better reading, but not every agent reports it, so idle time is the fallback.
function cpuPercent(cores, idle) {
  if (cores.length) return cores.reduce((sum, load) => sum + load, 0) / cores.length;
  return idle === undefined ? null : Math.max(0, 100 - Number(idle));
}

export async function readRouter(host, credentials, { port = 161 } = {}) {
  const session = open(host, credentials, port);
  try {
    const values = await getScalars(session, [
      OID.sysDescr,
      OID.sysName,
      OID.hrSystemUptime,
      OID.memTotalReal,
      OID.memAvailReal,
      OID.memBuffer,
      OID.memCached,
      OID.load1,
      OID.ssCpuIdle,
    ]);

    const cores = [...(await walk(session, OID.hrProcessorLoad)).values()].map(Number);
    const columns = {};
    for (const key of ['ifName', 'ifAlias', 'ifHighSpeed', 'ifAdminStatus', 'ifOperStatus', 'ifHCInOctets', 'ifHCOutOctets', 'ifInErrors', 'ifOutErrors', 'ifInDiscards', 'ifOutDiscards']) {
      columns[key] = await walk(session, OID[key]);
    }

    const interfaces = [...columns.ifName.entries()]
      .map(([index, name]) => ({
        index: Number(index),
        name: text(name),
        // VyOS repeats the interface name here when no description is set.
        alias: text(columns.ifAlias.get(index)) === text(name) ? '' : text(columns.ifAlias.get(index)),
        speedMbps: Number(columns.ifHighSpeed.get(index) ?? 0),
        admin: IF_STATUS[columns.ifAdminStatus.get(index)] ?? 'unknown',
        oper: IF_STATUS[columns.ifOperStatus.get(index)] ?? 'unknown',
        inOctets: toBigInt(columns.ifHCInOctets.get(index)),
        outOctets: toBigInt(columns.ifHCOutOctets.get(index)),
        inErrors: Number(columns.ifInErrors.get(index) ?? 0),
        outErrors: Number(columns.ifOutErrors.get(index) ?? 0),
        inDiscards: Number(columns.ifInDiscards.get(index) ?? 0),
        outDiscards: Number(columns.ifOutDiscards.get(index) ?? 0),
      }))
      .filter((iface) => iface.name && !HIDDEN_INTERFACES.has(iface.name));

    const uptime = values[OID.hrSystemUptime];
    return {
      sysName: text(values[OID.sysName]),
      sysDescr: text(values[OID.sysDescr]),
      uptimeSeconds: uptime === undefined ? null : Math.floor(Number(uptime) / 100),
      cpu: cpuPercent(cores, values[OID.ssCpuIdle]),
      memory: memoryPercent(values),
      load1: values[OID.load1] === undefined ? null : Number(text(values[OID.load1])),
      interfaces,
      bgp: await readBgp(session),
    };
  } finally {
    session.close();
  }
}
