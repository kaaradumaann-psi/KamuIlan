/**
 * Veritabanı TLS tanısı: "SELF_SIGNED_CERT_IN_CHAIN aldım" → "şu halka eksik".
 *
 * Bu modül, `pg-tls-probe` ile okunan GERÇEK zinciri ve `ca-file` ile okunan
 * GERÇEK güven kümesini karşılaştırır. Karar tablosu deterministiktir; tahmin
 * içermez ve doğrulamayı gevşetmeyi HİÇBİR dalda önermez.
 *
 * Gizlilik: çıktıda bağlantı dizesi, parola ve veritabanı içeriği yer almaz.
 * Sunucu adı ve sertifikanın herkese açık alanları (subject/issuer/SAN/parmak
 * izi/geçerlilik) tanının kendisidir; bunlar olmadan kullanıcı hangi CA'nın
 * eksik olduğunu doğrulayamaz.
 */
import type { CaFileReport } from './ca-file';
import { describeCertShort, inspectCaFile, loadTrustedCaCertificates } from './ca-file';
import {
  describePostgresEndpoint,
  evaluateChainTrust,
  defaultTrustAnchors,
  probePostgresTls,
  systemTrustAnchors,
  type ChainTrustResult,
  type EndpointInfo,
  type ProbeResult,
} from './pg-tls-probe';

/** Bilinen ara katman (TLS denetimi) kök adları: yalnızca YÖNLENDİRME içindir. */
const KNOWN_INTERCEPTION_MARKERS = [
  'zscaler',
  'fortinet',
  'fortigate',
  'fortinet',
  'kaspersky',
  'eset',
  'avast',
  'avg',
  'bitdefender',
  'sophos',
  'palo alto',
  'checkpoint',
  'check point',
  'websense',
  'forcepoint',
  'bluecoat',
  'blue coat',
  'symantec',
  'norton',
  'mcafee',
  'trellix',
  'barracuda',
  'sonicwall',
  'watchguard',
  'umbrella',
  'netskope',
  'sangfor',
  'deep security',
  'trend micro',
  'proxy',
  'firewall',
  'gateway',
  'antivirus',
  'antivirüs',
  'mitm',
  'inspector',
  'ssl inspection',
];

/** Bulut sağlayıcı CA adları (Supabase uç noktaları bu kökleri sunar). */
const KNOWN_PROVIDER_MARKERS = [
  'supabase',
  'supavisor',
  'amazon rds',
  'rds root',
  'amazonrootca',
  'amazon trust services',
  'starfield',
  'aws',
  'google trust services',
  'google internet authority',
  'cloudflare',
  'letsencrypt',
  "let's encrypt",
  'isrg root',
  'digicert',
  'globalsign',
  'godaddy',
  'baltimore',
  'comodo',
  'usertrust',
  'sectigo',
  'microsoft azure',
  'azure',
];

export type TlsCause =
  | 'tls-unsupported'
  | 'not-probed'
  | 'unreachable'
  | 'ca-file-unusable'
  | 'hostname-mismatch'
  | 'clock-skew'
  | 'trusted-by-file'
  | 'file-overrides-system-roots'
  | 'intercepted-chain'
  | 'missing-provider-root'
  | 'incomplete-chain'
  | 'unknown-chain';

export interface TlsDiagnosis {
  cause: TlsCause;
  /** Tek cümlelik kök neden. */
  headline: string;
  /** Bulgular (zincir, güven kümeleri, dosya durumu). */
  findings: string[];
  /** Yapılacaklar; her satır uygulanabilir bir adımdır. */
  actions: string[];
  /** Güven değerlendirmeleri (tanı çıktısında tablo olarak basılır). */
  trust: { file: ChainTrustResult | null; system: ChainTrustResult | null; nodeDefaults: ChainTrustResult | null };
}

export interface DiagnoseInput {
  probe: ProbeResult | null;
  endpoint: EndpointInfo | null;
  /** `POSTGRES_SSL_CA_FILE` raporu (dosya tanımlı değilse null). */
  caFileReport: CaFileReport | null;
  /** CA dosyası + (merge açıksa) sistem kökleri birleşimi. */
  fileAnchors: string[];
  mergeSystem: boolean;
  /** Etkin TLS kipi. */
  mode: 'verify' | 'no-verify' | 'disable';
}

export interface DiagnoseOptions {
  /** Sistem kökleriyle de karşılaştırılsın (varsayılan: açık). */
  compareSystemStore?: boolean;
}

/**
 * Sondaj sonucunu kök nedene ve eylem listesine çevirir.
 *
 * Sıra önemlidir: en kesin kanıt önce değerlendirilir (TLS yok → erişilemiyor →
 * CA dosyası bozuk → ad uyuşmuyor → saat yanlış → dosya doğruluyor → sistem
 * kökleri doğruluyor ama dosya eziyor → ara katman → eksik sağlayıcı kökü).
 */
export function diagnoseTls(input: DiagnoseInput, options: DiagnoseOptions = {}): TlsDiagnosis {
  const compareSystemStore = options.compareSystemStore ?? true;
  const { probe, endpoint, caFileReport } = input;
  const findings: string[] = [];
  const trust = {
    file: null as ChainTrustResult | null,
    system: null as ChainTrustResult | null,
    nodeDefaults: null as ChainTrustResult | null,
  };

  if (endpoint) {
    findings.push(`Uç nokta: ${endpoint.host}:${endpoint.port} — ${endpoint.kindLabel}`);
    if (endpoint.projectRef) findings.push(`Supabase proje referansı: ${endpoint.projectRef}`);
  }

  if (!probe) {
    // `probe === null` iki farklı durumdur ve karıştırılmaz:
    //  - endpoint yok  → bağlantı dizesi çözümlenemedi (unreachable),
    //  - endpoint var  → canlı sondaj HİÇ YAPILMADI (--no-probe ya da TLS kapalı).
    //    İkincisinde "ulaşılamadı" demek yanlıştır: sunucuya hiç bağlanılmadı.
    if (!endpoint) {
      return finish('unreachable', 'POSTGRES_URL çözümlenemedi; tanılama yapılamadı.', findings, [
        'POSTGRES_URL değerini Supabase → Project Settings → Database → Connection string ile karşılaştırın.',
        'Bağlantı dizesine sslmode/sslrootcert gibi TLS parametresi YAZMAYIN; bu uygulama TLS kararını POSTGRES_SSL_MODE ile verir.',
      ], trust);
    }

    const skipped = [
      ...findings,
      'Canlı sondaj yapılmadı: sunucunun sunduğu zincir bu çalışmada DENETLENMEDİ.',
    ];
    if (input.mode === 'disable') {
      return finish(
        'not-probed',
        'TLS kapalı (POSTGRES_SSL_MODE=disable): sunucuya bağlanılmadı, zincir doğrulaması yapılmıyor.',
        skipped,
        [
          'Yönetilen bir veritabanı (Supabase, RDS, Azure) için POSTGRES_SSL_MODE=verify yazın.',
          'Kararı değiştirdikten sonra zinciri canlı denetleyin: npm run db:tls-doctor',
        ],
        trust,
      );
    }
    return finish(
      'not-probed',
      'Canlı sondaj atlandı (--no-probe): yalnızca yapılandırma denetlendi.',
      skipped,
      [
        'Sunucunun sunduğu zinciri görmek için sondajı açın: npm run db:tls-doctor (--no-probe bayrağı olmadan).',
        'Yapılandırmanın tutarlı görünmesi doğrulamanın GEÇTİĞİNİ kanıtlamaz; son adımda ✔ satırını bekleyin.',
      ],
      trust,
    );
  }

  if (probe.failure === 'tls-unsupported') {
    return finish(
      'tls-unsupported',
      `Sunucu TLS desteklemiyor (${probe.host}:${probe.port}).`,
      [...findings, probe.errorMessage ?? 'SSLRequest yanıtı: N'],
      [
        'Yerel/güvenili bir Postgres ise POSTGRES_SSL_MODE=disable açıkça yazılabilir (trafik şifrelenmez).',
        'Supabase için bu yanıt beklenmez: adresi ve portu Connect ekranıyla karşılaştırın (doğrudan: 5432, transaction pooler: 6543).',
      ],
      trust,
    );
  }

  if (!probe.ok) {
    const label =
      probe.failure === 'dns'
        ? 'sunucu adı çözümlenemedi (DNS)'
        : probe.failure === 'tcp-refused'
          ? 'bağlantı reddedildi (port kapalı ya da IP kısıtı)'
          : probe.failure === 'tcp-timeout'
            ? 'bağlantı zaman aşımına uğradı (güvenlik duvarı/IP kısıtı)'
            : 'TLS el sıkışması tamamlanamadı';
    return finish(
      'unreachable',
      `Veritabanına ulaşılamadı: ${label}.`,
      [...findings, `Hata kodu: ${probe.errorCode ?? 'bilinmiyor'}`, probe.errorMessage ?? ''].filter(
        (line) => line.length > 0,
      ),
      [
        'Supabase → Project Settings → Database → Network restrictions: kendi IP adresinize izin verin (IPv4/IPv6).',
        'POSTGRES_URL adresini Connect ekranından kopyalayın; doğrudan bağlantı ile pooler adresi farklıdır.',
        'Ağ yeniden ulaşıldığında `npm run db:tls-doctor` komutunu tekrar çalıştırın.',
      ],
      trust,
    );
  }

  // Zincir okundu: güven kümeleriyle karşılaştır.
  const chain = probe.chain;
  findings.push(`Sunulan zincir (${chain.length} sertifika):`);
  for (const entry of chain) {
    findings.push(
      `  [${entry.depth}] ${entry.subjectCn || entry.subject} — ihraç eden: ${entry.issuerCn || entry.issuer}` +
        `${entry.selfSigned ? ' (kendi kendini imzalayan kök)' : ''}${entry.isCa ? '' : ' (CA değil)'}`,
    );
  }
  const root = chain[chain.length - 1];

  trust.file = evaluateChainTrust(chain, input.fileAnchors);
  if (compareSystemStore) {
    trust.system = evaluateChainTrust(chain, systemTrustAnchors());
    trust.nodeDefaults = evaluateChainTrust(chain, defaultTrustAnchors());
  }
  findings.push(
    `Güven denetimi: CA dosyası=${trustLabel(trust.file)} | sistem kökleri=${trustLabel(trust.system)} | Node gömülü kökler=${trustLabel(trust.nodeDefaults)}`,
  );

  if (caFileReport && caFileReport.issues.length > 0) {
    findings.push(
      `CA dosyası sorunları (${caFileReport.resolvedPath ?? caFileReport.requestedPath}):`,
      ...caFileReport.issues.map((entry) => `  - ${entry.message.replace(/\n\s*/g, ' ')}`),
    );
  }

  // 1) CA dosyası hiç kullanılabilir değilse neden budur.
  if (caFileReport && !caFileReport.usable) {
    const blocking = caFileReport.issues.filter((entry) => entry.blocking);
    return finish(
      'ca-file-unusable',
      `POSTGRES_SSL_CA_FILE kullanılamıyor: ${blocking.map((entry) => entry.code).join(', ') || 'geçersiz içerik'}.`,
      findings,
      [
        ...blocking.map((entry) => entry.message.replace(/\n\s*/g, ' ')),
        'Doğru dosyayı Supabase panosundan indirin: Database Settings → SSL Configuration → CA certificate.',
        'Dosyayı certs/supabase-ca.crt olarak kaydedin; .env içinde POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt bırakın.',
      ],
      trust,
    );
  }

  // 2) Ad uyuşmazlığı CA eklemekle çözülmez.
  if (probe.hostnameMatch === false) {
    return finish(
      'hostname-mismatch',
      'Sunucu adı, sertifikadaki adlarla eşleşmiyor (ERR_TLS_CERT_ALTNAME_INVALID).',
      [...findings, `Sertifika adları: ${chain[0]?.subjectAltNames || '(SAN yok)'}`, `Bağlanılan ad: ${probe.servername}`],
      [
        'POSTGRES_URL adresini Supabase Connect ekranındaki değerle birebir karşılaştırın.',
        'Doğrudan bağlantı için db.<proje>.supabase.co, pooler için aws-0-<bölge>.pooler.supabase.com biçimini kullanın.',
        'CA dosyası eklemek bu hatayı ÇÖZMEZ; adresi düzeltin.',
      ],
      trust,
    );
  }

  // 3) Saat kayması: sertifika geçerli ama yerel saat yanlış.
  if (probe.clockSkew) {
    return finish(
      'clock-skew',
      probe.clockSkew === 'expired'
        ? 'Sunulan sertifikanın süresi dolmuş görünüyor (ya da yerel saat ileride).'
        : 'Sunulan sertifika henüz geçerli değil (yerel saat geri kalmış).',
      [
        ...findings,
        `Sertifika geçerlilik aralığı: ${chain[0]?.validFrom} → ${chain[0]?.validTo}`,
        `Yerel saat: ${new Date().toISOString()}`,
      ],
      [
        'İşletim sistemi saatini otomatik eşitlemeye açın (Windows: Ayarlar → Zaman ve dil → Otomatik ayarla).',
        'Saat doğruysa sunucu sertifikası gerçekten süresi dolmuştur: sağlayıcıyı/yenilemeyi kontrol edin.',
      ],
      trust,
    );
  }

  // 4) Dosya doğruluyorsa TLS tarafında sorun yoktur.
  if (trust.file?.trusted) {
    const leafAnchorNote = trust.file.leafIsAnchor
      ? [
          'DİKKAT: CA dosyanız sunucunun KENDİ (leaf) sertifikasını içeriyor; güven buradan geliyor (CA doğrulaması değil). Sertifika yenilendiğinde bağlantı yeniden kopar — panelden CA (kök) sertifikasını indirin.',
        ]
      : [];
    return finish(
      'trusted-by-file',
      'Sunulan zincir geçerli güven kümesiyle DOĞRULANIYOR; TLS kök nedeni bu bağlantıda görülmedi.',
      [...findings, ...leafAnchorNote],
      [
        'Bağlantı yine de kopuyorsa hata TLS dışıdır: parola/kullanıcı adı, veritabanı adı veya IP kısıtı.',
        'Uygulamanın bağlandığı adres bu sondadaki adresle aynı mı? .env içindeki POSTGRES_URL değerini kontrol edin.',
        'Havuz (pooler) kullanıyorsanız aynı tanıtımı pooler adresi için de çalıştırın: npm run db:tls-doctor',
      ],
      trust,
    );
  }

  // 5) Sistem/Node kökleri doğruluyor ama CA dosyası eziyorsa: dosya yanlış uç noktaya ait.
  if (trust.system?.trusted || trust.nodeDefaults?.trusted) {
    const which = trust.nodeDefaults?.trusted ? "Node'un gömülü kökleri" : 'işletim sistemi kök deposu';
    return finish(
      'file-overrides-system-roots',
      `Zincir ${which} tarafından doğrulanıyor; ancak POSTGRES_SSL_CA_FILE tanımlı olduğu için sunucu sertifikası YALNIZCA o dosyadaki köklerle doğrulanmaya çalışılıyor. Dosya bu uç noktaya ait değil.`,
      findings,
      [
        'A) CA dosyasını kaldırın: .env içinde POSTGRES_SSL_CA_FILE= (boş bırakın). Doğrulama sistem kökleriyle açık kalır.',
        'B) Dosyayı tutmak istiyorsanız birleştirmeyi açın: POSTGRES_SSL_CA_MERGE_SYSTEM=1 (dosya kökleri + sistem kökleri birlikte kullanılır; doğrulama açık kalır).',
        'C) Bu uç noktanın DOĞRU CA dosyasını indirin: Supabase → Database Settings → SSL Configuration (doğrudan bağlantı ile pooler farklı kök sunabilir).',
        'Tanıyı yeniden çalıştırın: npm run db:tls-doctor',
      ],
      trust,
    );
  }

  // 6) Hiçbir güven kümesi doğrulamıyor: kökü tanı.
  const rootText = root ? `${root.subject} / ${root.issuer}`.toLowerCase() : '';
  const chainText = chain.map((entry) => `${entry.subject} ${entry.issuer}`.toLowerCase()).join(' ');
  const interception = KNOWN_INTERCEPTION_MARKERS.find((marker) => rootText.includes(marker));
  if (interception) {
    return finish(
      'intercepted-chain',
      `Zincirin kökü bir TLS denetim ara katmanına ait görünüyor ("${root?.subjectCn ?? root?.subject}"). Veritabanı trafiği kurum proxy/antivirüs tarafından yeniden imzalanıyor.`,
      [...findings, `Kök: ${root?.subject} (ihraç eden: ${root?.issuer})`],
      [
        'Kurum kökünü YALNIZCA bilgi işlemden doğrulayarak alın ve NODE_EXTRA_CA_CERTS=C:/certs/kurum-ca.pem ile tanıtın.',
        'NODE_EXTRA_CA_CERTS tanımlandığında uygulamanın hem HTTP hem Postgres güven deposu bu kökü okur (bkz. src/lib/tls-trust.ts).',
        'CA dosyası ile birlikte kullanıyorsanız birleştirmeyi açın: POSTGRES_SSL_CA_MERGE_SYSTEM=1 (aksi halde dosya sistem köklerini ezer).',
        'Kurum kökü doğrulanamıyorsa bu ağdan veritabanına bağlanmayın; doğrulamayı kapatmak (no-verify) kimlik bilgilerinizi ağa açık bırakır.',
      ],
      trust,
    );
  }

  const provider = KNOWN_PROVIDER_MARKERS.find((marker) => chainText.includes(marker));
  if (provider) {
    return finish(
      'missing-provider-root',
      `Zincir ${root?.subjectCn ?? root?.subject} köküne çıkıyor ama bu kök ne CA dosyanızda ne de sistem depolarında var.`,
      [
        ...findings,
        `Sunulan kök: ${root?.subject ?? '(okunamadı)'}`,
        root?.selfSigned ? 'Kök kendi kendini imzalıyor: zincir tam, güven eksik.' : 'Kök kendi kendini imzalamıyor: sunucu zinciri EKSİK gönderiyor (ara CA yok).',
      ],
      [
        'Supabase → Database Settings → SSL Configuration bölümünden CA sertifikasını indirin ve certs/supabase-ca.crt olarak kaydedin.',
        `.env: POSTGRES_SSL_MODE=verify ve POSTGRES_SSL_CA_FILE=./certs/supabase-ca.crt (bu uç nokta: ${endpoint?.kindLabel ?? 'bilinmiyor'}).`,
        'Doğrudan bağlantı ile pooler FARKLI kök sunabilir; dosyayı kullandığınız uç noktaya göre seçin.',
        root?.selfSigned
          ? ''
          : 'Ara CA eksikse dosyaya tam zinciri (leaf → intermediate → root) ekleyin ya da POSTGRES_SSL_CA_MERGE_SYSTEM=1 ile sistem köklerini birleştirin.',
        'Tanıyı doğrulayın: npm run db:tls-doctor',
      ].filter((line) => line.length > 0),
      trust,
    );
  }

  return finish(
    'unknown-chain',
    'Zincir hiçbir güven kümesiyle doğrulanamadı ve kök bilinen bir sağlayıcıya/ara katmana benzemiyor.',
    [...findings, `Sunulan kök: ${root?.subject ?? '(okunamadı)'} — ihraç eden: ${root?.issuer ?? '(okunamadı)'}`],
    [
      'Supabase panosundan indirilen CA dosyasının bu projeye ait olduğunu doğrulayın (proje referansı: ' +
        `${endpoint?.projectRef ?? 'okunamadı'}).`,
      'Dosyanın içeriğini denetleyin: npm run db:tls-doctor (sertifika konuları listelenir; sır yazdırılmaz).',
      'Gerekirse dosya kökleriyle sistem köklerini birleştirin: POSTGRES_SSL_CA_MERGE_SYSTEM=1.',
      'Ağınızda TLS denetimi olabileceğini düşünüyorsanız kurum kökünü yalnızca yöneticinizden doğrulayarak NODE_EXTRA_CA_CERTS ile tanıtın.',
    ],
    trust,
  );
}

function trustLabel(result: ChainTrustResult | null): string {
  if (!result) return 'denetlenmedi';
  if (result.reason === 'no-anchors') return 'çapa yok';
  if (result.reason === 'no-chain') return 'zincir yok';
  return result.trusted ? `DOĞRULUYOR (${result.matched.map((entry) => entry.subjectCn).filter(Boolean).join(', ') || 'parmak izi eşleşmesi'})` : 'doğrulamıyor';
}

function finish(
  cause: TlsCause,
  headline: string,
  findings: string[],
  actions: string[],
  trust: TlsDiagnosis['trust'],
): TlsDiagnosis {
  return { cause, headline, findings, actions: actions.filter((line) => line.length > 0), trust };
}

/** CA dosyası raporunu tanılama girişine çevirir (doctor ve migrate aynı yolu kullanır). */
export function describeCaFileForDiagnosis(report: CaFileReport | null): string[] {
  if (!report) return ['POSTGRES_SSL_CA_FILE tanımlı değil: doğrulama sistem kökleriyle yapılıyor.'];
  const lines = [
    `POSTGRES_SSL_CA_FILE=${report.requestedPath}`,
    report.resolvedPath ? `Çözümlenen yol: ${report.resolvedPath}` : 'Dosya BULUNAMADI.',
    `Sertifika sayısı: ${report.certificates.length}`,
  ];
  for (const cert of report.certificates) {
    lines.push(
      `  - ${describeCertShort(cert)}: ${cert.subject} | ihraç eden: ${cert.issuer} | geçerlilik: ${cert.notBefore} → ${cert.notAfter}`,
    );
  }
  return lines;
}

/* ---------------------------------------------------------------------------
 * Yapılandırılmış uç nokta için tanı koşucusu
 *
 * `db:migrate`, `db:indexes`, `start` ve `db:tls-doctor` AYNI tanı metnini
 * üretmelidir: kullanıcı bir komutta gördüğü kök nedeni diğerinde de
 * bulabilmeli. Bu yüzden koşucu burada, biçimlendirme tek fonksiyonda.
 * ------------------------------------------------------------------------- */

/** Tanı için gereken etkin kararlar (src/config/env.ts yardımcılarıyla doldurulur). */
export interface DatabaseTlsConfig {
  /** Etkin bağlantı dizesi (postgresUrl() çıktısı). */
  postgresUrl: string;
  /** Etkin TLS kipi (postgresTlsMode() çıktısı). */
  mode: 'verify' | 'no-verify' | 'disable';
  /** POSTGRES_SSL_CA_FILE (boşsa tanımlı değil). */
  caFilePath?: string | null;
  /** POSTGRES_SSL_CA_MERGE_SYSTEM (postgresCaMergeSystem() çıktısı). */
  mergeSystem?: boolean;
  /** Sondaj zaman aşımı (ms). */
  timeoutMs?: number;
}

export interface DatabaseTlsReport {
  endpoint: EndpointInfo | null;
  probe: ProbeResult | null;
  caFileReport: CaFileReport | null;
  anchors: string[];
  diagnosis: TlsDiagnosis;
}

/**
 * Verilen yapılandırma için uç noktayı sondajlar ve tanıyı üretir.
 *
 * Sondaj yapılamazsa (URL çözümlenemedi, ağ yok) tanılama YAPILAMADI diye
 * `null` döner; çağıran bu durumda genel yardım metnini gösterir. Parola
 * gönderilmez, bağlantı dizesi döndürülmez.
 */
export async function diagnoseConfiguredDatabaseTls(
  config: DatabaseTlsConfig,
): Promise<DatabaseTlsReport | null> {
  const endpoint = describePostgresEndpoint(config.postgresUrl);
  if (!endpoint) return null;

  const caFileReport = config.caFilePath ? inspectCaFile(config.caFilePath) : null;
  const mergeSystem = Boolean(config.mergeSystem);

  let anchors: string[] = [];
  if (caFileReport) {
    try {
      anchors = loadTrustedCaCertificates(caFileReport.requestedPath, {
        mergeSystem,
        systemCaStore: () => {
          const store = systemTrustAnchors();
          return store.length > 0 ? store : undefined;
        },
      }).certificates;
    } catch {
      // Dosya kullanılamıyor: tanı bu durumu ZATEN raporlar, burada patlamaz.
      anchors = [];
    }
  } else {
    anchors = systemTrustAnchors();
  }

  let probe: ProbeResult | null = null;
  if (config.mode !== 'disable') {
    try {
      probe = await probePostgresTls({
        host: endpoint.host,
        port: endpoint.port,
        servername: endpoint.host,
        timeoutMs: config.timeoutMs ?? 10_000,
      });
    } catch {
      probe = null;
    }
  }
  if (!probe) return null;

  const diagnosis = diagnoseTls({
    probe,
    endpoint,
    caFileReport,
    fileAnchors: anchors,
    mergeSystem,
    mode: config.mode,
  });
  return { endpoint, probe, caFileReport, anchors, diagnosis };
}

/**
 * Tanıyı konsola yazılabilir satırlara çevirir.
 *
 * Sır içermez: yalnızca sunucu adı, sertifikanın herkese açık alanları ve
 * uygulanacak adımlar. `maxFindings` ile uzun zincir çıktıları sınırlanır.
 */
export function formatTlsDiagnosis(report: DatabaseTlsReport, options: { maxFindings?: number } = {}): string[] {
  const maxFindings = options.maxFindings ?? 12;
  const lines: string[] = [
    'Veritabanı TLS tanısı (otomatik; parola gönderilmeden sunucunun sunduğu zincir okundu):',
    `  Kök neden [${report.diagnosis.cause}]: ${report.diagnosis.headline}`,
  ];
  const findings = report.diagnosis.findings.slice(0, maxFindings);
  if (findings.length > 0) {
    lines.push('  Bulgular:');
    for (const finding of findings) lines.push(`    ${finding}`);
    if (report.diagnosis.findings.length > findings.length) {
      lines.push(`    … (${report.diagnosis.findings.length - findings.length} bulgu daha: npm run db:tls-doctor)`);
    }
  }
  lines.push('  Yapılacaklar:');
  for (const [index, action] of report.diagnosis.actions.entries()) lines.push(`    ${index + 1}. ${action}`);
  lines.push('  Ayrıntılı çıktı: npm run db:tls-doctor — kurulum: docs/database-tls.md');
  return lines;
}
