/**
 * Vitest global kurulumu.
 * - src/db/file-store gibi modüllerin testte gerçek data/ dizinine dokunmaması için
 *   geçici veri dizini verilir.
 * - Testler hiçbir zaman gerçek kaynaklara istek atmaz (fetch engellenir);
 *   canlı doğrulama ayrı: `npm run test:live`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { beforeEach, vi } from 'vitest';
import { assertNoInsecureTlsOverrideAtTestStartup, shouldBlockExternalHttpInTest } from '../src/lib/offline-network';

assertNoInsecureTlsOverrideAtTestStartup();

// Never inherit credentials or production endpoints into the offline test process.
for (const name of [
  'DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE',
  'MONGODB_URI', 'MONGODB_URL', 'MONGODB_DB', 'REDIS_URL', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'LLM_CLASSIFIER_MODEL', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PASSWORD',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_USERNAME', 'ADMIN_EMAIL', 'ADMIN_PASSWORD',
  'SMTP_PORT', 'LLM_COST_USD_PER_MTOK_INPUT', 'LLM_COST_USD_PER_MTOK_OUTPUT',
  'LLM_RUN_COST_LIMIT_USD', 'LLM_DAILY_COST_LIMIT_USD',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_USE_ENV_PROXY',
]) delete process.env[name];

process.env.NODE_ENV = 'test';
process.env.DATABASE_DRIVER = 'file';
process.env.AI_ASSISTANT_ENABLED = '0';
process.env.LLM_CLASSIFIER_ENABLED = '0';
process.env.SCHEDULER_ENABLED = '0';
process.env.EMAIL_PROVIDER = 'file';
process.env.EMAIL_DEV_FILE_TRANSPORT = '1';
process.env.APP_SECRET = 'test-secret-please-ignore-0123456789abcdef';
process.env.SOURCE_LIVE_FETCH = '0';
// Chromium gerçek ağa çıkar: sahte HTTP istemcisiyle çalışan adaptör testlerinde
// tarayıcı yedeği AÇIK kalırsa test canlı siteyi okur ve sonuç makineye göre
// değişir (Playwright kuruluysa farklı, kurulu değilse farklı). Bu yüzden
// testlerde kapalıdır; tarayıcı katmanının kendi testleri (playwright mock'lu)
// anahtarı kendi içinde geçici olarak açar.
process.env.SOURCE_BROWSER_FALLBACK = '0';
process.env.SOURCE_TLS_AIA_COMPLETION = '0';

const testDataDir = mkdtempSync(join(tmpdir(), 'kamuilan-test-'));
process.env.DATA_DIR = testDataDir;
process.env.KAMUILAN_TEST_DATA_DIR = testDataDir;

// Guard raw node:http(s), net and tls paths too; a module that bypasses global
// fetch must still fail before a real external socket is opened. Loopback is
// retained for local fixture servers and MockAgent-backed tests.
const require = createRequire(import.meta.url);
type CjsFunction = (...args: unknown[]) => unknown;
interface MutableHttpModule {
  request: CjsFunction;
  get: CjsFunction;
}
interface MutableSocketModule {
  connect: CjsFunction;
  createConnection?: CjsFunction;
}
const httpModule = require('node:http') as MutableHttpModule;
const httpsModule = require('node:https') as MutableHttpModule;
const netModule = require('node:net') as MutableSocketModule;
const tlsModule = require('node:tls') as MutableSocketModule;
const originalHttpRequest = httpModule.request;
const originalHttpGet = httpModule.get;
const originalHttpsRequest = httpsModule.request;
const originalHttpsGet = httpsModule.get;
const originalNetConnect = netModule.connect;
const originalNetCreateConnection = netModule.createConnection;
const originalTlsConnect = tlsModule.connect;

function optionRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const raw = value.trim();
  const authority = (raw.match(/:/g)?.length ?? 0) > 1 && !raw.startsWith('[') ? `[${raw}]` : raw;
  try {
    const hostname = new URL(`tcp://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

function httpUrl(protocol: 'http:' | 'https:', target: unknown, extraOptions?: unknown): string {
  if (typeof target === 'string' || target instanceof URL) {
    try {
      return new URL(String(target), `${protocol}//localhost/`).toString();
    } catch {
      return `${protocol}//<invalid-url>`;
    }
  }
  const options = { ...optionRecord(target), ...optionRecord(extraOptions) };
  const lookupHost = options['hostname'] ?? options['host'];
  if (
    typeof options['lookup'] === 'function' &&
    (typeof lookupHost !== 'string' || !isLoopbackHost(lookupHost))
  ) {
    return `${protocol}//<custom-lookup>/`;
  }
  const socketPath = options['socketPath'];
  if (typeof socketPath === 'string' && socketPath.length > 0) return `${protocol}//localhost/`;
  const rawHost = String(options['hostname'] ?? options['host'] ?? 'localhost');
  let host = rawHost;
  let port = options['port'] === undefined ? '' : `:${String(options['port'])}`;
  const hostPortSeparator = rawHost.lastIndexOf(':');
  const hostPort = rawHost.slice(hostPortSeparator + 1);
  const hostPortIsNumeric = hostPort.length > 0 && [...hostPort].every((char) => char >= '0' && char <= '9');
  if (
    options['port'] === undefined &&
    hostPortSeparator > 0 &&
    rawHost.indexOf(':') === hostPortSeparator &&
    hostPortIsNumeric
  ) {
    host = rawHost.slice(0, hostPortSeparator);
    port = rawHost.slice(hostPortSeparator);
  }
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const path = String(options['path'] ?? '/');
  return `${protocol}//${host}${port}${path.startsWith('/') ? path : `/${path}`}`;
}

function socketUrl(args: unknown[], protocol: 'tcp:' | 'tls:' = 'tcp:'): string {
  const target = args[0];
  const records = args.map(optionRecord);
  if (records.some((options) => typeof options['socketPath'] === 'string' && options['socketPath'].length > 0)) {
    return `${protocol}//localhost/`;
  }
  // A custom lookup may resolve an apparently local name externally. Permit it
  // only when the connection explicitly targets a literal loopback host (used by
  // the in-process TLS fixture); absent/non-loopback hosts fail closed.
  const explicitHost = typeof target === 'number'
    ? args.slice(1).find((value): value is string => typeof value === 'string' && value.length > 0) ??
      records.slice(1).map((options) => options['host'] ?? options['hostname']).find((value): value is string => typeof value === 'string' && value.length > 0)
    : records.map((options) => options['host'] ?? options['hostname']).find((value): value is string => typeof value === 'string' && value.length > 0);
  if (
    records.some((options) => typeof options['lookup'] === 'function') &&
    !isLoopbackHost(explicitHost)
  ) {
    return `${protocol}//<custom-lookup>/`;
  }

  let host: string;
  let port: string;
  if (typeof target === 'number') {
    // tls.connect has a (port, host, options, callback) overload. In particular,
    // tls.connect(port, undefined, { host: 'external.example' }) must not be
    // mistaken for a loopback connection just because the host is argument 3.
    const trailing = args.slice(1);
    const explicitHost = trailing.find((value): value is string => typeof value === 'string' && value.length > 0);
    const optionHost = records
      .slice(1)
      .map((options) => options['host'] ?? options['hostname'])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    const serverName = records
      .slice(1)
      .map((options) => options['servername'])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    host = explicitHost ?? optionHost ?? serverName ?? 'localhost';
    port = `:${target}`;
  } else if (typeof target === 'string') {
    // The string overload is a Unix-domain socket path, not a host name.
    return `${protocol}//localhost/`;
  } else {
    const optionHost = records
      .map((options) => options['host'] ?? options['hostname'])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    const serverName = records
      .map((options) => options['servername'])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    host = optionHost ?? serverName ?? 'localhost';
    const optionPort = records.map((options) => options['port']).find((value) => value !== undefined);
    port = optionPort === undefined ? '' : `:${String(optionPort)}`;
  }

  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${protocol}//${authority}${port}/`;
}

function guardRawHttp(protocol: 'http:' | 'https:', args: unknown[]): void {
  if (shouldBlockExternalHttpInTest(httpUrl(protocol, args[0], args[1]), 'raw-http')) {
    throw new Error('Vitest offline guard blocked raw external HTTP(S) before opening a socket.');
  }
}

function guardRawSocket(args: unknown[], protocol: 'tcp:' | 'tls:'): void {
  if (shouldBlockExternalHttpInTest(socketUrl(args, protocol), 'raw-socket')) {
    throw new Error('Vitest offline guard blocked an external socket before connecting.');
  }
}

function installNodeNetworkGuards(): void {
  httpModule.request = function (this: unknown, ...args: unknown[]): unknown {
    guardRawHttp('http:', args);
    return Reflect.apply(originalHttpRequest, this, args);
  };
  httpModule.get = function (this: unknown, ...args: unknown[]): unknown {
    guardRawHttp('http:', args);
    return Reflect.apply(originalHttpGet, this, args);
  };
  httpsModule.request = function (this: unknown, ...args: unknown[]): unknown {
    guardRawHttp('https:', args);
    return Reflect.apply(originalHttpsRequest, this, args);
  };
  httpsModule.get = function (this: unknown, ...args: unknown[]): unknown {
    guardRawHttp('https:', args);
    return Reflect.apply(originalHttpsGet, this, args);
  };
  netModule.connect = function (this: unknown, ...args: unknown[]): unknown {
    guardRawSocket(args, 'tcp:');
    return Reflect.apply(originalNetConnect, this, args);
  };
  if (originalNetCreateConnection) {
    netModule.createConnection = function (this: unknown, ...args: unknown[]): unknown {
      guardRawSocket(args, 'tcp:');
      return Reflect.apply(originalNetCreateConnection, this, args);
    };
  }
  tlsModule.connect = function (this: unknown, ...args: unknown[]): unknown {
    guardRawSocket(args, 'tls:');
    return Reflect.apply(originalTlsConnect, this, args);
  };
  syncBuiltinESMExports();
}

const nativeFetch = globalThis.fetch.bind(globalThis);
function installOfflineFetchGuard(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (shouldBlockExternalHttpInTest(rawUrl, 'global-fetch')) {
      return Promise.reject(new Error('Vitest offline guard blocked external HTTP; use an injected fake or loopback server.'));
    }
    return nativeFetch(input, init);
  }) as typeof globalThis.fetch;
}

installNodeNetworkGuards();
installOfflineFetchGuard();
beforeEach(() => {
  vi.restoreAllMocks();
  installNodeNetworkGuards();
  installOfflineFetchGuard();
});
