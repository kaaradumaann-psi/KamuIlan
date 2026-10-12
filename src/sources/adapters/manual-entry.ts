/**
 * Elle giriş / yönetim adaptörü.
 *
 * Bazı kaynaklar (ör. erişim kısıtlı kurum sayfaları, yalnızca basılı duyuru)
 * otomatik toplanamaz. Bu durumda ilan yönetici tarafından elle girilir; bu
 * adaptör otomatik tarama YAPMAZ ve bunu açıkça bildirir. Böylece "taranmış
 * gibi" görünen uydurma veri oluşmaz.
 */
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

export class ManualEntryAdapter implements SourceAdapter {
  readonly key = 'manual-entry';
  readonly label = 'Elle giriş (otomatik tarama yok)';
  readonly method = 'manual-entry';
  readonly notes = 'Bu kaynak otomatik taranmaz; ilanlar yönetici tarafından elle girilir veya yüklenir.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    return {
      items: [],
      requestCount: 0,
      notes: [
        `Elle giriş kaynağı: ${ctx.source.key}. Otomatik tarama yapılmaz (kaynak şartları/teknik engel).`,
        'Yeni ilan girmek için yönetim panelindeki "elle ilan" akışını kullanın (docs/source-onboarding.md).',
      ],
      etag: null,
      lastModified: null,
      notModified: false,
      httpStatuses: [],
    };
  }
}
