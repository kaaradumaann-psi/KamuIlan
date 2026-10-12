/**
 * Resmî Gazete — Çeşitli İlânlar adaptörü (PDF tabanlı).
 *
 * Doğrulanmış akış (12.10.2026, canlı):
 *   /fihrist?tarih=YYYY-MM-DD  → günün bölüm bağlantıları
 *   /ilanlar/eskiilanlar/YYYY/MM/YYYYMMDD-4.htm → "ÇEŞİTLİ İLÂNLAR" tablosu
 *   Her satır bir kurum ilanı ve ilgili PDF'e (…-4-N.pdf) bağlantı verir.
 *
 * İlan metninin TAMAMI PDF içindedir; bu yüzden PDF indirilip metin katmanı
 * okunur. Taranmış PDF'lerde metin katmanı bulunmaz: bu durumda kayıt yine
 * oluşturulur (ek saklanır, durum "metin katmanı yok" olarak bildirilir) ve
 * metin gerektiren alanlar boş bırakılır — tahmin yürütülmez.
 */
import { collapseWhitespace } from '../../domain/text';
import { firstDateOnlyIn } from '../../domain/dates';
import { addDaysDateOnly, toIstanbulDateOnly, toIstanbulIso } from '../../domain/dates';
import type { JobAttachment, RawAnnouncement } from '../../domain';
import { AdapterStructureError } from '../errors';
import { cleanInstitution } from '../listing-utils';
import { loadHtml, readableText, absoluteUrl } from '../../lib/html';
import { extractPdfText } from '../../extraction/pdf';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

const RESMI_GAZETE_HOST = 'https://www.resmigazete.gov.tr';
const SECTION_PATTERN = /-\d+\.htm$/i;
const PDF_PATTERN = /\.pdf$/i;

interface SectionRow {
  index: number;
  pdfUrl: string;
  rowText: string;
}

export class ResmiGazeteAdapter implements SourceAdapter {
  readonly key = 'resmigazete-cestili';
  readonly label = 'Resmî Gazete — Çeşitli İlânlar';
  readonly method = 'pdf-index';
  readonly notes =
    'Günlük nüshadaki Çeşitli İlânlar bölümü HTML olarak okunur, ilan metni PDF metin katmanından çıkarılır. ' +
    'Yargı/ihale bölümleri kapsam dışıdır.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const items: RawAnnouncement[] = [];
    const notes: string[] = [];
    let requestCount = 0;
    let etag: string | null = null;
    let lastModified: string | null = null;
    let notModified = false;
    let detailFetches = 0;

    if (!ctx.liveFetch) {
      notes.push('Canlı erişim kapalı (SOURCE_LIVE_FETCH=0): adaptör yalnızca yapılandırma doğrulaması yaptı.');
      return { items, requestCount, notes, etag, lastModified, notModified };
    }

    const today = toIstanbulDateOnly(ctx.fetchedAt);
    const days = [0, 1]; // Bugün yayımlanmadıysa dünkü nüsha okunur.

    for (const offset of days) {
      const dateOnly = addDaysDateOnly(today, -offset);
      const sectionUrl = this.sectionUrl(dateOnly);
      const response = await ctx.http.fetchText(sectionUrl, {
        allowedHosts: ctx.source.allowedHosts,
        minIntervalMs: ctx.source.minRequestIntervalMs,
        // Yalnızca bugünün sayfası için koşullu istek anlamlıdır.
        ...(offset === 0 ? {} : {}),
      });
      requestCount += 1;

      if (response.notModified && offset === 0) {
        notModified = true;
        notes.push(`${dateOnly} nüshası değişmemiş (304).`);
        break;
      }

      const html = response.decoded?.text ?? response.body.toString('utf8');
      const $ = loadHtml(html);
      const rows = this.parseSectionRows($, sectionUrl);

      const pageText = readableText($, 'body', 5_000).toLocaleLowerCase('tr');
      const isAnnouncementPage = pageText.includes('ilân') || pageText.includes('ilan') || rows.length > 0;
      if (!isAnnouncementPage) {
        throw new AdapterStructureError(
          this.key,
          `Resmî Gazete Çeşitli İlânlar sayfası beklenen biçimde değil (${sectionUrl}).`,
          'Sayfa yüklendi ancak ne ilan bağlantısı ne de ilan metni bulundu; HTML yapısı değişmiş olabilir.',
        );
      }

      if (rows.length === 0) {
        notes.push(`${dateOnly} nüshasında Çeşitli İlânlar bölümü boş görünüyor (yapı doğrulandı).`);
        continue;
      }

      if (offset === 0) {
        etag = response.etag;
        lastModified = response.lastModified;
      }

      for (const row of rows) {
        const sourceItemId = this.sourceItemId(row.pdfUrl);
        const alreadyKnown = ctx.knownItemIds?.has(sourceItemId) ?? false;
        if (alreadyKnown || detailFetches >= ctx.maxDetailFetches) {
          if (!alreadyKnown) notes.push(`Belge indirme sınırı (${ctx.maxDetailFetches}) doldu; kalan ilanlar sonraki taramada alınacak.`);
          continue;
        }

        detailFetches += 1;
        const pdfResponse = await ctx.http.fetchBinary(row.pdfUrl, {
          allowedHosts: ctx.source.allowedHosts,
          minIntervalMs: ctx.source.minRequestIntervalMs,
          maxBytes: 15_728_640,
        });
        requestCount += 1;

        const pdf = await extractPdfText(new Uint8Array(pdfResponse.body), { maxPages: 16, maxChars: 60_000 });
        const itemNotes: string[] = [];
        if (pdf.error) itemNotes.push(`PDF okunamadı: ${pdf.error}`);
        if (pdf.noTextLayer && !pdf.error) {
          itemNotes.push('PDF metin katmanı yok (taranmış görüntü olabilir); metin alanları boş bırakıldı, belge saklandı.');
        }

        const rowInstitution = cleanInstitution(row.rowText);
        const title = deriveTitle(pdf.text, row.rowText, rowInstitution, dateOnly);
        const bodyText = pdf.text;
        const publishedAt = toIstanbulIso(dateOnly, '00:00');

        const attachment: JobAttachment = {
          url: row.pdfUrl,
          label: 'Resmî Gazete ilan belgesi (PDF)',
          kind: 'pdf',
          sizeBytes: pdfResponse.bytes,
        };

        items.push({
          sourceKey: ctx.source.key,
          sourceItemId,
          url: row.pdfUrl,
          title,
          bodyText,
          ...(rowInstitution ? { institution: rowInstitution } : {}),
          publishedAt,
          attachments: [attachment],
          sourceCategory: 'resmi-gazete-cesitli-ilanlar',
          rawExcerpt: collapseWhitespace(bodyText.slice(0, 1_200)),
          extractionConfidence: pdf.noTextLayer ? 0.2 : pdf.error ? 0.1 : 0.6,
          ...(itemNotes.length > 0 ? { notes: itemNotes } : {}),
        });
      }
    }

    notes.push(
      `${requestCount} istek yapıldı, ${items.length} ilan hazırlandı. ` +
        'Çeşitli İlânlar bölümünde yayımlanan her ilan ayrı bir PDF’tir; metin katmanı olmayan belgeler insan incelemesine düşer.',
    );

    return { items, requestCount, notes, etag, lastModified, notModified };
  }

  private sectionUrl(dateOnly: string): string {
    const [year, month, day] = dateOnly.split('-');
    return `${RESMI_GAZETE_HOST}/ilanlar/eskiilanlar/${year}/${month}/${year}${month}${day}-4.htm`;
  }

  private sourceItemId(pdfUrl: string): string {
    const file = pdfUrl.split('/').pop() ?? pdfUrl;
    return `resmigazete:${file}`;
  }

  /** Bölüm sayfasındaki ilan satırlarını (kurum → PDF) çıkarır. */
  parseSectionRows($: ReturnType<typeof loadHtml>, pageUrl: string): SectionRow[] {
    const rows: SectionRow[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_index, element) => {
      const node = $(element);
      const href = absoluteUrl(node.attr('href'), pageUrl, $);
      if (!href || !PDF_PATTERN.test(href)) return;
      if (!SECTION_PATTERN.test(new URL(href).pathname.replace(PDF_PATTERN, '.htm'))) {
        // Belge adı "-4-N.pdf" biçiminde olmalı.
        if (!/-\d+-\d+\.pdf$/i.test(new URL(href).pathname)) return;
      }
      if (seen.has(href)) return;
      seen.add(href);

      const container = node.closest('td, li, tr, div');
      const rowText = collapseWhitespace(
        (container.length > 0 ? container.text() : node.parent().text()) || node.text(),
      )
        .replace(/\s*\(?PDF\)?\s*$/i, '')
        .trim();

      rows.push({
        index: rows.length,
        pdfUrl: href,
        rowText: rowText.length >= 4 ? rowText : (node.text() ?? '').trim(),
      });
    });

    return rows;
  }

  /** İnsan tarafından okunabilir ilk başlığı bulur; bulunamazsa satır metni kullanılır. */
  static deriveTitleFromRow(rowText: string): string {
    return collapseWhitespace(rowText.replace(/[:;]\s*$/, ''));
  }
}

function deriveTitle(pdfText: string, rowText: string, institution: string | null, dateOnly: string): string {
  const normalizedRow = collapseWhitespace(rowText.replace(/[:;]\s*$/, ''));
  if (pdfText) {
    const lines = pdfText
      .split('\n')
      .map((line) => collapseWhitespace(line))
      .filter((line) => line.length >= 12);
    const heading = lines.find((line) =>
      /\b(?:ilan[ıi]?|al[ıi]m[ıi]?|alım|duyuru|sınav|kadro|personel|ba[şs]vuru)\b/iu.test(line) && !/^\d/.test(line),
    );
    if (heading) {
      const cleaned = heading.replace(/\s{2,}/g, ' ').replace(/[:;]$/, '').trim();
      if (cleaned.length >= 12) return cleaned.slice(0, 300);
    }
  }
  if (normalizedRow.length >= 8) return `${normalizedRow} — ${dateOnly}`.slice(0, 300);
  if (institution) return `${institution} ilanı — ${dateOnly}`.slice(0, 300);
  return `Resmî Gazete ilanı — ${dateOnly}`;
}

export { deriveTitle, firstDateOnlyIn };
