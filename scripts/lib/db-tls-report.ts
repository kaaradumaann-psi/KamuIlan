/**
 * Bakım/kurulum betiklerinin ortak TLS tanı girişi.
 *
 * Neden ortak: `db:migrate`, `db:indexes`, `seed:*` ve `npm run dev` aynı
 * bağlantıyı kullanır; kullanıcının `SELF_SIGNED_CERT_IN_CHAIN` karşısında
 * göreceği tanı da aynı olmalıdır. Her betiğin kendi yardım metnini yazması
 * "bir komutta çözülen sorun diğerinde anlaşılmaz" sonucunu doğurur.
 *
 * Bu betikler operatör araçlarıdır; `src/` altında sır yazdırmama kuralına
 * tabidir: tanı çıktısında bağlantı dizesi, parola ve veri yer almaz.
 */
import {
  getEnv,
  hasPostgresConfig,
  postgresCaMergeSystem,
  postgresTlsMode,
  postgresUrl,
} from '../../src/config/env';
import {
  diagnoseConfiguredDatabaseTls,
  formatTlsDiagnosis,
  type DatabaseTlsReport,
} from '../../src/lib/tls-diagnosis';

/** TLS zinciri hatası olduğunu gösteren Node/OpenSSL kodları. */
const TLS_CHAIN_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
]);

/** Hata, TLS zinciri/doğrulama kaynaklı mı? (ham mesaj incelenmez; yalnızca kod) */
export function isDatabaseTlsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TLS_CHAIN_CODES.has(code)) return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause && cause !== error) return isDatabaseTlsError(cause);
  return false;
}

/**
 * Etkin `.env` yapılandırması için canlı TLS tanısı üretir.
 *
 * Postgres tanımlı değilse ya da tanı üretilemezse `null` döner; çağıran
 * bu durumda genel yardım metnini (`databaseTlsHelp`) göstermeye devam eder.
 */
export async function runDatabaseTlsDiagnosis(
  options: { timeoutMs?: number } = {},
): Promise<DatabaseTlsReport | null> {
  let env;
  try {
    env = getEnv();
  } catch {
    return null;
  }
  if (!hasPostgresConfig(env)) return null;
  let url: string;
  try {
    url = postgresUrl(env);
  } catch {
    return null;
  }
  return diagnoseConfiguredDatabaseTls({
    postgresUrl: url,
    mode: postgresTlsMode(env),
    caFilePath: env.POSTGRES_SSL_CA_FILE || null,
    mergeSystem: postgresCaMergeSystem(env),
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

/** Tanıyı standart hata akışına yazar (betik catch blokları kullanır). */
export function printDatabaseTlsDiagnosis(report: DatabaseTlsReport): void {
  for (const line of formatTlsDiagnosis(report)) console.error(line);
}

/**
 * Tek çağrılık kolaylık: hata TLS kaynaklıysa tanıyı üretir ve yazar.
 *
 * @returns Tanı yazıldıysa `true` (çağıran genel yardım metnini atlayabilir).
 */
export async function reportDatabaseTlsFailure(
  error: unknown,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!isDatabaseTlsError(error)) return false;
  const report = await runDatabaseTlsDiagnosis(options);
  if (!report) return false;
  printDatabaseTlsDiagnosis(report);
  return true;
}
