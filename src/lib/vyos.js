// Talks to a VyOS router's HTTP API. VyOS API keys have no read-only mode, so whoever holds one controls
// the router. Everything that changes config is built in src/sync.js, which only produces address changes.
import http from 'node:http';
import tls from 'node:tls';

const TIMEOUT_MS = 20000;

export class VyosError extends Error {}

// VyOS certificates are self-signed, so there is no chain to check. Pinning the certificate on first
// use means the key is only ever sent to the router that was tested, checked before anything is sent.
function pinnedSocket(url, fingerprint) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false, servername: '' });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new VyosError('The router did not answer')));
    socket.once('error', (error) => reject(new VyosError(`Could not reach the router: ${error.message}`)));
    socket.once('secureConnect', () => {
      const seen = socket.getPeerCertificate().fingerprint256;
      if (fingerprint && seen !== fingerprint) {
        socket.destroy();
        reject(new VyosError('The router’s certificate has changed, so nothing was sent. Test the connection again if this is expected.'));
        return;
      }
      resolve({ socket, seen });
    });
  });
}

export async function certificateFingerprint(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') return '';
  const { socket, seen } = await pinnedSocket(url, '');
  socket.destroy();
  return seen;
}

async function post(baseUrl, fingerprint, path, key, data) {
  const url = new URL(path, baseUrl);
  const boundary = `----noc${Math.random().toString(16).slice(2)}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = `${field('data', JSON.stringify(data))}${field('key', key)}--${boundary}--\r\n`;
  const secure = url.protocol === 'https:';
  const socket = secure ? (await pinnedSocket(url, fingerprint)).socket : null;

  return new Promise((resolve, reject) => {
    // Plain http on purpose: the request rides the already-pinned TLS socket, which https.request would
    // replace with its own connection that rejects a self-signed certificate.
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        ...(socket ? { createConnection: () => socket } : {}),
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* handled below */
          }
          if (!parsed) return reject(new VyosError(`The router sent an unexpected reply (HTTP ${response.statusCode})`));
          resolve({ status: response.statusCode, ...parsed });
        });
      },
    );
    request.on('timeout', () => request.destroy(new VyosError('The router did not answer')));
    request.on('error', (error) => reject(error instanceof VyosError ? error : new VyosError(`Could not reach the router: ${error.message}`)));
    request.end(body);
  });
}

function failure(result) {
  return new VyosError(String(result.error ?? `The router refused the request (HTTP ${result.status})`).slice(0, 300));
}

export function createVyosClient({ url, key, fingerprint }) {
  return {
    async addresses(iface) {
      const result = await post(url, fingerprint, '/retrieve', key, { op: 'returnValues', path: ['interfaces', 'ethernet', iface, 'address'] });
      if (result.success) return result.data ?? [];
      if (/empty|does not exist/i.test(String(result.error))) return [];
      throw failure(result);
    },
    async configure(ops) {
      const result = await post(url, fingerprint, '/configure', key, ops);
      if (!result.success) throw failure(result);
    },
    async save() {
      const result = await post(url, fingerprint, '/config-file', key, { op: 'save' });
      if (!result.success) throw failure(result);
    },
  };
}
