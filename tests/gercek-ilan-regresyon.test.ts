/**
 * Gerçek kaynak gözlemiyle sınıflandırma regresyonu.
 *
 * `tests/fixtures/eval/labeled-set.json` kümesinin tamamı sentetik başlıklardan
 * oluşuyordu (17 kayıt, 0 gerçek kayıt); bu yüzden ölçüm raporu dürüstçe
 * "gerçek dünya doğruluğu DEĞİLDİR" diyordu. Bu dosya, 21.10.2026 tarihinde
 * resmî kaynaklardan OKUNAN gerçek başlıkları sabitler:
 *
 *   • ilan.gov.tr personel alımı listesi (gerçek pozitifler + gerçek iptal/düzeltme)
 *   • icisleri.gov.tr duyurular (süreç duyurusu / sonuç / haber ayrımı)
 *   • resmigazete.gov.tr Çeşitli İlânlar (yalnızca kurum adı gelen biçim)
 *
 * Etiketleri ajan koydu (`labelProvenance: agent-observed`, `humanVerified: false`).
 * Bu küme **yanlış kabul koruması** ve regresyon içindir; precision/recall iddiası
 * için insan doğrulamalı küme gerekir (`npm run eval:build-set`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import { detectWithdrawalSignal } from '../src/ingest/jobs-service';

interface RealRecord {
  id: string;
  sourceKey: string;
  sourceUrl: string;
  title: string;
  institution: string | null;
  expectedIsJob: boolean;
  expectedContentType: string;
  expectedWithdrawal?: 'withdrawn' | 'correction';
  caseTag: string;
  note?: string;
}

interface RealCorpus {
  kind: string;
  observedAt: string;
  provenance: { labelProvenance: string; humanVerified: boolean; note: string };
  records: RealRecord[];
}

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'gercek-ilanlar', '2026-10-21-gozlem.json'), 'utf8'),
) as RealCorpus;

/** Sınıflandırıcı kararı "yeni ilan" mı? (süreç duyurusu ilan akışına girmez) */
function isJob(record: RealRecord): boolean {
  const result = classify({ title: record.title, body: '' });
  return result.decision === 'accept' && result.kind !== 'process';
}

describe('gerçek ilan korpusu — bütünlük', () => {
  it('künye doğru: gerçek gözlem, insan doğrulaması YOK olarak işaretli', () => {
    expect(corpus.kind).toBe('kamuilan-real-observed-corpus');
    expect(corpus.records.length).toBeGreaterThanOrEqual(18);
    expect(corpus.provenance.humanVerified).toBe(false);
    expect(corpus.provenance.labelProvenance).toBe('agent-observed');
    expect(corpus.provenance.note).toContain('insan doğrulaması YOKTUR');
  });

  it('her kayıt resmî kaynak URL’si taşır', () => {
    for (const record of corpus.records) {
      expect(record.sourceUrl, record.id).toMatch(/^https:\/\/(www\.)?(ilan\.gov\.tr|icisleri\.gov\.tr|resmigazete\.gov\.tr)\//);
    }
  });
});

describe('gerçek ilan korpusu — sınıflandırma regresyonu', () => {
  const positives = corpus.records.filter((record) => record.expectedIsJob);
  const negatives = corpus.records.filter((record) => !record.expectedIsJob);

  it('gerçek personel alım ilanlarının hiçbiri akıştan düşmez (yanlış ret yok)', () => {
    const missed = positives.filter((record) => !isJob(record));
    expect(missed.map((record) => record.title)).toEqual([]);
  });

  it('iş ilanı olmayan gerçek kayıtların hiçbiri ilan olarak yayımlanmaz (yanlış kabul yok)', () => {
    const wrong = negatives.filter((record) => isJob(record));
    expect(wrong.map((record) => record.title)).toEqual([]);
  });

  it('gerçek iptal/düzeltme duyuruları geri çekme sinyali üretir', () => {
    for (const record of corpus.records.filter((item) => item.expectedWithdrawal)) {
      expect(detectWithdrawalSignal(record.title, ''), record.title).toBe(record.expectedWithdrawal);
    }
  });
});
