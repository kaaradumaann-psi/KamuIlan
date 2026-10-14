/**
 * İlan çekimi kalite kuralları (kullanıcı raporu: 2008/2018 yayımlı ilanlar açık görünüyordu,
 * gelecek tarihli yayım, sayfa kabuğu ve tekrarlayan kurum bloğu ilanlara karışıyordu,
 * kaynaklar dakikada bir taranıyordu).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos } from '../src/db/repos';
import { isStalePublication, sanePublishedDate, STALE_PUBLICATION_DAYS } from '../src/domain/dates';
import { applyRawAnnouncement, computeStatus } from '../src/ingest/jobs-service';
import { fixedClock } from '../src/lib/clock';
import { stripPageChrome, stripRepeatedBoilerplate } from '../src/sources/adapters/ilan-gov-tr-api';
import { effectiveGlobalInterval, MIN_GLOBAL_SCAN_INTERVAL_MINUTES } from '../src/worker/scheduler';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';

const NOW = new Date('2026-10-14T12:00:00+03:00');

/** Tarih içermeyen gövde: durum yalnızca yayım tarihinden hesaplanır. */
const TARIHSIZ_GOVDE =
  'Örnek Üniversitesi Rektörlüğünden sözleşmeli personel alımı yapılacaktır. ' +
  'Aranan nitelikler ilan metninde belirtilmiştir. Başvurular kurum internet sitesi üzerinden alınacaktır.';

describe('yayım tarihi ve eski ilan kuralları', () => {
  it('bugünden sonraki yayım tarihini geçersiz sayar (ör. 12 Kasım, bugün 14 Ekim)', () => {
    expect(sanePublishedDate('2026-11-12', '2026-10-14')).toBeNull();
    expect(sanePublishedDate('2026-10-14', '2026-10-14')).toBe('2026-10-14');
    expect(sanePublishedDate('2026-10-14T09:00:00+03:00', '2026-10-14')).toBe('2026-10-14');
    expect(sanePublishedDate('2026-02-31', '2026-10-14')).toBeNull();
    expect(sanePublishedDate(null, '2026-10-14')).toBeNull();
  });

  it('60 günden eski yayımlar eski sayılır; yayım tarihi yoksa bilinmez', () => {
    expect(STALE_PUBLICATION_DAYS).toBe(60);
    expect(isStalePublication('2008-12-30', '2026-10-14')).toBe(true);
    expect(isStalePublication('2018-07-15', '2026-10-14')).toBe(true);
    expect(isStalePublication('2026-09-01', '2026-10-14')).toBe(false); // 43 gün
    expect(isStalePublication('2026-08-01', '2026-10-14')).toBe(true); // 74 gün
    expect(isStalePublication(null, '2026-10-14')).toBe(false);
  });

  it('son başvuru tarihi olmayan eski ilan açık (active) görünmez', () => {
    const status = computeStatus({
      applicationStartAt: null,
      applicationEndAt: null,
      applicationEndDate: null,
      publishedAt: '2018-07-15',
      now: NOW,
    });
    expect(status).toBe('closed');
  });

  it('son başvuru tarihi olmayan yeni ilan eski sayılmaz; hiçbir tarihi olmayan ilan bilinmez', () => {
    // Mevcut davranış: bitiş ve başlangıç tarihi yoksa durum bilinmez (inceleme bekler).
    expect(
      computeStatus({
        applicationStartAt: null,
        applicationEndAt: null,
        applicationEndDate: null,
        publishedAt: '2026-10-01',
        now: NOW,
      }),
    ).toBe('unknown');
    expect(
      computeStatus({
        applicationStartAt: null,
        applicationEndAt: null,
        applicationEndDate: null,
        publishedAt: null,
        now: NOW,
      }),
    ).toBe('unknown');
  });

  it('gelecek yayım tarihi eski sayılmaz (veri hatası)', () => {
    expect(
      computeStatus({
        applicationStartAt: null,
        applicationEndAt: null,
        applicationEndDate: null,
        publishedAt: '2026-11-12',
        now: NOW,
      }),
    ).toBe('unknown');
  });

  it('son başvuru tarihi varsa eski yayım tek başına kapatmaz (mevcut kural korunur)', () => {
    expect(
      computeStatus({
        applicationStartAt: null,
        applicationEndAt: null,
        applicationEndDate: '2026-10-30',
        publishedAt: '2018-07-15',
        now: NOW,
      }),
    ).toBe('active');
  });

  it('ingest: eski ilan kapalı ve gerekçeli kaydedilir, gelecek yayım tarihi temizlenir', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-quality-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));
    const outcome = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({
        sourceItemId: 'ESKI-2018-1',
        publishedAt: '2018-07-15',
        bodyText: TARIHSIZ_GOVDE,
      }),
      { repos, now: NOW, workerId: 'quality-test', provenance: 'sample' },
    );
    const job = await repos.jobs.findById(outcome.jobId as string);
    expect(job?.status).toBe('closed');
    expect(job?.statusReason).toContain('Yayımından uzun süre geçti');

    const future = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({
        sourceItemId: 'GELECEK-1',
        title: 'Gelecek Tarihli Yayım Testi Sözleşmeli Personel Alım İlanı',
        publishedAt: '2026-11-12',
        bodyText: TARIHSIZ_GOVDE,
      }),
      { repos, now: NOW, workerId: 'quality-test', provenance: 'sample' },
    );
    const futureJob = await repos.jobs.findById(future.jobId as string);
    expect(futureJob?.publishedAt).toBeNull();
  });

  it('bakım: mevcut eski kayıtlar bir sonraki bakımda kapatılır', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'kamuilan-sweep-')));
    await store.init();
    const repos = createRepos(store, fixedClock(NOW));
    const outcome = await applyRawAnnouncement(
      sozlesmeliPersonelIlani({
        sourceItemId: 'SWEEP-1',
        publishedAt: '2026-10-01',
        bodyText: TARIHSIZ_GOVDE,
      }),
      { repos, now: NOW, workerId: 'quality-test', provenance: 'sample' },
    );
    // Yayımı yakın ve tarihsiz: durum bilinmez (inceleme bekler), henüz kapatılmaz.
    expect((await repos.jobs.findById(outcome.jobId as string))?.status).toBe('unknown');
    // 2026-12-31: yayımdan 91 gün sonra — kural tetiklenir.
    expect(await repos.jobs.closeStalePublications('2026-12-31')).toBeGreaterThanOrEqual(1);
    expect((await repos.jobs.findById(outcome.jobId as string))?.status).toBe('closed');
  });
});

describe('kaynak tarama aralığı tabanı', () => {
  it('global override yoksa kaynak aralığı kullanılır (null)', () => {
    expect(effectiveGlobalInterval(0)).toBeNull();
  });
  it('1 dakikalık override 15 dakikaya yükseltilir (kaynakları yıpratmaz)', () => {
    expect(effectiveGlobalInterval(1)).toBe(MIN_GLOBAL_SCAN_INTERVAL_MINUTES);
    expect(effectiveGlobalInterval(MIN_GLOBAL_SCAN_INTERVAL_MINUTES)).toBe(15);
  });
  it('15 üstü değer aynen uygulanır', () => {
    expect(effectiveGlobalInterval(30)).toBe(30);
  });
});

describe('sayfa kabuğu ve tekrarlayan kurum bloğu', () => {
  it('erişilebilirlik araç çubuğu ve oturum metinlerini başlıktan çıkarır', () => {
    expect(stripPageChrome('Daha yüksek erişilebilirlik modunu aç Karayolları Genel Müdürlüğü')).toBe(
      'Karayolları Genel Müdürlüğü',
    );
    expect(stripPageChrome('Ana içeriğe atla Sıkça Sorulan Sorular ilan metni')).toBe('ilan metni');
  });

  it('beş ve üzeri ilanda tekrarlayan kurum kabuğunu gövdelerden çıkarır, özgün metni korur', () => {
    const shell =
      'BİRİMLER Genel Sekreterlik Daire Başkanlıkları Bilgi İşlem Daire Başkanlığı kurum sitesi bağlantısı';
    const ozgun = [
      'Mühendis kadrosu için elektrik bilgisi aranmaktadır',
      'Veteriner hekim alımında hayvan sağlığı deneyimi istenmektedir',
      'Şoför pozisyonu için B sınıfı ehliyet zorunludur',
      'Lojistik uzmanı başvurularında ihracat tecrübesi değerlendirilir',
      'Ebe alımı için hemşirelik lisans diploması gerekir',
    ];
    const bodies = ozgun.map(
      (text) => `${shell} ${text}. Başvurular ilan tarihinden itibaren on gün içinde alınır.`,
    );
    const cleaned = stripRepeatedBoilerplate(bodies);
    for (const text of cleaned) expect(text).not.toContain('BİRİMLER Genel Sekreterlik');
    expect(cleaned[0]).toContain('Mühendis kadrosu');
    expect(cleaned[4]).toContain('Ebe alımı');
  });

  it('dört ya da daha az ilanda ortak metne dokunmaz', () => {
    const shell =
      'BİRİMLER Genel Sekreterlik Daire Başkanlıkları Bilgi İşlem Daire Başkanlığı kurum sitesi bağlantısı';
    const bodies = [0, 1, 2].map((index) => `${shell} özgün ${index}`);
    expect(stripRepeatedBoilerplate(bodies)[0]).toContain('BİRİMLER Genel Sekreterlik');
  });
});
