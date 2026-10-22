/**
 * Yapılandırılmış log (pino).
 *
 * Kişisel veri kuralı: e-posta adresi düz metin loglanmaz. Loglarda
 * `maskEmail()` kullanılır; pino redact ayarı da yanlışlıkla eklenen alanları
 * temizler.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getEnv } from '../config/env';
import { rotatingFileStream } from './rotating-file';

const REDACT_PATHS = [
  'email',
  'toEmail',
  'emailNormalized',
  'password',
  'passwordHash',
  'passwordSalt',
  'token',
  'tokenHash',
  'csrfToken',
  '*.email',
  '*.toEmail',
  '*.password',
  '*.passwordHash',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
  'headers["set-cookie"]',
  'headers["x-api-key"]',
  'headers["x-goog-api-key"]',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'botToken',
  'connectionString',
  'session',
  'sessionToken',
];

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const env = getEnv();
  // `.env`'deki `LOG_LEVEL=` boş metin olarak gelir; `??` onu varsayılana düşürmez ve pino
  // açılışta çöker ("default level: must be included"). Boş = tanımsız (bkz. withoutBlankValues).
  const level = options.level ?? (process.env.LOG_LEVEL?.trim() || env.LOG_LEVEL);
  const config: LoggerOptions = {
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[gizlendi]' },
    base: { app: env.APP_DISPLAY_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  };
  // Kalıcı log: LOG_FILE verilirse aynı JSON satırları döndürülen dosyaya da yazılır
  // (maskeleme dosyaya da uygulanır; pino satırı akışlara bölmeden önce temizler).
  if (!env.LOG_FILE || level === 'silent') return pino(config);
  const file = rotatingFileStream(env.LOG_FILE, {
    maxBytes: env.LOG_FILE_MAX_MB * 1024 * 1024,
    maxFiles: env.LOG_FILE_MAX_FILES,
  });
  return pino(
    config,
    pino.multistream([
      { level: level as pino.Level, stream: process.stdout },
      { level: level as pino.Level, stream: file },
    ]),
  );
}

export type { Logger };
