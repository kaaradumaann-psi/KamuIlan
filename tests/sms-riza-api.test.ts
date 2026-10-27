/**
 * SMS açık rıza API'si: numara + rıza olmadan SMS açılamaz; rıza geri alınınca kapanır;
 * numara denetim kaydına yazılmaz.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { hashPassword } from '../src/server/passwords';
import { buildApp } from '../src/server/app';

const CREDENTIAL = 'Deneme-Parola-2026!';

describe('PUT /api/notifications/sms', () => {
  it('numara normalize edilir, rıza zorunludur, numara denetim kaydına yazılmaz', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-sms-')), 'db.json');
    await store.init();
    const repos = createRepos(store, fixedClock(new Date('2026-10-27T10:00:00.000Z')));
    const { hash, salt } = await hashPassword(CREDENTIAL);
    const created = await repos.users.create({ email: 'sms@ornek.test', passwordHash: hash, passwordSalt: salt, displayName: 'Aday', emailVerified: true });
    const app = await buildApp({ repos, logger: createLogger('sms-test', { level: 'silent' }), disableRateLimit: true });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'sms@ornek.test', password: CREDENTIAL } });
      const csrf = (login.json() as { csrfToken: string }).csrfToken;
      const cookies = login.cookies as { name: string; value: string }[];
      const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const put = (payload: Record<string, unknown>) =>
        app.inject({ method: 'PUT', url: '/api/notifications/sms', headers: { cookie, 'x-csrf-token': csrf }, payload });

      expect((await put({ phone: '0532 123 45 67', consent: false, enabled: true })).statusCode).toBe(400);
      expect((await put({ phone: '12', consent: true, enabled: true })).statusCode).toBe(400);

      const ok = await put({ phone: '0532 123 45 67', consent: true, enabled: true });
      expect(ok.statusCode).toBe(200);
      const pref = await repos.notifications.getPreference(created.user.id);
      expect(pref?.sms).toEqual({ enabled: true, phoneE164: '+905321234567', consentAt: '2026-10-27T10:00:00.000Z' });

      const off = await put({ phone: '0532 123 45 67', consent: false, enabled: false });
      expect(off.statusCode).toBe(200);
      expect((await repos.notifications.getPreference(created.user.id))?.sms).toMatchObject({ enabled: false, consentAt: null });

      const logs = await store.find('auditLogs', {});
      expect(JSON.stringify(logs)).not.toContain('532123');
    } finally {
      await app.close();
    }
  });
});
