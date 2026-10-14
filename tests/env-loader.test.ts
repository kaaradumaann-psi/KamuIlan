/**
 * `.env` yükleyici testleri.
 *
 * Kurulum belgelerinin ilk adımı `cp .env.example .env`'dir; bu dosya o adımın
 * gerçekten işe yaradığını (dosyanın okunduğunu, ortam değişkenlerinin
 * ezilmediğini ve sırların sızmadığını) kanıtlar. Ağ erişimi yoktur.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyEnvValues,
  envFileSource,
  loadEnvFile,
  parseEnvFile,
  resetEnvFileState,
} from '../src/config/load-env';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kamuilan-env-'));
}

describe('.env ayrıştırma', () => {
  it('temel satırları, yorumları ve boş satırları okur', () => {
    const values = parseEnvFile(
      ['# yorum satırı', '', '  ', 'APP_SECRET=uzun-bir-anahtar', 'PORT=3000', 'EMPTY='].join('\n'),
    );
    expect(values).toEqual({ APP_SECRET: 'uzun-bir-anahtar', PORT: '3000', EMPTY: '' });
  });

  it('export önekini ve tırnakları işler', () => {
    const values = parseEnvFile(
      [
        'export EMAIL_FROM="Kamuİlan <bildirim@example.com>"',
        "LOG_LEVEL='info'",
        'MULTILINE="birinci\nikinci"',
      ].join('\n'),
    );
    expect(values.EMAIL_FROM).toBe('Kamuİlan <bildirim@example.com>');
    expect(values.LOG_LEVEL).toBe('info');
    expect(values.MULTILINE).toBe('birinci\nikinci');
  });

  it('tırnaksız değerlerde satır sonu yorumunu ayıklar', () => {
    const values = parseEnvFile('PORT=3000 # API portu\nTIRNAKLI="3000 # değil"');
    expect(values.PORT).toBe('3000');
    expect(values.TIRNAKLI).toBe('3000 # değil');
  });

  it('geçersiz anahtarları ve eşittirsiz satırları atlar', () => {
    const values = parseEnvFile('1BADKEY=deger\nbroken-line\n=deger\nGOOD_KEY=deger\n# yorum\n  ');
    expect(values).toEqual({ GOOD_KEY: 'deger' });
  });
});

describe('ortam değişkenlerine uygulama', () => {
  const KEY = 'KAMUILAN_ENV_TEST_KEY';

  beforeEach(() => {
    delete process.env[KEY];
  });

  afterEach(() => {
    delete process.env[KEY];
  });

  it('varsayılan olarak var olan ortam değişkenini ezmez', () => {
    process.env[KEY] = 'ortamdan';
    const written = applyEnvValues({ [KEY]: 'dosyadan' });
    expect(process.env[KEY]).toBe('ortamdan');
    expect(written).toEqual([]);
  });

  it('override ile dosya değeri uygulanır', () => {
    process.env[KEY] = 'ortamdan';
    applyEnvValues({ [KEY]: 'dosyadan' }, { override: true });
    expect(process.env[KEY]).toBe('dosyadan');
  });
});

describe('.env dosyası yükleme', () => {
  const KEY = 'KAMUILAN_ENV_FILE_KEY';
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env[KEY];
    resetEnvFileState();
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    delete process.env[KEY];
    resetEnvFileState();
  });

  it('çalışma dizinindeki .env dosyasını okur', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), `${KEY}=dosyadan-geldi\n`);
    process.env.NODE_ENV = 'development';

    expect(loadEnvFile(dir)).toBe(join(dir, '.env'));
    expect(process.env[KEY]).toBe('dosyadan-geldi');
    expect(envFileSource()).toBe(join(dir, '.env'));
  });

  it('gerçek ortam değişkeni .env değerinden önceliklidir', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), `${KEY}=dosyadan\n`);
    process.env[KEY] = 'ortamdan';
    process.env.NODE_ENV = 'development';

    loadEnvFile(dir);
    expect(process.env[KEY]).toBe('ortamdan');
  });

  it('.env.<NODE_ENV> dosyası .env üzerine yazar', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), `${KEY}=temel\n`);
    writeFileSync(join(dir, '.env.development'), `${KEY}=gelistirme\n`);
    process.env.NODE_ENV = 'development';

    loadEnvFile(dir);
    expect(process.env[KEY]).toBe('gelistirme');
    expect(envFileSource()).toBe(join(dir, '.env.development'));
  });

  it('.env.<NODE_ENV> dosyası gerçek ortam değerini ezmez', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), `${KEY}=temel\n`);
    writeFileSync(join(dir, '.env.development'), `${KEY}=gelistirme\n`);
    process.env[KEY] = 'ortamdan';
    process.env.NODE_ENV = 'development';

    loadEnvFile(dir);
    expect(process.env[KEY]).toBe('ortamdan');
  });

  it('dosya yoksa sessizce devam eder', () => {
    const dir = tempDir();
    process.env.NODE_ENV = 'development';
    expect(loadEnvFile(dir)).toBeNull();
    expect(process.env[KEY]).toBeUndefined();
  });

  it('test ortamında .env yüklenmez', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), `${KEY}=dosyadan\n`);
    process.env.NODE_ENV = 'test';

    expect(loadEnvFile(dir)).toBeNull();
    expect(process.env[KEY]).toBeUndefined();
  });
});
