/**
 * Offline verification contract: `npm run verify:all`.
 *
 * Runs only local checks. Live sources, browsers, LLM providers, real notification
 * transports and production database credentials are disabled/removed in every
 * child process. Reports/logs are kept under ignored `artifacts/verify-all/`.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

interface StepResult {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutLog: string;
  stderrLog: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validateStaticInventory(value: unknown): string | null {
  const root = record(value);
  const contract = record(root?.['sourceContract']);
  const fixtures = record(root?.['fixtureManifest']);
  const summary = record(root?.['summary']);
  const runtime = record(root?.['runtimeEvidence']);
  if (root?.['mode'] !== 'offline-static' || !contract || !fixtures || !summary || !runtime) {
    return 'Statik kaynak envanteri beklenen şemada değil.';
  }
  if (
    contract['sourceKeysUnique'] !== true ||
    !Array.isArray(contract['missingAdapters']) || contract['missingAdapters'].length !== 0 ||
    !Array.isArray(contract['listingHostNotAllowlisted']) || contract['listingHostNotAllowlisted'].length !== 0
  ) {
    return 'Kaynak key/adapter/allowlist sözleşmesi geçersiz.';
  }
  if (
    !Number.isSafeInteger(summary['total']) || Number(summary['total']) < 1 ||
    !['none', 'available'].includes(String(fixtures['status'])) ||
    fixtures['invalidCount'] !== 0 ||
    runtime['liveFetch'] !== 'NOT RUN' || runtime['productionDatabase'] !== 'NOT READ'
  ) {
    return 'Fixture provenansı, offline durumu veya kaynak envanteri özeti geçersiz.';
  }
  return null;
}

function validateDeterministicEvaluation(value: unknown): string | null {
  const root = record(value);
  const report = record(root?.['report']);
  const sufficiency = record(report?.['sufficiency']);
  if (
    root?.['mode'] !== 'rules' || root['provider'] !== null || root['llm'] !== null ||
    !report || !sufficiency ||
    !Number.isSafeInteger(report['total']) ||
    !Number.isSafeInteger(sufficiency['humanRealCount']) ||
    !Number.isSafeInteger(sufficiency['realCount']) ||
    typeof sufficiency['sufficient'] !== 'boolean'
  ) {
    return 'Deterministik evaluation raporu eksik veya LLM modunda.';
  }
  return null;
}

function gateMadeNoCall(gate: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(gate, 'call')) return false;
  const callValue = gate['call'];
  if (callValue === null) return true;
  return record(callValue)?.['attempted'] === false;
}

function validateOfflineDoctor(value: unknown): string | null {
  const root = record(value);
  const budget = record(root?.['apiBudget']);
  const gates = record(root?.['gates']);
  const classifier = record(gates?.['classifier']);
  const assistant = record(gates?.['assistant']);
  if (
    !budget || !gates || !classifier || !assistant ||
    budget['usedCalls'] !== 0 ||
    !gateMadeNoCall(classifier) ||
    !gateMadeNoCall(assistant)
  ) {
    return 'Offline LLM doctor kanıtı geçersiz veya provider çağrısı gözlendi.';
  }
  return null;
}

function checkChromium(): { available: boolean; executablePath: string | null } {
  try {
    const require = createRequire(import.meta.url);
    const playwright = require('playwright') as { chromium?: { executablePath(): string } };
    const executablePath = playwright.chromium?.executablePath() ?? null;
    if (!executablePath || !existsSync(executablePath)) return { available: false, executablePath };
    if (process.platform !== 'win32') accessSync(executablePath, constants.X_OK);
    return { available: true, executablePath };
  } catch {
    return { available: false, executablePath: null };
  }
}

function networkGuardSummary(path: string): {
  blockedAttemptCount: number;
  byChannel: Record<string, number>;
  blockedHosts: string[];
} {
  let rows: { channel?: string; host?: string }[] = [];
  try {
    rows = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { channel?: string; host?: string });
  } catch {
    rows = [];
  }
  const byChannel: Record<string, number> = {};
  for (const row of rows) {
    const channel = row.channel ?? 'unknown';
    byChannel[channel] = (byChannel[channel] ?? 0) + 1;
  }
  return {
    blockedAttemptCount: rows.length,
    byChannel,
    blockedHosts: [...new Set(rows.map((row) => row.host ?? 'unknown'))].sort(),
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = timestamp();
  const artifactDir = join(process.cwd(), 'artifacts', 'verify-all', runId);
  mkdirSync(artifactDir, { recursive: true });
  const isolationDir = mkdtempSync(join(tmpdir(), 'kamuilan-verify-all-'));
  const guardReportPath = join(isolationDir, 'network-guard.jsonl');
  const reportPath = join(artifactDir, 'report.json');
  const steps: StepResult[] = [];
  const chromium = checkChromium();
  const unsafeTlsOverride = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE',
    'MONGODB_URI', 'MONGODB_URL', 'MONGODB_DB', 'REDIS_URL',
    'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_CLASSIFIER_MODEL',
    'LLM_COST_USD_PER_MTOK_INPUT', 'LLM_COST_USD_PER_MTOK_OUTPUT', 'LLM_RUN_COST_LIMIT_USD', 'LLM_DAILY_COST_LIMIT_USD',
    'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PASSWORD',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_USERNAME',
    'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'KAMUILAN_NETWORK_GUARD_REPORT',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_USE_ENV_PROXY',
  ]) delete childEnv[name];
  Object.assign(childEnv, {
    NODE_ENV: 'test',
    DATABASE_DRIVER: 'file',
    DATA_DIR: join(isolationDir, 'data'),
    KAMUILAN_TEST_DATA_DIR: join(isolationDir, 'test-data'),
    KAMUILAN_NETWORK_GUARD_REPORT: guardReportPath,
    SOURCE_LIVE_FETCH: '0',
    SOURCE_BROWSER_FALLBACK: '0',
    SOURCE_TLS_AIA_COMPLETION: '0',
    SCHEDULER_ENABLED: '0',
    AI_ASSISTANT_ENABLED: '0',
    LLM_CLASSIFIER_ENABLED: '0',
    EMAIL_PROVIDER: 'file',
    EMAIL_DEV_FILE_TRANSPORT: '1',
    APP_SECRET: randomBytes(32).toString('hex'),
  });

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (
    name: string,
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      outputPath?: string;
      outputFilePath?: string;
      validateOutput?: (value: unknown) => string | null;
    } = {},
  ): void => {
    const index = steps.length + 1;
    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const stdoutLog = join(artifactDir, `${String(index).padStart(2, '0')}-${safeName}.stdout.log`);
    const stderrLog = join(artifactDir, `${String(index).padStart(2, '0')}-${safeName}.stderr.log`);
    const command = `npm ${args.join(' ')}`;
    const started = Date.now();
    const result = spawnSync(npm, args, {
      cwd: process.cwd(),
      env: { ...childEnv, ...(options.env ?? {}) },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    const stdout = result.stdout ?? '';
    let stderr = result.stderr ?? (result.error ? result.error.message : '');
    let outputValidationError: string | null = null;
    if (options.outputPath) {
      try {
        const json = JSON.parse(stdout) as unknown;
        outputValidationError = options.validateOutput?.(json) ?? null;
        if (!outputValidationError) writeJson(options.outputPath, json);
      } catch {
        outputValidationError = 'Salt-okunur JSON çıktısı geçerli/yalın JSON değil; rapor kaydedilmedi.';
      }
    }
    if (!outputValidationError && options.outputFilePath) {
      const json = readJson(options.outputFilePath);
      outputValidationError = json === null
        ? 'Çocuk komutun beklenen JSON raporu yok veya geçersiz.'
        : options.validateOutput?.(json) ?? null;
    }
    if (outputValidationError) {
      stderr = `${stderr}${stderr ? '\n' : ''}${outputValidationError}`;
    }
    writeFileSync(stdoutLog, stdout, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(stderrLog, stderr, { encoding: 'utf8', mode: 0o600 });
    const childExitCode = typeof result.status === 'number' ? result.status : 1;
    const exitCode = childExitCode === 0 && outputValidationError ? 1 : childExitCode;
    steps.push({ name, command, exitCode, durationMs: Date.now() - started, stdoutLog, stderrLog });
    console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'}  ${name} (exit ${exitCode}, ${Date.now() - started} ms)`);
  };

  if (unsafeTlsOverride) {
    const report = {
      generatedAt: new Date().toISOString(),
      startedAt,
      status: 'BLOCKED',
      reason: 'NODE_TLS_REJECT_UNAUTHORIZED=0 bulundu; güvenlik ayarı değiştirilmedi ve hiçbir doğrulama alt süreci başlatılmadı.',
      steps,
      isolation: { tlsVerification: 'BLOCKED: pre-existing insecure override' },
    };
    writeJson(reportPath, report);
    console.error(`verify:all BLOCKED — rapor: ${reportPath}`);
    process.exitCode = 2;
    rmSync(isolationDir, { recursive: true, force: true });
    return;
  }

  const staticReportPath = join(artifactDir, 'source-inventory.json');
  const evaluationPath = join(artifactDir, 'classification-evaluation.json');
  const doctorPath = join(artifactDir, 'llm-doctor-offline.json');

  run('TypeScript typecheck', ['run', 'typecheck']);
  run('ESLint', ['run', 'lint']);
  run('Vitest full suite', ['test']);
  run('Vitest coverage suite', ['run', 'test:coverage']);
  run('Production build', ['run', 'build']);
  run('Environment check', ['run', 'env:check']);
  run('Static source and fixture contract (offline)', ['run', '--silent', 'sources:report', '--', '--static', '--json'], {
    outputPath: staticReportPath,
    validateOutput: validateStaticInventory,
  });
  run('Deterministic classification/extraction evaluation', [
    'run', 'eval:classification', '--', '--json', evaluationPath,
  ], {
    outputFilePath: evaluationPath,
    validateOutput: validateDeterministicEvaluation,
  });
  run('LLM doctor (offline only)', ['run', 'llm:doctor', '--', '--offline', '--json', doctorPath], {
    outputFilePath: doctorPath,
    validateOutput: validateOfflineDoctor,
  });

  const guard = networkGuardSummary(guardReportPath);
  const sourceInventory = readJson(staticReportPath) as {
    summary?: { total?: number; enabled?: number; adapters?: number; fixtureSnapshots?: number };
    sourceContract?: { sourceKeysUnique?: boolean; missingAdapters?: string[]; listingHostNotAllowlisted?: string[] };
    fixtureManifest?: { status?: string; validCount?: number; invalidCount?: number };
    runtimeEvidence?: Record<string, string>;
  } | null;
  const evaluation = readJson(evaluationPath) as {
    report?: { sufficiency?: { sufficient?: boolean; humanRealCount?: number; realCount?: number; reasons?: string[] } };
    humanRealReport?: unknown;
  } | null;
  const doctor = readJson(doctorPath) as {
    apiBudget?: { usedCalls?: number; maxCalls?: number };
    gates?: { classifier?: { call?: { attempted?: boolean } | null }; assistant?: { call?: { attempted?: boolean } | null } };
  } | null;

  const failed = steps.filter((step) => step.exitCode !== 0);
  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    status: failed.length === 0 ? 'PASS_OFFLINE_CHECKS' : 'FAIL',
    branch: (() => {
      const result = spawnSync('git', ['branch', '--show-current'], { cwd: process.cwd(), encoding: 'utf8' });
      return result.status === 0 ? result.stdout.trim() : 'UNKNOWN';
    })(),
    commit: (() => {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
      return result.status === 0 ? result.stdout.trim() : 'UNKNOWN';
    })(),
    isolation: {
      mode: 'offline',
      sourceLiveFetch: false,
      browserFallback: false,
      tlsAiaCompletion: false,
      tlsVerification: 'ON',
      llmClassifierEnabled: false,
      aiAssistantEnabled: false,
      notificationTransport: 'file; live Resend/SMTP disabled',
      schedulerEnabled: false,
      databaseDriver: 'file',
      productionDatabaseCredentials: 'removed from child environment',
      productionDatabaseWrites: 0,
      realLlmCalls: 0,
      realSourceHttpCalls: 0,
      realNotificationSends: 0,
      blockedExternalHttpAttempts: guard,
      note: 'Unit/integration tests may use injected fakes and loopback-only fixtures; blocked attempts were stopped before external HTTP.',
    },
    evidence: {
      staticSourceInventory: sourceInventory
        ? {
            mode: 'offline-static',
            counts: sourceInventory.summary ?? null,
            contract: sourceInventory.sourceContract ?? null,
            fixtures: sourceInventory.fixtureManifest ?? null,
            runtimeEvidence: sourceInventory.runtimeEvidence ?? null,
          }
        : null,
      evaluation: evaluation?.report?.sufficiency ?? null,
      llmDoctor: doctor
        ? {
            usedCalls: doctor.apiBudget?.usedCalls ?? null,
            maxCalls: doctor.apiBudget?.maxCalls ?? null,
            classifierCallAttempted: doctor.gates?.classifier?.call?.attempted ?? false,
            assistantCallAttempted: doctor.gates?.assistant?.call?.attempted ?? false,
          }
        : null,
      liveSources: 'BLOCKED/NOT RUN: live-check requires explicit operator opt-in and was not invoked.',
      liveProvider: 'NOT RUN: eval uses deterministic rules only; llm:doctor was --offline.',
      humanLabels: evaluation?.report?.sufficiency ?? 'INSUFFICIENT DATA unless a human-real dataset is present',
    },
    e2e: {
      status: chromium.available ? 'NOT RUN — CI/local E2E is a separate step' : 'BLOCKED',
      browserAvailable: chromium.available,
      executablePath: chromium.executablePath,
      securityE2ETests: 'e2e/security.spec.ts included in Playwright suite; not executed by this offline verifier.',
    },
    steps,
    failedSteps: failed.map((step) => ({ name: step.name, exitCode: step.exitCode })),
    artifacts: {
      report: reportPath,
      staticSourceInventory: staticReportPath,
      classificationEvaluation: evaluationPath,
      offlineLlmDoctor: doctorPath,
      logsDirectory: artifactDir,
    },
  };
  writeJson(reportPath, report);
  console.log(`\nKaynak envanteri: ${sourceInventory?.summary?.total ?? 'n/a'} kaynak, ${sourceInventory?.summary?.enabled ?? 'n/a'} etkin, fixture ${sourceInventory?.fixtureManifest?.status ?? 'n/a'}.`);
  console.log(`Gerçek-insan etiketi: ${evaluation?.report?.sufficiency?.humanRealCount ?? 0} (kalite metriği varsa ayrıca raporda). LLM doctor çağrısı: ${doctor?.apiBudget?.usedCalls ?? 'n/a'}.`);
  console.log(`E2E: ${report.e2e.status}${chromium.executablePath ? ` (${chromium.executablePath})` : ''}`);
  console.log(`Dış HTTP guard: ${guard.blockedAttemptCount} engellenen deneme; gerçek outbound çağrı 0 olarak yapılandırıldı.`);
  console.log(`verify:all ${failed.length === 0 ? 'PASS (offline checks)' : 'FAIL'} — rapor: ${reportPath}`);
  if (failed.length > 0) process.exitCode = 1;
  rmSync(isolationDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error('verify:all başarısız:', error instanceof Error ? error.message : 'beklenmeyen hata');
  process.exitCode = 1;
});
