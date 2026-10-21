/**
 * İlan birimi (`unit`) çıkarımı — gerçek Resmî Gazete metinleri (21.10.2026).
 *
 * Eski kalıp birim adından önceki her kelimeyi (60 karaktere kadar) alıyordu; PDF
 * tablo başlıkları gövdede tek satıra sıkıştığı için kartta "SI KADRO ÜNVANI
 * AÇIKLAMA MDF01 Mühendislik ve Doğa Bilimleri Fakültesi" gibi çöp görünüyordu.
 * Çok fakülteli ilanda da ilk fakülte ilanın birimi sanılıyordu.
 */
import { describe, expect, it } from 'vitest';
import { extractUnit } from '../src/extraction/engine';

describe('extractUnit — gerçek tablo başlıkları', () => {
  it('tablo başlığı ve ilan kodu birim adına katılmaz', () => {
    expect(
      extractUnit(
        'İletişim Bilgileri : [e-posta gizlendi] AKADEMİK İLAN KODU AKADEMİK BİRİM BÖLÜM/ PROGRAM/ ANABİLİM DALI KADRO SAYISI KADRO ÜNVANI AÇIKLAMA MDF01 Mühendislik ve Doğa Bilimleri Fakültesi Bilgisayar Mühendisliği (İngilizce) 1 Profesör',
      ),
    ).toBe('Mühendislik ve Doğa Bilimleri Fakültesi');
    expect(
      extractUnit(
        'İnternet üzerinden başvurular kabul edilmez. Akademik Birim Bölüm/ Program/ Anabilim Dalı Kadro Sayısı Unvan ALES ve Merkezi Yabancı Dil Aranan Koşullar Sınav Takvimi İktisadi ve İdari Bilimler Fakültesi Uluslararası Finans ve Bankacılık 1 Arş. Gör.',
      ),
    ).toBe('İktisadi ve İdari Bilimler Fakültesi');
  });

  it('birden fazla farklı birim varsa tek birim uydurulmaz', () => {
    expect(
      extractUnit(
        'Tablo-1: Mezun Olunması Gereken Fakülte ve Bölümler Fakülteler Bölümler Hukuk Fakültesi İktisadi ve İdari Bilimler Fakültesi İktisat Maliye',
      ),
    ).toBeNull();
  });

  it('ek almış biçim (yönelme/bulunma) birim adı sayılmaz', () => {
    expect(
      extractUnit('Dijital dosya ile birlikte Personel Daire Başkanlığına şahsen veya posta yoluyla başvurulur.'),
    ).toBeNull();
  });

  it('düz metindeki tek birim korunur', () => {
    expect(extractUnit('Doğanyol Belediye Başkanlığı Mali Hizmetler Müdürlüğü kadrosuna 2 memur alınacaktır.')).toBe(
      'Doğanyol Belediye Başkanlığı Mali Hizmetler Müdürlüğü',
    );
    expect(extractUnit('Sağlık Bilimleri Fakültesi Hemşirelik Bölümü için öğretim üyesi alınacaktır.')).toBe(
      'Sağlık Bilimleri Fakültesi',
    );
    // Aynı birim birden çok kez geçebilir: tek birimdir.
    expect(
      extractUnit('Hukuk Fakültesi Kamu Hukuku Bölümü. Başvurular Hukuk Fakültesi Dekanlığına yapılır.'),
    ).toBe('Hukuk Fakültesi');
  });
});

describe('jobs:reclassify — saklı birim düzeltmesi', () => {
  it('yalnızca kurala uymayan birim boşaltılır (kısaltılmış alıntıdan uydurulmaz); doğru birime dokunulmaz', async () => {
    const { reclassifyJob } = await import('../src/ingest/reclassify');
    const { planReclassification } = await import('../src/ingest/reclassify-batch');
    const now = new Date('2026-10-22T09:00:00+03:00');
    const base = {
      id: 'job_birim_1',
      title: 'Fenerbahçe Üniversitesi Rektörlüğünden: Öğretim Üyesi Alım İlanı',
      institution: 'Fenerbahçe Üniversitesi Rektörlüğü',
      textExcerpt:
        'AKADEMİK İLAN KODU AKADEMİK BİRİM KADRO ÜNVANI AÇIKLAMA MDF01 Mühendislik ve Doğa Bilimleri Fakültesi Bilgisayar Mühendisliği 1 Profesör. Son başvuru tarihi 03.11.2026.',
      unit: 'SI KADRO ÜNVANI AÇIKLAMA MDF01 Mühendislik ve Doğa Bilimleri Fakültesi',
      status: 'active',
      applicationEndDate: '2026-11-03',
      applicationEndAt: null,
      applicationStartAt: null,
      publishedAt: '2026-10-20',
      firstSeenAt: '2026-10-20T10:00:00.000Z',
      classification: {
        decision: 'accept',
        kind: 'job',
        employmentType: 'akademik',
        confidence: 0.9,
        reasons: [],
        rules: [],
        negativeSignals: [],
        version: '2026.10.5',
        classifiedAt: '2026-10-20T10:00:00.000Z',
      },
    } as never;
    expect(reclassifyJob(base, now).patch).toHaveProperty('unit', null);
    const clean = { ...(base as object), unit: 'Mühendislik ve Doğa Bilimleri Fakültesi' } as never;
    expect('unit' in reclassifyJob(clean, now).patch).toBe(false);
    expect(planReclassification([base, clean], now).summary.unitsCleaned).toBe(1);
  });
});

describe('birleştirme — birim', () => {
  it('saklı çöp birim yeni okumada düzelir; geçerli birim korunur', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { FileStore } = await import('../src/db/file-store');
    const { createRepos } = await import('../src/db/repos');
    const { fixedClock } = await import('../src/lib/clock');
    const { applyRawAnnouncement } = await import('../src/ingest/jobs-service');
    const { sozlesmeliPersonelIlani } = await import('./fixtures/announcements');
    const now = new Date('2026-10-22T09:00:00+03:00');
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-birim-')));
    await store.init();
    const repos = createRepos(store, fixedClock(now));
    const ctx = { repos, now, workerId: 'w', provenance: 'scraped' as const };
    const raw = sozlesmeliPersonelIlani({
      bodyText:
        'Örnek Üniversitesi Rektörlüğünden: Sağlık Bilimleri Fakültesi bünyesinde istihdam edilmek üzere 4/B sözleşmeli personel alınacaktır. Son başvuru tarihi 20.11.2026.',
    });
    const first = await applyRawAnnouncement(raw, ctx);
    const jobId = first.jobId ?? '';
    expect((await repos.jobs.findById(jobId))?.unit).toBe('Sağlık Bilimleri Fakültesi');

    await repos.jobs.updateJob(jobId, { unit: 'SI KADRO ÜNVANI AÇIKLAMA MDF01 Sağlık Bilimleri Fakültesi' });
    await applyRawAnnouncement(raw, ctx);
    expect((await repos.jobs.findById(jobId))?.unit).toBe('Sağlık Bilimleri Fakültesi');

    await applyRawAnnouncement({ ...raw, bodyText: `${raw.bodyText} Hukuk Fakültesi mezunları başvurabilir.` }, ctx);
    // Yeni okumada iki birim var (null) ama saklı geçerli birim korunur.
    expect((await repos.jobs.findById(jobId))?.unit).toBe('Sağlık Bilimleri Fakültesi');
  });
});
