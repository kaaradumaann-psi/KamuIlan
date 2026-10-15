/**
 * `env:setup` sihirbazı: katalog kapsamı, doğrulama kuralları, `.env` yazımı.
 *
 * Üç katman:
 *  1. Katalog: şemadaki HER anahtar sihirbazda tanımlı mı? (eksik anahtar,
 *     kullanıcının "dolduracak yer bulamadığı" bir ayar demektir)
 *  2. Karar mantığı: hangi alan sorulur, hangi cevap kabul edilir, riskli
 *     karar (TLS doğrulamasını kapatma) ek onay ister mi?
 *  3. Dosya yazımı: yorumlar korunur, yedek alınır, atomik yazılır, sırlar
 *     düz metin basılmaz.
 *
 * Uçtan uca koşum alt süreçle yapılır: sihirbaz `process.env`'i değiştirdiği
 * için aynı süreçte çalıştırılması diğer testleri kirletirdi.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ENV_FIELDS,
  ENV_FIELD_BY_KEY,
  envFieldKeys,
  forbiddenTlsParamsInUrl,
  isValidEmail,
  maskValue,
  outsideSchemaKeys,
  validateFieldValue,
} from '../src/config/env-spec';
import {
  buildChangeSummary,
  buildFieldStatus,
  buildPromptPlan,
  buildValuesToWrite,
  processAnswer,
  riskyDecision,
  unknownKeys,
  type PromptPlanStep,
} from '../src/config/env-prompt';
import { parseEnvFileLines, quoteValue, unquote, upsertEnvValues, writeEnvFile } from '../src/config/env-file';

const REPO_ROOT = join(__dirname, '..');

/** Şema anahtarları (doğrulanmamış ayrıştırma üzerinden; testleri etkilemez). */
function schemaKeys(): string[] {
  const source = readFileSync(join(REPO_ROOT, 'src/config/env.ts'), 'utf8');
  const schema = source.slice(source.indexOf('const envSchema = z.object({'));
  return [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] ?? '');
}

function stepFor(key: string, values: Record<string, string> = {}): PromptPlanStep {
  const field = ENV_FIELD_BY_KEY.get(key);
  if (!field) throw new Error(`katalogda yok: ${key}`);
  return { field, group: field.group, current: values[key] ?? '', required: false, applicable: true };
}

describe('ortam kataloğu şemayı tam kapsar', () => {
  it('şemadaki her anahtar katalogda tanımlı; katalogda hayalet anahtar yok', () => {
    const schema = schemaKeys();
    expect(schema.length).toBeGreaterThan(70);
    const catalog = envFieldKeys();
    const extra = outsideSchemaKeys();
    for (const key of schema) {
      expect(catalog, `şemada var, katalogda yok: ${key}`).toContain(key);
    }
    for (const key of catalog) {
      if (extra.includes(key)) continue;
      expect(schema, `katalogda var, şemada yok: ${key}`).toContain(key);
    }
  });

  it('her alanın grubu, etiketi ve açıklaması var (sihirbaz soruyu ekranda kurabilsin)', () => {
    for (const field of ENV_FIELDS) {
      expect(field.label.length, field.key).toBeGreaterThan(2);
      expect(field.help.length, field.key).toBeGreaterThan(10);
      expect(field.group, field.key).toBeTruthy();
      if (field.type === 'enum') expect(field.options?.length, field.key).toBeGreaterThan(0);
    }
  });

  it('anahtarlar benzersiz', () => {
    const keys = envFieldKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('alan doğrulama kuralları', () => {
  it('POSTGRES_URL içindeki TLS parametresi reddedilir (pg kararı ezer)', () => {
    const field = ENV_FIELD_BY_KEY.get('POSTGRES_URL')!;
    const bad = validateFieldValue(field, 'postgres://u:p@db.example:5432/db?sslmode=disable');
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/TLS parametresi/);
    expect(forbiddenTlsParamsInUrl('postgres://u:p@h/db?sslrootcert=/tmp/ca.pem')).toEqual(['sslrootcert']);

    const good = validateFieldValue(field, 'postgres://u:p@db.example:5432/db');
    expect(good.ok).toBe(true);
    expect(validateFieldValue(field, 'http://db.example').ok).toBe(false);
  });

  it('APP_SECRET kısa değerde uyarır; üretimde boş bırakılamaz', () => {
    const field = ENV_FIELD_BY_KEY.get('APP_SECRET')!;
    expect(validateFieldValue(field, 'kisa', { NODE_ENV: 'development' }).ok).toBe(false);
    expect(validateFieldValue(field, '', { NODE_ENV: 'development' }).ok).toBe(true);
    expect(validateFieldValue(field, '', { NODE_ENV: 'production' }).ok).toBe(false);
    expect(validateFieldValue(field, 'a'.repeat(48), { NODE_ENV: 'production' }).ok).toBe(true);
    // Üretimde kısa değer "tahmin edilebilir" diye ayrıca reddedilir.
    const prodShort = validateFieldValue(field, 'dev-gizli', { NODE_ENV: 'production' });
    expect(prodShort.ok).toBe(false);
    expect(riskyDecision(field, 'dev-gizli')).toMatch(/tahmin edilebilir/);
  });

  it('sayı/enum/e-posta/csv tür denetimleri', () => {
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('PORT')!, '70000').ok).toBe(false);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('PORT')!, '3000').ok).toBe(true);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('PORT')!, 'abc').ok).toBe(false);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('NODE_ENV')!, 'staging').ok).toBe(false);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('NODE_ENV')!, 'production').ok).toBe(true);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('ADMIN_EMAIL')!, 'yonetici@ornek.com').ok).toBe(true);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('ADMIN_EMAIL')!, 'yonetici').ok).toBe(false);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('CORS_ORIGINS')!, 'a,b').ok).toBe(true);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('CORS_ORIGINS')!, ' , ').ok).toBe(false);
  });

  it('EMAIL_FROM "Görünen Ad <adres>" biçimini kabul eder', () => {
    expect(isValidEmail('Kamuİlan <bildirim@example.com>')).toBe(true);
    expect(isValidEmail('bildirim@example.com')).toBe(true);
    expect(isValidEmail('bildirim@')).toBe(false);
    expect(validateFieldValue(ENV_FIELD_BY_KEY.get('EMAIL_FROM')!, 'Kamuİlan <bildirim@example.com>').ok).toBe(true);
  });

  it('Telegram bağımlılığı: jeton yoksa kullanıcı adı sorulmaz', () => {
    const plan = buildPromptPlan({ NODE_ENV: 'development', TELEGRAM_BOT_TOKEN: '' }, { scope: 'all' });
    expect(plan.steps.map((step) => step.field.key)).not.toContain('TELEGRAM_BOT_USERNAME');
    expect(plan.skipped.map((step) => step.field.key)).toContain('TELEGRAM_BOT_USERNAME');

    const withToken = buildPromptPlan({ NODE_ENV: 'development', TELEGRAM_BOT_TOKEN: '123:abc' }, { scope: 'all' });
    expect(withToken.steps.map((step) => step.field.key)).toContain('TELEGRAM_BOT_USERNAME');
  });

  it('sırlar maskelenir; düz metin sızmaz', () => {
    const field = ENV_FIELD_BY_KEY.get('LLM_API_KEY')!;
    const masked = maskValue(field, 'super-secret-key-value');
    expect(masked).not.toContain('super-secret-key-value');
    expect(masked).toMatch(/•/);
    expect(maskValue(ENV_FIELD_BY_KEY.get('LLM_MODEL')!, 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});

describe('sihirbaz planı ve cevap işleme', () => {
  it('varsayılan kapsam yalnızca zorunlu/geçersiz alanları sorar', () => {
    const plan = buildPromptPlan({ NODE_ENV: 'development', DATABASE_DRIVER: 'supabase' }, {});
    const keys = plan.steps.map((step) => step.field.key);
    expect(keys).toContain('POSTGRES_URL'); // zorunlu + boş
    expect(keys).not.toContain('REDIS_URL'); // isteğe bağlı + boş → sorulmaz
    expect(keys).not.toContain('LLM_API_KEY'); // LLM kapalı → bağımlılık sağlanmıyor
  });

  it('--all kapsamında bağımlılığı sağlanan LLM alanları sorulur', () => {
    const plan = buildPromptPlan(
      { NODE_ENV: 'development', DATABASE_DRIVER: 'file', LLM_CLASSIFIER_ENABLED: '1' },
      { scope: 'all' },
    );
    const keys = plan.steps.map((step) => step.field.key);
    expect(keys).toContain('LLM_API_KEY');
    expect(keys).toContain('LLM_BASE_URL');
    expect(keys).not.toContain('POSTGRES_URL'); // DATABASE_DRIVER=file
  });

  it('--only ve --group süzgeçleri', () => {
    const only = buildPromptPlan({ NODE_ENV: 'development' }, { scope: 'all', only: ['PORT'] });
    expect(only.steps.map((step) => step.field.key)).toEqual(['PORT']);
    const grouped = buildPromptPlan({ NODE_ENV: 'development' }, { scope: 'all', groups: ['eposta'] });
    expect(grouped.steps.every((step) => step.group === 'eposta')).toBe(true);
    expect(grouped.groups.map((group) => group.group)).toEqual(['eposta']);
    expect(unknownKeys(['LLM_MODEL', 'OLMAYAN_ANAHTAR'])).toEqual(['OLMAYAN_ANAHTAR']);
  });

  it('geçersiz mevcut değer yeniden sorulur', () => {
    const plan = buildPromptPlan({ NODE_ENV: 'development', PORT: '999999' }, {});
    expect(plan.steps.map((step) => step.field.key)).toContain('PORT');
  });

  it('boş cevap mevcut değeri korur; varsayılanı olan alanda varsayılan yazılır', () => {
    const keep = processAnswer(stepFor('LLM_MODEL', { LLM_MODEL: 'gemini-2.5-flash' }), '', {});
    expect(keep).toMatchObject({ ok: true, skipped: true, value: 'gemini-2.5-flash' });

    // Varsayılanı olmayan alan boş Enter ile boş kalır (kullanıcı karar verir).
    const noDefault = processAnswer(stepFor('LLM_MODEL'), '', {});
    expect(noDefault).toMatchObject({ ok: true, skipped: true, value: '' });
    // Varsayılanı olan alan boş Enter ile varsayılana döner.
    const useDefault = processAnswer(stepFor('PORT'), '', {});
    expect(useDefault).toMatchObject({ ok: true, skipped: false, value: '3000' });

    // Zorunluluk bağlama bağlı: POSTGRES_URL yalnızca postgres/Supabase sürücüsünde zorunlu.
    const supabaseContext = { DATABASE_DRIVER: 'supabase' };
    expect(processAnswer(stepFor('POSTGRES_URL'), '', supabaseContext).ok).toBe(false);
    expect(processAnswer(stepFor('POSTGRES_URL'), '', { DATABASE_DRIVER: 'file' })).toMatchObject({ ok: true, skipped: true });
    // :clear de aynı kurala bağlıdır: zorunlu alan boşaltılamaz.
    expect(processAnswer(stepFor('POSTGRES_URL'), ':clear', supabaseContext).ok).toBe(false);
  });

  it(':skip / :clear / :help / :quit komutları', () => {
    expect(processAnswer(stepFor('LLM_MODEL', { LLM_MODEL: 'x' }), ':skip', {})).toMatchObject({ skipped: true, value: 'x' });
    expect(processAnswer(stepFor('LLM_MODEL', { LLM_MODEL: 'x' }), ':clear', {})).toMatchObject({ value: '', ok: true });
    expect(processAnswer(stepFor('LLM_MODEL'), ':help', {}).message).toMatch(/gemini/i);
    const quit = processAnswer(stepFor('LLM_MODEL'), ':quit', {});
    expect(quit.skipped).toBe(true);
    // Zorunlu alan boşaltılamaz.
    const requiredStep: PromptPlanStep = { ...stepFor('POSTGRES_URL'), required: true };
    expect(processAnswer(requiredStep, ':clear', {}).ok).toBe(false);
  });

  it('TLS doğrulamasını kapatmak AÇIK onay ister (! öneki)', () => {
    const step = stepFor('POSTGRES_SSL_MODE');
    const first = processAnswer(step, 'no-verify', {});
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/KAPATIR/);
    expect(first.message).toMatch(/!no-verify/);

    const confirmed = processAnswer(step, '!no-verify', {});
    expect(confirmed).toMatchObject({ ok: true, value: 'no-verify' });
    expect(riskyDecision(step.field, 'verify')).toBeNull();
    expect(riskyDecision(ENV_FIELD_BY_KEY.get('APP_SECRET')!, 'kisa')).toMatch(/32 karakter/);
    expect(processAnswer(step, 'verify', {}).ok).toBe(true);
  });

  it('geçersiz değer kabul edilmez ve mevcut değer korunur', () => {
    const step = stepFor('PORT', { PORT: '3000' });
    const result = processAnswer(step, 'abc', {});
    expect(result.ok).toBe(false);
    expect(result.value).toBe('3000');
  });

  it('yazılacak küme yalnızca DEĞİŞEN anahtarları içerir; özet maskelidir', () => {
    const initial = { LLM_MODEL: 'eski', APP_SECRET: 'a'.repeat(40) };
    const collected = { LLM_MODEL: 'yeni', APP_SECRET: 'a'.repeat(40), LLM_API_KEY: 'gizli-anahtar-degeri' };
    expect(buildValuesToWrite(collected, initial)).toEqual({ LLM_MODEL: 'yeni', LLM_API_KEY: 'gizli-anahtar-degeri' });
    const summary = buildChangeSummary(collected, initial);
    expect(summary.unchanged).toContain('APP_SECRET');
    expect(summary.changed.join('\n')).not.toContain('gizli-anahtar-degeri');
    expect(summary.changed.join('\n')).toMatch(/LLM_API_KEY/);
  });

  it('durum raporu sorunları listeler', () => {
    const status = buildFieldStatus({ NODE_ENV: 'development', DATABASE_DRIVER: 'supabase', POSTGRES_URL: '' });
    expect(status.problems.join('\n')).toMatch(/POSTGRES_URL/);
    expect(status.groups.length).toBeGreaterThan(1);
    expect(status.groups.flatMap((group) => group.rows).join('\n')).not.toContain('undefined');
  });
});

describe('.env dosyası yazımı', () => {
  it('yorumlar ve bilinmeyen satırlar korunur; anahtar yerinde güncellenir', () => {
    const original = [
      '# Kamuİlan ortam dosyası',
      '',
      'NODE_ENV=development',
      '# LLM sağlayıcısı',
      'LLM_MODEL=eski-model',
      'BOZUK SATIR',
      'LLM_API_KEY=',
    ].join('\n');
    const result = upsertEnvValues(original, { LLM_MODEL: 'yeni-model', LLM_API_KEY: 'gizli' });
    expect(result.updated).toEqual(['LLM_MODEL', 'LLM_API_KEY']);
    expect(result.added).toEqual([]);
    expect(result.contents).toContain('# Kamuİlan ortam dosyası');
    expect(result.contents).toContain('# LLM sağlayıcısı');
    expect(result.contents).toContain('BOZUK SATIR');
    expect(result.contents).toContain('LLM_MODEL=yeni-model');
    expect(result.contents).toContain('LLM_API_KEY=gizli');
    expect(result.contents).not.toContain('eski-model');
  });

  it('olmayan anahtar dosya sonuna başlıklı bölümde eklenir', () => {
    const result = upsertEnvValues('NODE_ENV=development\n', { YENI_ANAHTAR: 'deger' }, { sectionTitle: 'test' });
    expect(result.added).toEqual(['YENI_ANAHTAR']);
    expect(result.contents).toContain('# --- test (');
    expect(result.contents).toContain('YENI_ANAHTAR=deger');
  });

  it('özel karakterli değerler tırnaklanır; çok satırlı PEM kaçırılır', () => {
    expect(quoteValue('basit')).toBe('basit');
    expect(quoteValue('')).toBe('""');
    expect(quoteValue('ad soyad')).toBe('"ad soyad"');
    expect(quoteValue('deger # yorum')).toBe('"deger # yorum"');
    const pem = '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----';
    const quoted = quoteValue(pem);
    expect(quoted.startsWith('"')).toBe(true);
    expect(unquote(quoted)).toBe(pem);
  });

  it('parseEnvFileLines satır türlerini ayırır', () => {
    const lines = parseEnvFileLines('# yorum\n\nKEY=value\nbozuk\n');
    // Sondaki satır sonu boş bir satır daha üretir (dosya sonu korunur).
    expect(lines.map((line) => line.kind)).toEqual(['comment', 'blank', 'entry', 'unknown', 'blank']);
    expect(lines[2]).toMatchObject({ kind: 'entry', key: 'KEY', value: 'value' });
  });

  it('writeEnvFile: değişiklik yoksa yazmaz; değişiklik varsa yedek alır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kamuilan-envfile-'));
    const path = join(dir, '.env');
    writeFileSync(path, '# yorum\nLLM_MODEL=gemini-2.5-flash\n', 'utf8');

    const noChange = writeEnvFile(path, { LLM_MODEL: 'gemini-2.5-flash' });
    expect(noChange.updated).toEqual([]);
    expect(noChange.added).toEqual([]);
    expect(noChange.unchanged).toEqual(['LLM_MODEL']);
    expect(noChange.backupPath).toBeNull();
    expect(readdirSync(dir)).toEqual(['.env']);

    const changed = writeEnvFile(path, { LLM_MODEL: 'yeni', LLM_API_KEY: 'gizli' });
    expect(changed.updated).toEqual(['LLM_MODEL']);
    expect(changed.added).toEqual(['LLM_API_KEY']);
    expect(changed.backupPath).not.toBeNull();
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('# yorum');
    expect(written).toContain('LLM_MODEL=yeni');
    expect(written).toContain('LLM_API_KEY=gizli');
    expect(readFileSync(changed.backupPath!, 'utf8')).toContain('LLM_MODEL=gemini-2.5-flash');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('uçtan uca: sihirbaz alt süreçle çalıştırılır', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-env-setup-'));
  const envPath = join(dir, '.env');
  const answersPath = join(dir, 'answers.txt');
  const APP_SECRET_40 = 'a'.repeat(40);

  beforeAll(() => {
    writeFileSync(
      envPath,
      [
        '# Kamuİlan ortam dosyası (yorumlar korunmalı)',
        'NODE_ENV=development',
        '# Veritabanı',
        'DATABASE_DRIVER=file',
        'POSTGRES_URL=',
        `APP_SECRET=${APP_SECRET_40}`,
        'LLM_CLASSIFIER_ENABLED=0',
        'BOZUK SATIR',
      ].join('\n'),
      'utf8',
    );
    // Cevap dosyası: yorum satırları desteklenir (dotenv biçimi).
    writeFileSync(
      answersPath,
      [
        '# sihirbaza toplu cevap',
        'DATABASE_DRIVER=supabase',
        'POSTGRES_URL=postgres://postgres.ref:gizli-parola@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
        'POSTGRES_SSL_MODE=verify',
        `APP_SECRET=${'b'.repeat(48)}`,
        'LLM_CLASSIFIER_ENABLED=1',
        'LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai',
        'LLM_API_KEY=cevaptan-gelen-anahtar',
        'LLM_MODEL=gemini-2.5-flash',
      ].join('\n'),
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Alt süreç ortamı: vitest'in `tests/setup.ts` ile verdiği değerler
   * (APP_SECRET, DATA_DIR, SOURCE_LIVE_FETCH) sihirbazın kararını
   * gölgelemesin diye silinir; NODE_ENV geliştirme olarak zorlanır.
   */
  function sanitizedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', NO_COLOR: '1' };
    for (const key of ['APP_SECRET', 'DATA_DIR', 'SOURCE_LIVE_FETCH', 'KAMUILAN_TEST_DATA_DIR']) delete env[key];
    return env;
  }

  function runWizard(args: string[]): { output: string; status: number } {
    try {
      const stdout = execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), join(REPO_ROOT, 'scripts/env-setup.ts'), ...args],
        {
          cwd: dir,
          encoding: 'utf8',
          env: sanitizedEnv(),
          timeout: 120_000,
        },
      );
      return { output: stdout, status: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number };
      return { output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, status: failure.status ?? 1 };
    }
  }

  it('--check tüm ayarları grup grup raporlar ve dosyaya yazmaz', () => {
    const before = readFileSync(envPath, 'utf8');
    const run = runWizard(['--file', '.env', '--check']);
    expect(run.output).toContain('Kamuİlan ortam kurulum sihirbazı');
    expect(run.output).toContain('LLM / yapay zekâ');
    expect(run.output).toMatch(/DATABASE_DRIVER\s+file\s+tamam/);
    // Sır maskelenir, dosya içeriği değişmez, yedek alınmaz.
    expect(run.output).toContain(APP_SECRET_40.slice(0, 3) + '•');
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(readdirSync(dir).some((name) => name.startsWith('.env.yedek-'))).toBe(false);
  });

  it('--check eksik zorunlu alanı adıyla söyler ve başarısız çıkar', () => {
    const broken = join(dir, '.env.broken');
    writeFileSync(broken, 'NODE_ENV=development\nDATABASE_DRIVER=supabase\nPOSTGRES_URL=\n', 'utf8');
    const run = runWizard(['--file', '.env.broken', '--check']);
    expect(run.output).toMatch(/POSTGRES_URL: zorunlu ama boş/);
    expect(run.output).toMatch(/Eksik zorunlu alanlar: POSTGRES_URL/);
    expect(run.status).not.toBe(0);
    expect(existsSync(`${broken}.yedek`)).toBe(false);
  });

  it('--answers değerleri dosyaya yazar; yorumlar korunur; yedek alınır', () => {
    const run = runWizard(['--file', '.env', '--answers', 'answers.txt', '--yes']);
    expect(run.output).toContain('Yazıldı');
    expect(run.status).toBe(0);

    const written = readFileSync(envPath, 'utf8');
    expect(written).toContain('# Kamuİlan ortam dosyası (yorumlar korunmalı)');
    expect(written).toContain('# Veritabanı');
    expect(written).toContain('BOZUK SATIR');
    expect(written).toContain('DATABASE_DRIVER=supabase');
    expect(written).toContain('POSTGRES_SSL_MODE=verify');
    expect(written).toContain('LLM_MODEL=gemini-2.5-flash');
    expect(written).toContain(`APP_SECRET=${'b'.repeat(48)}`);
    // Sırlar dosyada düz metin durur (.env budur) ama EKRANDA maskelenir.
    expect(run.output).not.toContain('cevaptan-gelen-anahtar');
    expect(run.output).not.toContain('gizli-parola');
    expect(run.output).toMatch(/•/);
    expect(readdirSync(dir).some((name) => name.startsWith('.env.yedek-'))).toBe(true);
  });

  it('aynı cevaplar ikinci kez verilirse dosya değişmez (gereksiz yedek yok)', () => {
    const before = readFileSync(envPath, 'utf8');
    const backupsBefore = readdirSync(dir).filter((name) => name.startsWith('.env.yedek-')).length;
    const run = runWizard(['--file', '.env', '--answers', 'answers.txt', '--yes']);
    expect(run.status).toBe(0);
    expect(run.output).toContain('Dosyada değişiklik gerekmedi');
    expect(readFileSync(envPath, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((name) => name.startsWith('.env.yedek-')).length).toBe(backupsBefore);
  });

  it('geçersiz --set değeri reddedilir ve dosyaya yazılmaz', () => {
    const before = readFileSync(envPath, 'utf8');
    const run = runWizard(['--file', '.env', '--set', 'PORT=99999', '--yes']);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/en çok 65535/);
    expect(readFileSync(envPath, 'utf8')).toBe(before);
  });

  it('bilinmeyen anahtar erken reddedilir', () => {
    const run = runWizard(['--file', '.env', '--set', 'OLMAYAN_ANAHTAR=1']);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/Bilinmeyen anahtar/);
  });

  it('bağlantı dizesine TLS parametresi yazılmaya çalışılınca reddedilir', () => {
    const run = runWizard([
      '--file',
      '.env',
      '--set',
      'POSTGRES_URL=postgres://u:p@db.example:5432/db?sslmode=disable',
      '--yes',
    ]);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/TLS parametresi/);
  });

  it('var olmayan CA dosyası yolu reddedilir (doğrulama gevşetilmez)', () => {
    const before = readFileSync(envPath, 'utf8');
    const run = runWizard(['--file', '.env', '--set', 'NODE_EXTRA_CA_CERTS=./certs/yok.pem', '--yes']);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/bulunamadı|yok/i);
    expect(readFileSync(envPath, 'utf8')).toBe(before);
  });

  it('TLS doğrulamasını kapatan değer ! öneki olmadan yazılmaz', () => {
    const before = readFileSync(envPath, 'utf8');
    const run = runWizard(['--file', '.env', '--set', 'POSTGRES_SSL_MODE=no-verify', '--yes']);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/KAPATIR/);
    expect(readFileSync(envPath, 'utf8')).toBe(before);
  });

  it('yazımdan sonra denetim hedef dosyaya göre çalışır ve özet maskelidir', () => {
    const run = runWizard(['--file', '.env', '--answers', 'answers.txt', '--yes']);
    expect(run.output).toContain('Dosyada değişiklik gerekmedi');
    expect(run.output).toContain('Ortam özeti (gizli değer yok)');
    expect(run.output).toMatch(/dbTls\s*:\s*verify/);
    expect(run.output).toMatch(/database\s*:\s*supabase\/postgres/);
    expect(existsSync(envPath)).toBe(true);
  });
});
