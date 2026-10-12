/**
 * Resmî Gazete — Çeşitli İlânlar adaptörü.
 *
 * Doğrulanmış akış (12.10.2026, canlı):
 *   /fihrist?tarih=YYYY-MM-DD  → günün nüshası ve bölüm bağlantıları
 *   /ilanlar/eskiilanlar/YYYY/MM/YYYYMMDD-4.htm → "ÇEŞİTLİ İLÂNLAR" tablosu
 *   satırlar: kurum adı (…-4-N.pdf bağlantısı) → ilan metni PDF içinde
 *
 * Not: Personel alım ilanlarının hukuken yayımlandığı yer burasıdır. Yargı (-2),
 * ihale (-3) ve Merkez Bankası (-5) bölümleri kapsam dışıdır.
 *
 * İlan başlığı yalnızca PDF metninden çıkarılabilir; bu yüzden PDF metni
 * indirilir. Aynı ilan birden çok nüshada yayımlanabildiği için daha önce
 * görülmüş ve metni çıkarılmış kayıtlar tekrar indirilmez.
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { loadHtml, readableText, absoluteUrl } from '../../lib/html';
import { addDaysDateOnly, toIstanbulDateOnly } from '../../domain/dates';
import { extractPdfTextFromBuffer } from '../../extraction/pdf';
import { AdapterStructureError } from '../errors';
import { cleanInstitution, extractReferenceNo } from '../listing-utils';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

const BASE = 'https://www.resmigazete.gov.tr';
const BOLUM_PATTERN = /-\d+\.htm$/;

interface IssueSection {
  dateOnly: string;
  cesitliIlanlarUrl: string | null;
  issueNumber: string | null;
}

export class ResmiGazeteAdapter implements SourceAdapter {
  readonly key = 'resmigazete-ilan';
  readonly label = 'Resmî Gazete — Çeşitli İlânlar';

  listingUrl(): string {
    return `${BASE}/ilanlar`;
  }

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const httpStatuses: number[] = [];
    const notes: string[] = [];
    const items: RawAnnouncement[] = [];
    const today = toIstanbulDateOnly(ctx.clock.now());
    const days = Math.min(Math.max(ctx.limits.maxListingPages, 1), 3);
    let notModified = false;

    for (let offset = 0; offset < days; offset += 1) {
      const dateOnly = addDaysDateOnly(today, -offset);
      const fihristUrl = `${BASE}/fihrist?tarih=${dateOnly}`;
      const response = await ctx.fetcher.fetchText(fihristUrl, {
        source: ctx.source,
        conditional: offset === 0 ? { etag: ctx.source.health.etag, lastModified: ctx.source.health.lastModified } : undefined,
      });
      httpStatuses.push(response.status);

      if (response.notModified && offset === 0) {
        notModified = true;
        notes.push(`${dateOnly} nüshası değişmemiş (304).`);
        continue;
      }
      if (!response.text) {
        notes.push(`${dateOnly} fihristi boş yanıt döndü.`);
        continue;
      }

      const issue = this.parseFihrist(response.text, dateOnly, response.finalUrl);
      if (!issue.cesitliIlanlarUrl) {
        notes.push(`${dateOnly} nüshasında "Çeşitli İlânlar" bölümü bulunamadı (tatil günü olabilir).`);
        continue;
      }

      const sectionResponse = await ctx.fetcher.fetchText(issue.cesitliIlanlarUrl, { source: ctx.source });
      httpStatuses.push(sectionResponse.status);
      if (!sectionResponse.text) {
        notes.push(`${dateOnly} Çeşitli İlânlar sayfası okunamadı.`);
        continue;
      }

      const rows = this.parseSection(sectionResponse.text, sectionResponse.finalUrl);
      if (rows.length === 0) {
        throw new AdapterStructureError(
          ctx.source.key,
          `${dateOnly} nüshasında ilan satırı bulunamadı: sayfa yapısı değişmiş olabilir.`,
          sectionResponse.finalUrl,
        );
      }
      notes.push(`${dateOnly}: ${rows.length} ilan başlığı bulundu.`);

      for (const row of rows) {
        const itemId = row.pdfUrl.split('/').pop() ?? row.pdfUrl;
        const known = ctx.knownItemIds?.has(itemId) ?? false;
        let body = '';
        let documentMissingText = false;
        let attachmentSize: number | undefined;

        if (ctx.liveFetch && !known) {
          try {
            const pdfResponse = await ctx.fetcher.fetchBinary(row.pdfUrl, { source: ctx.source });
            httpStatuses.push(pdfResponse.status);
            if (pdfResponse.buffer) {
              attachmentSize = pdfResponse.byteLength;
              const extracted = await extractPdfTextFromBuffer(pdfResponse.buffer, { maxPages: 12, maxChars: 120_000 });
              if (extracted.hasTextLayer) {
                body = extracted.text;
              } else {
                documentMissingText = true;
                notes.push(`${itemId}: PDF metin katmanı yok (OCR gerekir) — ek bağlantısı korundu.`);
              }
              if (extracted.error) notes.push(`${itemId}: ${extracted.error}`);
            }
          } catch (error) {
            documentMissingText = true;
            notes.push(`${itemId}: PDF indirilemedi (${(error as Error).message})`);
          }
        } else if (known) {
          notes.push(`${itemId}: daha önce görüldü, PDF tekrar indirilmedi.`);
        }

        const title = this.deriveTitle(body, row.institution);
        items.push({
          sourceKey: ctx.source.key,
          sourceItemId: itemId,
          url: row.pdfUrl,
          title,
          bodyText: body || undefined,
          institution: row.institution ?? undefined,
          publishedAt: `${dateOnly}T00:00:00+03:00`,
          attachments: [{ url: row.pdfUrl, label: 'İlan metni (PDF)', kind: 'pdf', sizeBytes: attachmentSize }],
          sourceCategory: 'Resmî Gazete — Çeşitli İlânlar',
          rawExcerpt: collapseWhitespace(body).slice(0, 2_000) || row.institution || '',
          extractionConfidence: body ? 0.75 : 0.35,
          notes: documentMissingText ? ['PDF metin katmanı yok; alanlar ek bağlantısından doğrulanmalı.'] : [],
        });
      }
    }

    return {
      items,
      httpStatuses,
      notes,
      notModified,
      cacheHeaders: {
        etag: ctx.source.health.etag,
        lastModified: ctx.source.health.lastModified,
        contentHash: null,
      },
    };
  }

  /** Fihrist sayfasından günün nüshasını ve Çeşitli İlânlar bölümünü bulur. */
  parseFihrist(html: string, dateOnly: string, baseUrl: string): IssueSection {
    const root = loadHtml(html);
    const issueNumberMatch = /(\d{4,6})\s*Sayılı\s*Resmî Gazete/i.exec(readableText(root));
    let cesitliIlanlarUrl: string | null = null;

    root('a[href]').each((_, anchor) => {
      const element = root(anchor);
      const text = collapseWhitespace(element.text()).toLocaleLowerCase('tr');
      const href = absoluteUrl(element.attr('href'), baseUrl);
      if (!href) return;
      if (!BOLUM_PATTERN.test(new URL(href).pathname)) return;
      // "c - Çeşitli İlânlar" satırı
      if (/çeşitli\s*il[âa]nlar/.test(text) && /(^|\s)c\s*-/.test(text)) {
        cesitliIlanlarUrl = href;
      }
    });

    // Bazı günlerde bağlantı metni farklı olabilir; yol sonuna göre yedek arama:
    if (!cesitliIlanlarUrl) {
      const compact = dateOnly.replace(/-/g, '');
      const guess = `${BASE}/ilanlar/eskiilanlar/${dateOnly.slice(0, 4)}/${dateOnly.slice(5, 7)}/${compact}-4.htm`;
      if (html.includes(`${compact}-4.htm`)) cesitliIlanlarUrl = guess;
    }

    return { dateOnly, cesitliIlanlarUrl, issueNumber: issueNumberMatch?.[1] ?? null };
  }

  /** Çeşitli İlânlar tablosundan kurum + PDF bağlantılarını okur. */
  parseSection(html: string, baseUrl: string): { institution: string | null; pdfUrl: string }[] {
    const root = loadHtml(html);
    const rows: { institution: string | null; pdfUrl: string }[] = [];
    const seen = new Set<string>();

    root('a[href]').each((_, anchor) => {
      const element = root(anchor);
      const href = element.attr('href');
      if (!href || !/\.pdf$/i.test(href)) return;
      const url = absoluteUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);
      const institution = cleanInstitution(collapseWhitespace(element.text()) || null);
      rows.push({ institution, pdfUrl: url });
    });

    if (rows.length === 0) {
      // Bazı sayfalarda bağlantı yerine düz PDF adı geçebilir.
      const referenceMatch = /eskiilanlar\/(\d{4})\/(\d{2})\/(\d{8})-\d+\.pdf/g;
      const text = readableText(root);
      for (const match of text.matchAll(referenceMatch)) {
        const url = `${BASE}/ilanlar/eskiilanlar/${match[1]}/${match[2]}/${match[0].split('/').pop()}`;
        if (!seen.has(url)) {
          seen.add(url);
          rows.push({ institution: null, pdfUrl: url });
        }
      }
    }
    return rows;
  }

  /** PDF metninden ilan başlığını üretir; kurum adına düşer. */
  deriveTitle(body: string, institution: string | null): string {
    if (body) {
      const head = body.slice(0, 500);
      const match = /^([\s\S]{5,220}?(?:İlanı|İlanları|İlânı|İlânları|Duyurusu|İlandır|İlan Metni|Alım İlanı|Sınav İlanı|Temin İlanı))\b/u.exec(head);
      if (match?.[1]) return collapseWhitespace(match[1]).replace(/[:.]$/, '');
      const firstSentence = /^([\s\S]{10,180}?[.:])\s/.exec(head);
      if (firstSentence?.[1]) return collapseWhitespace(firstSentence[1]).replace(/[:.]$/, '');
    }
    if (institution) return collapseWhitespace(institution.replace(/[:.]$/, ''));
    return 'Resmî Gazete ilanı';
  }

  /** İlan numarası PDF adından/başlıktan çıkarılır. */
  referenceOf(item: { url: string; title: string }): string | null {
    return extractReferenceNo(item.title) ?? extractReferenceNo(item.url);
  }
}
