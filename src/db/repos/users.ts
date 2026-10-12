/**
 * Kullanıcı, oturum ve tek kullanımlık jeton deposu.
 *
 * Gizlilik:
 *  - E-posta adresi normalize edilerek saklanır; loglarda maskelenir.
 *  - Oturum ve jeton değerleri yalnızca hash olarak tutulur.
 *  - Hesap silme (KVKK): kullanıcı verisi anonimleştirilir, oturum/jetonlar iptal edilir.
 */
import { createId, sha256Hex } from '../../domain/ids';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import type { StoragePort } from '../ports';
import type { SessionDoc, TokenDoc, UserDoc } from '../schemas';
import { validateDocument } from '../validate';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
    role?: 'user' | 'admin';
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
    await this.update(id, { emailVerified: true, emailVerifiedAt: now });
  }

  async recordLogin(id: string): Promise<void> {
    await this.store.updateOne('users', { id }, { lastLoginAt: this.clock.now().toISOString() });
  }

  /** KVKK kapsamında hesap silme: kimlik verisi anonimleştirilir. */
  async erasePersonalData(id: string): Promise<void> {
    const now = this.clock.now().toISOString();
    const user = await this.findById(id);
    if (!user) return;
    await this.store.updateOne('users', { id }, {
      status: 'deleted',
      email: `deleted+${id}@kamuradar.invalid`,
      emailNormalized: `deleted+${id}@kamuradar.invalid`,
      displayName: null,
      passwordHash: 'erased',
      passwordSalt: 'erased',
      emailVerified: false,
      emailVerifiedAt: null,
      deletedAt: now,
      updatedAt: now,
    });
    await this.store.deleteMany('sessions', { userId: id });
    await this.store.deleteMany('tokens', { userId: id });
    await this.store.deleteMany('savedJobs', { userId: id });
    await this.store.updateOne('notificationPreferences', { userId: id }, { enabled: false, paused: true });
  }

  // ---------------------------------------------------------------- oturumlar

  async createSession(input: {
    userId: string;
    token: string;
    csrfToken: string;
    ttlHours: number;
    userAgentHash?: string | null;
    ipHash?: string | null;
  }): Promise<SessionDoc> {
    const now = this.clock.now();
    const doc: SessionDoc = {
      id: createId('ses'),
      userId: input.userId,
      tokenHash: sha256Hex(input.token),
      csrfToken: input.csrfToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlHours * 3_600_000).toISOString(),
      revokedAt: null,
      userAgentHash: input.userAgentHash ?? null,
      ipHash: input.ipHash ?? null,
      lastSeenAt: now.toISOString(),
    };
    validateDocument('sessions', doc);
    await this.store.insertOne('sessions', doc);
    return doc;
  }

  async findSessionByToken(token: string): Promise<SessionDoc | null> {
    const session = await this.store.findOne('sessions', { tokenHash: sha256Hex(token) });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (new Date(session.expiresAt).getTime() <= this.clock.now().getTime()) return null;
    return session;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.store.updateOne('sessions', { id: sessionId }, { lastSeenAt: this.clock.now().toISOString() });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.store.updateOne('sessions', { id: sessionId }, { revokedAt: this.clock.now().toISOString() });
  }

  async revokeAllSessions(userId: string): Promise<number> {
    return this.store.updateMany('sessions', { userId, revokedAt: null }, { revokedAt: this.clock.now().toISOString() });
  }

  async purgeExpiredSessions(): Promise<number> {
    return this.store.deleteMany('sessions', { expiresAt: { $lt: this.clock.now().toISOString() } });
  }

  // ------------------------------------------------------------ jetonlar

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

  async consumeToken(token: string, type: TokenDoc['type']): Promise<TokenDoc | null> {
    const doc = await this.store.findOne('tokens', { tokenHash: sha256Hex(token), type });
    if (!doc) return null;
    if (doc.usedAt) return null;
    if (new Date(doc.expiresAt).getTime() <= this.clock.now().getTime()) return null;
    const updated = await this.store.updateOne('tokens', { id: doc.id, usedAt: null }, { usedAt: this.clock.now().toISOString() });
    if (!updated) return null; // eşzamanlı iki kullanımda yalnızca biri kazanır
    return updated;
  }
}
