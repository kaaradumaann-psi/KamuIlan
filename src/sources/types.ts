/**
 * Kaynak adaptörü sözleşmesi.
 *
 * Adaptörler birbirinden bağımsızdır: her biri yalnızca kendi listeleme
 * yapısını bilir, ortak HTTP/ayrıştırma yardımcılarını kullanır ve
 * `RawAnnouncement` üretir. Sınıflandırma, çıkarım ve tekilleştirme bu
 * katmanın dışındadır (tek yerde yapılır).
 */
import type { RawAnnouncement } from '../domain';
import type { SourceDoc } from '../db/schemas';
import type { Logger } from '../lib/logger';
import type { Clock } from '../lib/clock';

export interface FetchRequestOptions {
  /** Kaynak kaydı (hız sınırı, allowlist ve koşullu istek bilgisi buradan gelir). */
  source: SourceDoc;
  /** Koşullu istek başlıkları (yalnızca ilk sayfa için anlamlı). */
  conditional?: { etag?: string | null; lastModified?: string | null };
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Hata sayılan durum kodları için yeniden deneme sayısı. */
  retries?: number;
  signal?: AbortSignal;
}

export interface FetchResponse {
  url: string;
  finalUrl: string;
  status: number;
  notModified: boolean;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  byteLength: number;
  /** Metin gövdeler (html/xml/json). */
  text: string | null;
  /** İkili gövdeler (pdf). */
  buffer: Buffer | null;
  charset: string | null;
  attempts: number;
  /** Yönlendirme zinciri — denetim/loglama için. */
  redirectChain: string[];
}

export interface Fetcher {
  fetchText(url: string, options: FetchRequestOptions): Promise<FetchResponse>;
  fetchBinary(url: string, options: FetchRequestOptions): Promise<FetchResponse>;
}

export interface AdapterLimits {
  maxListingPages: number;
  timeoutMs: number;
  maxDetailFetches: number;
  /** Belge (PDF) indirme sınırı. */
  maxDocumentBytes: number;
}

export interface AdapterContext {
  fetcher: Fetcher;
  logger: Logger;
  clock: Clock;
  source: SourceDoc;
  limits: AdapterLimits;
  /** Ağ erişimi kapalıysa (SOURCE_LIVE_FETCH=0) adaptör yalnızca doğrulama yapar. */
  liveFetch: boolean;
  /**
   * Daha önce görülmüş kaynak içi kimlikler (jobSources'tan). Adaptör bu
   * kayıtlar için pahalı belge indirmeyi atlar; içerik değişmediyse gereksiz
   * indirme ve işlem yapılmaz.
   */
  knownItemIds?: ReadonlySet<string>;
}

export interface AdapterRunResult {
  items: RawAnnouncement[];
  httpStatuses: number[];
  notes: string[];
  /** 304 döndü: içerik değişmemiş, gereksiz işlem yapılmadı. */
  notModified: boolean;
  /** ETag/Last-Modified bilgisi sonraki turda koşullu istek için saklanır. */
  cacheHeaders?: { etag?: string | null; lastModified?: string | null; contentHash?: string | null };
}

export interface SourceAdapter {
  /** Adaptör anahtarı (config/sources.ts ile eşleşir). */
  readonly key: string;
  readonly label: string;
  /** Sonraki tarama için varsayılan listeleme adresi. */
  listingUrl(source: SourceDoc): string;
  run(ctx: AdapterContext): Promise<AdapterRunResult>;
}
