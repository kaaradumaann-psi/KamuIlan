/**
 * E-posta outbox'ı (transactional outbox deseni).
 *
 * Akış: bildirim olayı kaydedildikten sonra e-posta işi AYNI veritabanına yazılır.
 * Worker çökse bile iş kaybolmaz. Aynı idempotency anahtarıyla ikinci iş
 * oluşturulamaz (benzersiz indeks).
 *
 * Durum modeli: pending → sending (lease) → accepted | failed → (retry) | dead | suppressed
 * "accepted" = sağlayıcı mesajı kabul etti. "Teslim edildi" iddiası YOKTUR.
 */
import { createId, sha256Hex } from '../../domain/ids';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { EmailOutboxDoc } from '../schemas';
import { validateDocument } from '../validate';

export interface EnqueueEmailInput {
  /** Teslim kanalı (varsayılan e-posta). Telegram işleri `telegram` olarak yazılır. */
  channel?: EmailOutboxDoc['channel'];
  eventId: string | null;
  jobId: string | null;
  userId: string | null;
  kind: EmailOutboxDoc['kind'];
  toEmail: string;
  subject: string;
  template: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts?: number;
}

export function outboxIdempotencyKey(input: {
  userId: string | null;
  kind: EmailOutboxDoc['kind'];
  reference: string;
}): string {
  return sha256Hex([input.userId ?? 'anon', input.kind, input.reference].join('|')).slice(0, 48);
}

export class OutboxRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async enqueue(input: EnqueueEmailInput, maxAttemptsDefault = 5): Promise<{ item: EmailOutboxDoc; created: boolean }> {
    const now = this.clock.now().toISOString();
    const doc: EmailOutboxDoc = {
      id: createId('eml'),
      channel: input.channel ?? 'email',
      eventId: input.eventId,
      jobId: input.jobId,
      userId: input.userId,
      kind: input.kind,
      toEmail: input.toEmail,
      subject: input.subject.slice(0, 300),
      template: input.template,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? maxAttemptsDefault,
      nextAttemptAt: now,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      providerMessageId: null,
      providerResponse: null,
      acceptedAt: null,
      failedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    validateDocument('emailOutbox', doc);
    const result = await this.store.insertIfAbsent('emailOutbox', doc);
    return { item: result.document, created: result.inserted };
  }

  /**
   * Gönderilecek işleri lease'ler. İki worker aynı işi alamaz: güncelleme
   * yalnızca durum değişmediyse uygulanır (koşullu yazma).
   */
  async claimBatch(
    workerId: string,
    limit: number,
    leaseMs = 120_000,
    channel: EmailOutboxDoc['channel'] = 'email',
  ): Promise<EmailOutboxDoc[]> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    // Kanal filtresi SORGUDA değil KODDA uygulanır: eski kayıtlarda `channel`
    // alanı yoktur ve bu kayıtlar e-posta sayılmalıdır (sorguda eşleşmezlerdi).
    // Aday penceresi, diğer kanalın işleriyle dolup açlık yaratmasın diye geniştir.
    const candidates = await this.store.find(
      'emailOutbox',
      { status: { $in: ['pending', 'failed', 'sending'] }, nextAttemptAt: { $lte: nowIso } },
      { limit: limit * 10 + 50, sort: [['nextAttemptAt', 1]] },
    );

    const claimed: EmailOutboxDoc[] = [];
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      if ((candidate.channel ?? 'email') !== channel) continue;
      if (candidate.status === 'sending') {
        const lockedUntil = candidate.lockedUntil ? Date.parse(candidate.lockedUntil) : 0;
        if (lockedUntil > now.getTime()) continue; // başka worker işliyor
      }
      const updated = await this.store.updateOne(
        'emailOutbox',
        { id: candidate.id, status: candidate.status },
        {
          status: 'sending',
          lockedBy: workerId,
          lockedUntil: new Date(now.getTime() + leaseMs).toISOString(),
          updatedAt: nowIso,
        },
      );
      if (updated) claimed.push(updated);
    }
    return claimed;
  }

  /** Sağlayıcı mesajı kabul etti. Teslim edildiği iddia edilmez. */
  async markAccepted(id: string, providerMessageId: string | null, providerResponse: string | null): Promise<void> {
    const now = this.clock.now().toISOString();
    const current = await this.store.findOne('emailOutbox', { id });
    await this.store.updateOne('emailOutbox', { id }, {
      status: 'accepted',
      providerMessageId,
      providerResponse,
      acceptedAt: now,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
      attempts: (current?.attempts ?? 0) + 1,
      updatedAt: now,
    });
  }

  /** Başarısız gönderim: yeniden deneme zamanı verilir; sınır dolduysa `dead`. */
  async markFailed(id: string, error: string, retryAt: string | null): Promise<EmailOutboxDoc | null> {
    const current = await this.store.findOne('emailOutbox', { id });
    if (!current) return null;
    const now = this.clock.now().toISOString();
    const attempts = current.attempts + 1;
    const exhausted = attempts >= current.maxAttempts;
    const status: EmailOutboxDoc['status'] = retryAt && !exhausted ? 'pending' : 'dead';

    return this.store.updateOne('emailOutbox', { id }, {
      status,
      attempts,
      lastError: error.slice(0, 500),
      failedAt: now,
      nextAttemptAt: retryAt ?? now,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    });
  }

  async findById(id: string): Promise<EmailOutboxDoc | null> {
    return this.store.findOne('emailOutbox', { id });
  }

  async list(
    filter: { status?: EmailOutboxDoc['status']; userId?: string; jobId?: string; channel?: EmailOutboxDoc['channel'] } = {},
    limit = 100,
  ): Promise<EmailOutboxDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.status) query.status = filter.status;
    if (filter.channel) query.channel = filter.channel;
    if (filter.userId) query.userId = filter.userId;
    if (filter.jobId) query.jobId = filter.jobId;
    return this.store.find('emailOutbox', query, { limit, sort: [['createdAt', -1]] });
  }

  async stats(): Promise<Record<EmailOutboxDoc['status'], number>> {
    const statuses: EmailOutboxDoc['status'][] = ['pending', 'sending', 'accepted', 'failed', 'dead', 'suppressed'];
    const counts = await Promise.all(statuses.map((status) => this.store.count('emailOutbox', { status })));
    return statuses.reduce<Record<EmailOutboxDoc['status'], number>>(
      (acc, status, index) => {
        acc[status] = counts[index] ?? 0;
        return acc;
      },
      { pending: 0, sending: 0, accepted: 0, failed: 0, dead: 0, suppressed: 0 },
    );
  }

  /** Ölü mektuplar: panelde görünür ve tekrar denenebilir. */
  async listDead(limit = 50): Promise<EmailOutboxDoc[]> {
    return this.store.find('emailOutbox', { status: 'dead' }, { limit, sort: [['failedAt', -1]] });
  }

  /**
   * Kullanıcının bekleyen (henüz gönderilmemiş) işlerini bastırır. Telegram
   * bağlantısı kaldırıldığında veya engellendiğinde çağrılır: bağlantı kalktıktan
   * sonra eski bildirimlerin gönderilmesi istenmeyen bir mesaj olurdu.
   */
  async suppressPendingForUser(userId: string, channel: EmailOutboxDoc['channel'], reason: string): Promise<number> {
    const now = this.clock.now().toISOString();
    const pending = await this.store.find(
      'emailOutbox',
      { userId, channel, status: { $in: ['pending', 'failed'] } },
      { limit: 500 },
    );
    let count = 0;
    for (const item of pending) {
      const updated = await this.store.updateOne(
        'emailOutbox',
        { id: item.id, status: item.status },
        { status: 'suppressed', lastError: reason.slice(0, 500), lockedBy: null, lockedUntil: null, updatedAt: now },
      );
      if (updated) count += 1;
    }
    return count;
  }

  /** Tek bir işi bastırır (gönderim anındaki denetim: bağlantı durdu/engellendi). Ölü mektup değildir. */
  async markSuppressed(id: string, reason: string): Promise<void> {
    const now = this.clock.now().toISOString();
    await this.store.updateOne(
      'emailOutbox',
      { id },
      { status: 'suppressed', lastError: reason.slice(0, 500), lockedBy: null, lockedUntil: null, updatedAt: now },
    );
  }

  /** Ölü mektubu elle yeniden kuyruğa alır (yönetici işlemi). */
  async requeue(id: string): Promise<EmailOutboxDoc | null> {
    const now = this.clock.now().toISOString();
    return this.store.updateOne('emailOutbox', { id, status: 'dead' }, {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    });
  }
}
