/**
 * Sade Türkçe sistem durum raporu (`npm run durum`) — SALT OKUNUR.
 *
 * Neden: `/api/health` 200 dönse de worker durmuş, kaynaklar başarısız ya da e-postalar takılmış
 * olabilir. Teknik olmayan operatör tek komutla "çalışıyor mu, ne yapmalıyım?" sorusunun yanıtını
 * almalı; aynı çıktı Claude Code'a teşhis için verilebilir.
 *
 * Seviyeler: healthy · warning · critical · unknown. Ölçülemeyen şey sağlıklı sayılmaz (unknown).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../config/env';
import type { Repos } from '../db/repos';

export type StatusLevel = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface StatusCheck {
  area: string;
  level: StatusLevel;
  summary: string;
  action?: string;
}

export interface StatusReport {
  checkedAt: string;
  level: StatusLevel;
  checks: StatusCheck[];
  recentErrors: { time: string; component: string; message: string; context: string }[];
}

const HEARTBEAT_STALE_MS = 3 * 60_000;
const DAY_MS = 24 * 3_600_000;

const RANK: Record<StatusLevel, number> = { healthy: 0, unknown: 1, warning: 2, critical: 3 };

function worst(levels: StatusLevel[]): StatusLevel {
  return levels.reduce<StatusLevel>((acc, level) => (RANK[level] > RANK[acc] ? level : acc), 'healthy');
}

function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'hiç';
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${minutes} dk önce`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} saat önce`;
  return `${Math.round(minutes / 1440)} gün önce`;
}

/** Log dosyalarındaki son hata satırları (level ≥ 50). Kişisel veri zaten maskelidir. */
export function readRecentErrors(paths: readonly string[], limit = 8): StatusReport['recentErrors'] {
  const rows: StatusReport['recentErrors'] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').trim().split('\n').slice(-2_000);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (typeof entry.level !== 'number' || entry.level < 50) continue;
        const context = ['sourceKey', 'jobId', 'reqId', 'errorType', 'stage', 'model']
          .filter((key) => entry[key] !== undefined)
          .map((key) => `${key}=${String(entry[key])}`)
          .join(' ');
        const err = entry.err as { message?: string } | undefined;
        rows.push({
          time: String(entry.time ?? ''),
          component: String(entry.name ?? '?'),
          message: String(entry.msg ?? '') + (err?.message ? ` — ${err.message}` : ''),
          context,
        });
      } catch {
        // JSON olmayan satır (ör. elle eklenmiş) yok sayılır.
      }
    }
  }
  return rows.sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
}

/** Varsayılan log yolları: LOG_FILE + `./logs/*.log`. */
export function defaultLogPaths(env: Pick<Env, 'LOG_FILE'>, cwd = process.cwd()): string[] {
  const paths = new Set<string>();
  if (env.LOG_FILE) paths.add(env.LOG_FILE);
  const dir = join(cwd, 'logs');
  if (existsSync(dir)) for (const name of readdirSync(dir)) if (name.endsWith('.log')) paths.add(join(dir, name));
  return [...paths];
}

export async function buildStatusReport(
  repos: Repos,
  env: Env,
  now: Date,
  logPaths: readonly string[] = [],
): Promise<StatusReport> {
  const checks: StatusCheck[] = [];
  const since = new Date(now.getTime() - DAY_MS).toISOString();

  const db = await repos.store.health();
  checks.push(
    db.ok
      ? { area: 'Veritabanı', level: 'healthy', summary: `Erişilebiliyor (${db.driver}).` }
      : {
          area: 'Veritabanı',
          level: 'critical',
          summary: 'Veritabanına erişilemiyor; ilanlar kaydedilemez, site veri gösteremez.',
          action: 'npm run env:check ve npm run db:tls-doctor çıktısını Claude Code\'a verin.',
        },
  );
  if (!db.ok) {
    return { checkedAt: now.toISOString(), level: 'critical', checks, recentErrors: readRecentErrors(logPaths) };
  }

  const store = repos.store as { rowLevelSecurityReport?: () => Promise<{ table: string; enabled: boolean }[]> };
  if (typeof store.rowLevelSecurityReport === 'function') {
    const rls = await store.rowLevelSecurityReport();
    const off = rls.filter((row) => !row.enabled);
    checks.push(
      off.length === 0
        ? { area: 'Veri erişim koruması (RLS)', level: 'healthy', summary: `${rls.length} tabloda açık.` }
        : {
            area: 'Veri erişim koruması (RLS)',
            level: 'critical',
            summary: `${off.length} tabloda kapalı (Supabase REST üzerinden okunabilir).`,
            action: 'npm run db:indexes çalıştırın; düzelmezse veritabanı kullanıcısının tablo sahibi olduğunu doğrulayın.',
          },
    );
  }

  const heartbeats = (await repos.heartbeats.list()).filter((beat) => beat.role === 'worker');
  const fresh = new Date(now.getTime() - HEARTBEAT_STALE_MS).toISOString();
  const running = heartbeats.filter((beat) => beat.status === 'running' && beat.lastHeartbeatAt >= fresh);
  const lastBeat = heartbeats.map((beat) => beat.lastHeartbeatAt).sort().pop() ?? null;
  checks.push(
    running.length > 0
      ? {
          area: 'Arka plan işçisi (worker)',
          level: 'healthy',
          // Kalp atışı 3 dk'da bayatlar: yaşı yazılır ki yeni çöken worker "çalışıyor" diye yanıltmasın.
          summary: `${running.length} worker çalışıyor (son kalp atışı ${Math.round((now.getTime() - Date.parse(lastBeat ?? now.toISOString())) / 1000)} sn önce; 3 dk'yı aşarsa durmuş sayılır).`,
        }
      : {
          area: 'Arka plan işçisi (worker)',
          level: 'critical',
          summary: `Çalışan worker yok (son kalp atışı: ${ago(lastBeat, now)}). Tarama ve e-posta gönderimi durdu.`,
          action: 'Worker servisini başlatın (npm run start:worker ya da systemctl restart kamuilan-worker).',
        },
  );

  // Şartlar kapısının taramadığı kaynaklar (K8) arıza değildir: ayrı sayılır.
  const coverage = await repos.sources.coverage({ termsPolicy: env.SOURCE_TERMS_POLICY });
  const enabled = coverage.sources.filter((source) => source.enabled && !source.termsGated);
  const awaitingTerms = coverage.summary.awaitingTerms;
  const failing = enabled.filter((source) => source.health.consecutiveFailures > 0);
  const lastSuccess = enabled.map((source) => source.health.lastSuccessAt).filter(Boolean).sort().pop() ?? null;
  checks.push({
    area: 'Kaynak taraması',
    level: !lastSuccess ? 'warning' : failing.length > Math.max(2, enabled.length / 3) ? 'critical' : failing.length > 0 ? 'warning' : 'healthy',
    summary:
      `${enabled.length} taranan kaynak · son başarılı tarama ${ago(lastSuccess, now)} · ` +
      (failing.length ? `başarısız: ${failing.slice(0, 5).map((source) => source.name).join(', ')}${failing.length > 5 ? ` (+${failing.length - 5})` : ''}` : 'başarısız kaynak yok') +
      (awaitingTerms > 0 ? ` · kullanım şartları onayı bekleyen ${awaitingTerms} kaynak taranmıyor (config/source-terms.json)` : ''),
    ...(enabled.length === 0
      ? { action: 'Kaynak envanteri yüklenmemiş: npm run db:migrate' }
      : failing.length
        ? { action: 'Yönetim → İlan kaynakları ekranında hata nedenine bakın; tek kaynak kesintisi diğerlerini etkilemez.' }
        : {}),
  });

  const [newJobs, openReview, failedMail, pendingMail] = await Promise.all([
    repos.store.count('jobs', { createdAt: { $gte: since } }),
    repos.store.count('reviewQueue', { status: 'open' }),
    repos.store.count('emailOutbox', { status: { $in: ['failed', 'dead'] }, updatedAt: { $gte: since } }),
    repos.store.count('emailOutbox', { status: 'pending' }),
  ]);
  checks.push({
    area: 'İlanlar',
    level: openReview > 50 ? 'warning' : 'healthy',
    summary: `Son 24 saatte ${newJobs} yeni kayıt · incelemeyi bekleyen ${openReview}.`,
    ...(openReview > 50 ? { action: 'Yönetim panelindeki inceleme kuyruğunu gözden geçirin.' } : {}),
  });

  const mailConfigured = env.EMAIL_PROVIDER === 'resend' ? Boolean(env.RESEND_API_KEY) : env.EMAIL_PROVIDER === 'smtp' ? Boolean(env.SMTP_HOST) : true;
  checks.push({
    area: 'E-posta',
    level: !mailConfigured ? 'critical' : failedMail > 0 ? 'warning' : 'healthy',
    summary: !mailConfigured
      ? `${env.EMAIL_PROVIDER} seçili ama ayarları eksik.`
      : `Sağlayıcı: ${env.EMAIL_PROVIDER} · son 24 saatte başarısız ${failedMail} · kuyrukta ${pendingMail}.`,
    ...(failedMail > 0 ? { action: 'Panelim → Bildirim geçmişi; sağlayıcı alan adı doğrulamasını kontrol edin.' } : {}),
  });

  checks.push({
    area: 'Telegram',
    level: env.TELEGRAM_BOT_TOKEN ? 'healthy' : 'unknown',
    summary: env.TELEGRAM_BOT_TOKEN ? 'Bot yapılandırılmış.' : 'Yapılandırılmamış (isteğe bağlı).',
  });

  if (env.LLM_CLASSIFIER_ENABLED) {
    const [llmErrors, llmTotal] = await Promise.all([
      repos.store.count('llmAnalyses', { status: { $in: ['error', 'timeout'] }, createdAt: { $gte: since } }),
      repos.store.count('llmAnalyses', { createdAt: { $gte: since } }),
    ]);
    checks.push({
      area: 'Yapay zekâ kapısı',
      level: llmTotal > 0 && llmErrors / llmTotal > 0.5 ? 'warning' : 'healthy',
      summary: `Son 24 saatte ${llmTotal} analiz, ${llmErrors} sağlayıcı hatası. Hata olsa da ilanlar kurallarla işlenmeye devam eder.`,
    });
  } else {
    checks.push({ area: 'Yapay zekâ kapısı', level: 'unknown', summary: 'Kapalı (belirsiz ilanlar insan incelemesine kalır).' });
  }

  const recentErrors = readRecentErrors(logPaths);
  if (logPaths.length === 0) {
    checks.push({ area: 'Kalıcı log', level: 'unknown', summary: 'LOG_FILE tanımlı değil; son hatalar dosyadan okunamadı.', action: 'API ve worker için LOG_FILE=./logs/api.log ve ./logs/worker.log tanımlayın.' });
  }

  return { checkedAt: now.toISOString(), level: worst(checks.map((check) => check.level === 'unknown' ? 'healthy' : check.level)), checks, recentErrors };
}

const LABEL: Record<StatusLevel, string> = {
  healthy: 'ÇALIŞIYOR',
  warning: 'UYARI',
  critical: 'KRİTİK',
  unknown: 'BİLİNMİYOR',
};

export function formatStatusReport(report: StatusReport): string {
  const lines = [`Kamuİlan durum raporu — ${report.checkedAt}`, `GENEL: ${LABEL[report.level]}`, ''];
  for (const check of report.checks) {
    lines.push(`[${LABEL[check.level]}] ${check.area}: ${check.summary}`);
    if (check.action) lines.push(`    → Yapılacak: ${check.action}`);
  }
  lines.push('', report.recentErrors.length ? 'Son hatalar (loglardan):' : 'Loglarda son hata yok.');
  for (const error of report.recentErrors) {
    lines.push(`  ${error.time} [${error.component}] ${error.message}${error.context ? ` (${error.context})` : ''}`);
  }
  lines.push('', 'Bir sorun varsa bu çıktının tamamını Claude Code\'a yapıştırıp "teşhis et ve düzelt" deyin.');
  return lines.join('\n');
}
