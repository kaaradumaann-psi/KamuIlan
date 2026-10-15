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
 * Sistem deposu okunamazsa varsayılan kökler ve ek CA dosyası korunur.
 * API yoksa veya varsayılan depo okunamıyorsa `undefined` döner; çağıran
 * Node'un kendi deposunu kullanır. Doğrulama hiçbir durumda KAPATILMAZ.
 */
export function loadCaStore(): string[] | undefined {
  if (!systemCaStoreAvailable()) return undefined;

  // Depolar birbirinden bağımsız okunmalı. Windows sistem deposundaki bir
  // hata, çalışan varsayılan depoyu ve .env'den gelen ek CA'yı yok etmemeli.
  let defaults: string[];
  try {
    defaults = getCACertificates('default');
  } catch {
    // Varsayılan kökler olmadan yalnızca özel CA'larla genel depoyu ezmeyiz.
    return undefined;
  }
  let system: string[] = [];
  try {
    system = getCACertificates('system');
  } catch {
    // Varsayılan köklerle doğrulama sürer; ek CA dosyası yine de yüklenir.
  }
  const merged = new Set([...defaults, ...system, ...loadNodeExtraCaCerts()]);
  return merged.size > 0 ? [...merged] : undefined;
}

/**
 * Yalnızca bilinen TLS hata kodlarına göre sabit çözüm metni üretir.
 * Ham hata mesajı/URL/sertifika içeriği yazılmaz (DB sırları içerebilir).
 */
export function databaseTlsHelp(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  if (
    code !== 'SELF_SIGNED_CERT_IN_CHAIN' &&
    code !== 'DEPTH_ZERO_SELF_SIGNED_CERT' &&
    code !== 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' &&
    code !== 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' &&
    code !== 'CERT_HAS_EXPIRED' &&
    code !== 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) return undefined;

  if (code === 'CERT_HAS_EXPIRED') {
    return 'Veritabanı TLS sertifikasının süresi dolmuş. Sistem saatini ve sunucu/ara katman sertifikasını kontrol edin. Doğrulamayı kapatmayın.';
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'Veritabanı adresi TLS sertifikasındaki adla eşleşmiyor. POSTGRES_URL sunucu adını Supabase Connect ekranıyla karşılaştırın. Doğrulamayı kapatmayın.';
  }
  return [
    'Veritabanı TLS zinciri güvenilir bir CA ile doğrulanamadı; bağlantı reddedildi.',
    'Supabase kullanıyorsanız projenizin Database Settings → SSL Configuration bölümünden CA sertifikasını indirin.',
    "Dosyayı örneğin certs/supabase-ca.crt olarak kaydedin ve .env içine POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt ile POSTGRES_SSL_MODE=verify yazın.",
    'CA zaten tanımlıysa doğru projeye ve kullandığınız doğrudan/pooler adresine ait olduğunu kontrol edin.',
    'Kurumsal proxy/antivirüs TLS denetimi varsa yalnızca yöneticinizden doğruladığınız kökü NODE_EXTRA_CA_CERTS ile tanıtın (özel POSTGRES_SSL_CA_FILE yalnızca kendi CA dosyasına güvenir; sistem kökleriyle birleştirmek için POSTGRES_SSL_CA_MERGE_SYSTEM=1).',
    'Kök nedeni otomatik bulmak için: npm run db:tls-doctor (parola göndermeden sunucunun sunduğu zinciri okur, eksik halkayı ve uygulanacak adımı yazar).',
    'NODE_TLS_REJECT_UNAUTHORIZED=0 veya no-verify kullanmayın. Ayrıntılar: docs/database-tls.md',
  ].join('\n');
}

/**
 * TLS doğrulaması süreç genelinde KAPATILMIŞ mı?
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` Node'un acil durum anahtarıdır: HTTPS ve
 * Postgres dahil TÜM TLS bağlantılarında sertifika denetimi atlanır. Sonuçta
 * `npm run test:live` "başarılı" görünür ama bu, sitelerin doğru çalıştığını
 * değil, kimsenin denetlenmediğini gösterir; ağ üzerindeki herhangi biri
 * (kurum vekili, DNS zehirlenmesi, sahte Wi-Fi) trafiği okuyabilir/değiştirebilir.
 *
 * Bu yüzden uygulama bu anahtarı GİZLEMEZ: her tanılama çıktısında söyler ve
 * üretimde başlangıcı durdurur. Doğru karşılık anahtarı kaldırmak ve eksik
 * zinciri/kökü tamamlamaktır (docs/database-tls.md).
 */
export function tlsVerificationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['NODE_TLS_REJECT_UNAUTHORIZED']?.trim();
  return raw === '0';
}

/**
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` için uyarı + kaldırma adımları.
 *
 * Anahtar kapalı değilse `null` döner. Adımlar işletim sistemine göredir:
 * değişken genellikle kabukta değil, Windows'ta KALICI kullanıcı değişkeni
 * olarak tanımlıdır (`setx`), bu yüzden "kaldırdım ama hâlâ görünüyor"
 * tuzağına düşülmemesi için kalıcı kaldırma yolu da yazılır.
 */
export function describeTlsVerificationOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!tlsVerificationDisabled(env)) return null;
  const windows = process.platform === 'win32';
  const lines = [
    '⚠ NODE_TLS_REJECT_UNAUTHORIZED=0 etkin: TLS sertifika doğrulaması BU SÜREÇTE TAMAMEN KAPALI.',
    '  Etkisi: HTTPS istekleri ve Postgres bağlantıları HİÇBİR sertifika denetiminden geçmez;',
    '  test/tarama sonuçları "başarılı" görünse bile GÜVENİLMEZ (MITM trafiği ayırt edilemez).',
    '  Bu bir çözüm değildir; kaldırılması gerekir. Gerçek çözüm eksik kök/zinciri tamamlamaktır:',
    '    · Supabase CA dosyası: POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt + POSTGRES_SSL_MODE=verify',
    '    · Dosya + sistem kökleri birlikte: POSTGRES_SSL_CA_MERGE_SYSTEM=1',
    '    · Kurumsal proxy/antivirüs kökü: NODE_EXTRA_CA_CERTS=C:/certs/kurum-ca.pem',
    '    · Eksik zincirli resmî siteler: Node 22.15+ (sistem kök deposu) ve npm run db:tls-doctor',
  ];
  if (windows) {
    lines.push(
      '  Kaldırmak için (Windows):',
      '    1) Geçici (yalnızca açık pencere): set NODE_TLS_REJECT_UNAUTHORIZED=   ya da  $env:NODE_TLS_REJECT_UNAUTHORIZED=$null',
      '    2) Kalıcı kullanıcı değişkeni:     setx NODE_TLS_REJECT_UNAUTHORIZED ""   (YENİ bir kabuk açın)',
      '       Kalıcı silme: Sistem Özellikleri → Gelişmiş → Ortam Değişkenleri → NODE_TLS_REJECT_UNAUTHORIZED → Sil',
      '    3) Kontrol: node -e "console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED)"  → undefined yazmalı',
    );
  } else {
    lines.push(
      '  Kaldırmak için (Linux/macOS):',
      '    1) Geçici: unset NODE_TLS_REJECT_UNAUTHORIZED',
      '    2) Kalıcı: ~/.bashrc, ~/.zshrc, ~/.profile ya da systemd/Cloudflare ortam tanımından satırı silin',
      '    3) Kontrol: node -e "console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED)"  → undefined yazmalı',
    );
  }
  return lines.join('\n');
}

/** Kullanıcıya gösterilecek TLS güven modu özeti (live-check ve bağlantı tanısı). */
export function describeTlsTrust(): string {
  const extraPath = process.env['NODE_EXTRA_CA_CERTS'];
  const extraNote = extraPath ? `; NODE_EXTRA_CA_CERTS=${extraPath}` : '';
  const caFile = process.env['POSTGRES_SSL_CA_FILE'];
  const merge = process.env['POSTGRES_SSL_CA_MERGE_SYSTEM'];
  const dbNote = caFile
    ? `; veritabanı CA dosyası: ${caFile}${merge === '1' || merge?.toLowerCase() === 'true' ? ' (sistem kökleriyle birleştiriliyor)' : ' (YALNIZCA bu dosya)'}`
    : '';
  // Doğrulama kapatılmışsa hiçbir "güven deposu" bilgisinin anlamı kalmaz:
  // okuyucunun önce bunu görmesi gerekir (test:live çıktısının ilk satırı).
  const override = describeTlsVerificationOverride();
  if (override) return override;
  return systemCaStoreAvailable()
    ? `Node ${process.version}: sistem sertifika deposu kullanılıyor (eksik zincirli resmî siteler için)${extraNote}${dbNote}.`
    : `Node ${process.version}: sistem sertifika deposu KULLANILAMIYOR. ilan.gov.tr, BDDK ve TMSF gibi siteler ` +
        `UNABLE_TO_VERIFY_LEAF_SIGNATURE hatası verebilir. Node ${SYSTEM_CA_MIN_NODE} veya üstünü kurun${extraNote ? `; ek CA: ${extraPath}` : ''}${dbNote}.`;
}
