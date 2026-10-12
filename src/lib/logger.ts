/**
 * Yapılandırılmış log (pino).
 *
 * Kişisel veri kuralı: e-posta adresi düz metin loglanmaz. Loglarda
 * `maskEmail()` kullanılır; pino redact ayarı da yanlışlıkla eklenen alanları
 * temizler.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getEnv } from '../config/env';

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
];

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const env = getEnv();
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[gizlendi]' },
    base: { app: env.APP_DISPLAY_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  });
}

export type { Logger };
