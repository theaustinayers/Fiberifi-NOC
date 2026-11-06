// Reads a router's health and interfaces over SNMPv3 (authPriv, SHA and AES).
import snmp from 'net-snmp';

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  // sysUpTime restarts with snmpd on every commit. This one is the machine's real uptime.
  hrSystemUptime: '1.3.6.1.2.1.25.1.1.0',
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  ssCpuIdle: '1.3.6.1.4.1.2021.11.11.0',
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

function memoryPercent(values) {
  const total = Number(values[OID.memTotalReal] ?? 0);
  if (!total) return null;
  const free = Number(values[OID.memAvailReal] ?? 0) + Number(values[OID.memBuffer] ?? 0) + Number(values[OID.memCached] ?? 0);
  return Math.max(0, Math.min(100, ((total - free) / total) * 100));
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
        alias: text(columns.ifAlias.get(index)),
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
      .filter((iface) => iface.name && iface.name !== 'lo');

    const uptime = values[OID.hrSystemUptime];
    return {
      sysName: text(values[OID.sysName]),
      sysDescr: text(values[OID.sysDescr]),
      uptimeSeconds: uptime === undefined ? null : Math.floor(Number(uptime) / 100),
      cpu: cpuPercent(cores, values[OID.ssCpuIdle]),
      memory: memoryPercent(values),
      load1: values[OID.load1] === undefined ? null : Number(text(values[OID.load1])),
      interfaces,
    };
  } finally {
    session.close();
  }
}
