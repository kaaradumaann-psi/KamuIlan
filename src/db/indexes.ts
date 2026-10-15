/**
 * Benzersizlik ve sorgu indeksleri.
 *
 * Benzersiz indeksler yalnızca performans için değil, veri bütünlüğü içindir:
 * iki worker aynı anda aynı ilanı/bildirimi işlerse ikinci yazma indeks
 * tarafından reddedilir ve sistem mevcut kaydı kullanır.
 */
import type { IndexSpec } from './ports';

export const INDEXES: readonly IndexSpec[] = [
  // Kaynaklar
  { collection: 'sources', name: 'uniq_source_key', keys: [['key', 1]], unique: true },
  { collection: 'sources', name: 'enabled_next_run', keys: [['enabled', 1], ['scrapeIntervalMinutes', 1]] },

  // İlanlar
  { collection: 'jobs', name: 'uniq_dedupe_key', keys: [['dedupeKey', 1]], unique: true },
  { collection: 'jobs', name: 'uniq_normalized_url', keys: [['normalizedUrl', 1]], unique: true },
  { collection: 'jobs', name: 'status_deadline', keys: [['status', 1], ['applicationEndDate', 1]] },
  { collection: 'jobs', name: 'created_desc', keys: [['createdAt', -1]] },
  { collection: 'jobs', name: 'published_desc', keys: [['publishedAt', -1]] },
  { collection: 'jobs', name: 'institution', keys: [['institutionNormalized', 1]] },
  { collection: 'jobs', name: 'city', keys: [['city', 1]] },
  { collection: 'jobs', name: 'employment_type', keys: [['employmentType', 1]] },
  { collection: 'jobs', name: 'source_keys', keys: [['sourceKeys', 1]] },
  { collection: 'jobs', name: 'title_norm', keys: [['titleNormalized', 1]] },

  // İlan-kaynak bağları
  { collection: 'jobSources', name: 'uniq_source_item', keys: [['sourceKey', 1], ['sourceItemId', 1]], unique: true },
  { collection: 'jobSources', name: 'job_id', keys: [['jobId', 1]] },

  // Tarama belleği (ilan oluşturmayan işlenmiş kaynak kayıtları)
  { collection: 'sourceItemDecisions', name: 'uniq_source_item_decision', keys: [['sourceKey', 1], ['sourceItemId', 1]], unique: true },
  { collection: 'sourceItemDecisions', name: 'decision_source_key', keys: [['sourceKey', 1]] },

  // Sürüm geçmişi
  { collection: 'jobRevisions', name: 'uniq_job_version', keys: [['jobId', 1], ['version', 1]], unique: true },

  // Kullanıcı ve oturum
  { collection: 'users', name: 'uniq_email', keys: [['emailNormalized', 1]], unique: true },
  { collection: 'sessions', name: 'uniq_token_hash', keys: [['tokenHash', 1]], unique: true },
  { collection: 'sessions', name: 'user_id', keys: [['userId', 1]] },
  { collection: 'sessions', name: 'expires', keys: [['expiresAt', 1]] },
  { collection: 'tokens', name: 'uniq_token_hash', keys: [['tokenHash', 1]], unique: true },
  { collection: 'tokens', name: 'user_type', keys: [['userId', 1], ['type', 1]] },

  // Bildirim
  { collection: 'notificationPreferences', name: 'uniq_user', keys: [['userId', 1]], unique: true },
  { collection: 'notificationEvents', name: 'uniq_idempotency', keys: [['idempotencyKey', 1]], unique: true },
  { collection: 'notificationEvents', name: 'user_job', keys: [['userId', 1], ['jobId', 1]] },

  // E-posta kuyruğu
  { collection: 'emailOutbox', name: 'uniq_idempotency', keys: [['idempotencyKey', 1]], unique: true },
  { collection: 'emailOutbox', name: 'status_next_attempt', keys: [['status', 1], ['nextAttemptAt', 1]] },
  { collection: 'emailOutbox', name: 'user_created', keys: [['userId', 1], ['createdAt', -1]] },

  // Telegram bağlantıları
  { collection: 'telegramLinks', name: 'uniq_user', keys: [['userId', 1]], unique: true },
  { collection: 'telegramLinks', name: 'chat_id', keys: [['chatId', 1]] },
  { collection: 'emailOutbox', name: 'channel_status', keys: [['channel', 1], ['status', 1]] },

  // Tarama kayıtları
  { collection: 'scrapeRuns', name: 'source_started', keys: [['sourceKey', 1], ['startedAt', -1]] },
  { collection: 'scrapeRuns', name: 'status', keys: [['status', 1]] },

  // İnceleme kuyruğu
  { collection: 'reviewQueue', name: 'status_kind', keys: [['status', 1], ['kind', 1]] },
  { collection: 'reviewQueue', name: 'uniq_review', keys: [['kind', 1], ['url', 1], ['reason', 1]], unique: true },

  // Denetim kaydı
  { collection: 'auditLogs', name: 'created_desc', keys: [['createdAt', -1]] },
  { collection: 'auditLogs', name: 'action', keys: [['action', 1]] },

  // Kaydedilen ilanlar
  { collection: 'savedJobs', name: 'uniq_user_job', keys: [['userId', 1], ['jobId', 1]], unique: true },

  // Zamanlanmış görevler
  { collection: 'scheduledTasks', name: 'uniq_kind_source', keys: [['kind', 1], ['sourceKey', 1]], unique: true },
  { collection: 'scheduledTasks', name: 'next_run', keys: [['nextRunAt', 1]] },

  // Yerleşik kuyruk (Redis yoksa kullanılır)
  { collection: 'queueJobs', name: 'uniq_dedupe_key', keys: [['dedupeKey', 1]], unique: true },
  { collection: 'queueJobs', name: 'status_run_at', keys: [['status', 1], ['runAt', 1]] },

  // Dağıtık kilitler
  { collection: 'locks', name: 'uniq_lock_key', keys: [['key', 1]], unique: true },
  { collection: 'locks', name: 'expires', keys: [['expiresAt', 1]] },

  // Hız sınırlama
  { collection: 'rateLimits', name: 'uniq_bucket_window', keys: [['bucket', 1], ['windowStart', 1]], unique: true },
  { collection: 'rateLimits', name: 'window', keys: [['windowStart', 1]] },

  // Worker sağlığı
  { collection: 'workerHeartbeats', name: 'uniq_worker', keys: [['workerId', 1]], unique: true },
  { collection: 'workerHeartbeats', name: 'heartbeat', keys: [['lastHeartbeatAt', 1]] },
];
