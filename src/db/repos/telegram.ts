/**
 * Telegram hesap bağlantıları.
 *
 * Kurallar:
 *  - Kullanıcı başına en çok bir bağlantı (benzersiz indeks: userId).
 *  - Bir Telegram sohbeti aynı anda yalnızca bir hesaba bağlı olabilir: yeni bir
 *    hesap aynı sohbeti bağlarsa önceki bağlantı kaldırılır (paylaşılmış sohbetten
 *    başka hesabın bildirimi sızmaz).
 *  - Bağlantıyı kaldırmak kaydı `unlinked` yapar (kayıt izi). Hesap silme (KVKK)
 *    ise kişisel veriyi içeren kaydı tamamen siler: `erase`.
 */
import { createId } from '../../domain/ids';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { TelegramLinkDoc } from '../schemas';
import { validateDocument } from '../validate';

export type TelegramLinkStatus = TelegramLinkDoc['status'];

export class TelegramRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async findByUser(userId: string): Promise<TelegramLinkDoc | null> {
    return this.store.findOne('telegramLinks', { userId });
  }

  async findByChat(chatId: string): Promise<TelegramLinkDoc[]> {
    return this.store.find('telegramLinks', { chatId }, { limit: 20 });
  }

  /**
   * Sohbeti kullanıcıya bağlar (idempotent). Aynı sohbete bağlı diğer hesapların
   * bağlantıları `unlinked` yapılır.
   */
  async link(input: {
    userId: string;
    chatId: string;
    telegramUsername: string | null;
  }): Promise<TelegramLinkDoc> {
    const now = this.clock.now().toISOString();
    for (const other of await this.findByChat(input.chatId)) {
      if (other.userId !== input.userId && other.status !== 'unlinked') {
        await this.store.updateOne(
          'telegramLinks',
          { id: other.id },
          { status: 'unlinked', statusChangedAt: now, updatedAt: now, lastError: null },
        );
      }
    }
    const existing = await this.findByUser(input.userId);
    if (existing) {
      const updated = await this.store.updateOne(
        'telegramLinks',
        { userId: input.userId },
        {
          chatId: input.chatId,
          telegramUsername: input.telegramUsername,
          status: 'active',
          linkedAt: now,
          statusChangedAt: now,
          lastError: null,
          updatedAt: now,
        },
      );
      if (!updated) throw new Error('Telegram bağlantısı güncellenemedi.');
      validateDocument('telegramLinks', updated);
      return updated;
    }
    const doc: TelegramLinkDoc = {
      id: createId('tgl'),
      userId: input.userId,
      chatId: input.chatId,
      telegramUsername: input.telegramUsername,
      status: 'active',
      linkedAt: now,
      statusChangedAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    validateDocument('telegramLinks', doc);
    const result = await this.store.insertIfAbsent('telegramLinks', doc);
    if (!result.inserted) {
      // Eşzamanlı ikinci istek: mevcut kaydı güncel durumla döndür.
      return this.link(input);
    }
    return doc;
  }

  async setStatus(
    userId: string,
    status: TelegramLinkStatus,
    error: string | null = null,
  ): Promise<TelegramLinkDoc | null> {
    const now = this.clock.now().toISOString();
    return this.store.updateOne(
      'telegramLinks',
      { userId },
      { status, statusChangedAt: now, updatedAt: now, lastError: error ? error.slice(0, 300) : null },
    );
  }

  /** Kaydı `unlinked` yapar; kullanıcı yeniden bağlayana kadar gönderim yapılmaz. */
  async unlink(userId: string): Promise<TelegramLinkDoc | null> {
    return this.setStatus(userId, 'unlinked');
  }

  /**
   * KVKK silme: sohbet kimliği ve Telegram kullanıcı adı kişisel veridir; hesap
   * silindiğinde kayıt tamamen kaldırılır (kalan kayıt izi gerekmez).
   */
  async erase(userId: string): Promise<number> {
    return this.store.deleteMany('telegramLinks', { userId });
  }
}
