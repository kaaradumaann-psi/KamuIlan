/**
 * Tek komutla geliştirme ortamı: `npm run dev`
 *
 * Sırayla:
 *  1. `db:migrate` (kaynak envanteri + zamanlanmış görevler + indeksler)
 *  2. Yerel posta sunucusu (SMTP 1025 + görüntüleyici 1080) — dış SMTP tanımlı değilse
 *  3. API (0.0.0.0:$PORT)      → /api, /api/docs
 *  4. API portu TCP üzerinden dinlemeye başlayana kadar beklenir
 *  5. Worker (kalıcı kuyruk)   → zamanlanmış tarama + e-posta; DB kalp atışı beklenir
 *  6. Vite arayüz (0.0.0.0:5173, /api proxy)
 *
 * Neden API beklenir: Vite, `/api` isteklerini 127.0.0.1:$PORT'a proxy'ler.
 * API daha dinlemeye başlamadan Vite açılırsa ilk istekler
 * "connect ECONNREFUSED 127.0.0.1:3000" ile düşer ve kullanıcı, giriş
 * ekranında sebepsiz bir hata görür. API'nin kapsamlı `/api/health` ucu veritabanı
 * ve kaynak ölçümleri için çok sayıda sorgu yaptığından, hazır olma sinyali
 * olarak HTTP yanıtını değil hedef API portuna TCP bağlantısını kullanırız.
 *
 * Not: Zamanlanmış tarama bu süreçlerden BİRİNDE (worker) çalışır; tarayıcı
 * sekmesinin açık kalmasına bağlı değildir.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { safeExitCode, signalExitCode } from './lib/exit-codes';
import { createConnection } from 'node:net';
import { getEnv } from '../src/config/env';
import { describeDriver, effectiveDriver } from '../src/db/store';

const env = getEnv();
const children: ChildProcess[] = [];
const isWindows = process.platform === 'win32';

/** Yerel posta sunucusunun adresi (dev:smtp ile aynı portu dinler). */
function isLocalMailHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '' || normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
  );
}

function spawnNpm(args: string[]): ChildProcess {
  // npm run içindeyken npm_execpath, npm CLI JS girişini verir. Node ile
  // doğrudan çalıştırmak Windows'ta .cmd + shell kullanımını ve DEP0190'ı önler.
  const npmCli = process.env['npm_execpath'];
  if (npmCli) {
    return spawn(process.execPath, [npmCli, ...args], { stdio: 'inherit', env: process.env });
  }
  // Betik npm dışında doğrudan çağrılırsa taşınabilir yedek yol.
  return spawn(isWindows ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
    env: process.env,
    shell: isWindows,
  });
}

function run(name: string, args: string[]): ChildProcess {
  const child = spawnNpm(args);
  child.on('error', (error) => {
    console.error(`[dev] "${name}" süreci başlatılamadı: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal === null) {
      console.error(`[dev] "${name}" süreci ${code} koduyla kapandı.`);
    }
  });
  children.push(child);
  return child;
}

/**
 * Tüm alt süreçleri kapatır ve verilen SAYISAL kodla çıkar.
 *
 * DİKKAT: `process.on('SIGINT', shutdown)` yazıldığında Node sinyal ADINI
 * ('SIGINT') ilk argüman olarak geçirir ve `process.exit('SIGINT')`
 * `ERR_INVALID_ARG_TYPE` fırlatırdı — Ctrl+C sonrası süreç çökerek kapanıyordu
 * (2026-10-16 Windows koşumunda görüldü). `process.exit` yalnızca sayı alır;
 * sinyal için geleneksel kodlar kullanılır (128 + sinyal numarası).
 */
function shutdown(exitCode = 0): void {
  console.log('\n[dev] tüm süreçler kapatılıyor…');
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(safeExitCode(exitCode)), 500);
}

process.on('SIGINT', (signal) => shutdown(signalExitCode(signal)));
process.on('SIGTERM', (signal) => shutdown(signalExitCode(signal)));
process.on('SIGHUP', (signal) => shutdown(signalExitCode(signal)));

/** Vite proxy'nin hedef API portu erişilebilir olana kadar TCP ile bekler. */
function canConnectToApi(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: env.PORT });
    let settled = false;
    const timeout = setTimeout(() => finish(false), 1_000);

    function finish(ready: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(ready);
    }

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForApi(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectToApi()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** Hafif heartbeat uç noktası; tam /api/health kaynak başına sorgular yaptığı için burada kullanılmaz. */
async function getWorkerState(): Promise<'running' | 'starting' | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${env.PORT}/api/health/worker`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const health = (await response.json()) as {
      workers?: { running?: unknown; starting?: unknown };
    };
    if (typeof health.workers?.running === 'number' && health.workers.running > 0) return 'running';
    if (typeof health.workers?.starting === 'number' && health.workers.starting > 0) return 'starting';
    return null;
  } catch {
    return null;
  }
}

async function waitForWorker(workerProcess: ChildProcess, timeoutMs = 180_000): Promise<'running' | 'starting' | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) return null;
    const state = await getWorkerState();
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

async function main(): Promise<void> {
  // Tanılama: hesabın HANGİ veritabanına yazıldığı burada ve giriş ekranında
  // aynı biçimde görünür (yanlış veritabanına hesap eklemek girişte 401 verir).
  const driver = effectiveDriver(env);
  console.log(
    `[dev] veritabanı: ${describeDriver(driver)}` + (driver === 'file' ? ` (${env.DATA_DIR})` : ''),
  );
  console.log('[dev] veritabanı bakımı çalıştırılıyor (kaynak envanteri + görevler)…');
  await new Promise<void>((resolve, reject) => {
    const migrate = spawnNpm(['run', 'db:migrate']);
    migrate.on('error', reject);
    migrate.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`db:migrate başarısız (${code})`)),
    );
  }).catch((error: unknown) => {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      '[dev] Bakım yukarıdaki hatayla durdu. Hata TLS/sertifika kaynaklıysa (SELF_SIGNED_CERT_IN_CHAIN, ' +
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE) kök nedeni bulmak için: npm run db:tls-doctor ' +
        '(parola göndermeden sunucunun zincirini okur ve uygulanacak adımı yazar). ' +
        'Kurulum: docs/database-tls.md — doğrulamayı kapatmayın (no-verify).',
    );
    process.exitCode = 1;
    process.exit(1);
  });

  const localMail = isLocalMailHost(env.SMTP_HOST);
  if (localMail) {
    // Yerel posta sunucusu ÖNCE ayağa kalkar: API/worker ilk e-postayı hemen
    // göndermeye çalışırsa bağlantı hazır olmalıdır.
    run('smtp', ['run', 'dev:smtp']);
  } else {
    console.log(
      `[dev] SMTP_HOST tanımlı (${env.SMTP_HOST}:${env.SMTP_PORT}); yerel posta sunucusu başlatılmadı.`,
    );
  }

  run('api', ['run', 'dev:api']);

  const apiReady = await waitForApi();
  if (!apiReady) {
    console.error(
      `[dev] API ${env.PORT} portunda bağlantı kabul etmiyor. Süreç günlüklerini kontrol edin ` +
        '(ortam doğrulaması, veritabanı bağlantısı ya da port kullanımı sorunlu olabilir).',
    );
    process.exitCode = 1;
    shutdown(1);
    return;
  }

  const workerProcess = run('worker', ['run', 'dev:worker']);
  console.log('[dev] worker başlangıcı doğrulanıyor (hafif heartbeat ucu; Supabase başlangıcı zaman alabilir)…');
  const workerState = await waitForWorker(workerProcess);
  if (workerState === 'running') {
    console.log('[dev] worker heartbeat alındı; zamanlanmış işler çalışıyor.');
  } else if (workerState === 'starting') {
    console.log('[dev] worker başlangıç heartbeat’i alındı; kaynak/görev eşitlemesi sürüyor.');
  } else {
    console.error(
      '[dev] worker heartbeat’i alınamadı. Worker günlüklerini, veritabanı ayarını ve `npm run dev:worker` girişini kontrol edin.',
    );
  }
  run('web', ['run', 'dev:web']);

  const startupState =
    workerState === 'running'
      ? 'hazır'
      : workerState === 'starting'
        ? 'arayüz hazır; worker başlatılıyor'
        : 'arayüz hazır; worker doğrulanamadı';
  console.log(`
[dev] ${startupState}:
  • Arayüz        http://localhost:5173
  • API           http://localhost:${env.PORT}/api/health
  • API dokümanı  http://localhost:${env.PORT}/api/docs
  • Posta kutusu  ${localMail ? `http://localhost:${env.DEV_MAIL_VIEWER_PORT} (SMTP 127.0.0.1:${env.SMTP_PORT})` : '(harici SMTP kullanılıyor)'}
  • Kapsam raporu npm run sources:report
  • İlk yönetici  ADMIN_EMAIL ve benzersiz ADMIN_PASSWORD değerlerini ortamda ayarlayıp npm run seed:admin
Kapatmak için Ctrl+C.
`);
}

void main();
