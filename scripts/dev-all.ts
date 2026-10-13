/**
 * Tek komutla geliştirme ortamı: `npm run dev`
 *
 * Sırayla:
 *  1. `db:migrate` (kaynak envanteri + zamanlanmış görevler + indeksler)
 *  2. API (0.0.0.0:$PORT)      → /api, /api/docs
 *  3. Worker (kalıcı kuyruk)   → zamanlanmış tarama + e-posta
 *  4. Vite arayüz (0.0.0.0:5173, /api proxy)
 *  5. Yerel posta sunucusu (SMTP 1025 + görüntüleyici 1080) — SMTP_HOST tanımlı değilse
 *
 * Not: Zamanlanmış tarama bu süreçlerden BİRİNDE (worker) çalışır; tarayıcı
 * sekmesinin açık kalmasına bağlı değildir.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { getEnv } from '../src/config/env';

const env = getEnv();
const children: ChildProcess[] = [];
const isWindows = process.platform === 'win32';

function run(name: string, args: string[]): void {
  // Windows'ta Node ≥ 20.12, .cmd dosyalarını shell olmadan spawn edemez
  // (EINVAL verir); bu yüzden Windows'ta kabuk üzerinden çalıştırılır.
  const child = spawn(isWindows ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
    env: process.env,
    shell: isWindows,
  });
  child.on('error', (error) => {
    console.error(`[dev] "${name}" süreci başlatılamadı: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal === null) {
      console.error(`[dev] "${name}" süreci ${code} koduyla kapandı.`);
    }
  });
  children.push(child);
}

function shutdown(): void {
  console.log('\n[dev] tüm süreçler kapatılıyor…');
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main(): Promise<void> {
  console.log('[dev] veritabanı bakımı çalıştırılıyor (kaynak envanteri + görevler)…');
  await new Promise<void>((resolve, reject) => {
    const migrate = spawn(isWindows ? 'npm.cmd' : 'npm', ['run', 'db:migrate'], {
      stdio: 'inherit',
      env: process.env,
      shell: isWindows,
    });
    migrate.on('error', reject);
    migrate.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`db:migrate başarısız (${code})`))));
  }).catch((error: unknown) => {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    process.exit(1);
  });

  run('api', ['run', 'dev:api']);
  run('worker', ['run', 'dev:worker']);
  run('web', ['run', 'dev:web']);
  if (!env.SMTP_HOST) {
    run('smtp', ['run', 'dev:smtp']);
  } else {
    console.log(`[dev] SMTP_HOST tanımlı (${env.SMTP_HOST}:${env.SMTP_PORT}); yerel posta sunucusu başlatılmadı.`);
  }

  console.log(`
[dev] hazır:
  • Arayüz        http://localhost:5173
  • API           http://localhost:${env.PORT}/api/health
  • API dokümanı  http://localhost:${env.PORT}/api/docs
  • Posta kutusu  ${env.SMTP_HOST ? '(harici SMTP kullanılıyor)' : `http://localhost:${env.DEV_MAIL_VIEWER_PORT}`}
  • Kapsam raporu npm run sources:report
Kapatmak için Ctrl+C.
`);
}

void main();
