/**
 * `.env` yükleyici (bağımlılıksız).
 *
 * README ve `docs/setup.md` kurulumun ilk adımı olarak `cp .env.example .env`
 * der; bu yüzden `.env` dosyasının GERÇEKTEN okunması gerekir. Node'un
 * `--env-file` bayrağı yalnızca komut satırından verildiğinde çalıştığı ve
 * (`npm start`, `npm run start:worker`, `vite`, tüm `scripts/*`) giriş
 * noktalarının hepsine tek tek eklenmesi kırılgan olduğu için yükleme burada,
 * kod içinde yapılır.
 *
 * Kurallar:
 *  - **Var olan ortam değişkeni ezilmez.** Gerçek ortam (CI, Docker, systemd,
 *    Cloudflare) her zaman `.env` dosyasından önceliklidir.
 *  - Dosya yoksa sessizce devam edilir (`.env` isteğe bağlıdır).
 *  - Testte (`NODE_ENV=test`) yüklenmez: testler ortamı kendileri kurar
 *    (`tests/setup.ts`) ve geliştirici makinesindeki `.env` sonuçları
 *    değiştirmemelidir.
 *  - Sırlar hiçbir yere yazdırılmaz.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Yüklenen dosyanın yolu (tanılama için; içerik değil). */
let loadedFrom: string | null = null;
let attempted = false;

/** `.env` dosyasının aranacağı varsayılan ad. */
const ENV_FILE = '.env';

/**
 * `.env` içeriğini ayrıştırır.
 *
 * Desteklenen biçimler: `KEY=value`, `export KEY=value`, `# yorum`,
 * `KEY="çoklu satır\ndeğer"`, `KEY='tek tırnak'` ve satır sonu yorumları.
 * Geçersiz satırlar sessizce atlanır (yarı bozuk bir dosya uygulamayı
 * başlatılamaz hâle getirmemelidir).
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] ?? '';
    // Tırnak içinde kalan (kapanmamış) bir değer sonraki satırlarda devam eder;
    // böylece sertifikalar ve çok satırlı notlar tek anahtarda taşınabilir.
    while (hasUnterminatedQuote(line) && index + 1 < lines.length) {
      index += 1;
      line += `\n${lines[index] ?? ''}`;
    }
    const parsed = parseLine(line);
    if (parsed) values[parsed.key] = parsed.value;
  }
  return values;
}

/** Değerin açılmış ama kapatılmamış bir tırnağı var mı? */
function hasUnterminatedQuote(line: string): boolean {
  const quoteIndex = line.indexOf('="');
  if (quoteIndex < 0) return false;
  const value = line.slice(quoteIndex + 2);
  return value.split('"').length % 2 === 1;
}

/**
 * Ayrıştırılan değerleri `process.env` içine yazar.
 *
 * @param override `true` ise var olan değerlerin ÜZERİNE yazar.
 * @param overrideKeys `override` kapalıyken bile üzerine yazılmasına izin verilen
 *   anahtarlar; özel `.env.<NODE_ENV>` dosyası yalnızca temel `.env` dosyasından
 *   gelen anahtarları bu yolla ezer, gerçek ortam değerlerine dokunmaz.
 * @returns Yazılan anahtarlar.
 */
export function applyEnvValues(
  values: Record<string, string>,
  {
    override = false,
    overrideKeys = new Set<string>(),
  }: { override?: boolean; overrideKeys?: ReadonlySet<string> } = {},
): string[] {
  const written: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!override && process.env[key] !== undefined && !overrideKeys.has(key)) continue;
    process.env[key] = value;
    written.push(key);
  }
  return written;
}

/** `KEY=value` satırını ayrıştırır; yorum/boş satır için `null` döner. */
function parseLine(rawLine: string): { key: string; value: string } | null {
  let line = rawLine.trim();
  if (line.length === 0 || line.startsWith('#')) return null;
  if (line.startsWith('export ')) line = line.slice('export '.length).trim();

  const separator = line.indexOf('=');
  if (separator <= 0) return null;

  const key = line.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = line.slice(separator + 1).trim();

  // Satır sonu yorumu (yalnızca tırnaksız değerlerde güvenlidir).
  if (value.charAt(0) !== '"' && value.charAt(0) !== "'") {
    const hash = value.indexOf(' #');
    if (hash >= 0) value = value.slice(0, hash).trimEnd();
  }

  const quote = value.charAt(0);
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    value = quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : inner;
  }

  return { key, value };
}

/**
 * `.env` (ve varsa `.env.<NODE_ENV>`) dosyalarını okuyup `process.env` içine
 * yazar. Süreç başına bir kez çalışır.
 *
 * @param cwd Arama kökü (varsayılan: sürecin çalışma dizini).
 * @returns Yüklenen son dosyanın yolu ya da `null`.
 */
export function loadEnvFile(cwd: string = process.cwd()): string | null {
  if (attempted) return loadedFrom;
  attempted = true;

  // Test ortamında geliştirici `.env` dosyası sonuçları etkilememelidir.
  if (process.env.NODE_ENV === 'test') return null;

  const nodeEnv = process.env.NODE_ENV?.trim() ?? '';
  // İkinci dosya (`.env.development` / `.env.production`) daha özeldir:
  // `.env` içindeki aynı anahtarı ezer, ama gerçek ortam değişkenlerini ezmez.
  const candidates: { path: string; override: boolean }[] = [
    { path: resolve(cwd, ENV_FILE), override: false },
  ];
  if (nodeEnv.length > 0) {
    candidates.push({ path: resolve(cwd, `${ENV_FILE}.${nodeEnv}`), override: true });
  }

  const keysWrittenByBaseFile = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    let contents: string;
    try {
      contents = readFileSync(candidate.path, 'utf8');
    } catch {
      continue;
    }
    const values = parseEnvFile(contents);
    const written = candidate.override
      ? applyEnvValues(values, { overrideKeys: keysWrittenByBaseFile })
      : applyEnvValues(values);
    if (!candidate.override) {
      for (const key of written) keysWrittenByBaseFile.add(key);
    }
    loadedFrom = candidate.path;
  }
  return loadedFrom;
}

/** Tanılama: `.env` yüklendiyse dosya yolunu döndürür (içeriği değil). */
export function envFileSource(): string | null {
  return loadedFrom;
}

/** Yalnızca testler için: yükleme bayrağını ve kaydı sıfırlar. */
export function resetEnvFileState(): void {
  attempted = false;
  loadedFrom = null;
}
