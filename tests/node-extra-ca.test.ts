/**
 * NODE_EXTRA_CA_CERTS birleştirme davranışı (kurum proxy/antivirüs kökü senaryosu).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getCACertificates = vi.fn();
vi.mock('node:tls', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, getCACertificates: (...args: unknown[]) => getCACertificates(...args) };
});

import { loadCaStore } from '../src/lib/tls-trust';

const BUNDLE = `-----BEGIN CERTIFICATE-----
AAAA
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
BBBB
-----END CERTIFICATE-----
`;

describe('NODE_EXTRA_CA_CERTS birleştirme', () => {
  let tmpDir: string;
  const origExtraCa = process.env['NODE_EXTRA_CA_CERTS'];

  beforeEach(() => {
    getCACertificates.mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), 'kamuilan-tls-test-'));
  });

  afterEach(() => {
    if (origExtraCa === undefined) delete process.env['NODE_EXTRA_CA_CERTS'];
    else process.env['NODE_EXTRA_CA_CERTS'] = origExtraCa;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('NODE_EXTRA_CA_CERTS yoksa eski davranış korunur (default + system birleşimi)', () => {
    delete process.env['NODE_EXTRA_CA_CERTS'];
    getCACertificates.mockImplementation((type: string) =>
      type === 'default' ? ['DEFAULT-ROOT'] : ['SYSTEM-ROOT'],
    );
    const bundle = loadCaStore();
    expect(bundle?.sort()).toEqual(['DEFAULT-ROOT', 'SYSTEM-ROOT'].sort());
  });

  it('NODE_EXTRA_CA_CERTS gösterildiğinde ek sertifikalar birleştirilir, tekilleştirilir', () => {
    const extraPath = join(tmpDir, 'extra.pem');
    writeFileSync(extraPath, BUNDLE, 'utf8');
    process.env['NODE_EXTRA_CA_CERTS'] = extraPath;

    getCACertificates.mockImplementation((type: string) =>
      type === 'default' ? ['DEFAULT-ROOT', 'SHARED'] : ['SYSTEM-ROOT', 'SHARED'],
    );
    const bundle = loadCaStore();
    expect(bundle).toBeDefined();
    expect(bundle).toContain('DEFAULT-ROOT');
    expect(bundle).toContain('SYSTEM-ROOT');
    // PEM bloğu bütün olarak eklenir (bloklar ayıklanır).
    const singleBlock = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    const secondBlock = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';
    expect(bundle).toContain(singleBlock);
    expect(bundle).toContain(secondBlock);
    // SHARED iki depoda da vardı; tekilleştirme nedeniyle iki kez bulunmamalı.
    const sharedCount = bundle!.filter((c) => c === 'SHARED').length;
    expect(sharedCount).toBe(1);
  });

  it('NODE_EXTRA_CA_CERTS dosyası yok/okunamazsa çökmez, diğer depolar döner', () => {
    process.env['NODE_EXTRA_CA_CERTS'] = join(tmpDir, 'olmayan.pem');
    getCACertificates.mockImplementation((type: string) =>
      type === 'default' ? ['DEFAULT-ROOT'] : ['SYSTEM-ROOT'],
    );
    const bundle = loadCaStore();
    expect(bundle?.sort()).toEqual(['DEFAULT-ROOT', 'SYSTEM-ROOT'].sort());
  });

  it('sistem deposu hata verse bile varsayılan kökleri ve ek CA dosyasını korur', () => {
    const extraPath = join(tmpDir, 'extra.pem');
    writeFileSync(extraPath, BUNDLE, 'utf8');
    process.env['NODE_EXTRA_CA_CERTS'] = extraPath;
    getCACertificates.mockImplementation((type: string) => {
      if (type === 'system') throw new Error('Windows certificate store unavailable');
      return ['DEFAULT-ROOT'];
    });
    expect(loadCaStore()).toEqual([
      'DEFAULT-ROOT',
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----',
    ]);
  });

  it('sistem deposu hata verdiğinde ek CA olmasa da varsayılan kökler korunur', () => {
    delete process.env['NODE_EXTRA_CA_CERTS'];
    getCACertificates.mockImplementation((type: string) => {
      if (type === 'system') throw new Error('unavailable');
      return ['DEFAULT-ROOT'];
    });
    expect(loadCaStore()).toEqual(['DEFAULT-ROOT']);
  });

  it('eski Node (<22.15) sistem deposu API\'si yoksa ve NODE_EXTRA_CA_CERTS ayarlıysa CA zorla ezilmez; undefined döner', () => {
    // Not: eski Node'da getCACertificates yoktur; varsayılan depoyu programlı olarak
    // okuyamayız. Bu durumda `ca` seçeneği vermek yerine Node\'un kendi varsayılan
    // deposunu (Mozilla + NODE_EXTRA_CA_CERTS) kullanması için undefined döneriz.
    const extraPath = join(tmpDir, 'extra.pem');
    writeFileSync(extraPath, BUNDLE, 'utf8');
    process.env['NODE_EXTRA_CA_CERTS'] = extraPath;
    getCACertificates.mockImplementation(() => { throw new Error('unsupported'); });
    expect(loadCaStore()).toBeUndefined();
  });
});
