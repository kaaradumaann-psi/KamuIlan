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
 * Üç kaynak birleştirilir:
 *  1. Node'un gömülü Mozilla kökleri (`getCACertificates('default')`)
 *  2. İşletim sisteminin kök deposu (`getCACertificates('system')`) — Node ≥22.15
 *  3. NODE_EXTRA_CA_CERTS ile gösterilen PEM dosyası (kurum vekili/antivirüs kökü
 *     için standart Node mekanizması). Özellikle Windows'ta Zscaler, Fortinet,
 *     Kaspersky gibi SSL denetimi yapan ara katmanlar kendi kök sertifikasını
 *     sisteme yükler; bu sertifika Mozilla listesinde yoktur ve eski Node
 *     sürümleri sistem deposunu okuyamaz. NODE_EXTRA_CA_CERTS her iki durumda
 *     da çalışır.
 *
 * Bu modül yalnızca kök sertifika listesini döndürür; kararı (kabul/red)
 * Node'un TLS yığını verir.
 */
import { readFileSync } from 'node:fs';
import { getCACertificates } from 'node:tls';

/** Sistem sertifika deposu API'si Node 22.15 ile geldi; daha eski sürümlerde yoktur. */
export const SYSTEM_CA_MIN_NODE = '22.15.0';

export function systemCaStoreAvailable(): boolean {
  return typeof getCACertificates === 'function';
}

/**
 * NODE_EXTRA_CA_CERTS yolunu gösteren PEM dosyasındaki sertifikaları okur.
 *
 * Node, NODE_EXTRA_CA_CERTS'teki sertifikaları otomatik olarak güvendiği
 * köklere ekler — ANCAK bu otomatik ekleme, `tls.connect()` içinde `ca`
 * seçeneği AÇIKÇA verildiğinde devre dışı kalır (Node belgeleri: "When the
 * `ca` option is specified, the default CA store is NOT used").
 * `sslConfigFor()` içinde CA listesini kendimiz oluşturduğumuz için,
 * NODE_EXTRA_CA_CERTS'teki sertifikaları da listeye elle eklemek zorundayız;
 * aksi takdirde kullanıcı kurum kökünü standart Node mekanizmasıyla eklemiş
 * olsa bile yok sayılır ve SELF_SIGNED_CERT_IN_CHAIN hatası alınır.
 */
function loadNodeExtraCaCerts(): string[] {
  const extraPath = process.env['NODE_EXTRA_CA_CERTS'];
  if (!extraPath) return [];
  try {
    const pem = readFileSync(extraPath, 'utf8');
    // PEM dosyası birden fazla CERTIFICATE bloğu içerebilir; bloklara ayır.
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!blocks) return [];
    return blocks.map((block) => block.trim()).filter((block) => block.length > 0);
  } catch {
    // Dosya yok/okunamıyor: sessizce atla (hata, gerçek bağlantıda daha
    // net bir biçimde görünecektir; burada çökersek uygulama hiç başlamaz).
    return [];
  }
}

/**
 * Node'un varsayılan (Mozilla) + işletim sisteminin kök sertifikalarını +
 * NODE_EXTRA_CA_CERTS ile belirtilen ek kökleri tekilleştirilmiş tek liste
 * olarak döndürür.
 *
 * Sistem deposu okunamazsa (eski Node, izin sorunu) ve NODE_EXTRA_CA_CERTS
 * de yoksa `undefined` döner — çağıran taraf bu durumda Node'un varsayılan
 * deposunu kullanır; hata fırlatmaz ve doğrulamayı KAPATMAZ.
 */
export function loadCaStore(): string[] | undefined {
  try {
    const extra = loadNodeExtraCaCerts();
    if (!systemCaStoreAvailable()) {
      // Eski Node (<22.15): sistem CA deposu API'si yok ve gömülü Mozilla
      // köklerini programlı olarak okuyamıyoruz. `ca` seçeneği VERMEYİP
      // `undefined` döndüğümüzde Node kendi varsayılan deposunu (Mozilla +
      // NODE_EXTRA_CA_CERTS + platform deposu) kullanır. Eğer `ca` olarak
      // sadece `extra`'yı verseydik, Node varsayılan depoyu atar ve yalnızca
      // ek CA'ya güvenir — tüm genel CA siteleri kırılır.
      //
      // Dolayısıyla eski Node'da en güvenli davranış: CA'yı ezmemek.
      // Kullanıcı NODE_EXTRA_CA_CERTS ile kurum kökünü eklemişse Node bunu
      // zaten otomatik olarak güvenir.
      return undefined;
    }
    const merged = new Set<string>([
      ...getCACertificates('default'),
      ...getCACertificates('system'),
      ...extra,
    ]);
    return merged.size > 0 ? [...merged] : undefined;
  } catch {
    return undefined;
  }
}

/** Kullanıcıya gösterilecek TLS güven modu özeti (live-check ve bağlantı tanısı). */
export function describeTlsTrust(): string {
  const extraPath = process.env['NODE_EXTRA_CA_CERTS'];
  const extraNote = extraPath ? `; NODE_EXTRA_CA_CERTS=${extraPath}` : '';
  return systemCaStoreAvailable()
    ? `Node ${process.version}: sistem sertifika deposu kullanılıyor (eksik zincirli resmî siteler için)${extraNote}.`
    : `Node ${process.version}: sistem sertifika deposu KULLANILAMIYOR. ilan.gov.tr, BDDK ve TMSF gibi siteler ` +
        `UNABLE_TO_VERIFY_LEAF_SIGNATURE hatası verebilir. Node ${SYSTEM_CA_MIN_NODE} veya üstünü kurun${extraNote ? `; ek CA: ${extraPath}` : ''}.`;
}
