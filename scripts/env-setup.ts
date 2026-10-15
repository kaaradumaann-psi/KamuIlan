/**
 * Etkileşimli ortam kurulum sihirbazı: `npm run env:setup`
 *
 * Ne yapar:
 *  1. Mevcut `.env` (ve gerçek ortam değişkenlerini) okur — doğrulama
 *     BAŞARISIZ olsa bile, çünkü sihirbazın işi tam da o hatayı düzeltmektir.
 *  2. Tüm ayarları grup grup inceler: eksik, boş ya da GEÇERSİZ olanları sorar.
 *  3. Kullanıcının verdiği değeri tür/kural denetiminden geçirir; riskli bir
 *     karar (TLS doğrulamasını kapatmak, kısa APP_SECRET) ek onay ister.
 *  4. Değişen anahtarları `.env` dosyasına YAZAR: yorumlar korunur, yazmadan
 *     önce `.env.yedek-<zaman>` kopyası alınır, dosya atomik değiştirilir.
 *  5. Yazdıktan sonra gerçek denetimi (`getEnv` + `inspectEnvironment`) ve
 *     veritabanı seçildiyse TLS tanısını çalıştırır; sonucu maskeli özetler.
 *
 * Kullanım:
 *   npm run env:setup                       :: eksik/geçersiz alanları sorar
 *   npm run env:setup -- --all              :: tüm alanları baştan sorar
 *   npm run env:setup -- --check            :: sormadan mevcut durumu raporlar
 *   npm run env:setup -- --only LLM_API_KEY,LLM_MODEL
 *   npm run env:setup -- --group llm,eposta
 *   npm run env:setup -- --set LLM_MODEL=gemini-2.5-flash --set APP_SECRET=...
 *   npm run env:setup -- --answers cevaplar.txt   (KEY=value satırları; betik/CI)
 *   npm run env:setup -- --file .env.production
 *
 * Gizlilik: sırlar ekranda maskelenir; `.env` dosyası `.gitignore` içindedir ve
 * sihirbaz hiçbir değeri günlüğe yazmaz. Sır DEĞERİ uydurulmaz — yalnızca nasıl
 * üretileceği gösterilir.
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  getEnv,
  inspectEnvironment,
  describeEnv,
  parseEnvWithoutValidation,
  postgresCaMergeSystem,
  postgresTlsMode,
  postgresUrl,
  hasPostgresConfig,
  resetEnvCache,
} from '../src/config/env';
import { applyEnvValues, envOverridesFromFile, parseEnvFile, resetEnvFileState } from '../src/config/load-env';
import { writeEnvFile } from '../src/config/env-file';
import {
  ENV_FIELD_BY_KEY,
  ENV_GROUP_LABELS,
  isFieldApplicable,
  maskValue,
  summarizeMissingFields,
  summarizeTlsDecision,
  validateFieldValue,
  type EnvFieldSpec,
  type EnvGroup,
} from '../src/config/env-spec';
import {
  buildChangeSummary,
  buildFieldStatus,
  buildPromptPlan,
  buildValuesToWrite,
  processAnswer,
  riskyDecision,
  unknownKeys,
  type PromptPlanStep,
  type PromptScope,
} from '../src/config/env-prompt';
import { inspectCaFile, formatCaFileIssues } from '../src/lib/ca-file';
import { describeTlsTrust } from '../src/lib/tls-trust';
import { runDatabaseTlsDiagnosis } from './lib/db-tls-report';
import { formatTlsDiagnosis } from '../src/lib/tls-diagnosis';

interface Options {
  file: string;
  scope: PromptScope;
  only: string[];
  groups: EnvGroup[];
  check: boolean;
  yes: boolean;
  set: Record<string, string>;
  answers: string | null;
  backup: boolean;
}

const GROUP_NAMES = Object.keys(ENV_GROUP_LABELS) as EnvGroup[];

function printUsage(): void {
  console.log(`Kullanım: npm run env:setup [-- seçenekler]

Seçenekler:
  --check              Sormadan tüm ayarları inceler ve raporu yazar (maskeli)
  --all                Tüm alanları baştan sorar (varsayılan: eksik/geçersiz olanlar)
  --missing            Yalnızca boş alanları sorar
  --only A,B           Yalnızca bu anahtarları sorar
  --group llm,eposta   Yalnızca bu grupları sorar (${GROUP_NAMES.join(', ')})
  --set KEY=VALUE      Sormadan değer yazar (tekrarlanabilir)
  --answers DOSYA      KEY=value satırlarını dosyadan okur (etkileşimsiz kurulum)
  --file .env.production  Hedef dosya (varsayılan: .env)
  --no-backup          Yedek almadan yazar (önerilmez)
  --yes                Yazma onayını atlar

Soru sırasında komutlar:
  :skip   bu soruyu atla (mevcut değer korunur)
  :clear  alanı boşalt (zorunlu alanlarda kullanılamaz)
  :help   alanın açıklamasını göster
  :quit   hiçbir şey yazmadan çık
  Boş Enter  mevcut değeri korur; değer yoksa varsayılanı kullanır
  !değer     riskli kararı AÇIKÇA onaylar (ör. !no-verify)`);
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    file: '.env',
    scope: 'required-first',
    only: [],
    groups: [],
    check: false,
    yes: false,
    set: {},
    answers: null,
    backup: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} için değer gerekli.`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--check') options.check = true;
    else if (arg === '--all') options.scope = 'all';
    else if (arg === '--missing') options.scope = 'missing';
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-backup') options.backup = false;
    else if (arg === '--file') options.file = next();
    else if (arg === '--only') options.only = next().split(',').map((part) => part.trim()).filter(Boolean);
    else if (arg === '--group') {
      options.groups = next()
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part): part is EnvGroup => GROUP_NAMES.includes(part as EnvGroup));
    } else if (arg === '--set') {
      const pair = next();
      const separator = pair.indexOf('=');
      if (separator <= 0) throw new Error(`--set KEY=VALUE biçiminde olmalıdır: ${pair}`);
      options.set[pair.slice(0, separator).trim()] = pair.slice(separator + 1);
    } else if (arg === '--answers') options.answers = next();
    else throw new Error(`Bilinmeyen seçenek: ${arg} (yardım: npm run env:setup -- --help)`);
  }
  return options;
}

/** Mevcut değerler: `.env` dosyası + gerçek ortam (gerçek ortam önceliklidir). */
/**
 * Hedef dosyayı okur ve süreç ortamıyla karşılaştırır.
 *
 * Öncelik sırası: HEDEF DOSYA → süreç ortamı (yalnızca dosyada olmayan
 * anahtarlar). Neden dosya önce: sihirbazın yazdığı yer dosyadır; kabukta
 * tanımlı bir değişken (Windows'ta `setx`, PowerShell `$env:`) dosyayı
 * GÖLGELEYEBİLİR ve bu durumda dosyaya yazılan değer hiç devreye girmez.
 * Bu çakışmalar sessizce yutulmaz: `overridden` olarak döner, ekranda uyarı
 * çıkar ve ilgili alan sorulur (kullanıcı hangi değerin kazanacağına karar verir).
 *
 * İstisna NODE_ENV: uygulama kipini seçen anahtardır ve süreç ortamından
 * gelmesi beklenir (ör. `NODE_ENV=production npm run env:setup`).
 */
function readCurrentValues(filePath: string): {
  values: Record<string, string>;
  fileValues: Record<string, string>;
  overridden: string[];
  fileExists: boolean;
} {
  const fileValues: Record<string, string> = {};
  const fileExists = existsSync(filePath);
  if (fileExists) {
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(filePath, 'utf8')))) {
      fileValues[key] = value;
    }
  }
  const values: Record<string, string> = { ...fileValues };
  for (const key of ENV_FIELD_BY_KEY.keys()) {
    const fromProcess = process.env[key];
    if (typeof fromProcess !== 'string' || fromProcess === '') continue;
    if (key in fileValues) continue;
    values[key] = fromProcess;
  }
  if (values.NODE_ENV === undefined || values.NODE_ENV === '') {
    values.NODE_ENV = process.env.NODE_ENV?.trim() || 'development';
  }
  const overridden = envOverridesFromFile(fileValues, [...ENV_FIELD_BY_KEY.keys()], process.env).filter(
    (key) => key !== 'NODE_ENV',
  );
  return { values, fileValues, overridden, fileExists };
}

async function promptOnce(question: string, secret: boolean): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const hideInput = secret && stdin.isTTY === true && process.platform !== 'win32';
  if (hideInput) {
    // POSIX: gizli giriş için ham mod + çıktı susturma.
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* ham mod desteklenmiyorsa normal giriş */
    }
  }
  const rl = createInterface({ input: stdin, output: hideInput ? undefined : stdout, terminal: true });
  let muted = false;
  const onData = (chunk: Buffer): void => {
    if (!hideInput || !muted) return;
    const text = chunk.toString('utf8');
    if (text === '\r' || text === '\n') stdout.write('\n');
    // Girilen karakterler ekrana YANSITILMAZ (parola okunabilir kalmasın).
  };
  return new Promise<string>((resolveAnswer) => {
    if (hideInput) {
      stdin.on('data', onData);
      stdout.write(question);
      muted = true;
    }
    rl.question(hideInput ? '' : question, (answer) => {
      muted = false;
      if (hideInput) {
        stdin.off('data', onData);
        try {
          stdin.setRawMode?.(false);
        } catch {
          /* yoksay */
        }
        stdout.write('\n');
      }
      rl.close();
      resolveAnswer(answer);
    });
    rl.on('close', () => {
      if (hideInput) {
        stdin.off('data', onData);
        try {
          stdin.setRawMode?.(false);
        } catch {
          /* yoksay */
        }
      }
    });
  });
}

function buildQuestion(step: PromptPlanStep, values: Record<string, string>): string {
  const field = step.field;
  const parts: string[] = [];
  parts.push(`\n▶ ${field.label}  [${field.key}]${step.required ? '  (ZORUNLU)' : ''}`);
  parts.push(`  ${field.help}`);
  if (field.example) parts.push(`  Örnek: ${field.example}`);
  if (field.options) parts.push(`  Seçenekler: ${field.options.map((option) => option || '(boş)').join(' | ')}`);
  if (field.defaultValue !== undefined) parts.push(`  Varsayılan: ${field.defaultValue || '(boş)'}`);
  if (step.current !== '') parts.push(`  Mevcut: ${maskValue(field, step.current)}`);
  const required = field.requiredInProduction && (values['NODE_ENV'] ?? 'development') === 'production';
  parts.push(
    `  Değer${field.secret ? ' (gizli girilir)' : ''}${required ? ' [üretimde zorunlu]' : ''} (:skip atla, :clear boşalt, :help açıklama, :quit çık): `,
  );
  return parts.join('\n');
}

/** Bir soruyu, doğrulanana dek (en çok 3 deneme) sorar. */
async function askStep(
  step: PromptPlanStep,
  values: Record<string, string>,
  pathRoot: string,
): Promise<{ value: string | null; quit: boolean }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const question = buildQuestion(step, values);
    const answer = await promptOnce(question, Boolean(step.field.secret));
    if (answer.trim().toLowerCase() === ':quit') return { value: null, quit: true };
    const result = processAnswer(step, answer, values, { pathRoot });
    if (answer.trim().toLowerCase() === ':help') {
      console.log(`  ${step.field.help}`);
      continue;
    }
    if (result.skipped) return { value: step.current, quit: false };
    if (!result.ok) {
      console.log(`  ✖ ${result.message ?? 'Geçersiz değer; yeniden deneyin.'}`);
      continue;
    }
    if (result.message) console.log(`  ! ${result.message}`);
    return { value: result.value, quit: false };
  }
  console.error(`  ✖ ${step.field.key} için 3 geçersiz giriş; sihirbaz durduruldu (dosyaya yazılmadı).`);
  return { value: null, quit: true };
}

/** Alan + mevcut değerden soru adımı üretir (doğrulama/cevap işleme için). */
function stepFor(field: EnvFieldSpec, values: Record<string, string>): PromptPlanStep {
  return {
    field,
    group: field.group,
    current: values[field.key] ?? '',
    required: false,
    applicable: true,
  };
}

function printStatus(values: Record<string, string>, pathRoot: string): void {
  const status = buildFieldStatus(values, { pathRoot });
  for (const group of status.groups) {
    console.log(`\n${group.label}:`);
    for (const row of group.rows) console.log(`  ${row}`);
  }
  if (status.problems.length > 0) {
    console.error('\nSorunlar:');
    for (const problem of status.problems) console.error(`  ✖ ${problem}`);
  } else {
    console.log('\n✔ Katalog denetimi: alan bazında sorun bulunamadı.');
  }
  const summary = summarizeMissingFields(values);
  if (summary.missing.length > 0) console.log(`\nEksik zorunlu alanlar: ${summary.missing.join(', ')}`);
}

async function main(): Promise<void> {
  // `NODE_ENV=test` altında çalışan bir süreçten çağrılırsa (ör. test paketi)
  // tests/setup.ts'in verdiği değerler sihirbazın kararını bozar: .env zaten
  // yüklenmez ve APP_SECRET/DATA_DIR dışarıdan gelir. Bu anahtarlar yok sayılır.
  if (process.env.NODE_ENV === 'test') {
    for (const key of ['APP_SECRET', 'DATA_DIR', 'SOURCE_LIVE_FETCH', 'KAMUILAN_TEST_DATA_DIR']) {
      delete process.env[key];
    }
  }
  const options = parseOptions(process.argv.slice(2));
  const filePath = resolvePath(process.cwd(), options.file);
  const { values: initial, fileValues, overridden, fileExists } = readCurrentValues(filePath);

  console.log('Kamuİlan ortam kurulum sihirbazı (env:setup)');
  console.log('============================================');
  console.log(`Hedef dosya: ${filePath}${fileExists ? '' : ' (yok; oluşturulacak)'}`);
  console.log(`Çalışma dizini: ${process.cwd()}`);
  console.log(`Node: ${process.version}`);
  console.log(describeTlsTrust());

  const values: Record<string, string> = { ...initial };

  // --set: sormadan yaz (betik/CI yolu). Bilinmeyen anahtar erken reddedilir.
  const unknown = unknownKeys([...Object.keys(options.set), ...options.only]);
  if (unknown.length > 0) {
    console.error(`\n✖ Bilinmeyen anahtar: ${unknown.join(', ')}`);
    console.error('  Katalog: npm run env:setup -- --check');
    process.exitCode = 1;
    return;
  }
  // Bu koşumda KULLANICININ verdiği değerler (soru ya da --set/--answers).
  // Yalnızca bu küme dosyaya yazılır; sihirbaz kendi kendine değer uydurmaz.
  const explicitWrites: Record<string, string> = {};
  for (const [key, raw] of Object.entries(options.set)) {
    const field = ENV_FIELD_BY_KEY.get(key);
    if (!field) continue;
    const validation = validateFieldValue(field, raw, values, { pathRoot: dirname(filePath) });
    if (!validation.ok) {
      console.error(`\n✖ ${key}: ${validation.message}`);
      process.exitCode = 1;
      return;
    }
    // `--set` etkileşimsizdir: doğrulamayı kapatan / zayıflatan bir değer burada
    // ONAYLANAMAZ. Kullanıcı ya sihirbazı etkileşimli çalıştırır (!öneki) ya da
    // cevap dosyasında değerin başına "!" koyarak riski açıkça kabul eder.
    const risky = riskyDecision(field, raw.trim());
    if (risky) {
      console.error(`\n✖ ${key}: ${risky}`);
      console.error(`  Etkileşimli onay: npm run env:setup -- --only ${key}   (değer: !${raw.trim()})`);
      process.exitCode = 1;
      return;
    }
    values[key] = raw.trim();
    explicitWrites[key] = raw.trim();
    console.log(`\n· ${key}=${maskValue(field, raw.trim())} (--set)`);
  }

  // --answers: KEY=value satırları (etkileşimsiz).
  const providedByAnswers: Record<string, string> = {};
  if (options.answers) {
    const answersPath = resolvePath(process.cwd(), options.answers);
    if (!existsSync(answersPath)) {
      console.error(`\n✖ Cevap dosyası yok: ${answersPath}`);
      process.exitCode = 1;
      return;
    }
    for (const [key, raw] of Object.entries(parseEnvFile(readFileSync(answersPath, 'utf8')))) {
      const field = ENV_FIELD_BY_KEY.get(key);
      if (!field) {
        console.log(`\n! Bilinmeyen anahtar atlandı: ${key}`);
        continue;
      }
      // Cevap dosyası da etkileşimsizdir: riskli değer yalnızca başına "!"
      // konarak (bilinçli kabul) yazılır.
      const answer = processAnswer(stepFor(field, values), raw, values, { pathRoot: dirname(filePath) });
      if (!answer.ok) {
        console.error(`\n✖ ${key}: ${answer.message}`);
        process.exitCode = 1;
        return;
      }
      values[key] = answer.value;
      providedByAnswers[key] = answer.value;
      explicitWrites[key] = answer.value;
      const risky = riskyDecision(field, answer.value);
      console.log(
        `\n· ${key}=${maskValue(field, answer.value)} (cevap dosyası${risky ? ' · RİSK AÇIKÇA KABUL EDİLDİ' : ''})`,
      );
    }
  }

  if (overridden.length > 0) {
    console.log('\n! Süreç ortamı dosyayı gölgeliyor (çalışma zamanında ORTAM DEĞİŞKENİ kazanır):');
    for (const key of overridden) {
      const field = ENV_FIELD_BY_KEY.get(key);
      const fromFile = key in fileValues ? fileValues[key] ?? '' : null;
      const inFile = fromFile === null ? '(dosyada yok)' : field ? maskValue(field, fromFile) : fromFile;
      const inProcess = field ? maskValue(field, process.env[key] ?? '') : (process.env[key] ?? '');
      console.log(`  - ${key}: dosyada ${inFile} · ortamda ${inProcess}`);
    }
    console.log('  Bu alanlar aşağıda sorulacak; Windows\'ta kalıcı değişkeni kaldırmak için:');
    console.log('    setx KEY ""        (yeni kabuklarda etkili olur) ya da Sistem Özellikleri → Ortam Değişkenleri');
  }

  if (options.check) {
    printStatus(values, dirname(filePath));
    await printPostChecks(values, filePath);
    return;
  }

  // Plan, --set/--answers uygulandıktan SONRA kurulur: kullanıcının bu koşumda
  // açıkça verdiği alan yeniden sorulmaz ve bağımlılıklar güncel değerle çözülür.
  const explicitlyProvided = new Set([...Object.keys(options.set), ...Object.keys(providedByAnswers)]);
  const plan = buildPromptPlan(values, {
    scope: options.scope,
    pathRoot: dirname(filePath),
    only: options.only.length > 0 ? options.only : undefined,
    groups: options.groups.length > 0 ? options.groups : undefined,
    attention: overridden.filter((key) => !explicitlyProvided.has(key)),
  });
  plan.steps = plan.steps.filter((step) => !explicitlyProvided.has(step.field.key));
  plan.groups = plan.groups
    .map((group) => ({ ...group, steps: group.steps.filter((step) => !explicitlyProvided.has(step.field.key)) }))
    .filter((group) => group.steps.length > 0);

  if (plan.skipped.length > 0 && options.scope === 'all') {
    console.log('\nAtlanan alanlar (bağımlılığı sağlanmıyor):');
    for (const step of plan.skipped) console.log(`  - ${step.field.key}: ${step.skipReason ?? 'koşul sağlanmıyor'}`);
  }

  if (plan.steps.length === 0) {
    console.log('\n✔ Sorulacak alan yok: katalogdaki zorunlu/geçersiz alan bulunamadı.');
    await finalize(explicitWrites, initial, values, filePath, options);
    return;
  }

  const interactive = process.stdin.isTTY === true;
  if (!interactive) {
    console.error(
      `\n✖ ${plan.steps.length} alan eksik/geçersiz ve giriş etkileşimli değil (TTY yok). ` +
        'Cevapları dosyayla verin: npm run env:setup -- --answers cevaplar.txt',
    );
    console.error('Eksik alanlar:');
    for (const step of plan.steps) console.error(`  - ${step.field.key}: ${step.field.label}`);
    if (Object.keys(explicitWrites).length > 0) {
      console.error('\nBu koşumda verilen değerler yine de yazılacak (eksikler için tekrar çalıştırın):');
      await finalize(explicitWrites, initial, values, filePath, options);
    } else {
      process.exitCode = 1;
    }
    return;
  }

  console.log(`\n${plan.steps.length} alan sorulacak. Değerleri girin; sırlar ekranda maskelenir.`);
  const collected: Record<string, string> = {};
  let currentGroup: EnvGroup | null = null;
  for (const step of plan.steps) {
    if (step.group !== currentGroup) {
      currentGroup = step.group;
      console.log(`\n── ${ENV_GROUP_LABELS[currentGroup]} ─────────────────────────`);
    }
    const answer = await askStep(step, { ...values, ...collected }, dirname(filePath));
    if (answer.quit) {
      console.error('\n✖ Sihirbaz durduruldu; dosyaya HİÇBİR şey yazılmadı.');
      process.exitCode = 1;
      return;
    }
    if (answer.value !== null) collected[step.field.key] = answer.value;
    // Bağımlı alanlar (ör. DATABASE_DRIVER → POSTGRES_URL) anında görünür olmalı.
    if (!isFieldApplicable(step.field, { ...values, ...collected })) {
      console.log(`  ! ${step.field.key} bu değerle artık kullanılmıyor.`);
    }
  }

  for (const [key, value] of Object.entries(collected)) explicitWrites[key] = value;
  await finalize(explicitWrites, initial, values, filePath, options);
}

/**
 * Yazma + doğrulama adımı (etkileşimli, --set ve --answers yollarının ortak sonu).
 *
 * Kural: yalnızca kullanıcının verdiği değerler yazılır; eksik zorunlu alan
 * varsa dosyaya HİÇ yazılmaz (yarım yapılandırma, hiç yapılandırma olmamasından
 * daha tehlikelidir çünkü kullanıcı "doldurdum" sanır).
 */
async function finalize(
  collected: Record<string, string>,
  initial: Record<string, string>,
  values: Record<string, string>,
  filePath: string,
  options: Options,
): Promise<void> {
  const toWrite = buildValuesToWrite(collected, initial);
  const summary = buildChangeSummary(collected, initial);

  console.log('\n─────────────────────────────────────────────');
  console.log('Yazılacak değişiklikler (maskeli):');
  if (summary.changed.length === 0 && summary.cleared.length === 0) console.log('  (değişiklik yok)');
  for (const line of summary.changed) console.log(`  · ${line}`);
  for (const line of summary.cleared) console.log(`  · ${line} = (temizlendi)`);
  console.log(`  Değişmeyen: ${summary.unchanged.length} alan`);

  const missing = summarizeMissingFields(values);
  if (missing.missing.length > 0) {
    console.error(`\n✖ Hâlâ eksik zorunlu alan var: ${missing.missing.join(', ')}`);
    console.error('  Dosyaya yazılmadı; sihirbazı yeniden çalıştırın: npm run env:setup');
    process.exitCode = 1;
    return;
  }
  for (const warning of missing.warnings) console.log(`  ! ${warning}`);

  if (Object.keys(toWrite).length === 0) {
    console.log('\n✔ Dosyada değişiklik gerekmedi.');
    await printPostChecks(values, filePath);
    return;
  }

  if (!options.yes && process.stdin.isTTY === true) {
    const confirmation = await promptOnce(
      `\n${filePath} dosyasına ${Object.keys(toWrite).length} anahtar yazılsın mı? (evet/hayır): `,
      false,
    );
    if (confirmation.trim().toLowerCase() !== 'evet' && confirmation.trim().toLowerCase() !== 'e') {
      console.error('\n✖ Onaylanmadı; dosyaya yazılmadı.');
      process.exitCode = 1;
      return;
    }
  }

  const result = writeEnvFile(filePath, toWrite, {
    backup: options.backup,
    sectionTitle: 'env:setup ile dolduruldu',
  });
  console.log(`\n✔ Yazıldı: ${result.path}`);
  if (result.backupPath) console.log(`  Yedek: ${result.backupPath}`);
  console.log(`  Güncellenen: ${result.updated.length} · Eklenen: ${result.added.length} · Değişmeyen: ${result.unchanged.length}`);

  await printPostChecks(values, filePath);
}

/** Yazım sonrası gerçek denetim: getEnv + inspectEnvironment + TLS tanısı. */
/**
 * Yazımdan (ya da `--check`) sonra gerçek denetim.
 *
 * Denetim HEDEF DOSYAYA göre yapılır (`envFile`): modül yüklenirken okunan
 * proje `.env`'i ya da kabukta kalan bir değişken, başka bir dosya için verilen
 * kararı değiştirmemelidir. Aynı değerler `process.env`'e de uygulanır; çünkü
 * canlı TLS tanısı (`runDatabaseTlsDiagnosis`) süreç ortamından okur.
 */
async function printPostChecks(values: Record<string, string>, filePath: string): Promise<void> {
  console.log('\n── Doğrulama ────────────────────────────────');
  const defaultFile = resolvePath(process.cwd(), '.env');
  if (resolvePath(filePath) !== defaultFile) {
    console.log(`(Denetim YALNIZCA ${filePath} dosyasına göre yapılır; proje .env'i ve süreç ortamı yok sayılır.)`);
  }
  applyEnvValues(values, { overrideKeys: new Set(Object.keys(values)) });
  resetEnvFileState();
  resetEnvCache();

  const parsed = parseEnvWithoutValidation({}, { envFile: filePath });
  if (!parsed.ok) {
    console.error('✖ Ortam şeması ayrıştırılamadı:');
    for (const issue of parsed.issues) console.error(`  ✖ ${issue}`);
    console.error(`  Dosya: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  try {
    // CA dosyası yolu hedef `.env` dosyasının köküne göre çözülür.
    const env = getEnv({}, { caFileRoot: dirname(filePath), envFile: filePath });
    console.log('Ortam özeti (gizli değer yok):');
    for (const [key, value] of Object.entries(describeEnv(env))) {
      console.log(`  ${key.padEnd(20)}: ${String(value)}`);
    }
    const inspection = inspectEnvironment(env, { caFileRoot: dirname(filePath), envFile: filePath });
    if (inspection.warnings.length > 0) {
      console.log('\nUyarılar:');
      for (const warning of inspection.warnings) console.log(`  ! ${warning}`);
    }
    if (inspection.problems.length > 0) {
      console.error('\nSorunlar:');
      for (const problem of inspection.problems) console.error(`  ✖ ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log('\n✔ Ortam yapılandırması kullanılabilir.');

    // Veritabanı seçildiyse TLS kararını ve CA dosyasını burada da doğrula.
    if (hasPostgresConfig(env) && postgresTlsMode(env) === 'verify') {
      console.log(`\n${summarizeTlsDecision(values, env)}`);
      if (env.POSTGRES_SSL_CA_FILE) {
        const report = inspectCaFile(env.POSTGRES_SSL_CA_FILE, { root: dirname(filePath) });
        console.log(`CA dosyası: ${report.resolvedPath ?? 'BULUNAMADI'} · sertifika: ${report.certificates.length}`);
        for (const line of formatCaFileIssues(report, '  ')) console.log(line);
      }
      console.log(`Birleştirme: ${postgresCaMergeSystem(env) ? 'açık (dosya + sistem kökleri)' : 'kapalı (yalnızca dosya)'}`);
      try {
        // Bağlantı dizesindeki yasak TLS parametreleri burada da görünür olur
        // (postgresUrl() fail-closed'tur; değer ASLA yazdırılmaz).
        postgresUrl(env);
      } catch (error) {
        console.error(`  ✖ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      console.log('\nCanlı TLS tanısı çalıştırılıyor (parola gönderilmez)…');
      try {
        const report = await runDatabaseTlsDiagnosis({ timeoutMs: 8_000 });
        if (report) {
          for (const line of formatTlsDiagnosis(report, { maxFindings: 6 })) console.log(`  ${line}`);
          const cause = report.diagnosis.cause;
          if (cause === 'trusted-by-file') {
            // Beklenen durum: doğrulama açık ve zincir güvenilen köke bağlanıyor.
          } else if (cause === 'unreachable' || cause === 'tls-unsupported') {
            // AĞ sorunu, YAPILANDIRMA sorunu değil: dosya doğru yazıldı, bu yüzden
            // sihirbaz "başarısız" sayılmaz. Kullanıcıya ayrım açıkça söylenir;
            // ağ açıldığında `npm run db:tls-doctor` aynı denetimi tekrar yapar.
            console.log(
              '  ! Sunucuya şu an ulaşılamıyor: YAPILANDIRMA geçerli, ağ/erişim denetimi yapılamadı. ' +
                'Başka bir ağdan/VPN ile `npm run db:tls-doctor` çalıştırın.',
            );
          } else if (cause === 'ca-file-unusable') {
            console.error('  ✖ CA dosyası kullanılamıyor: doğrulama bu dosyayla çalışmaz (dosya yazıldı ama düzeltilmeli).');
            process.exitCode = 1;
          } else {
            console.error('  ✖ Sertifika doğrulaması bu yapılandırmayla BAŞARISIZ olur (neden yukarıda).');
            console.error('    Doğrulamayı kapatmak çözüm değildir: eksik zinciri/kökü tamamlayın (docs/database-tls.md).');
            process.exitCode = 1;
          }
        } else {
          console.log('  Tanı üretilemedi (uç nokta çözümlenemedi ya da TLS kapalı).');
        }
      } catch {
        console.log('  Canlı tanı çalıştırılamadı; npm run db:tls-doctor ile deneyin.');
      }
      console.log('\nSonraki adımlar:');
      console.log('  npm run db:tls-doctor   (bağlantı zincirini ayrıntılı incele)');
      console.log('  npm run db:migrate      (bakım/şema)');
      console.log('  npm run dev             (arayüz + API + worker)');
    } else if (hasPostgresConfig(env)) {
      console.log(`\n${summarizeTlsDecision(values, env)}`);
      console.log('  Doğrulamayı açmak için: POSTGRES_SSL_MODE=verify (npm run env:setup -- --only POSTGRES_SSL_MODE)');
    }
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    console.error('  Düzeltmek için: npm run env:setup');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  console.error('Yardım: npm run env:setup -- --help');
  process.exitCode = 1;
});
