/**
 * Marka ve uygulama sabitleri.
 * İsim, logo metni ve iletişim adresleri burada tek yerde durur; sonradan
 * değiştirilebilir olması için arayüz/e-posta şablonları bu değerleri okur.
 */
import { getEnv } from './env';

export interface Branding {
  name: string;
  shortName: string;
  tagline: string;
  logoText: string;
  contactEmail: string;
  repositoryUrl: string;
}

export function branding(): Branding {
  return {
    name: getEnv().APP_DISPLAY_NAME,
    shortName: 'KamuRadar',
    tagline: 'Kamu personel alım ilanları — toplanmış, doğrulanmış, tek yerde',
    logoText: 'KR',
    contactEmail: 'destek@kamuradar.example',
    repositoryUrl: 'https://github.com/kaaradumaann-psi/kamuradar',
  };
}

/** Zamanlayıcı ve kota varsayılanları. */
export const RUNTIME_DEFAULTS = {
  /** Kaynak uzun süre başarısız olursa yönetici panelinde uyarı eşiği. */
  sourceFailureWarningThreshold: 3,
  /** Kaynak kaç kez üst üste boş dönerse "yapı değişmiş olabilir" uyarısı üretilir. */
  emptyResultWarningThreshold: 3,
  /** Kuyruk birikimi uyarı eşiği (bekleyen e-posta işi). */
  emailQueueWarningThreshold: 25,
  /** Tarama gecikmesi (planlanan - gerçek) uyarı eşiği (ms). */
  scheduleDelayWarningMs: 15 * 60_000,
  /** Worker heartbeat bayatlık eşiği (ms). */
  workerHeartbeatStaleMs: 5 * 60_000,
  /** E-posta gönderim eşzamanlılığı. */
  emailConcurrency: 2,
  /** Kaynak tarama işçi eşzamanlılığı. */
  scrapeConcurrency: 2,
} as const;

export const CLASSIFICATION_VERSION = 'cls-2026.10.1';
export const EXTRACTION_VERSION = 'ext-2026.10.1';
export const DEDUPE_VERSION = 'dedupe-2026.10.1';
