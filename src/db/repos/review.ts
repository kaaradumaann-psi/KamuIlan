/**
 * İnceleme kuyruğu: düşük güvenli sınıflandırma ve şüpheli tekilleştirme.
 * Kayıt sessizce silinmez; karar verilemeyen her şey buraya düşer.
 */
import { createId } from '../../domain/ids';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { ReviewQueueDoc } from '../schemas';
import { validateDocument } from '../validate';

export class ReviewRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async enqueue(input: {
    kind: ReviewQueueDoc['kind'];
    sourceKey: string;
    title: string;
    url: string;
    reason: string;
    confidence: number;
    payload: Record<string, unknown>;
    candidateJobIds?: string[];
  }): Promise<{ item: ReviewQueueDoc; created: boolean }> {
    const now = this.clock.now().toISOString();
    const doc: ReviewQueueDoc = {
      id: createId('rev'),
      kind: input.kind,
      sourceKey: input.sourceKey,
      status: 'open',
      title: input.title.slice(0, 300),
      url: input.url,
      reason: input.reason,
      confidence: input.confidence,
      payload: input.payload,
      candidateJobIds: input.candidateJobIds ?? [],
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };
    validateDocument('reviewQueue', doc);
    const result = await this.store.insertIfAbsent('reviewQueue', doc);
    return { item: result.document, created: result.inserted };
  }

  async list(filter: { kind?: ReviewQueueDoc['kind']; status?: ReviewQueueDoc['status'] } = {}, limit = 50): Promise<ReviewQueueDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.kind) query.kind = filter.kind;
    query.status = filter.status ?? 'open';
    return this.store.find('reviewQueue', query, { limit, sort: [['createdAt', -1]] });
  }

  async countOpen(): Promise<{ total: number; classification: number; dedupe: number; extraction: number }> {
    const [total, classification, dedupe, extraction] = await Promise.all([
      this.store.count('reviewQueue', { status: 'open' }),
      this.store.count('reviewQueue', { status: 'open', kind: 'classification' }),
      this.store.count('reviewQueue', { status: 'open', kind: 'dedupe' }),
      this.store.count('reviewQueue', { status: 'open', kind: 'extraction' }),
    ]);
    return { total, classification, dedupe, extraction };
  }

  async findById(id: string): Promise<ReviewQueueDoc | null> {
    return this.store.findOne('reviewQueue', { id });
  }

  async resolve(id: string, resolution: string, resolvedBy: string): Promise<ReviewQueueDoc | null> {
    return this.store.updateOne('reviewQueue', { id }, {
      status: 'resolved',
      resolution,
      resolvedBy,
      resolvedAt: this.clock.now().toISOString(),
    });
  }

  async ignore(id: string, resolution: string, resolvedBy: string): Promise<ReviewQueueDoc | null> {
    return this.store.updateOne('reviewQueue', { id }, {
      status: 'ignored',
      resolution,
      resolvedBy,
      resolvedAt: this.clock.now().toISOString(),
    });
  }
}
