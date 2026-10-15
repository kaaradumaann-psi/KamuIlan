/**
 * TLS güven deposu yardımcıları (ağ ve veritabanı katmanının ortak tek kaynağı).
 *
 * Neden ortak: HTTP istemcisi ile Postgres sürücüsü AYNI doğrulama ilkesine
 * uymak zorundadır — "doğrulamayı kapat" seçeneği sessiz varsayılan olamaz.
 * Bazı resmî sitelerin (ilan.gov.tr, BDDK, TMSF) ve bazı kurum içi
 * köklerin zinciri Node'un gömülü Mozilla listesinde bulunmaz; tarayıcı
 * işletim sistemi deposundan çözer. Doğru karşılık doğrulamayı kapatmak
 * değil, sistem deposunu varsayılan paketle BİRLEŞTİRMEKTİR (Node'un kendi
 * önerisi: `--use-system-ca`).
 *
 * Bu modül yalnızca kök sertifika listesini döndürür; kararı (kabul/red)
 * Node'un TLS yığını verir.
 */
import { getCACertificates } from 'node:tls';

/** Sistem sertifika deposu API'si Node 22.15 ile geldi; daha eski sürümlerde yoktur. */
export const SYSTEM_CA_MIN_NODE = '22.15.0';

export function systemCaStoreAvailable(): boolean {
  return typeof getCACertificates === 'function';
}

/**
 * Node'un varsayılan (Mozilla) + işletim sisteminin kök sertifikalarını
 * tekilleştirilmiş tek liste olarak döndürür.
 *
 * Okunamazsa (eski Node, izin sorunu) `undefined` döner — çağıran taraf bu
 * durumda Node'un varsayılan deposunu kullanır; hata fırlatmaz ve doğrulamayı
 * KAPATMAZ.
 */
export function loadCaStore(): string[] | undefined {
  try {
    if (!systemCaStoreAvailable()) return undefined;
    const merged = new Set<string>([...getCACertificates('default'), ...getCACertificates('system')]);
    return merged.size > 0 ? [...merged] : undefined;
  } catch {
    return undefined;
  }
}

/** Kullanıcıya gösterilecek TLS güven modu özeti (live-check ve bağlantı tanısı). */
export function describeTlsTrust(): string {
  return systemCaStoreAvailable()
    ? `Node ${process.version}: sistem sertifika deposu kullanılıyor (eksik zincirli resmî siteler için).`
    : `Node ${process.version}: sistem sertifika deposu KULLANILAMIYOR. ilan.gov.tr, BDDK ve TMSF gibi siteler ` +
        `UNABLE_TO_VERIFY_LEAF_SIGNATURE hatası verebilir. Node ${SYSTEM_CA_MIN_NODE} veya üstünü kurun.`;
}
