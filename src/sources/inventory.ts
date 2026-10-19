import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PLANNED_SOURCES, SOURCE_DEFINITIONS } from '../config/sources';
import { listAdapters } from './registry';

const MAX_FIXTURE_BYTES = 5_000_000;
const SENSITIVE_QUERY_KEY = /(?:token|api[_-]?key|apikey|session|sid|csrf|nonce|auth|password|secret)/i;

interface FixtureManifestEntry {
  sourceKey: string;
  sourceUrl: string;
  file: string;
  capturedAt: string;
  bytes: number;
  contentType: string;
  status: number;
  sha256: string;
  captureMethod: string;
  redacted: boolean;
  redactionNotes: string[];
}

export interface FixtureManifestInspection {
  status: 'none' | 'available' | 'invalid';
  manifestPath: string;
  entries: (FixtureManifestEntry & { valid: boolean; errors: string[] })[];
  errors: string[];
  validCount: number;
  invalidCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeProvenanceUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[INVALID-URL]';
  }
}

function safeInventoryText(raw: string): string {
  return raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeProvenanceUrl(url))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]')
    .replace(/\b[1-9]\d{10}\b/g, '[TCKN-LIKE REDACTED]')
    .replace(/\b(?:\+90|0090|0)?[\s().-]*\(?5\d{2}\)?[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}\b/g, '[PHONE REDACTED]')
    .replace(/(authorization|api[_-]?key|apikey|access_token|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
}

function safeManifestText(raw: string, maxLength = 300): string {
  return safeInventoryText(raw).slice(0, maxLength);
}

function fixtureFilenamePattern(sourceKey: string): RegExp {
  const escapedKey = sourceKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^fixtures/html/${escapedKey}-\\d{4}-\\d{2}-\\d{2}\\.(?:html?|json)$`, 'i');
}

/**
 * Snapshot manifestini kaynağı, provenansı, scrub işareti ve gövde hash'iyle
 * doğrular. Ham dosya içeriği rapora kopyalanmaz. PDF ve kaynağı belli olmayan
 * dosyalar otomatik fixture olarak kabul edilmez.
 */
export function inspectFixtureManifest(root = process.cwd()): FixtureManifestInspection {
  const manifestPath = join(root, 'fixtures', 'html', 'manifest.json');
  const empty = (status: FixtureManifestInspection['status'], errors: string[] = []): FixtureManifestInspection => ({
    status,
    manifestPath: relative(root, manifestPath).replaceAll('\\', '/'),
    entries: [],
    errors,
    validCount: 0,
    invalidCount: 0,
  });
  if (!existsSync(manifestPath)) {
    const fixtureDir = join(root, 'fixtures', 'html');
    const unmanifested = existsSync(fixtureDir)
      ? readdirSync(fixtureDir).filter((name) => name !== 'manifest.json' && /\.(html?|json)$/i.test(name))
      : [];
    return unmanifested.length > 0
      ? empty('invalid', [`manifest.json yok ancak provenansı olmayan ${unmanifested.length} fixture dosyası var.`])
      : empty('none');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    return empty('invalid', ['manifest.json okunamadı veya geçerli JSON değil.']);
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['entries'])) {
    return empty('invalid', ['manifest sürümü veya entries alanı beklenen şemaya uymuyor.']);
  }
  if (parsed['entries'].length > 500) {
    return empty('invalid', ['manifest beklenen 500 fixture giriş sınırını aşıyor.']);
  }

  const sourceByKey = new Map(SOURCE_DEFINITIONS.map((source) => [source.key, source]));
  const seenFiles = new Set<string>();
  const listedFiles = new Set<string>();
  const errors: string[] = [];
  const entries: FixtureManifestInspection['entries'] = [];

  for (const [index, raw] of parsed['entries'].entries()) {
    const entryErrors: string[] = [];
    if (!isRecord(raw)) {
      errors.push(`entries[${index}] nesne değil.`);
      continue;
    }
    const rawSourceKey = typeof raw['sourceKey'] === 'string' ? raw['sourceKey'] : '';
    const source = sourceByKey.get(rawSourceKey);
    const sourceKey = source ? rawSourceKey : '[INVALID-SOURCE-KEY]';
    const sourceUrl = typeof raw['sourceUrl'] === 'string' ? raw['sourceUrl'] : '';
    const rawFile = typeof raw['file'] === 'string' ? raw['file'] : '';
    const capturedAtRaw = typeof raw['capturedAt'] === 'string' ? raw['capturedAt'] : '';
    const capturedDate = Date.parse(capturedAtRaw);
    const capturedAt = Number.isFinite(capturedDate) ? new Date(capturedDate).toISOString() : '[INVALID-DATE]';
    const bytes = typeof raw['bytes'] === 'number' ? raw['bytes'] : 0;
    const rawContentType = typeof raw['contentType'] === 'string' ? raw['contentType'] : '';
    const contentType = /^(?:text\/html|application\/xhtml\+xml|application\/json)(?:\s*;[^\r\n]{0,100})?$/i.test(rawContentType)
      ? rawContentType.slice(0, 150)
      : '[INVALID-CONTENT-TYPE]';
    const status = typeof raw['status'] === 'number' ? raw['status'] : 0;
    const rawSha256 = typeof raw['sha256'] === 'string' ? raw['sha256'] : '';
    const sha256 = /^[a-f0-9]{64}$/i.test(rawSha256) ? rawSha256.toLowerCase() : '[INVALID-SHA256]';
    const rawCaptureMethod = typeof raw['captureMethod'] === 'string' ? raw['captureMethod'] : '';
    const captureMethod = rawCaptureMethod === 'capture-fixtures/v1 HttpClient.fetchText (one listing request; no PDF/detail)'
      ? rawCaptureMethod
      : '[UNRECOGNIZED-CAPTURE-METHOD]';
    const redacted = raw['redacted'] === true;
    const redactionNotes = Array.isArray(raw['redactionNotes'])
      ? raw['redactionNotes'].filter((value): value is string => typeof value === 'string').slice(0, 20).map((note) => safeManifestText(note))
      : [];

    if (!source) entryErrors.push('sourceKey kaynak envanterinde yok.');
    if (!/^https?:\/\//i.test(sourceUrl)) entryErrors.push('sourceUrl mutlak HTTP(S) URL değil.');
    else if (source) {
      try {
        const parsedSourceUrl = new URL(sourceUrl);
        const hostname = parsedSourceUrl.hostname.toLowerCase();
        if (parsedSourceUrl.username || parsedSourceUrl.password) entryErrors.push('sourceUrl kimlik bilgisi içeremez.');
        if (parsedSourceUrl.search || parsedSourceUrl.hash) entryErrors.push('sourceUrl query/fragment içermemeli; provenans URL içeriği gizleyebilir.');
        if (!source.allowedHosts.map((host) => host.toLowerCase()).includes(hostname)) {
          entryErrors.push('sourceUrl hostu ilgili kaynağın allowedHosts listesinde değil.');
        }
        if ([...parsedSourceUrl.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) {
          entryErrors.push('sourceUrl hassas token/session/auth query parametresi içeriyor.');
        }
      } catch {
        entryErrors.push('sourceUrl ayrıştırılamadı.');
      }
    }
    const fileMatchesSource = source ? fixtureFilenamePattern(source.key).test(rawFile) : false;
    if (fileMatchesSource) listedFiles.add(rawFile);
    const file = fileMatchesSource ? rawFile : '[INVALID-PATH]';
    if (!fileMatchesSource || isAbsolute(rawFile) || rawFile.includes('..')) {
      entryErrors.push('file kaynak anahtarı ve tarih içeren fixtures/html göreli HTML/JSON yolu olmalıdır.');
    } else {
      const absolute = resolve(root, rawFile);
      const relativePath = relative(resolve(root), absolute);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        entryErrors.push('fixture yolu depo kökünün dışına çıkıyor.');
      } else if (!existsSync(absolute)) {
        entryErrors.push('fixture dosyası bulunamadı.');
      } else {
        try {
          const stat = lstatSync(absolute);
          if (!stat.isFile()) {
            entryErrors.push('fixture sembolik bağlantı veya normal dosya değil.');
          } else {
            const real = realpathSync(absolute);
            const realRelative = relative(realpathSync(root), real);
            if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
              entryErrors.push('fixture gerçek yolu depo kökünün dışına çıkıyor.');
            }
            if (stat.size > MAX_FIXTURE_BYTES) {
              entryErrors.push(`fixture boyutu ${MAX_FIXTURE_BYTES} bayt sınırını aşıyor.`);
            } else {
              const contents = readFileSync(absolute);
              if (!Number.isSafeInteger(bytes) || bytes < 1 || contents.length !== bytes) {
                entryErrors.push('byte uzunluğu manifest ile fixture dosyası eşleşmiyor.');
              }
              const actualHash = createHash('sha256').update(contents).digest('hex');
              if (!/^[a-f0-9]{64}$/i.test(sha256) || actualHash !== sha256.toLowerCase()) {
                entryErrors.push('SHA-256 manifest ile fixture dosyası eşleşmiyor.');
              }
            }
          }
        } catch {
          entryErrors.push('fixture dosyası okunamadı veya hash hesaplanamadı.');
        }
      }
      if (seenFiles.has(file)) entryErrors.push('aynı fixture dosyası manifestte birden fazla kullanılmış.');
      seenFiles.add(file);
    }
    if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) entryErrors.push('capturedAt geçerli tarih değil.');
    if (!contentType || (!/text\/html|application\/xhtml\+xml|application\/json/i.test(contentType))) {
      entryErrors.push('contentType HTML/XHTML/JSON değil.');
    }
    if (!Number.isInteger(status) || status < 200 || status >= 300) entryErrors.push('HTTP status 2xx değil.');
    if (rawCaptureMethod !== 'capture-fixtures/v1 HttpClient.fetchText (one listing request; no PDF/detail)') {
      entryErrors.push('captureMethod beklenen sınırlı listing capture protokolü değil.');
    }
    if (!redacted || redactionNotes.length === 0) entryErrors.push('redacted=true ve redactionNotes zorunlu.');

    const normalized: FixtureManifestEntry = {
      sourceKey,
      sourceUrl: safeProvenanceUrl(sourceUrl),
      file,
      capturedAt,
      bytes,
      contentType,
      status,
      sha256,
      captureMethod,
      redacted,
      redactionNotes,
    };
    entries.push({ ...normalized, valid: entryErrors.length === 0, errors: entryErrors });
    if (entryErrors.length > 0) errors.push(`entries[${index}] (${sourceKey || 'sourceKey yok'}): ${entryErrors.join(' ')}`);
  }

  const fixtureDirectory = join(root, 'fixtures', 'html');
  if (existsSync(fixtureDirectory)) {
    try {
      const unmanifested = readdirSync(fixtureDirectory).filter((name) =>
        name !== 'manifest.json' && /\.(?:html?|json)$/i.test(name) && !listedFiles.has(`fixtures/html/${name}`),
      );
      if (unmanifested.length > 0) {
        errors.push(`Manifestte bulunmayan ${unmanifested.length} HTML/JSON fixture dosyası var.`);
      }
    } catch {
      errors.push('fixtures/html dizini okunamadı.');
    }
  }
  const validCount = entries.filter((entry) => entry.valid).length;
  const invalidCount = entries.length - validCount;
  return {
    status: invalidCount > 0 || errors.length > 0 ? 'invalid' : validCount > 0 ? 'available' : 'none',
    manifestPath: relative(root, manifestPath).replaceAll('\\', '/'),
    entries,
    errors,
    validCount,
    invalidCount,
  };
}

export interface SourceInventoryContract {
  sourceKeysUnique: boolean;
  missingAdapters: string[];
  listingHostNotAllowlisted: string[];
  sourceCount: number;
  adapterCount: number;
}

/** Salt okunur envanter; bu fonksiyon ağ/DB çağrısı yapmaz. */
export function buildStaticSourceInventory(root = process.cwd()): {
  generatedAt: string;
  mode: 'offline-static';
  sourceContract: SourceInventoryContract;
  fixtureManifest: FixtureManifestInspection;
  sources: Record<string, unknown>[];
  planned: typeof PLANNED_SOURCES;
  runtimeEvidence: {
    liveFetch: 'NOT RUN';
    productionDatabase: 'NOT READ';
    sourceHealth: 'UNKNOWN';
    zeroResultReason: 'NOT OBSERVED';
  };
  summary: { total: number; enabled: number; adapters: number; fixtureSnapshots: number; planned: number };
} {
  const adapters = new Map(listAdapters().map((adapter) => [adapter.key, adapter]));
  const fixtureManifest = inspectFixtureManifest(root);
  const keyCounts = new Map<string, number>();
  for (const source of SOURCE_DEFINITIONS) keyCounts.set(source.key, (keyCounts.get(source.key) ?? 0) + 1);
  const sourceKeysUnique = [...keyCounts.values()].every((count) => count === 1);
  const missingAdapters = SOURCE_DEFINITIONS
    .filter((source) => !adapters.has(source.adapterKey))
    .map((source) => `${source.key}:${source.adapterKey}`);
  const listingHostNotAllowlisted = SOURCE_DEFINITIONS
    .filter((source) => source.method !== 'manual-entry')
    .filter((source) => {
      try {
        return !source.allowedHosts.map((host) => host.toLowerCase()).includes(new URL(source.listingUrl).hostname.toLowerCase());
      } catch {
        return true;
      }
    })
    .map((source) => source.key);
  const sourceSnapshots = new Map<string, number>();
  for (const entry of fixtureManifest.entries) {
    if (entry.valid) sourceSnapshots.set(entry.sourceKey, (sourceSnapshots.get(entry.sourceKey) ?? 0) + 1);
  }

  const sources = SOURCE_DEFINITIONS.map((source) => {
    const adapter = adapters.get(source.adapterKey);
    return {
      key: source.key,
      name: source.name,
      institution: source.institution,
      listingUrl: safeProvenanceUrl(source.listingUrl),
      allowedHosts: [...source.allowedHosts],
      adapterKey: source.adapterKey,
      adapterRegistered: Boolean(adapter),
      adapterMethod: adapter?.method ?? null,
      configuredMethod: source.method,
      status: source.status,
      statusNote: safeInventoryText(source.statusNote),
      enabled: source.enabled,
      lastVerifiedAt: source.lastVerifiedAt,
      verificationEvidence: safeInventoryText(source.verificationEvidence),
      intervalMinutes: source.intervalMinutes,
      minRequestIntervalMs: source.minRequestIntervalMs,
      maxConcurrency: source.maxConcurrency,
      fixtureSnapshotCount: sourceSnapshots.get(source.key) ?? 0,
      fixtureEvidence: (sourceSnapshots.get(source.key) ?? 0) > 0 ? 'manifest-verified-scrubbed-snapshot' : 'no-verified-snapshot',
      lastHttpStatus: null,
      lastSuccessfulScanAt: null,
      lastNoticeGeneratedAt: null,
      lastRunOutcome: 'UNKNOWN_NOT_OBSERVED',
      zeroResultReason: 'UNKNOWN_NOT_OBSERVED',
    };
  });
  const contract: SourceInventoryContract = {
    sourceKeysUnique,
    missingAdapters,
    listingHostNotAllowlisted,
    sourceCount: SOURCE_DEFINITIONS.length,
    adapterCount: adapters.size,
  };

  return {
    generatedAt: new Date().toISOString(),
    mode: 'offline-static',
    sourceContract: contract,
    fixtureManifest,
    sources,
    planned: PLANNED_SOURCES,
    runtimeEvidence: {
      liveFetch: 'NOT RUN',
      productionDatabase: 'NOT READ',
      sourceHealth: 'UNKNOWN',
      zeroResultReason: 'NOT OBSERVED',
    },
    summary: {
      total: sources.length,
      enabled: sources.filter((source) => source['enabled'] === true).length,
      adapters: adapters.size,
      fixtureSnapshots: fixtureManifest.validCount,
      planned: PLANNED_SOURCES.length,
    },
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? '—')
    .replace(/\|/gu, '\\|')
    .replace(/[\r\n]+/gu, ' ')
    .trim();
}

/**
 * Statik envanteri operatörün okuyabileceği Markdown tablosuna çevirir.
 *
 * Tablo YALNIZCA kod/envanter kanıtıdır: canlı HTTP, sağlık, ilan sayısı veya
 * fixture'ın gerçekliği iddia edilmez. İlgili sütunlar açıkça NOT RUN/UNKNOWN
 * yazar; böylece "200 döndü" veya "envanterde var" yanlış okunmaz.
 */
export function renderSourceMatrixMarkdown(
  report: ReturnType<typeof buildStaticSourceInventory>,
): string {
  const lines: string[] = [
    '# Kaynak kapsam matrisi (statik envanter)',
    '',
    `Üretim: ${report.generatedAt} · Mod: **${report.mode}**`,
    '',
    '> Bu tablo yalnızca depo içindeki kaynak tanımlarını, adaptör eşleşmesini,',
    '> izinli hostları ve doğrulanmış fixture manifestini gösterir. **Canlı HTTP,',
    '> kaynak sağlığı, ilan sayısı, sayfalama, detay/PDF başarısı ve seçici',
    '> doğruluğu ölçülmemiştir.** Fixture yokluğu "test edildi" değil, açık',
    '> kapsam boşluğudur.',
    '',
    `- Kaynak tanımı: **${report.summary.total}** (etkin **${report.summary.enabled}**)`,
    `- Adaptör: **${report.summary.adapters}** · eksik: **${report.sourceContract.missingAdapters.length}**`,
    `- Doğrulanmış fixture snapshot: **${report.summary.fixtureSnapshots}** (manifest: ${report.fixtureManifest.status})`,
    `- Planlanan kapsam grubu: **${report.summary.planned}**`,
    '',
    '| sourceKey | Kurum / ad | Resmî URL | İzinli hostlar | Adaptör / yöntem | Envanter | Etkin | Fixture | Canlı kanıt |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const entry of report.sources) {
    const fixtureCount = Number(entry['fixtureSnapshotCount'] ?? 0);
    const lastVerified = entry['lastVerifiedAt'] ? `son kayıt: ${markdownCell(entry['lastVerifiedAt'])}` : 'kayıt yok';
    lines.push(
      `| ${markdownCell(entry['key'])} | ${markdownCell(entry['institution'])} / ${markdownCell(entry['name'])} | ${markdownCell(entry['listingUrl'])} | ${markdownCell(Array.isArray(entry['allowedHosts']) ? (entry['allowedHosts'] as string[]).join(', ') : '')} | ${markdownCell(entry['adapterKey'])} / ${markdownCell(entry['adapterMethod'])} | ${markdownCell(entry['status'])} (${lastVerified}) | ${entry['enabled'] === true ? 'evet' : 'hayır'} | ${fixtureCount > 0 ? `${fixtureCount} doğrulanmış` : 'YOK'} | NOT RUN / UNKNOWN |`,
    );
  }
  lines.push(
    '',
    '## Bu matrisin kanıtlamadığı şeyler',
    '',
    '- Kaynağın bugün erişilebilir olduğunu veya HTTP 200 döndüğünü.',
    '- Liste kartı, detay, PDF veya sayfalama sayılarını.',
    '- Sıfır sonucun nedeni (`not-observed`, `blocked`, `parse-failure`, `unknown`).',
    '- Adaptör seçicilerinin canlı sayfada hâlâ doğru olduğunu.',
    '',
    'Canlı kanıt için yetkili operatör `npm run staging:capture` akışını kullanmalıdır;',
    'robots/ToS kapısı ve dar istek bütçesi zorunludur.',
    '',
  );
  return lines.join('\n');
}
