/**
 * URL normalisation + SSRF guards.
 *
 * Normalisation is deliberately conservative: only parameters that are known to
 * be analytics/tracking are dropped. Parameters that may identify the
 * announcement (id, ilanId, ilanno, kalem, etc.) are always preserved.
 */

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'fbclid',
  'gclid',
  'yclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'igshid',
  'spm',
  'scid',
  'trk',
  'trkcampaign',
  'wt_mc',
  'wt_zmc',
]);

export function normalizeUrl(raw: string, base?: string): string {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return raw.trim();
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.protocol = url.protocol.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

export function sameSite(a: string, b: string): boolean {
  try {
    return hostOf(a) === hostOf(b);
  } catch {
    return false;
  }
}

export function hostOf(raw: string): string {
  return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.internal$/i,
  /\.local$/i,
  /^metadata\./i,
];

/**
 * Blocks requests to loopback/private/metadata endpoints and non-HTTP schemes.
 * Admin-provided URLs are additionally checked against the source allowlist.
 */
export function assertFetchableUrl(raw: string, opts: { allowHosts?: string[] } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Geçersiz URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Desteklenmeyen protokol: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (
    url.username ||
    url.password ||
    /^\d+(?:\.\d+){0,3}$/.test(bareHost) ||
    /^0x[0-9a-f]+$/i.test(bareHost) ||
    host.startsWith('[')
  ) {
    throw new Error(`Sayısal adres veya URL kimlik bilgileri kabul edilmez: ${host}`);
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(`Özel/yerel ağ adreslerine istek engellendi: ${host}`);
  }
  if (!host.includes('.') && host !== 'localhost') {
    throw new Error(`Geçersiz ana bilgisayar adı: ${host}`);
  }
  if (
    (url.protocol === 'https:' && url.port && url.port !== '443') ||
    (url.protocol === 'http:' && url.port && url.port !== '80')
  ) {
    throw new Error(`Desteklenmeyen URL portu: ${url.port}`);
  }
  if (opts.allowHosts && opts.allowHosts.length > 0) {
    const normalizedHost = bareHost.replace(/\.$/, '');
    const allowed = opts.allowHosts.some(
      (entry) => normalizedHost === entry.toLowerCase().replace(/\.$/, ''),
    );
    if (!allowed) throw new Error(`Alan adı izin listesinde değil: ${host}`);
  }
  return url;
}

const OFFICIAL_APPLICATION_DOMAINS = [
  'kariyerkapisi.gov.tr',
  'esube.iskur.gov.tr',
  'turkiye.gov.tr',
  'ais.osym.gov.tr',
] as const;

/** Match an application service by parsed hostname, never by a URL substring. */
export function isOfficialApplicationUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return OFFICIAL_APPLICATION_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function fileExtensionOf(raw: string): string {
  try {
    const path = new URL(raw).pathname;
    const match = /\.([a-z0-9]{1,5})$/i.exec(path);
    return match?.[1]?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}
