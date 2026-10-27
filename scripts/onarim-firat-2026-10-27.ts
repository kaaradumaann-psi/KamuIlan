/**
 * Tek seferlik onarım (27.10.2026, kullanıcı onayıyla): RG 26.10.2026-4-4 (Fırat Ü.) PDF'i iki ilan
 * içeriyordu; eski kod tek kayıt oluşturup son başvuruyu sınav günü (16.11) sanmıştı.
 * Resmî PDF yeniden indirilir, yeni kodla bölünür ve iki parça normal kabul hattından geçirilir:
 *  - 1. parça mevcut kaynak kimliğiyle → var olan ilan GÜNCELLENİR (son başvuru 09.11, 65 kadro);
 *  - 2. parça `#2` kimliğiyle → öğretim elemanı ilanı AYRI kayıt olur (son başvuru 10.11).
 * LLM çağrılmaz. Varsayılan KURU çalışmadır; yazmak için `--uygula`.
 */
import { initStore, closeStore } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { extractPdfText } from '../src/extraction/pdf';
import { applyRawAnnouncement } from '../src/ingest/jobs-service';
import { sanitizeRawAnnouncement } from '../src/ingest/sanitize';
import { splitResmiGazeteAnnouncements, deriveTitle } from '../src/sources/adapters/resmigazete';
import { extract } from '../src/extraction/engine';
import { toIstanbulIso } from '../src/domain/dates';
import type { RawAnnouncement } from '../src/domain';

const URL_PDF = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/2026/10/20261026-4-4.pdf';
const ROW = 'Fırat Üniversitesi Rektörlüğünden';
const apply = process.argv.includes('--uygula');

const response = await fetch(URL_PDF, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; KamuIlan/0.3; +https://kamuilan.halilkaraduman.com.tr)' } });
if (!response.ok) throw new Error(`PDF indirilemedi: HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const pdf = await extractPdfText(bytes, { maxPages: 16, maxChars: 60_000 });
const segments = splitResmiGazeteAnnouncements(pdf.text);
if (segments.length !== 2) throw new Error(`Beklenen 2 parça, bulunan ${segments.length}`);
const publishedAt = toIstanbulIso('2026-10-26', '00:00');

const raws: RawAnnouncement[] = segments.map((bodyText, index) => ({
  sourceKey: 'resmigazete-cestili-ilanlar',
  sourceItemId: index === 0 ? 'resmigazete:20261026-4-4.pdf' : 'resmigazete:20261026-4-4.pdf#2',
  url: URL_PDF,
  title: deriveTitle(bodyText, ROW, 'Fırat Üniversitesi Rektörlüğü', '2026-10-26'),
  bodyText,
  bodyTextSource: 'document',
  institution: 'Fırat Üniversitesi Rektörlüğü',
  publishedAt,
  attachments: [{ url: URL_PDF, label: 'Resmî Gazete ilan belgesi (PDF)', kind: 'pdf', sizeBytes: bytes.byteLength }],
  sourceCategory: 'resmi-gazete-cesitli-ilanlar',
  rawExcerpt: bodyText.slice(0, 1_200),
  extractionConfidence: 0.6,
  notes: [`PDF 2 ayrı ilan içeriyor; bu kayıt ${index + 1}. ilandır. (onarım 27.10.2026)`],
}));

for (const raw of raws) {
  const preview = extract({ title: raw.title, body: raw.bodyText ?? '', listing: { publishedAt }, bodySource: 'document' });
  console.log(`• ${raw.sourceItemId}: "${raw.title}" → son başvuru ${preview.applicationEndDate}, kontenjan ${preview.quota}, yöntem ${preview.applicationMethod}`);
}
if (!apply) {
  console.log('KURU ÇALIŞMA: veritabanına yazılmadı (--uygula ile yazılır).');
  process.exit(0);
}

const store = await initStore(undefined, { ensureIndexes: false });
try {
  const repos = createRepos(store);
  for (const raw of raws) {
    const outcome = await applyRawAnnouncement(sanitizeRawAnnouncement(raw), {
      repos,
      now: new Date(),
      workerId: 'onarim-firat-2026-10-27',
      provenance: 'scraped',
    });
    console.log(`✔ ${raw.sourceItemId}: ${outcome.action} ${outcome.jobId ?? ''} ${outcome.changes.join(', ')}`);
  }
} finally {
  await closeStore();
}
