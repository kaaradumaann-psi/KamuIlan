/**
 * Toplama katmanı hataları.
 *
 * Amaç: "sessizce boş liste dönen" bir tarama, kaynağın bozulduğunu gizler.
 * Bu yüzden ayrı hata türleri tanımlanır; her biri çalıştırma kaydına ve
 * kaynak sağlığına yazılır, operatör panelde görür.
 */

/** Kaynak erişilebilir ama yapı beklenenden farklı (HTML değişmiş olabilir). */
export class AdapterStructureError extends Error {
  readonly sourceKey: string;
  readonly detail: string;

  constructor(sourceKey: string, message: string, detail = '') {
    super(message);
    this.name = 'AdapterStructureError';
    this.sourceKey = sourceKey;
    this.detail = detail;
  }
}

/** Kaynak için gereken yetenek yok/yapılandırma eksik (ör. Playwright kurulu değil). */
export class AdapterUnavailableError extends Error {
  readonly sourceKey: string;
  readonly requirement: string;

  constructor(sourceKey: string, message: string, requirement: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
    this.sourceKey = sourceKey;
    this.requirement = requirement;
  }
}

/** Kaynak erişimi kısıtlı (WAF/geo/oturum). Kısıt aşılmaya çalışılmaz. */
export class SourceAccessError extends Error {
  readonly sourceKey: string;
  readonly httpStatus: number | null;

  constructor(sourceKey: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'SourceAccessError';
    this.sourceKey = sourceKey;
    this.httpStatus = httpStatus;
  }
}

export function isAdapterError(error: unknown): error is AdapterStructureError | AdapterUnavailableError | SourceAccessError {
  return (
    error instanceof AdapterStructureError ||
    error instanceof AdapterUnavailableError ||
    error instanceof SourceAccessError
  );
}
