/**
 * Manuel kayıt adaptörü.
 *
 * Bazı kaynaklar teknik olarak otomatik toplanmaya uygun değildir (ASP.NET
 * postback + oturum isteyen e-Şube ekranları, coğrafi kısıt uygulayan
 * platformlar). Bu kaynaklar silinmez; "manuel yöntem gerekiyor" durumunda
 * tutulur ve yönetici ilanları elle ekler.
 *
 * Manuel eklenen ilanlar `provenance: 'manual'` ile işaretlenir ve kaynak
 * bağlantısı zorunludur.
 */
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

export class ManualAdapter implements SourceAdapter {
  readonly key = 'manual';
  readonly label = 'Manuel kayıt (otomatik tarama yok)';

  listingUrl(source: { homepageUrl: string; listingUrl: string }): string {
    return source.listingUrl || source.homepageUrl;
  }

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    return {
      items: [],
      httpStatuses: [],
      notes: [
        `${ctx.source.name}: otomatik toplama uygulanmıyor (${ctx.source.statusNote || 'teknik kısıt'}). ` +
          'İlanlar yönetici panelinden manuel eklenir.',
      ],
      notModified: false,
    };
  }
}
