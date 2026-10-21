/**
 * `TRUST_PROXY` ayrıştırma: hangi vekilin `X-Forwarded-For` başlığına güvenilir?
 *
 * Değerler:
 *  - `0` / `false` / boş → hiçbir vekile güvenilmez; istemci IP'si soket adresidir.
 *  - `1` / `true` → HER vekile güvenilir (eski davranış). Yalnızca API'ye vekil
 *    dışında hiçbir yoldan ulaşılamıyorsa güvenlidir.
 *  - Virgülle ayrılmış IP/CIDR listesi ve/veya `cloudflare` anahtar sözcüğü →
 *    yalnızca bu adreslerden gelen isteklerde başlık değerlendirilir. API kökeni
 *    doğrudan internetten erişilebilir olsa bile, vekili atlayan bir istemcinin
 *    sahte `X-Forwarded-For` başlığı yok sayılır (R-09).
 *
 * Liste Fastify'ın `trustProxy` seçeneğine verilir; zincir proxy-addr ile sağdan
 * sola değerlendirilir ve güvenilmeyen ilk adres istemci IP'si olur.
 */
import { isIP } from 'node:net';

/**
 * Cloudflare'in yayımladığı kenar ağı aralıkları.
 * Kaynak: https://www.cloudflare.com/ips-v4 ve /ips-v6 (21.10.2026'da okundu).
 * Liste değişirse burası güncellenir; `TRUST_PROXY` içine ek CIDR de yazılabilir.
 */
export const CLOUDFLARE_IP_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** proxy-addr'in tanıdığı ad kümeleri (ör. Docker ağı için `uniquelocal`). */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

export type TrustProxySetting = boolean | string[];

/** Tek bir liste öğesi geçerli mi (IP, CIDR, ad kümesi)? Geçersizse açıklama döner. */
function invalidEntry(entry: string): string | null {
  if (NAMED_RANGES.has(entry) || entry === 'cloudflare') return null;
  const [address, prefix, extra] = entry.split('/');
  if (extra !== undefined || !address) return entry;
  const family = isIP(address);
  if (family === 0) return entry;
  if (prefix === undefined) return null;
  if (!/^\d{1,3}$/.test(prefix)) return entry;
  const bits = Number(prefix);
  return bits <= (family === 4 ? 32 : 128) ? null : entry;
}

/** Geçersiz öğeleri döndürür (boş dizi = geçerli). */
export function invalidTrustProxyEntries(raw: string): string[] {
  const value = raw.trim().toLowerCase();
  if (['', '0', '1', 'true', 'false'].includes(value)) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(invalidEntry)
    .filter((entry): entry is string => entry !== null);
}

/** Ham değeri Fastify `trustProxy` biçimine çevirir. Geçersiz öğe varsa hata fırlatır. */
export function parseTrustProxy(raw: string): TrustProxySetting {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  const invalid = invalidTrustProxyEntries(value);
  if (invalid.length > 0) {
    throw new Error(`TRUST_PROXY geçersiz öğe içeriyor: ${invalid.join(', ')}`);
  }
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .flatMap((part) => (part === 'cloudflare' ? [...CLOUDFLARE_IP_RANGES] : [part]));
  return [...new Set(entries)];
}
