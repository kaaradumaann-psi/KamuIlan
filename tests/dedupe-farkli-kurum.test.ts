/**
 * Üretim bulgusu (22.10.2026, Resmî Gazete): farklı üniversitelerin "…Rektörlüğünden: ÖĞRETİM ÜYESİ
 * ALIM İLANI" ilanları ortak kalıp yüzünden %73–79 başlık benzerliğiyle "aynı ilan olabilir"
 * incelemesine düşüyor, yayına çıkmıyordu (Ege, Bolu AİBÜ, FSMVÜ, Çağ ↔ KTO Karatay).
 */
import { describe, expect, it } from 'vitest';
import { decideDedupe, type DedupeCandidateJob, type DedupeRawItem } from '../src/ingest/dedupe';
import { normalizeTr } from '../src/domain/text';

function candidate(title: string, institution: string, excerpt = ''): DedupeCandidateJob {
  return {
    id: 'job_1',
    title,
    titleNormalized: normalizeTr(title),
    institution,
    institutionNormalized: normalizeTr(institution),
    normalizedUrl: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261022-4-6.pdf',
    originalRefNo: null,
    applicationEndDate: '2026-11-06',
    textExcerpt: excerpt,
    sourceKeys: ['resmigazete-cestili-ilanlar'],
    sourceItemIds: [],
  };
}

function raw(title: string, institution: string | null, excerpt = ''): DedupeRawItem {
  return {
    sourceKey: 'resmigazete-cestili-ilanlar',
    sourceItemId: 'resmigazete:20261022-4-15.pdf',
    title,
    institution,
    normalizedUrl: 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261022-4-15.pdf',
    referenceNo: null,
    applicationEndDate: '2026-11-05',
    textExcerpt: excerpt,
  };
}

const karatay = candidate('KTO Karatay Üniversitesi Rektörlüğünden: ÖĞRETİM ÜYESİ ALIM İLANI', 'KTO Karatay Üniversitesi');

describe('farklı kurumların kalıp başlıklı ilanları', () => {
  it('kurum alanları farklıysa ayrı ilan olarak kaydedilir (incelemeye düşmez)', () => {
    const decision = decideDedupe(
      raw('Bolu Abant İzzet Baysal Üniversitesi Rektörlüğünden: ÖĞRETİM ÜYESİ ALIM İLANI', 'Bolu Abant İzzet Baysal Üniversitesi'),
      [karatay],
    );
    expect(decision.action).toBe('create');
  });

  it('kurum alanı boşsa başlıktaki "…den:" öneki karşılaştırılır', () => {
    const decision = decideDedupe(raw('Ege Üniversitesi Rektörlüğünden: ÖĞRETİM ELEMANI ALIM İLANI', null), [karatay]);
    expect(decision.action).toBe('create');
  });

  it('aynı kurumun benzer başlıklı ilanı yine incelemeye gider (güvenlik korunur)', () => {
    const decision = decideDedupe(
      raw('KTO Karatay Üniversitesi Rektörlüğünden: ÖĞRETİM ELEMANI ALIM İLANI', 'KTO Karatay Üniversitesi'),
      [karatay],
    );
    expect(decision.action).not.toBe('create');
  });

  it('kurum yazımı farklı ama metin aynıysa (başka siteden aynı ilan) incelemeye gider', () => {
    const text = 'Üniversitemiz birimlerine 2547 sayılı Kanun uyarınca öğretim üyesi alınacaktır. '.repeat(6);
    const decision = decideDedupe(
      raw('Karatay Üniversitesi Rektörlüğü: Öğretim Üyesi Alım İlanı', 'Konya Karatay Üni.', text),
      [candidate(karatay.title, karatay.institution, text)],
    );
    expect(decision.action).not.toBe('create');
  });
});
