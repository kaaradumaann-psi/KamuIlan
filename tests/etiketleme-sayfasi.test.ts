/**
 * Çevrimdışı etiketleme sayfası: veri gömme güvenliği ve dışa aktarma biçiminin içe aktarmayla uyumu.
 */
import { describe, expect, it } from 'vitest';
import { LABEL_CHOICES, renderLabelPage } from '../src/classification/label-page';
import { importLabeledWorksheet } from '../src/classification/eval-set';
import { CONTENT_TYPES } from '../src/domain/types';

const record = {
  id: 'job_test0001',
  origin: 'real',
  labelProvenance: 'unreviewed',
  sourceKey: 'goc-idaresi-duyurular',
  url: 'https://goc.gov.tr/ilan/1',
  title: 'Uzman Yardımcılığı </script><script>alert(1)</script>',
  institution: 'Göç İdaresi Başkanlığı',
  sourceCategory: 'kurum duyurusu',
  bodyExcerpt: 'Göç İdaresi Başkanlığı taşra teşkilatında istihdam edilmek üzere uzman yardımcısı alınacaktır.',
  bodyCompleteness: 'captured',
  machineSuggestion: { contentType: 'personnel_recruitment', decision: 'accept', confidence: 0.9, reasons: [], llm: null },
  expectedContentType: null,
  expectedFields: {},
  labelEvidence: null,
  caseTags: [],
  labeledBy: null,
  labeledAt: null,
  notes: '',
};
const worksheet = { kind: 'kamuilan-eval-worksheet', generatedAt: '2026-10-22T12:00:00Z', instructions: 'test', records: [record] };

describe('etiketleme sayfası', () => {
  it('gömülü veri </script> ile sayfadan kaçamaz', () => {
    const html = renderLabelPage(worksheet);
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\u003c/script>');
    expect(html).toContain('job_test0001');
  });

  it('seçenekler gerçek içerik türleri', () => {
    for (const choice of LABEL_CHOICES) expect(CONTENT_TYPES).toContain(choice.value);
  });

  it('dışa aktarılan biçim (sayfanın yazdığı alanlar) içe aktarmada kabul edilir', () => {
    const labeled = {
      ...worksheet,
      records: [
        {
          ...record,
          expectedContentType: 'personnel_recruitment',
          labelProvenance: 'human',
          labeledBy: 'Halil',
          labeledAt: '2026-10-22T13:00:00.000Z',
          labelEvidence: { sourceUrl: record.url, quote: 'istihdam edilmek üzere uzman yardımcısı alınacaktır', locator: '' },
        },
      ],
    };
    const { records, report } = importLabeledWorksheet(labeled);
    expect(report.rejected).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.labelProvenance).toBe('human');
  });
});
