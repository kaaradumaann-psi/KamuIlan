/**
 * Kariyer Kapısı — Kamu İşe Alım adaptörü.
 *
 * DÜRÜST DURUM: Sayfa açılıyor ancak ilan listesi tarayıcıda üretiliyor
 * (12.10.2026 canlı kontrol: HTML içinde ilan tablosu yok, "Aktif İlanlar"
 * bölümü istemci tarafında dolduruluyor). Düz HTTP isteğiyle liste okunamaz.
 *
 * Bu adaptör Playwright ile çalışır ve yalnızca tarayıcı kuruluysa devreye
 * girer. Tarayıcı yoksa iş sessizce başarılı sayılmaz: `AdapterUnavailableError`
 * fırlatılır ve kaynak sağlık panelinde "teknik gereksinim eksik" olarak görünür.
 *
 * Kurulum: `npm i -D playwright && npx playwright install chromium`
 * Kaynağı açma: yönetici panelinden `enabled=true` yapın.
 */
import { collapseWhitespace } from '../../domain/text';
import type { RawAnnouncement } from '../../domain';
import { AdapterUnavailableError } from '../errors';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  $$eval<T>(selector: string, callback: (elements: Element[]) => T): Promise<T>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launch(options: { headless: boolean; args?: string[] }): Promise<PlaywrightBrowser>;
}

interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

export class KariyerKapisiAdapter implements SourceAdapter {
  readonly key = 'kariyerkapisi';
  readonly label = 'Kariyer Kapısı — Kamu İşe Alım (tarayıcı gerektirir)';

  listingUrl(source: { listingUrl: string }): string {
    return source.listingUrl || 'https://kariyerkapisi.gov.tr/isealim';
  }

  private async loadPlaywright(): Promise<PlaywrightModule> {
    try {
      const module_ = (await import(/* @vite-ignore */ 'playwright')) as unknown as PlaywrightModule;
      if (!module_.chromium) throw new Error('chromium tanımlı değil');
      return module_;
    } catch (error) {
      throw new AdapterUnavailableError(
        this.key,
        [
          'Kariyer Kapısı ilan listesi JavaScript ile üretiliyor; tarayıcı otomasyonu gerekiyor.',
          `Playwright yüklenemedi: ${(error as Error).message}`,
          'Kurulum: npm i -D playwright && npx playwright install chromium',
        ].join(' '),
        'playwright',
      );
    }
  }

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    const play = await this.loadPlaywright();
    const httpStatuses: number[] = [];
    const notes: string[] = [];
    let browser: PlaywrightBrowser | null = null;
    let page: PlaywrightPage | null = null;

    try {
      browser = await play.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      page = await browser.newPage();
      await page.goto(this.listingUrl(ctx.source), { waitUntil: 'networkidle', timeout: ctx.limits.timeoutMs });
      httpStatuses.push(200);

      const emptyState = await page.$$eval('[class*="ilan"], table, .card', (elements) =>
        elements.map((element) => (element.textContent ?? '').trim()).join(' \n '),
      );
      if (/şu an aktif bir ilan bulunmamaktadır/i.test(emptyState)) {
        notes.push('Kariyer Kapısı şu an aktif ilan göstermiyor (sayfa boş durumu doğrulandı).');
      }

      const rows = await page.$$eval('a[href*="/isealim"], a[href*="basvuru"], .ilan-listesi a, table tbody tr', (elements) =>
        elements.map((element) => ({
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
          href: element instanceof HTMLAnchorElement ? element.href : '',
        })),
      );

      const items: RawAnnouncement[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (row.text.length < 15) continue;
        const itemId = row.href ? row.href.split('/').filter(Boolean).slice(-1)[0] ?? row.text.slice(0, 40) : row.text.slice(0, 40);
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        items.push({
          sourceKey: ctx.source.key,
          sourceItemId: itemId,
          url: row.href || this.listingUrl(ctx.source),
          title: collapseWhitespace(row.text).slice(0, 250),
          institution: undefined,
          attachments: [],
          sourceCategory: 'Kariyer Kapısı — Kamu İşe Alım',
          rawExcerpt: collapseWhitespace(row.text).slice(0, 500),
          extractionConfidence: 0.4,
          notes: ['Tarayıcı ile okundu; alanların bir kısmı doğrulanmalı.'],
        });
      }

      if (items.length === 0 && notes.length === 0) {
        notes.push('Tarayıcı ile okunan sayfada ilan kaydı bulunamadı (aktif ilan olmayabilir).');
      }

      return { items, httpStatuses, notes, notModified: false };
    } finally {
      if (page) await page.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
    }
  }
}
