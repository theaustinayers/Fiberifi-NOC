// A small in-memory stand-in for the Cloudflare v4 API, matching the documented request and response shapes.
import http from 'node:http';

export async function startMockCloudflare({ token, zones }) {
  const state = { records: [], requests: [], failDeletes: false, nextId: 1 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const ok = (result, info) => send(200, { success: true, errors: [], result, result_info: info });

    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(403, { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] });
    }

    if (req.method === 'GET' && url.pathname === '/zones') {
      if (Number(url.searchParams.get('per_page')) > 50) {
        return send(400, { success: false, errors: [{ message: 'per_page must be 50 or less' }] });
      }
      return ok(zones, { total_pages: 1 });
    }

    const match = url.pathname.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (!match) return send(404, { success: false, errors: [{ message: 'no route' }] });
    const [, zoneId, recordId] = match;

    if (req.method === 'GET') {
      const name = url.searchParams.get('name.exact');
      const result = state.records.filter((r) => r.zone_id === zoneId && (!name || r.name === name));
      return ok(result, { total_pages: 1 });
    }
    if (req.method === 'POST') {
      const record = { ...body, id: `rec${state.nextId++}`, zone_id: zoneId };
      state.records.push(record);
      return ok(record);
    }
    const record = state.records.find((r) => r.id === recordId);
    if (req.method === 'DELETE' && state.failDeletes) {
      return send(500, { success: false, errors: [{ message: 'upstream failure' }] });
    }
    if (!record) return send(404, { success: false, errors: [{ message: 'not found' }] });
    if (req.method === 'PATCH') {
      Object.assign(record, body);
      return ok(record);
    }
    if (req.method === 'DELETE') {
      state.records.splice(state.records.indexOf(record), 1);
      return ok({ id: recordId });
    }
    send(405, { success: false, errors: [{ message: 'method' }] });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() };
}
