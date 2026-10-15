/**
 * Testlerden TypeScript betiklerini çalıştırma yardımcısı.
 *
 * Neden `npx tsx` DEĞİL: Windows'ta `npx` bir `.cmd` sarmalayıcısıdır ve
 * `child_process` ile doğrudan çağrıldığında `spawnSync npx ENOENT` hatası
 * verir (Node, güvenlik nedeniyle `.cmd`/`.bat` dosyalarını `shell: true`
 * olmadan çalıştırmaz). Bu yüzden betikler doğrudan süreç içindeki Node
 * çalıştırıcısıyla (`process.execPath`) ve tsx'in kendi CLI giriş noktasıyla
 * başlatılır: aynı davranış Linux/macOS/Windows'ta.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Depo kökü (bu dosya `tests/helpers/` altında). */
export const REPO_ROOT = join(__dirname, '..', '..');

/** tsx'in CLI giriş noktası; kurulum bozuksa anlaşılır hata verir. */
export function tsxCliPath(): string {
  const candidate = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(candidate)) {
    throw new Error(`tsx bulunamadı (${candidate}); önce \`npm install\` çalıştırın.`);
  }
  return candidate;
}

export interface RunScriptOptions {
  /** Çalışma dizini (varsayılan: depo kökü). */
  cwd?: string;
  /** Alt süreç ortamı (varsayılan: mevcut ortam). */
  env?: NodeJS.ProcessEnv;
  /** Zaman aşımı (ms). Varsayılan 120 sn. */
  timeoutMs?: number;
}

export interface RunScriptResult {
  /** stdout + (hata durumunda) stderr. */
  output: string;
  /** Süreç çıkış kodu (0 = başarılı). */
  status: number;
}

/**
 * Bir TypeScript betiğini alt süreçte çalıştırır ve çıktısını döndürür.
 *
 * @param scriptPath Depo köküne göreli (`scripts/env-setup.ts`) ya da mutlak yol.
 *
 * Betik sıfır dışında bir kodla çıkarsa hata FIRLATILMAZ: çıktı ve kod
 * birlikte döner, böylece "başarısız olmalı" senaryoları da doğrulanabilir.
 */
export function runTsxScript(
  scriptPath: string,
  args: string[] = [],
  options: RunScriptOptions = {},
): RunScriptResult {
  const script = isAbsolute(scriptPath) ? scriptPath : join(REPO_ROOT, scriptPath);
  if (!existsSync(script)) throw new Error(`Betik bulunamadı: ${script}`);
  try {
    const stdout = execFileSync(process.execPath, [tsxCliPath(), script, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: 'utf8',
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { output: stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number; message?: string };
    if (typeof failure.stdout !== 'string' && typeof failure.stderr !== 'string') {
      // Süreç hiç başlatılamadı (ör. tsx yok): bu bir test hatasıdır, yutulmaz.
      throw error;
    }
    return {
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      status: typeof failure.status === 'number' ? failure.status : 1,
    };
  }
}
