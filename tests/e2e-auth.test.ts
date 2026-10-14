import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginAsAdmin } from '../e2e/support/api';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('E2E yönetici girişi', () => {
  it('sabit/sample kimlik bilgisi yerine açıkça verilen env değerlerini ister', async () => {
    vi.stubEnv('E2E_ADMIN_EMAIL', '');
    vi.stubEnv('E2E_ADMIN_PASSWORD', '');
    vi.stubEnv('ADMIN_EMAIL', '');
    vi.stubEnv('ADMIN_PASSWORD', '');

    await expect(loginAsAdmin({} as Page)).rejects.toThrow(
      /E2E_ADMIN_EMAIL\/E2E_ADMIN_PASSWORD veya ADMIN_EMAIL\/ADMIN_PASSWORD gerekir/,
    );
  });
});
