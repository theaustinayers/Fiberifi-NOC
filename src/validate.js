export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function invalid(message, field) {
  return new ApiError(400, 'invalid', message, field ? { field } : {});
}

export function text(value, { max = 200, field, label = field } = {}) {
  const s = String(value ?? '').trim();
  if (s.length > max) throw invalid(`${label} must be ${max} characters or fewer`, field);
  // Control characters have no place in these fields and would corrupt CSV exports.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)) throw invalid(`${label} contains invalid characters`, field);
  return s;
}

export function requiredText(value, options) {
  const s = text(value, options);
  if (!s) throw invalid(`${options.label ?? options.field} is required`, options.field);
  return s;
}

export function email(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw invalid('Enter a valid email address', 'email');
  return s;
}

export function password(value, field = 'password') {
  const s = String(value ?? '');
  if (s.length < 12) throw invalid('Use at least 12 characters', field);
  if (s.length > 200) throw invalid('Use 200 characters or fewer', field);
  return s;
}

export function vlan(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4094) throw invalid('VLAN must be a number from 1 to 4094', 'vlan');
  return n;
}

export function mac(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  const hex = s.replace(/[:\-.]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) throw invalid('Enter a MAC address like 00:1a:2b:3c:4d:5e', 'mac');
  return hex.match(/../g).join(':');
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw invalid(`${field} must be one of: ${allowed.join(', ')}`, field);
  return value;
}

export function ptrHostname(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  const field = 'hostname';
  if (!s) throw invalid('Enter a hostname', field);
  if (s.length > 253) throw invalid('Hostnames can be at most 253 characters', field);
  const labels = s.split('.');
  if (labels.length < 2) throw invalid('Enter a full hostname, like mail.example.com', field);
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw invalid('Hostnames can only use letters, numbers, hyphens and dots', field);
  }
  if (/^\d+$/.test(labels.at(-1))) throw invalid('The hostname must end in a domain, not a number', field);
  if (labels.at(-1) === 'arpa') throw invalid('A PTR record cannot point at an .arpa name', field);
  return s;
}

export function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// Neutralises spreadsheet formula injection: customer-typed text ends up in admin exports.
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
