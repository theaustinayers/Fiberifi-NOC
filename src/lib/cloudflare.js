// Thin client for the parts of the Cloudflare v4 API that rDNS needs.
// The token needs Zone:Read and DNS:Edit on the reverse zones.
const ZONE_PAGE_SIZE = 50; // API maximum for GET /zones
const RECORD_PAGE_SIZE = 500;

export class CloudflareError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class CloudflareClient {
  constructor({ token, accountId = '', baseUrl }) {
    this.token = token;
    this.accountId = accountId;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(method, path, { query = {}, body } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new CloudflareError(`Could not reach Cloudflare: ${error.message}`, 0);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      const detail = data?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
      throw new CloudflareError(`Cloudflare rejected the request: ${detail}`, response.status);
    }
    return data;
  }

  async paginate(path, query, perPage) {
    const results = [];
    for (let page = 1; ; page += 1) {
      const data = await this.request('GET', path, { query: { ...query, page, per_page: perPage } });
      results.push(...data.result);
      const totalPages = data.result_info?.total_pages ?? 1;
      if (page >= totalPages || data.result.length === 0) return results;
    }
  }

  async listReverseZones() {
    const zones = await this.paginate('/zones', { 'account.id': this.accountId }, ZONE_PAGE_SIZE);
    return zones
      .filter((zone) => zone.name.endsWith('.arpa'))
      .map((zone) => ({ id: zone.id, name: zone.name, status: zone.status }));
  }

  async findPtr(zoneId, name) {
    const data = await this.request('GET', `/zones/${zoneId}/dns_records`, {
      query: { type: 'PTR', 'name.exact': name, per_page: 100 },
    });
    return data.result;
  }

  listPtr(zoneId) {
    return this.paginate(`/zones/${zoneId}/dns_records`, { type: 'PTR' }, RECORD_PAGE_SIZE);
  }

  async createPtr(zoneId, record) {
    const data = await this.request('POST', `/zones/${zoneId}/dns_records`, { body: { type: 'PTR', ...record } });
    return data.result;
  }

  // Sends the whole record: the API reference does not promise that PATCH accepts a partial body.
  async updatePtr(zoneId, recordId, record) {
    const data = await this.request('PATCH', `/zones/${zoneId}/dns_records/${recordId}`, {
      body: { type: 'PTR', ...record },
    });
    return data.result;
  }

  async deleteRecord(zoneId, recordId) {
    try {
      await this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}
