/**
 * Kullanıcı, oturum ve jeton deposu.
 *
 * Güvenlik:
 *  - Şifreler bu katmanda HASH'lenmiş olarak saklanır (hash üretimi auth katmanında).
 *  - Oturum ve jeton değerleri yalnızca hash olarak tutulur; düz metin saklanmaz.
 *  - KVKK: veri silme talebinde kişisel alanlar geri döndürülemez şekilde temizlenir.
 */
import { createId, randomToken, sha256Hex } from '../../domain/ids';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { SessionDoc, TokenDoc, UserDoc } from '../schemas';
import { validateDocument } from '../validate';

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase('tr');
}

export class UserRepo {
  constructor(
    private readonly store: StoragePort,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    email: string;
    passwordHash: string;
    passwordSalt: string;
    displayName?: string | null;
    role?: UserDoc['role'];
    emailVerified?: boolean;
  }): Promise<{ user: UserDoc; created: boolean }> {
    const now = this.clock.now().toISOString();
    const doc: UserDoc = {
      id: createId('usr'),
      email: input.email.trim(),
      emailNormalized: normalizeEmail(input.email),
      displayName: input.displayName ?? null,
      passwordHash: input.passwordHash,
      passwordSalt: input.passwordSalt,
      passwordAlgo: 'scrypt',
      role: input.role ?? 'user',
      emailVerified: input.emailVerified ?? false,
      emailVerifiedAt: input.emailVerified ? now : null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      deletedAt: null,
    };
    validateDocument('users', doc);
    const result = await this.store.insertIfAbsent('users', doc);
    return { user: result.document, created: result.inserted };
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.store.findOne('users', { emailNormalized: normalizeEmail(email) });
  }

  async findById(id: string): Promise<UserDoc | null> {
    return this.store.findOne('users', { id });
  }

  async update(id: string, patch: Partial<UserDoc>): Promise<UserDoc | null> {
    const updated = await this.store.updateOne('users', { id }, { ...patch, updatedAt: this.clock.now().toISOString() });
    if (updated) validateDocument('users', updated);
    return updated;
  }

  async markEmailVerified(id: string): Promise<void> {
    const now = this.clock.now().toISOString();
    await this.store.updateOne('users', { id }, { emailVerified: true, emailVerifiedAt: now, updatedAt: now });
  }

  async recordLogin(id: string): Promise<void> {
    const now = this.clock.now().toISOString();
    await this.store.updateOne('users', { id }, { lastLoginAt: now, updatedAt: now });
  }

  /**
   * KVKK: hesap silme talebi.
   * Kişisel veriler temizlenir, oturumlar iptal edilir; ilan/bildirim kayıtları
   * istatistik amaçlı anonim kalır (kullanıcı bağı koparılır).
   */
  async erasePersonalData(id: string): Promise<{ user: UserDoc | null; sessionsRevoked: number }> {
    const now = this.clock.now().toISOString();
    const user = await this.findById(id);
    if (!user) return { user: null, sessionsRevoked: 0 };

    const anonymizedEmail = `silinmis-${sha256Hex(id).slice(0, 16)}@example.invalid`;
    const updated = await this.store.updateOne('users', { id }, {
      email: anonymizedEmail,
      emailNormalized: anonymizedEmail,
      displayName: null,
      passwordHash: sha256Hex(`${id}:erased:${now}`),
      passwordSalt: sha256Hex(`${id}:salt`).slice(0, 32),
      status: 'deleted',
      emailVerified: false,
      emailVerifiedAt: null,
      deletedAt: now,
      updatedAt: now,
    });

    const sessions = await this.store.find('sessions', { userId: id });
    for (const session of sessions) {
      await this.store.updateOne('sessions', { id: session.id }, { revokedAt: now });
    }
    await this.store.deleteMany('tokens', { userId: id });
    await this.store.updateMany('notificationPreferences', { userId: id }, { enabled: false, paused: true, updatedAt: now });
    await this.store.updateMany('emailOutbox', { userId: id, status: 'pending' }, { status: 'suppressed', updatedAt: now });
    await this.store.updateMany('savedJobs', { userId: id }, { userId: `erased_${sha256Hex(id).slice(0, 20)}` });

    return { user: updated, sessionsRevoked: sessions.length };
  }

  // ------------------------------------------------------------------ oturumlar

  async createSession(input: {
    userId: string;
    ttlHours: number;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<{ session: SessionDoc; token: string; csrfToken: string }> {
    const now = this.clock.now();
    const token = randomToken(32);
    const csrfToken = randomToken(16);
    const doc: SessionDoc = {
      id: createId('ses'),
      userId: input.userId,
      tokenHash: sha256Hex(token),
      csrfToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlHours * 3_600_000).toISOString(),
      revokedAt: null,
      userAgentHash: input.userAgent ? sha256Hex(input.userAgent).slice(0, 32) : null,
      ipHash: input.ip ? sha256Hex(input.ip).slice(0, 32) : null,
      lastSeenAt: now.toISOString(),
    };
    validateDocument('sessions', doc);
    await this.store.insertOne('sessions', doc);
    return { session: doc, token, csrfToken };
  }

  async findSessionByToken(token: string): Promise<SessionDoc | null> {
    const session = await this.store.findOne('sessions', { tokenHash: sha256Hex(token) });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (Date.parse(session.expiresAt) <= this.clock.now().getTime()) return null;
    return session;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.store.updateOne('sessions', { id: sessionId }, { lastSeenAt: this.clock.now().toISOString() });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.store.updateOne('sessions', { id: sessionId }, { revokedAt: this.clock.now().toISOString() });
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const now = this.clock.now().toISOString();
    return this.store.updateMany('sessions', { userId, revokedAt: null }, { revokedAt: now });
  }

  async purgeExpiredSessions(): Promise<number> {
    return this.store.deleteMany('sessions', { expiresAt: { $lt: this.clock.now().toISOString() } });
  }

  // ------------------------------------------------------------------- jetonlar

  async createToken(input: {
    userId: string;
    type: TokenDoc['type'];
    token: string;
    ttlMinutes: number;
  }): Promise<TokenDoc> {
    const now = this.clock.now();
    const doc: TokenDoc = {
      id: createId('tok'),
      userId: input.userId,
      type: input.type,
      tokenHash: sha256Hex(input.token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString(),
      usedAt: null,
    };
    validateDocument('tokens', doc);
    await this.store.insertOne('tokens', doc);
    return doc;
  }

  /** Tek kullanımlık jeton tüketimi (yarış koşuluna dayanıklı). */
  async consumeToken(token: string, type: TokenDoc['type']): Promise<TokenDoc | null> {
    const doc = await this.store.findOne('tokens', { tokenHash: sha256Hex(token), type });
    if (!doc) return null;
    if (doc.usedAt) return null;
    if (Date.parse(doc.expiresAt) <= this.clock.now().getTime()) return null;
    const updated = await this.store.updateOne('tokens', { id: doc.id, usedAt: null }, { usedAt: this.clock.now().toISOString() });
    if (!updated) return null;
    return updated;
  }

  async findToken(token: string, type: TokenDoc['type']): Promise<TokenDoc | null> {
    const doc = await this.store.findOne('tokens', { tokenHash: sha256Hex(token), type });
    if (!doc || doc.usedAt || Date.parse(doc.expiresAt) <= this.clock.now().getTime()) return null;
    return doc;
  }
}
