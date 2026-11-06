// Polls routers on a timer, works out bandwidth from the counters, and keeps history.
import { getSetting, setSetting, transaction } from './db.js';
import { readLive, readRouter } from './lib/snmp.js';
import { decryptSecret, encryptSecret } from './lib/security.js';
import { ApiError, invalid, oneOf, requiredText, text } from './validate.js';

const RAW_DAYS = 2;
const BGP_EVENT_DAYS = 90;
const ROLLUP_DAYS = 35;
const ROLLUP_SECONDS = 300;
const DOWN_AFTER_FAILURES = 2;
const MAX_POINTS = 360;

export const RANGES = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };

// Open pages read once a second, but snmpd only refreshes interface counters every 3 seconds. A plain
// 1-second rate would show traffic, then two zeros. So a rate is only worked out when the counters move,
// over the time since they last moved, and held until then. No movement for longer than this means idle.
const LIVE_MIN_MS = 900;
const LIVE_HOLD_MS = 4500;
// BGP goes through AgentX to bgpd, so it is read less often than the rest.
const LIVE_BGP_MS = 6000;
// An interface missing for this long has been removed from the router.
const GONE_AFTER_MS = 3600 * 1000;

// The largest gap two samples can have before the rate between them stops meaning anything.
const MAX_GAP_SECONDS = 600;

export function rate(previous, current, seconds) {
  if (seconds <= 0 || seconds > MAX_GAP_SECONDS) return null;
  const delta = current - previous;
  // A counter going backwards means the router or interface restarted, not negative traffic.
  if (delta < 0n) return null;
  return Number(delta * 8n) / seconds;
}

export function createMonitor(db, config) {
  const reader = config.snmpReader ?? ((host, credentials) => readRouter(host, credentials, { port: config.snmpPort }));
  const liveReader = config.snmpLiveReader ?? ((host, credentials, options) => readLive(host, credentials, { ...options, port: config.snmpPort }));
  const intervalMs = (config.snmpIntervalSeconds ?? 30) * 1000;
  const liveReadings = new Map();
  const liveRequests = new Map();
  let timer = null;
  let polling = false;

  function credentials() {
    const stored = getSetting(db, 'snmp_auth');
    if (!stored) return null;
    return {
      user: getSetting(db, 'snmp_user'),
      authPassword: decryptSecret(stored, config.appSecret),
      privPassword: decryptSecret(getSetting(db, 'snmp_priv'), config.appSecret),
    };
  }

  function getSettings() {
    return { configured: Boolean(getSetting(db, 'snmp_auth')), user: getSetting(db, 'snmp_user') };
  }

  function saveSettings(input) {
    const user = requiredText(input.user, { max: 64, field: 'user', label: 'Username' });
    const auth = String(input.authPassword ?? '');
    const priv = String(input.privPassword ?? '') || auth;
    if (!auth && !getSettings().configured) throw invalid('Enter the SNMP password', 'authPassword');
    if (auth && auth.length < 8) throw invalid('SNMPv3 passwords must be at least 8 characters', 'authPassword');
    setSetting(db, 'snmp_user', user);
    if (auth) {
      setSetting(db, 'snmp_auth', encryptSecret(auth, config.appSecret));
      setSetting(db, 'snmp_priv', encryptSecret(priv, config.appSecret));
    }
    return getSettings();
  }

  function requireRouter(id) {
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(Number(id));
    if (!router) throw new ApiError(404, 'not_found', 'That router does not exist');
    return router;
  }

  function fields(input) {
    const datacenterId = input.datacenterId ? Number(input.datacenterId) : null;
    if (datacenterId && !db.prepare('SELECT 1 FROM datacenters WHERE id = ?').get(datacenterId)) {
      throw invalid('Choose a datacenter from the list', 'datacenterId');
    }
    return {
      name: requiredText(input.name, { max: 80, field: 'name', label: 'Name' }),
      host: requiredText(input.host, { max: 253, field: 'host', label: 'Address' }),
      role: oneOf(input.role || 'edge', ['core', 'edge'], 'role'),
      datacenterId,
      notes: text(input.notes, { max: 500, field: 'notes', label: 'Notes' }),
    };
  }

  function assertNameFree(name, ignoreId = 0) {
    if (db.prepare('SELECT 1 FROM routers WHERE name = ? AND id <> ?').get(name, ignoreId)) {
      throw new ApiError(409, 'duplicate', 'A router with that name already exists', { field: 'name' });
    }
  }

  function createRouter(input) {
    const f = fields(input);
    assertNameFree(f.name);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO routers (name, host, role, datacenter_id, notes) VALUES (?, ?, ?, ?, ?)')
      .run(f.name, f.host, f.role, f.datacenterId, f.notes);
    return requireRouter(lastInsertRowid);
  }

  function updateRouter(id, input) {
    const router = requireRouter(id);
    const f = fields({ ...router, datacenterId: router.datacenter_id, ...input });
    assertNameFree(f.name, router.id);
    db.prepare('UPDATE routers SET name = ?, host = ?, role = ?, datacenter_id = ?, notes = ? WHERE id = ?').run(
      f.name,
      f.host,
      f.role,
      f.datacenterId,
      f.notes,
      router.id,
    );
    return requireRouter(router.id);
  }

  function deleteRouter(id) {
    const router = requireRouter(id);
    db.prepare('DELETE FROM routers WHERE id = ?').run(router.id);
    return router;
  }

  // Logs a change the moment it is seen. Live pages feed this every 5 seconds, the background poll every 30.
  function storeBgp(router, peers, now) {
    if (!peers) return;
    const upsert = db.prepare(
      `INSERT INTO bgp_sessions (router_id, peer_ip, local_ip, remote_as, state, admin, in_updates, out_updates, in_messages,
         out_messages, transitions, state_seconds, last_error, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (router_id, peer_ip) DO UPDATE SET local_ip = excluded.local_ip, remote_as = excluded.remote_as,
         state = excluded.state, admin = excluded.admin, in_updates = excluded.in_updates, out_updates = excluded.out_updates,
         in_messages = excluded.in_messages, out_messages = excluded.out_messages, transitions = excluded.transitions,
         state_seconds = excluded.state_seconds, last_error = excluded.last_error, seen_at = excluded.seen_at`,
    );
    const addEvent = db.prepare('INSERT INTO bgp_events (session_id, ts, type, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)');
    for (const peer of peers) {
      const previous = db.prepare('SELECT * FROM bgp_sessions WHERE router_id = ? AND peer_ip = ?').get(router.id, peer.peerIp);
      upsert.run(router.id, peer.peerIp, peer.localIp, peer.remoteAs, peer.state, peer.admin, peer.inUpdates, peer.outUpdates, peer.inMessages, peer.outMessages, peer.transitions, peer.stateSeconds, peer.lastError, now);
      // Only the background poll reads these, so a live reading leaves them alone.
      if (peer.description !== undefined) {
        db.prepare('UPDATE bgp_sessions SET description = ? WHERE router_id = ? AND peer_ip = ?').run(peer.description, router.id, peer.peerIp);
      }
      if (!previous) continue;
      // The router's own counters restarted, so a reset from before that no longer means anything.
      const restarted = peer.inUpdates < previous.in_updates || peer.outUpdates < previous.out_updates || peer.inMessages < previous.in_messages || peer.outMessages < previous.out_messages || peer.transitions < previous.transitions;
      if (restarted) {
        db.prepare('UPDATE bgp_sessions SET base_in_updates = 0, base_out_updates = 0, base_in_messages = 0, base_out_messages = 0, base_transitions = 0 WHERE id = ?').run(previous.id);
      }
      const wasUp = previous.state === 'established';
      const isUp = peer.state === 'established';
      if (wasUp && !isUp) addEvent.run(previous.id, now, 'down', previous.state, peer.state, peer.lastError);
      else if (!wasUp && isUp) addEvent.run(previous.id, now, 'up', previous.state, peer.state, '');
      // Back up already, with the counter moved on: it dropped and recovered between two readings.
      else if (wasUp && isUp && peer.transitions > previous.transitions) addEvent.run(previous.id, now, 'flap', previous.state, peer.state, peer.lastError);
    }
  }

  function store(router, data, now) {
    const seconds = Math.floor(now / 1000);
    transaction(db, () => {
      db.prepare(
        `UPDATE routers SET status = 'up', fails = 0, last_error = '', sys_name = ?, sys_descr = ?, uptime_seconds = ?,
         cpu = ?, memory = ?, load1 = ?, last_seen = ?, polled_at = ? WHERE id = ?`,
      ).run(data.sysName, data.sysDescr, data.uptimeSeconds, data.cpu, data.memory, data.load1, now, now, router.id);
      db.prepare('INSERT OR REPLACE INTO router_samples (router_id, ts, cpu, memory) VALUES (?, ?, ?, ?)').run(
        router.id,
        seconds,
        data.cpu,
        data.memory,
      );

      storeBgp(router, data.bgp, now);
      const existing = new Map(db.prepare('SELECT * FROM router_interfaces WHERE router_id = ?').all(router.id).map((row) => [row.name, row]));
      const upsert = db.prepare(
        `INSERT INTO router_interfaces (router_id, name, if_index, alias, speed_mbps, admin, oper, in_octets, out_octets,
           in_bps, out_bps, in_errors, out_errors, in_discards, out_discards, counters_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (router_id, name) DO UPDATE SET if_index = excluded.if_index, alias = excluded.alias,
           speed_mbps = excluded.speed_mbps, admin = excluded.admin, oper = excluded.oper, in_octets = excluded.in_octets,
           out_octets = excluded.out_octets, in_bps = excluded.in_bps, out_bps = excluded.out_bps, in_errors = excluded.in_errors,
           out_errors = excluded.out_errors, in_discards = excluded.in_discards, out_discards = excluded.out_discards,
           counters_at = excluded.counters_at`,
      );
      const sample = db.prepare('INSERT OR REPLACE INTO interface_samples (interface_id, ts, in_bps, out_bps) VALUES (?, ?, ?, ?)');
      const lookup = db.prepare('SELECT id FROM router_interfaces WHERE router_id = ? AND name = ?');

      for (const iface of data.interfaces) {
        const previous = existing.get(iface.name);
        const elapsed = previous ? (now - previous.counters_at) / 1000 : 0;
        const inBps = previous ? rate(BigInt(previous.in_octets), iface.inOctets, elapsed) : null;
        const outBps = previous ? rate(BigInt(previous.out_octets), iface.outOctets, elapsed) : null;
        upsert.run(
          router.id,
          iface.name,
          iface.index,
          iface.alias,
          iface.speedMbps,
          iface.admin,
          iface.oper,
          iface.inOctets.toString(),
          iface.outOctets.toString(),
          inBps,
          outBps,
          iface.inErrors,
          iface.outErrors,
          iface.inDiscards,
          iface.outDiscards,
          now,
        );
        if (inBps !== null && outBps !== null) sample.run(lookup.get(router.id, iface.name).id, seconds, inBps, outBps);
      }
    });
  }

  function recordFailure(router, error, now) {
    const fails = router.fails + 1;
    db.prepare(`UPDATE routers SET fails = ?, status = ?, last_error = ?, polled_at = ? WHERE id = ?`).run(
      fails,
      fails >= DOWN_AFTER_FAILURES ? 'down' : router.status,
      String(error.message ?? error).slice(0, 200),
      now,
      router.id,
    );
  }

  async function pollRouter(router, now = Date.now()) {
    const creds = credentials();
    if (!creds) throw new ApiError(409, 'snmp_not_configured', 'Add the SNMP username and password first');
    try {
      store(router, await reader(router.host, creds), now);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      recordFailure(router, error, now);
    }
    return requireRouter(router.id);
  }

  // Averages finished five-minute buckets, then drops what is too old to keep.
  function compact(now = Date.now()) {
    const seconds = Math.floor(now / 1000);
    const bucket = seconds - (seconds % ROLLUP_SECONDS);
    const from = bucket - 2 * ROLLUP_SECONDS;
    const span = `${ROLLUP_SECONDS}`;
    transaction(db, () => {
      db.prepare(
        `INSERT OR REPLACE INTO interface_rollups (interface_id, ts, in_bps, out_bps, in_max, out_max)
         SELECT interface_id, (ts / ${span}) * ${span}, AVG(in_bps), AVG(out_bps), MAX(in_bps), MAX(out_bps)
         FROM interface_samples WHERE ts >= ? AND ts < ? GROUP BY interface_id, ts / ${span}`,
      ).run(from, bucket);
      db.prepare(
        `INSERT OR REPLACE INTO router_rollups (router_id, ts, cpu, memory)
         SELECT router_id, (ts / ${span}) * ${span}, AVG(cpu), AVG(memory)
         FROM router_samples WHERE ts >= ? AND ts < ? GROUP BY router_id, ts / ${span}`,
      ).run(from, bucket);
      const rawCutoff = seconds - RAW_DAYS * 86400;
      const rollupCutoff = seconds - ROLLUP_DAYS * 86400;
      db.prepare('DELETE FROM interface_samples WHERE ts < ?').run(rawCutoff);
      db.prepare('DELETE FROM router_samples WHERE ts < ?').run(rawCutoff);
      db.prepare('DELETE FROM interface_rollups WHERE ts < ?').run(rollupCutoff);
      db.prepare('DELETE FROM router_rollups WHERE ts < ?').run(rollupCutoff);
      db.prepare('DELETE FROM bgp_events WHERE ts < ?').run(now - BGP_EVENT_DAYS * 86400 * 1000);
    });
  }

  async function pollAll() {
    if (polling || !credentials()) return;
    polling = true;
    try {
      const routers = db.prepare('SELECT * FROM routers').all();
      await Promise.allSettled(routers.map((router) => pollRouter(router)));
      compact();
    } finally {
      polling = false;
    }
  }

  // Short ranges read the raw samples and long ones the five-minute rollups, thinned to a drawable number of points.
  function series(id, column, columns, range, rawTable, rollupTable) {
    const seconds = RANGES[range] ?? RANGES['1h'];
    const raw = seconds <= RANGES['24h'];
    const step = Math.max(raw ? 30 : ROLLUP_SECONDS, Math.ceil(seconds / MAX_POINTS));
    const since = Math.floor(Date.now() / 1000) - seconds;
    const fieldsSql = columns.map((name) => `AVG(${name}) AS ${name}`).join(', ');
    const rows = db
      .prepare(
        `SELECT (ts / ${step}) * ${step} AS ts, ${fieldsSql} FROM ${raw ? rawTable : rollupTable}
         WHERE ${column} = ? AND ts >= ? GROUP BY ts / ${step} ORDER BY 1`,
      )
      .all(id, since);
    return { range, step, rows };
  }

  function requireInterface(routerId, interfaceId) {
    const iface = db.prepare('SELECT * FROM router_interfaces WHERE id = ? AND router_id = ?').get(Number(interfaceId), Number(routerId));
    if (!iface) throw new ApiError(404, 'not_found', 'That interface does not exist');
    return iface;
  }

  async function takeLiveReading(router, last, now) {
    const creds = credentials();
    if (!creds) throw new ApiError(409, 'snmp_not_configured', 'Add the SNMP username and password first');
    const includeBgp = !last || now - last.bgpAt >= LIVE_BGP_MS;
    let data;
    try {
      data = await liveReader(router.host, creds, { includeBgp });
    } catch (error) {
      throw new ApiError(502, 'snmp_error', `Could not read ${router.name}: ${error.message}`);
    }

    const rows = new Map(db.prepare('SELECT * FROM router_interfaces WHERE router_id = ?').all(router.id).map((row) => [row.if_index, row]));
    const counters = new Map();
    const interfaces = [];
    for (const reading of data.interfaces) {
      const row = rows.get(reading.index);
      if (!row) continue;
      // With no live readings yet it measures from the last poll, so the first sample already has a rate.
      const previous = last?.counters.get(row.id) ?? { at: row.counters_at, inOctets: BigInt(row.in_octets), outOctets: BigInt(row.out_octets), in_bps: row.in_bps, out_bps: row.out_bps };
      const unmoved = previous.inOctets === reading.inOctets && previous.outOctets === reading.outOctets;
      let entry = previous;
      if (!unmoved || now - previous.at >= LIVE_HOLD_MS) {
        const seconds = (now - previous.at) / 1000;
        entry = {
          at: now,
          inOctets: reading.inOctets,
          outOctets: reading.outOctets,
          in_bps: rate(previous.inOctets, reading.inOctets, seconds),
          out_bps: rate(previous.outOctets, reading.outOctets, seconds),
        };
      }
      counters.set(row.id, entry);
      interfaces.push({ id: row.id, oper: reading.oper, in_bps: entry.in_bps, out_bps: entry.out_bps });
    }

    // Busy share of the ticks since the last reading. Until there is one, the last polled figure stands in.
    let cpu = router.cpu;
    if (data.cpuTicks && last?.cpuTicks) {
      const total = data.cpuTicks.total - last.cpuTicks.total;
      const idle = data.cpuTicks.idle - last.cpuTicks.idle;
      if (total > 0) cpu = Math.max(0, Math.min(100, (1 - idle / total) * 100));
      else cpu = last.sample.cpu;
    }

    transaction(db, () => storeBgp(router, data.bgp, now));
    const sample = { ts: Math.floor(now / 1000), cpu, memory: data.memory, interfaces, bgp: includeBgp ? bgpSessions(router) : undefined };
    liveReadings.set(router.id, { at: now, counters, cpuTicks: data.cpuTicks, sample, bgpAt: includeBgp ? now : last.bgpAt });
    return sample;
  }

  // One reading per router every few seconds, shared by everyone watching it.
  async function liveSample(routerId, now = Date.now()) {
    const router = requireRouter(routerId);
    const last = liveReadings.get(router.id);
    if (last && now - last.at < LIVE_MIN_MS) return last.sample;
    if (liveRequests.has(router.id)) return liveRequests.get(router.id);
    const request = takeLiveReading(router, last, now).finally(() => liveRequests.delete(router.id));
    liveRequests.set(router.id, request);
    return request;
  }

  function interfaceHistory(routerId, interfaceId, range) {
    const iface = requireInterface(routerId, interfaceId);
    return series(iface.id, 'interface_id', ['in_bps', 'out_bps'], range, 'interface_samples', 'interface_rollups');
  }

  function routerHistory(routerId, range) {
    const router = requireRouter(routerId);
    return series(router.id, 'router_id', ['cpu', 'memory'], range, 'router_samples', 'router_rollups');
  }

  // A session gone from the table has been removed from the router's config.
  function bgpSessions(router) {
    return db
      .prepare(`SELECT * FROM bgp_sessions WHERE router_id = ? AND seen_at >= ? ORDER BY (state = 'established'), COALESCE(NULLIF(label, ''), NULLIF(description, ''), peer_ip)`)
      .all(router.id, (router.last_seen ?? 0) - GONE_AFTER_MS)
      .map((row) => ({
        id: row.id,
        peerIp: row.peer_ip,
        localIp: row.local_ip,
        label: row.label,
        description: row.description,
        remoteAs: row.remote_as,
        state: row.state,
        admin: row.admin,
        inUpdates: Math.max(0, row.in_updates - row.base_in_updates),
        outUpdates: Math.max(0, row.out_updates - row.base_out_updates),
        inMessages: Math.max(0, row.in_messages - row.base_in_messages),
        outMessages: Math.max(0, row.out_messages - row.base_out_messages),
        transitions: Math.max(0, row.transitions - row.base_transitions),
        stateSeconds: row.state_seconds,
        lastError: row.last_error,
      }));
  }

  function requireSession(routerId, sessionId) {
    const session = db.prepare('SELECT * FROM bgp_sessions WHERE id = ? AND router_id = ?').get(Number(sessionId), Number(routerId));
    if (!session) throw new ApiError(404, 'not_found', 'That BGP session does not exist');
    return session;
  }

  function bgpEvents(routerId, sessionId) {
    const session = requireSession(routerId, sessionId);
    return db
      .prepare('SELECT id, ts, type, from_state AS fromState, to_state AS toState, detail FROM bgp_events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 200')
      .all(session.id);
  }

  function labelSession(routerId, sessionId, input) {
    const session = requireSession(routerId, sessionId);
    db.prepare('UPDATE bgp_sessions SET label = ? WHERE id = ?').run(text(input.label, { max: 80, field: 'label', label: 'Name' }), session.id);
    return session;
  }

  // Only changes what the panel shows. Nothing is sent to the router, so no session is touched.
  function resetBgpStats(routerId) {
    const router = requireRouter(routerId);
    db.prepare(
      `UPDATE bgp_sessions SET base_in_updates = in_updates, base_out_updates = out_updates, base_in_messages = in_messages,
       base_out_messages = out_messages, base_transitions = transitions WHERE router_id = ?`,
    ).run(router.id);
    return router;
  }

  function summary(router) {
    const ports = db
      .prepare(`SELECT COUNT(*) AS total, SUM(oper = 'up') AS up FROM router_interfaces WHERE router_id = ? AND admin = 'up' AND counters_at >= ?`)
      .get(router.id, (router.last_seen ?? 0) - GONE_AFTER_MS);
    const bgp = db
      .prepare(`SELECT COUNT(*) AS total, SUM(state = 'established') AS up FROM bgp_sessions WHERE router_id = ? AND seen_at >= ?`)
      .get(router.id, (router.last_seen ?? 0) - GONE_AFTER_MS);
    const datacenter = router.datacenter_id ? db.prepare('SELECT id, name, code FROM datacenters WHERE id = ?').get(router.datacenter_id) : null;
    return {
      id: router.id,
      name: router.name,
      host: router.host,
      role: router.role,
      notes: router.notes,
      datacenter,
      status: router.status,
      sysName: router.sys_name,
      sysDescr: router.sys_descr,
      uptimeSeconds: router.uptime_seconds,
      cpu: router.cpu,
      memory: router.memory,
      load1: router.load1,
      lastError: router.last_error,
      lastSeen: router.last_seen,
      polledAt: router.polled_at,
      portsUp: ports.up ?? 0,
      portsTotal: ports.total,
      bgpUp: bgp.up ?? 0,
      bgpTotal: bgp.total,
    };
  }

  function listRouters() {
    return db.prepare('SELECT * FROM routers ORDER BY name').all().map(summary);
  }

  function routerDetail(id) {
    const router = requireRouter(id);
    const interfaces = db
      .prepare('SELECT * FROM router_interfaces WHERE router_id = ? AND counters_at >= ? ORDER BY (oper = \'up\') DESC, name')
      .all(router.id, (router.last_seen ?? 0) - GONE_AFTER_MS)
      .map((row) => ({
        id: row.id,
        name: row.name,
        alias: row.alias,
        speedMbps: row.speed_mbps,
        admin: row.admin,
        oper: row.oper,
        inBps: row.in_bps,
        outBps: row.out_bps,
        errors: row.in_errors + row.out_errors,
        discards: row.in_discards + row.out_discards,
      }));
    return { ...summary(router), interfaces, bgp: bgpSessions(router) };
  }

  return {
    start() {
      pollAll();
      timer = setInterval(pollAll, intervalMs);
      timer.unref();
    },
    stop: () => clearInterval(timer),
    getSettings,
    saveSettings,
    requireRouter,
    createRouter,
    updateRouter,
    deleteRouter,
    pollRouter,
    pollAll,
    compact,
    listRouters,
    routerDetail,
    interfaceHistory,
    liveSample,
    bgpEvents,
    labelSession,
    resetBgpStats,
    routerHistory,
  };
}
