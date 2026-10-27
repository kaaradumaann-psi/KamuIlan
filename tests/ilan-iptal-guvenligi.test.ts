/**
 * İptal/düzeltme duyuruları: gerçek biçimler ve güvenli hedef seçimi.
 *
 * Neden bu test dosyası (kanıt: 21.10.2026 ilan.gov.tr personel alımı listesi):
 * aynı gün yayımlanan gerçek bir kayıt **"İptal İlanı (İzmir Kalkınma Ajansı)"**
 * başlığını taşıyordu. Eski `detectWithdrawalSignal()` yalnızca "ilan iptal…"
 * sırasını tanıyordu; bu yüzden gerçek iptal duyurusu sıradan bir "ret" olarak
 * düşüyor ve iptal edilen ilan **başvuru açık** kalmaya devam ediyordu.
 *
 * İkinci risk daha ağırdır: iptal duyurusunun hedef ilanı `candidates[0]` ile
 * seçiliyordu; kurum bilgisi eşleşmediğinde bu, "en son eklenen ilan" demektir.
 * Yani ilgisiz bir ilan iptal edilmiş gibi kapatılabiliyordu. Hedef artık yalnızca
 * kanıtla (resmî ilan no, kanonik URL, başlık kapsama, kurum + yüksek başlık
 * benzerliği) seçilir; kanıt yoksa kayıt insan incelemesine gider.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/db/file-store';
import { createRepos, type Repos } from '../src/db/repos';
import { fixedClock } from '../src/lib/clock';
import { applyRawAnnouncement, detectWithdrawalSignal } from '../src/ingest/jobs-service';
import { sozlesmeliPersonelIlani } from './fixtures/announcements';
import type { RawAnnouncement } from '../src/domain';

const NOW = new Date('2026-10-21T09:00:00+03:00');
const WORKER = 'worker-iptal-test';

async function makeRepos(): Promise<Repos> {
  const dir = mkdtempSync(join(tmpdir(), 'kamuilan-iptal-'));
  const store = new FileStore(dir);
  await store.init();
  return createRepos(store, fixedClock(NOW));
}

async function apply(repos: Repos, item: RawAnnouncement) {
  return applyRawAnnouncement(item, { repos, now: NOW, workerId: WORKER, provenance: 'scraped' });
}

/**
 * Kaynak listesinden gelen gerçek biçimde bir iptal duyurusu.
 * Zorunlu alanlar (attachments, publishedAt…) gerçek ilan fixture'ından miras alınır.
 */
function iptalIlani(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
  return sozlesmeliPersonelIlani({
    sourceItemId: 'ILN-IPTAL-0001',
    url: 'https://www.ilan.gov.tr/ilan/2264013/iptal-ilani',
    title: 'İptal İlanı (İzmir Kalkınma Ajansı)',
    institution: 'İZMİR KALKINMA AJANSI GENEL SEKRETERLİĞİ',
    bodyText:
      'İzmir Kalkınma Ajansı Genel Sekreterliğince yayımlanan personel alım ilanı iptal edilmiştir.',
    rawExcerpt: 'İptal ilanı',
    ...overrides,
  });
}

describe('detectWithdrawalSignal — gerçek başlık biçimleri', () => {
  it('kaynakta görülen "İptal İlanı (…)" biçimini geri çekme olarak tanır', () => {
    expect(detectWithdrawalSignal('İptal İlanı (İzmir Kalkınma Ajansı)', '')).toBe('withdrawn');
    expect(detectWithdrawalSignal('İptal Duyurusu', '')).toBe('withdrawn');
  });

  it('mevcut biçimleri korur', () => {
    expect(detectWithdrawalSignal('Örnek Kurum: Personel Alım İlanı İptal Edilmiştir', '')).toBe(
      'withdrawn',
    );
    expect(detectWithdrawalSignal('Personel alım ilanı geri çekilmiştir', '')).toBe('withdrawn');
    expect(detectWithdrawalSignal('(Düzeltme İlanı) Uludağ Üniversitesi Rektörlüğü', '')).toBe(
      'correction',
    );
    expect(detectWithdrawalSignal('Düzeltme Duyurusu', '')).toBe('correction');
  });

  it('koşullu/olumsuz ifadeleri iptal saymaz (yanlış iptal koruması)', () => {
    expect(
      detectWithdrawalSignal(
        'Sözleşmeli Personel Alım İlanı',
        'Sınav iptal edilirse başvurular yeniden değerlendirilir. İptal edilebilir hükümler saklıdır.',
      ),
    ).toBeNull();
    expect(
      detectWithdrawalSignal('Hastane Temizlik Hizmeti Alım İlanı', 'İhale iptal edilebilir.'),
    ).toBeNull();
    expect(detectWithdrawalSignal('Zabıta Memuru Alım İlanı', 'Başvuru süresi 5 gündür.')).toBeNull();
  });
});

describe('iptal duyurusunun hedef ilanı', () => {
  it('kurum eşleşmese bile ilgisiz bir ilanı İPTAL ETMEZ; kurumun ilanı yoksa incelemesiz kaydedilir', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());
    expect(first.action).toBe('created');

    const outcome = await apply(repos, iptalIlani());

    // Çıktı: ilan kapatılmaz.
    const job = await repos.jobs.findById(first.jobId as string);
    expect(job?.status).not.toBe('cancelled');
    expect(outcome.jobId).toBeNull();
    expect(outcome.action).toBe('withdrawal-signal');
  });

  it('kurum bilgisi hiç yoksa da ilgisiz ilanı kapatmaz', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());

    const outcome = await apply(
      repos,
      iptalIlani({ institution: undefined, title: 'İlan iptal duyurusu' }),
    );

    const job = await repos.jobs.findById(first.jobId as string);
    expect(job?.status).not.toBe('cancelled');
    expect(outcome.action).toBe('review');
  });

  it('başlığında orijinal ilan adı geçen iptal duyurusu doğru ilanı kapatır', async () => {
    const repos = await makeRepos();
    const first = await apply(repos, sozlesmeliPersonelIlani());
    const original = await repos.jobs.findById(first.jobId as string);

    const outcome = await apply(
      repos,
      iptalIlani({
        url: 'https://ornek.test/iptal-duyurusu',
        title: `İptal İlanı: ${original?.title ?? ''}`,
        institution: original?.institution,
        bodyText: 'Yukarıda adı geçen ilan iptal edilmiştir.',
      }),
    );

    expect(outcome.action).toBe('withdrawal-signal');
    expect(outcome.jobId).toBe(first.jobId);
    expect((await repos.jobs.findById(first.jobId as string))?.status).toBe('cancelled');
  });
});
