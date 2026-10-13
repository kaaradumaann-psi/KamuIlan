/**
 * Tek komutla geliştirme ortamı: `npm run dev`
 *
 * Sırayla:
 *  1. `db:migrate` (kaynak envanteri + zamanlanmış görevler + indeksler)
 *  2. Yerel posta sunucusu (SMTP 1025 + görüntüleyici 1080) — dış SMTP tanımlı değilse
 *  3. API (0.0.0.0:$PORT)      → /api, /api/docs
 *  4. API HAZIR olana kadar beklenir (health kontrolü)
 *  5. Worker (kalıcı kuyruk)   → zamanlanmış tarama + e-posta
 *  6. Vite arayüz (0.0.0.0:5173, /api proxy)
 *
 * Neden API beklenir: Vite, `/api` isteklerini 127.0.0.1:$PORT'a proxy'ler.
 * API daha dinlemeye başlamadan Vite açılırsa ilk istekler
 * "connect ECONNREFUSED 127.0.0.1:3000" ile düşer ve kullanıcı, giriş
 * ekranında sebepsiz bir hata görür. Bu yarış yalnızca bekleme ile kapanır.
 *
 * Not: Zamanlanmış tarama bu süreçlerden BİRİNDE (worker) çalışır; tarayıcı
 * sekmesinin açık kalmasına bağlı değildir.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { getEnv } from '../src/config/env';
import { describeDriver, effectiveDriver } from '../src/db/store';

const env = getEnv();
const children: ChildProcess[] = [];
const isWindows = process.platform === 'win32';

/** Yerel posta sunucusunun adresi (dev:smtp ile aynı portu dinler). */
function isLocalMailHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '' || normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

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

/** API `/api/health` yanıt verene kadar bekler (yanlış adrese proxy yapılmaz). */
async function waitForApi(timeoutMs = 60_000): Promise<boolean> {
  const url = `http://127.0.0.1:${env.PORT}/api/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // Henüz dinlemiyor; kısa bir bekleme ile tekrar denenir.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main(): Promise<void> {
  // Tanılama: hesabın HANGİ veritabanına yazıldığı burada ve giriş ekranında
  // aynı biçimde görünür (yanlış veritabanına hesap eklemek girişte 401 verir).
  const driver = effectiveDriver(env);
  console.log(`[dev] veritabanı: ${describeDriver(driver)}` + (driver === 'file' ? ` (${env.DATA_DIR})` : ''));
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

  const localMail = isLocalMailHost(env.SMTP_HOST);
  if (localMail) {
    // Yerel posta sunucusu ÖNCE ayağa kalkar: API/worker ilk e-postayı hemen
    // göndermeye çalışırsa bağlantı hazır olmalıdır.
    run('smtp', ['run', 'dev:smtp']);
  } else {
    console.log(`[dev] SMTP_HOST tanımlı (${env.SMTP_HOST}:${env.SMTP_PORT}); yerel posta sunucusu başlatılmadı.`);
  }

  run('api', ['run', 'dev:api']);

  const apiReady = await waitForApi();
  if (!apiReady) {
    console.error(
      `[dev] API ${env.PORT} portunda başlamadı. Süreç günlüklerini kontrol edin ` +
        '(ortam doğrulaması ya da veritabanı bağlantısı başarısız olabilir).',
    );
    shutdown();
    process.exitCode = 1;
    return;
  }

  run('worker', ['run', 'dev:worker']);
  run('web', ['run', 'dev:web']);

  console.log(`
[dev] hazır:
  • Arayüz        http://localhost:5173
  • API           http://localhost:${env.PORT}/api/health
  • API dokümanı  http://localhost:${env.PORT}/api/docs
  • Posta kutusu  ${localMail ? `http://localhost:${env.DEV_MAIL_VIEWER_PORT} (SMTP 127.0.0.1:${env.SMTP_PORT})` : '(harici SMTP kullanılıyor)'}
  • Kapsam raporu npm run sources:report
  • İlk yönetici  ADMIN_EMAIL=siz@ornek.com ADMIN_PASSWORD="güçlü-parola" npm run seed:admin
Kapatmak için Ctrl+C.
`);
}

void main();
