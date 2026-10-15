/**
 * Adaptör sözleşmesi.
 *
 * Her adaptör yalnızca KENDİ kaynağının listesini bilir ve `RawAnnouncement`
 * üretir. Sınıflandırma/tekilleştirme/kayıt işini hat (pipeline) yapar; adaptör
 * karar vermez. Bu ayrım yeni kaynak eklemeyi tek dosyaya indirir.
 */
import type { RawAnnouncement } from '../domain';
import type { SourceDefinition } from '../config/sources';
import type { Logger } from '../lib/logger';
import type { FetchResponse, HttpClient } from './fetcher';

export interface AdapterContext {
  /** Kaynak kaydı (DB'den; yönetici alanları buradan okunur). */
  source: SourceDefinition;
  /** HTTP istemcisi: hız sınırı, boyut sınırı, yeniden deneme, allowlist dahil. */
  http: HttpClient;
  logger: Logger;
  /** Canlı erişim kapalıysa adaptör yalnızca doğrulama yapar ve boş liste döner. */
  liveFetch: boolean;
  /** Tarama zaman aşımı/iptalinde HTTP ve browser işlemlerini durdurur. */
  signal?: AbortSignal;
  /**
   * Tarama bütçesinin SON ANI (pipeline `SCRAPE_TIMEOUT_MS`'ten pay düşerek verir).
   *
   * Adaptör pahalı bir indirmeye başlamadan önce `hasBudgetFor(ctx, …)` ile
   * bakar; bütçe yetmiyorsa durup KISMİ sonuç + kapsam notu döndürür. Böylece
   * tek yavaş belge tüm koşumu düşürmez (bkz. `src/sources/scan-budget.ts`).
   * Tanımsızsa süre sınırı uygulanmaz.
   */
  deadlineAt?: Date | null;
  fetchedAt: Date;
  /** Kaynak içi ilerleme: daha önce gördüğümüz kayıt kimlikleri (idempotency için). */
  knownItemIds?: ReadonlySet<string>;
  /** Daha önce tam detay metni yakalanmış kayıtlar; eksik detaylar yeniden denenir. */
  knownItemIdsWithDetail?: ReadonlySet<string>;
  /** Adapter'ın indirebileceği ek belge sayısı üst sınırı. */
  maxDetailFetches: number;
}

export interface AdapterRunResult {
  items: RawAnnouncement[];
  /** Kaç HTTP isteği yapıldı (kaynak sağlığı ve hız denetimi için). */
  requestCount: number;
  /** Kaynak sayfası özeti (log/panel). */
  notes: string[];
  /** ETag/Last-Modified (sonraki taramada koşullu istek için). */
  etag: string | null;
  lastModified: string | null;
  /** İçerik değişmediyse true (304). */
  notModified: boolean;
  /** Kapsam bu çalışmada gerçekten kanıtlandı mı? "unknown" is not "complete". */
  coverage?: { status: 'complete' | 'partial' | 'unknown'; note: string };
  /** Görülen HTTP durum kodları (opsiyonel; tarama kaydında gösterilir). */
  httpStatuses?: number[];
}

export interface SourceAdapter {
  /** registry'deki anahtar; SourceDefinition.adapterKey ile eşleşir. */
  readonly key: string;
  readonly label: string;
  /** Bu adaptörün yöntemi (panelde gösterilir). */
  readonly method: string;
  /** İnsan okur not: kaynak neden bu yöntemle toplanıyor? */
  readonly notes: string;
  run(ctx: AdapterContext): Promise<AdapterRunResult>;
}

export type { RawAnnouncement, FetchResponse };
