import { appendFileSync } from 'node:fs';

export type OfflineHttpChannel = 'global-fetch' | 'source-http' | 'llm-provider' | 'email-provider' | 'smtp' | 'raw-http' | 'raw-socket';

function hostFromUrl(rawUrl: string): { host: string; loopback: boolean } {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
    return { host: host || '<empty-host>', loopback };
  } catch {
    return { host: '<invalid-url>', loopback: false };
  }
}

function recordBlocked(channel: OfflineHttpChannel, host: string): void {
  const reportPath = process.env.KAMUILAN_NETWORK_GUARD_REPORT;
  if (!reportPath) return;
  try {
    appendFileSync(
      reportPath,
      `${JSON.stringify({ event: 'external-http-blocked', channel, host })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Logging must never weaken the block or disclose request details.
  }
}

/**
 * Vitest'te üçüncü taraf hostlara çıkışı engeller. Local provider/fixture
 * server'ları yalnız 127/localhost/::1 üzerinden kullanılabilir. true dönüşü
 * çağıranın isteği reddetmesi gerektiğini belirtir.
 */
export function shouldBlockExternalHttpInTest(rawUrl: string, channel: OfflineHttpChannel): boolean {
  if (process.env.NODE_ENV !== 'test') return false;
  const { host, loopback } = hostFromUrl(rawUrl);
  if (loopback) return false;
  recordBlocked(channel, host);
  return true;
}

export function assertNoInsecureTlsOverrideAtTestStartup(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Vitest fail-closed: NODE_TLS_REJECT_UNAUTHORIZED=0 iken TLS doğrulaması kapalı; test başlatılmadı.');
  }
}
