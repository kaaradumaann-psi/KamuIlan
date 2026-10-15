/**
 * `.env` dosyası yazma katmanı (yorumlar korunur, sırlar günlüğe yazılmaz).
 *
 * Neden ayrı modül: `env:setup` sihirbazı kullanıcıdan aldığı değeri dosyaya
 * yazarken mevcut dosyayı YENİDEN YAZMAZ. `.env` dosyaları elle eklenmiş
 * yorumlar ve bölümler içerir; bunları silen bir araç, kurulumu geri
 * döndürülemez biçimde bozar. Bu modül satır düzeyinde çalışır:
 *
 *  - Var olan `KEY=value` satırı yerinde güncellenir (yorumu korunur).
 *  - Olmayan anahtar dosyanın sonuna, başlığı olan bir bölümde eklenir.
 *  - Yorumlar, boş satırlar ve tanınmayan satırlar AYNEN korunur.
 *  - Değerler gerekiyorsa tırnaklanır (boşluk, `#`, tırnak, çok satır).
 *  - Yazmadan önce `.env.yedek-<zaman>` kopyası alınır (istek dışı kayıp yok).
 *
 * Gizlilik: bu modül hiçbir değeri yazdırmaz; çağıran taraf maskeler.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EnvFileLine {
  kind: 'blank' | 'comment' | 'entry' | 'unknown';
  raw: string;
  key?: string;
  value?: string;
}

const KEY_LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/;

/** Dosyayı satır satır çözümler (yorum/boş/anahtar ayrımıyla). */
export function parseEnvFileLines(contents: string): EnvFileLine[] {
  return contents.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { kind: 'blank' as const, raw };
    if (trimmed.startsWith('#')) return { kind: 'comment' as const, raw };
    const match = KEY_LINE.exec(raw);
    if (!match) return { kind: 'unknown' as const, raw };
    return { kind: 'entry' as const, raw, key: match[3], value: unquote(match[5] ?? '') };
  });
}

/** Tırnaklı değeri açar (load-env.ts ile aynı kural). */
export function unquote(rawValue: string): string {
  let value = rawValue.trim();
  // Satır sonu yorumu yalnızca tırnaksız değerlerde kesilir.
  if (value.charAt(0) !== '"' && value.charAt(0) !== "'") {
    const hash = value.indexOf(' #');
    if (hash >= 0) value = value.slice(0, hash).trimEnd();
  }
  const quote = value.charAt(0);
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : inner;
  }
  return value;
}

/** Değeri `.env` için güvenli biçimde tırnaklar. */
export function quoteValue(value: string): string {
  if (value === '') return '""';
  const needsQuotes =
    /[\s#'"\\]/.test(value) || value !== value.trim() || value.includes('\n') || value.includes('\r');
  if (!needsQuotes) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/**
 * Değerleri mevcut dosya içeriğine işler ve yeni içeriği döner.
 *
 * @returns yeni içerik ve hangi anahtarın güncellendiği/eklendiği bilgisi.
 */
export function upsertEnvValues(
  contents: string,
  values: Record<string, string>,
  options: { sectionTitle?: string } = {},
): { contents: string; updated: string[]; added: string[] } {
  const pending = new Map(Object.entries(values).map(([key, value]) => [key, value]));
  const lines = parseEnvFileLines(contents);
  const updated: string[] = [];
  const eol = contents.includes('\r\n') ? '\r\n' : '\n';

  // Çok satırlı değerler: tırnak içinde devam satırları olabilir. Basit ve
  // güvenli yol, bu satırları tek satıra indirgemektir (quoteValue kaçışlar).
  const rebuilt: EnvFileLine[] = [];
  for (const line of lines) {
    if (line.kind === 'entry' && line.key && pending.has(line.key)) {
      const value = pending.get(line.key) ?? '';
      pending.delete(line.key);
      updated.push(line.key);
      rebuilt.push({ ...line, raw: `${line.key}=${quoteValue(value)}`, value });
      continue;
    }
    rebuilt.push(line);
  }

  let output = rebuilt.map((line) => line.raw).join(eol);
  const added = [...pending.keys()];
  if (added.length > 0) {
    const title = options.sectionTitle ?? 'env:setup ile eklendi';
    const block = [
      '',
      `# --- ${title} (${new Date().toISOString().slice(0, 10)}) ---`,
      ...added.map((key) => `${key}=${quoteValue(pending.get(key) ?? '')}`),
      '',
    ].join(eol);
    output = `${output.replace(/(?:\r?\n)*$/, '')}${eol}${block}`;
  }
  return { contents: output, updated, added };
}

export interface WriteEnvFileResult {
  path: string;
  backupPath: string | null;
  updated: string[];
  added: string[];
  unchanged: string[];
}

/**
 * Değerleri `.env` dosyasına yazar (yedek alarak).
 *
 * Yalnızca GERÇEKTEN değişen anahtarlar yazılır: aynı değeri tekrar yazmak
 * dosyanın gereksiz yere değişmesine ve yedek yığını oluşmasına yol açar.
 */
export function writeEnvFile(
  path: string,
  values: Record<string, string>,
  options: { backup?: boolean; sectionTitle?: string } = {},
): WriteEnvFileResult {
  const backup = options.backup ?? true;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const current = new Map(
    parseEnvFileLines(existing)
      .filter((line): line is EnvFileLine & { key: string; value: string } => line.kind === 'entry' && Boolean(line.key))
      .map((line) => [line.key, line.value]),
  );

  const changed: Record<string, string> = {};
  const unchanged: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (current.get(key) === value) unchanged.push(key);
    else changed[key] = value;
  }

  if (Object.keys(changed).length === 0) {
    return { path, backupPath: null, updated: [], added: [], unchanged };
  }

  let backupPath: string | null = null;
  if (backup && existing.length > 0) {
    backupPath = `${path}.yedek-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backupPath);
  }

  const result = upsertEnvValues(existing, changed, { sectionTitle: options.sectionTitle });
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.gecici`;
  writeFileSync(tmpPath, result.contents, 'utf8');
  // Atomik değiştirme: yazım yarıda kesilirse `.env` bozulmaz.
  renameSync(tmpPath, path);

  return { path, backupPath, updated: result.updated, added: result.added, unchanged };
}
