/**
 * Veritabanı TLS tanı aracı: `npm run db:tls-doctor`
 *
 * `SELF_SIGNED_CERT_IN_CHAIN` bir sonuçtur, neden değil. Bu betik nedeni
 * bulur: `.env` kararını, CA dosyasının içeriğini ve sunucunun GERÇEKTEN
 * sunduğu sertifika zincirini okur; hangi halkanın hangi güven kümesinde
 * olmadığını söyler ve uygulanacak adımı yazar.
 *
 * Gizlilik kuralları:
 *  - Parola/kimlik bilgisi GÖNDERİLMEZ: sonda yalnızca Postgres SSLRequest
 *    müzakeresini yürütür ve TLS el sıkışmasından zinciri okur (startup
 *    paketi yazılmaz, SQL çalıştırılmaz).
 *  - Bağlantı dizesi ASLA yazdırılmaz; yalnızca host:port ve veritabanı adı.
 *  - Sertifika alanları (subject/issuer/SAN/geçerlilik/parmak izi) herkese
 *    açık bilgilerdir; tanının kendisi bunlardır.
 *
 * Doğrulama hiçbir dalda kapatılmaz ve "kapat" önerilmez.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspectCaFile, formatCaFileIssues, describeCertShort, loadTrustedCaCertificates } from '../src/lib/ca-file';
import { envFileSource } from '../src/config/load-env';
import {
  getEnv,
  parseEnvWithoutValidation,
  hasPostgresConfig,
  postgresCaMergeSystem,
  postgresTlsMode,
  postgresUrl,
  postgresUrlTlsConflicts,
  type Env,
} from '../src/config/env';
import {
  describePostgresEndpoint,
  probePostgresTls,
  systemTrustAnchors,
  defaultTrustAnchors,
  type ProbeResult,
} from '../src/lib/pg-tls-probe';
import { diagnoseTls, describeCaFileForDiagnosis } from '../src/lib/tls-diagnosis';
import { SYSTEM_CA_MIN_NODE, systemCaStoreAvailable, describeTlsTrust } from '../src/lib/tls-trust';
import { safeErrorFields } from '../src/lib/safe-error';

interface Options {
  probe: boolean;
  timeoutMs: number;
  saveChain: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { probe: true, timeoutMs: 10_000, saveChain: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--no-probe' || arg === '--offline') options.probe = false;
    else if (arg === '--timeout') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        options.timeoutMs = value;
        index += 1;
      }
    } else if (arg === '--save-chain') {
      const value = argv[index + 1];
      if (value) {
        options.saveChain = value;
        index += 1;
      }
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return options;
}

function printUsage(): void {
  console.log(`Kullanım: npm run db:tls-doctor [-- --no-probe] [-- --timeout 15000] [-- --save-chain certs/observed-chain.pem]

  --no-probe     Canlı bağlantı denemeden yalnızca yapılandırmayı ve CA dosyasını denetler
  --timeout ms   Sondaj zaman aşımı (varsayılan 10000)
  --save-chain   Sunucunun sunduğu zinciri PEM olarak dosyaya yazar (İNCELEME amaçlı;
                 dosyayı CA olarak KULLANMAYIN — güven doğrulaması panelden yapılmalıdır)`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const problems: string[] = [];
  const warnings: string[] = [];

  console.log('Kamuİlan veritabanı TLS tanı aracı');
  console.log('==================================\n');

  /* 1) Node sürümü: sistem kök deposu API'si 22.15 ile geldi. */
  console.log('[1/6] Node sürümü');
  const nodeOk = satisfiesMinimumNode(process.version);
  console.log(`  Node ${process.version} — ${nodeOk ? 'uygun' : `ESKİ (en az ${SYSTEM_CA_MIN_NODE} gerekir)`}`);
  if (!nodeOk) {
    problems.push(`Node ${process.version} kullanıyorsunuz; sistem sertifika deposu için en az ${SYSTEM_CA_MIN_NODE} gerekir.`);
  }
  console.log(`  ${describeTlsTrust()}\n`);

  /* 2) .env ve etkin kararlar. */
  console.log('[2/6] Yapılandırma (.env)');
  let env: Env;
  try {
    env = getEnv();
  } catch (error) {
    // Fail-closed doğrulama sunucu/worker başlangıcını DURDURMALI (doğru davranış),
    // ama TANILAMA ARACINI durdurmamalı: eksik CA dosyası gibi sorunları çözecek
    // olan tam olarak bu betiktir. Eskiden burada "önce .env'i düzeltin" deyip
    // çıkıyordu; oysa .env'i düzeltmenin yolunu söyleyen araç buydu (kısır döngü).
    // Doğrulanmamış ayrıştırmayla devam edilir; bağlantı denemesi hiçbir dalda
    // sertifika doğrulamasını kapatmaz.
    const message = error instanceof Error ? error.message : String(error);
    const tolerant = parseEnvWithoutValidation();
    if (!tolerant.ok) {
      console.error(`  ✖ Ortam okunamadı: ${message}`);
      console.error(`    Ayrıştırma da başarısız: ${tolerant.issues.join('; ')}`);
      console.error('\nTanılama devam edemiyor: npm run env:setup ile değerleri düzeltin.');
      process.exitCode = 1;
      return;
    }
    env = tolerant.env;
    console.log('  ⚠ Ortam DOĞRULAMASI başarısız; tanılama doğrulanmamış değerlerle sürdürülüyor.');
    console.log(`    Neden: ${message.split('\n').join('\n    ')}`);
    console.log('    Bu yapılandırmayla sunucu/worker BAŞLAMAZ (fail-closed) — doğru olan da bu.');
    console.log('    Tanılama doğrulamayı hiçbir dalda kapatmaz; onarım adımları aşağıda.\n');
    problems.push(`Ortam doğrulaması başarısız: ${message.replace(/\n\s*/g, ' ')}`);
  }
  console.log(`  .env dosyası: ${envFileSource() ?? 'okunmadı (yalnızca ortam değişkenleri)'}`);
  console.log(`  Çalışma dizini: ${process.cwd()}`);

  if (!hasPostgresConfig(env)) {
    console.log('  POSTGRES_URL/DATABASE_URL tanımlı değil: veritabanı TLS tanısı yapılamaz.');
    console.log('\n✖ Tanı için POSTGRES_URL gerekli (Supabase → Project Settings → Database).');
    process.exitCode = 1;
    return;
  }

  let url: string;
  try {
    url = postgresUrl(env);
  } catch (error) {
    console.error(`  ✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const endpoint = describePostgresEndpoint(url);
  if (!endpoint) {
    console.error('  ✖ POSTGRES_URL postgres:// biçiminde çözümlenemedi.');
    process.exitCode = 1;
    return;
  }
  const mode = postgresTlsMode(env);
  const merge = postgresCaMergeSystem(env);
  console.log(`  Uç nokta: ${endpoint.host}:${endpoint.port} (veritabanı: ${endpoint.database}, kullanıcı: ${endpoint.user})`);
  console.log(`  Tür: ${endpoint.kindLabel}${endpoint.projectRef ? ` — proje referansı ${endpoint.projectRef}` : ''}`);
  console.log(`  TLS kipi: ${mode}${env.POSTGRES_SSL_CA_FILE ? ` | CA dosyası: ${env.POSTGRES_SSL_CA_FILE}` : ' | CA dosyası: yok'}`);
  console.log(`  Sistem kökleriyle birleştirme (POSTGRES_SSL_CA_MERGE_SYSTEM): ${merge ? 'AÇIK' : 'kapalı'}\n`);

  const urlConflicts = postgresUrlTlsConflicts(url);
  if (urlConflicts.length > 0) {
    problems.push(`Bağlantı dizesinde TLS parametresi var (${urlConflicts.join(', ')}): POSTGRES_SSL_MODE kararını ezer; URL'den kaldırın.`);
  }
  if (mode === 'no-verify') {
    problems.push('POSTGRES_SSL_MODE=no-verify: sunucu sertifikası doğrulanmıyor. Bu tanı aracı doğrulamayı geri açmanızı önerir; MITM riski vardır.');
  }
  if (mode === 'disable') {
    warnings.push('POSTGRES_SSL_MODE=disable (veya POSTGRES_SSL=0): TLS hiç kullanılmıyor, trafik şifrelenmiyor.');
  }
  if (!systemCaStoreAvailable()) {
    warnings.push(`Node sistem sertifika deposu API'si yok (${SYSTEM_CA_MIN_NODE} altı sürüm). Gömülü kökler kullanılıyor.`);
  }

  /* 3) CA dosyası denetimi. */
  console.log('[3/6] CA dosyası (POSTGRES_SSL_CA_FILE)');
  const report = env.POSTGRES_SSL_CA_FILE ? inspectCaFile(env.POSTGRES_SSL_CA_FILE) : null;
  if (!report) {
    console.log('  Tanımlı değil: doğrulama Node gömülü kökleri + sistem deposu + NODE_EXTRA_CA_CERTS ile yapılır.');
    console.log(`  Sistem kök sayısı: ${systemTrustAnchors().length} | Node gömülü kök sayısı: ${defaultTrustAnchors().length}`);
  } else {
    console.log(`  İstenen yol: ${report.requestedPath}`);
    console.log(`  Çözümlenen yol: ${report.resolvedPath ?? 'BULUNAMADI'}`);
    if (!report.exists) {
      console.log('  Denenen yollar:');
      for (const candidate of report.candidates) console.log(`    - ${candidate}`);
      // En sık gerçek durum: yol .env'e yazılmış ama dosya hiç oluşturulmamış.
      // Kullanıcıya üç somut çıkış yolu verilir (hangisinin uygun olduğuna
      // [5/6] sondajındaki zincir ve parmak izleri karar verir).
      console.log('  ✖ Dosya YOK: .env yolu bildiriyor ama diskte değil. Onarım seçenekleri:');
      console.log('    A) Sunucunun sunduğu zinciri bu yola yazın, SONRA [5/6] dökümündeki kök');
      console.log('       parmak izini sağlayıcının yayımladığı kökle karşılaştırın:');
      console.log(`         npm run db:tls-doctor -- --save-chain ${report.requestedPath}`);
      if (mode === 'no-verify' || mode === 'disable') {
        console.log('       UYARI: POSTGRES_SSL_MODE şu an doğrulamayı kapatıyor; önce kipi verify');
        console.log('              yapın, yoksa araya giren (proxy) zincirini kaydedebilirsiniz.');
      }
      console.log('    B) Sağlayıcının resmî kökünü indirip aynı yola koyun');
      console.log('       (Supabase: Project Settings → Database → CA certificate; docs/database-tls.md).');
      console.log('    C) CA dosyası kullanmak istemiyorsanız anahtarı .env dosyasından kaldırın; güven');
      console.log('       sistem kökleri + Node gömülü kökleri + NODE_EXTRA_CA_CERTS ile kurulur:');
      console.log('         npm run env:setup -- --only POSTGRES_SSL_CA_FILE');
    }
    console.log(`  Sertifika sayısı: ${report.certificates.length}`);
    for (const cert of report.certificates) {
      console.log(
        `    - ${describeCertShort(cert)}: ${cert.subject} | ihraç eden: ${cert.issuer} | ${cert.notBefore} → ${cert.notAfter} | ${cert.fingerprint}`,
      );
    }
    for (const line of formatCaFileIssues(report, '  ')) console.log(line);
    for (const entry of report.issues) if (entry.blocking) problems.push(`CA dosyası: ${entry.message.replace(/\n\s*/g, ' ')}`);
    for (const entry of report.warnings) warnings.push(`CA dosyası: ${entry.message.replace(/\n\s*/g, ' ')}`);
    if (report.usable && !merge) {
      console.log('  Not: dosya tanımlı olduğu için sistem kökleri KULLANILMIYOR (yalnızca bu dosya).');
      console.log('       Birleştirmek isterseniz: POSTGRES_SSL_CA_MERGE_SYSTEM=1');
    }
  }
  console.log('');

  /* 4) Etkin güven kümesi. */
  console.log('[4/6] Etkin güven kümesi');
  let effectiveAnchors: string[] = [];
  try {
    if (env.POSTGRES_SSL_CA_FILE) {
      const loaded = loadTrustedCaCertificates(env.POSTGRES_SSL_CA_FILE, { mergeSystem: merge, systemCaStore: systemTrustAnchorsOrUndefined });
      effectiveAnchors = loaded.certificates;
      console.log(
        `  CA dosyası kökleri: ${report?.certificates.length ?? 0} | birleştirme: ${merge ? 'açık' : 'kapalı'} | toplam çapa: ${effectiveAnchors.length}`,
      );
    } else {
      effectiveAnchors = systemTrustAnchors();
      console.log(`  Sistem kök deposu çapa sayısı: ${effectiveAnchors.length}`);
    }
  } catch (error) {
    console.error(`  ✖ ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  console.log('');

  /* 5) Canlı sondaj. */
  console.log('[5/6] Sunucunun sunduğu zincir (parola gönderilmez)');
  let probe: ProbeResult | null = null;
  if (!options.probe) {
    console.log('  Atlandı (--no-probe).\n');
  } else if (mode === 'disable') {
    console.log('  TLS kapalı olduğu için sondaj anlamsız; atlandı.\n');
  } else {
    probe = await probePostgresTls({
      host: endpoint.host,
      port: endpoint.port,
      servername: endpoint.host,
      timeoutMs: options.timeoutMs,
    });
    if (!probe.ok) {
      console.log(`  ✖ Sondaj başarısız: ${probe.failure ?? 'bilinmeyen'}${probe.errorCode ? ` (${probe.errorCode})` : ''}`);
      if (probe.errorMessage) console.log(`    ${probe.errorMessage}`);
    } else {
      console.log(`  TLS desteği: ${probe.tlsSupported ? 'var (S)' : 'yok (N)'}`);
      console.log(`  Sunulan zincir (${probe.chain.length} sertifika):`);
      for (const entry of probe.chain) {
        console.log(
          `    [${entry.depth}] ${entry.subjectCn || entry.subject}\n        ihraç eden: ${entry.issuerCn || entry.issuer}` +
            `\n        geçerlilik: ${entry.validFrom} → ${entry.validTo}` +
            `\n        ${entry.selfSigned ? 'kendi kendini imzalayan kök' : 'ara/leaf sertifika'}${entry.isCa ? ' (CA)' : ' (CA değil)'}` +
            `\n        SAN: ${entry.subjectAltNames || '(yok)'}\n        parmak izi (SHA-256): ${entry.fingerprint}`,
        );
      }
      console.log(`  Sunucu adı doğrulaması: ${probe.hostnameMatch === null ? 'yapılamadı' : probe.hostnameMatch ? 'UYUMLU' : `UYUŞMUYOR — ${probe.hostnameError ?? ''}`}`);
      if (probe.clockSkew) console.log(`  Saat uyarısı: ${probe.clockSkew === 'expired' ? 'sertifika süresi dolmuş görünüyor' : 'sertifika henüz geçerli değil'}`);

      if (options.saveChain) {
        const target = resolve(process.cwd(), options.saveChain);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${probe.chain.map((entry) => entry.pem).join('\n')}\n`, 'utf8');
        console.log(`  Zincir kaydedildi: ${target}`);
        console.log('    UYARI: bu dosya sunucunun KENDİ BEYANIDIR; CA olarak KULLANMAYIN.');
        console.log('    Güvenilir kökü yalnızca Supabase panosundan ya da kurum yöneticinizden alın.');
      }
    }
    console.log('');
  }

  /* 6) Tanı ve eylemler. */
  console.log('[6/6] Tanı');
  const diagnosis = diagnoseTls({
    probe,
    endpoint,
    caFileReport: report,
    fileAnchors: effectiveAnchors,
    mergeSystem: merge,
    mode,
  });
  console.log(`  Kök neden (${diagnosis.cause}): ${diagnosis.headline}`);
  if (diagnosis.findings.length > 0) {
    console.log('\n  Bulgular:');
    for (const finding of diagnosis.findings) console.log(`    ${finding}`);
  }
  console.log('\n  Yapılacaklar:');
  for (const [index, action] of diagnosis.actions.entries()) console.log(`    ${index + 1}. ${action}`);

  if (report) {
    console.log('\n  CA dosyası özeti:');
    for (const line of describeCaFileForDiagnosis(report)) console.log(`    ${line}`);
  }

  if (warnings.length > 0) {
    console.log('\nUyarılar:');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  if (problems.length > 0) {
    console.error('\nSorunlar:');
    for (const problem of problems) console.error(`  ✖ ${problem}`);
    console.error('\n✖ Veritabanı TLS yapılandırması kullanılamaz. Yukarıdaki adımları uygulayın.');
    console.error('  Doğrulamayı kapatmak (no-verify / NODE_TLS_REJECT_UNAUTHORIZED=0) çözüm değildir.');
    process.exitCode = 1;
    return;
  }

  const resolved =
    diagnosis.cause === 'trusted-by-file' || (probe?.ok === true && diagnosis.trust.file?.trusted === true);
  if (!options.probe) {
    console.log('\n✔ Yapılandırma ve CA dosyası tutarlı (canlı sondaj atlandı: --no-probe).');
    return;
  }
  if (resolved) {
    console.log('\n✔ Zincir geçerli güven kümesiyle doğrulanıyor. Bağlantı hâlâ kopuyorsa neden TLS dışıdır.');
    return;
  }
  console.log('\n✖ Zincir doğrulanamadı. Yukarıdaki "Yapılacaklar" listesini uygulayın.');
  process.exitCode = 1;
}

function systemTrustAnchorsOrUndefined(): string[] | undefined {
  const anchors = systemTrustAnchors();
  return anchors.length > 0 ? anchors : undefined;
}

function satisfiesMinimumNode(version: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number(part) || 0);
  const actual = parse(version);
  const required = parse(SYSTEM_CA_MIN_NODE);
  for (let index = 0; index < 3; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

main().catch((error: unknown) => {
  console.error('Tanı aracı beklenmeyen bir hatayla durdu:', safeErrorFields(error));
  console.error('Ayrıntılar: docs/database-tls.md');
  process.exitCode = 1;
});
