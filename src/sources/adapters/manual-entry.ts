/**
 * Manuel giriş adaptörü.
 *
 * Bazı kaynaklar otomatik toplamaya uygun değildir (oturum/postback/CAPTCHA ya da
 * kullanım koşulları). Bu kaynaklar için sistem SAHTE VERİ ÜRETMEZ; bunun yerine
 * "manuel yöntem gerekli" durumunu bildirir ve kaynak kaydı bu şekilde görünür.
 *
 * Yönetici panelinden manuel ilan ekleme (`POST /api/admin/jobs/manual`) bu
 * kaynağın veri giriş yoludur.
 */
import { AdapterUnavailableError } from '../errors';
import type { AdapterContext, AdapterRunResult, SourceAdapter } from '../types';

export class ManualEntryAdapter implements SourceAdapter {
  readonly key = 'manual-entry';
  readonly label = 'Manuel giriş';
  readonly method = 'manual';
  readonly notes =
    'Bu kaynak otomatik toplanmaz. İlanlar yönetici panelinden manuel eklenir; ' +
    'kapsam raporunda "manuel yöntem" olarak işaretlenir.';

  async run(ctx: AdapterContext): Promise<AdapterRunResult> {
    throw new AdapterUnavailableError(
      ctx.source.key,
      `${ctx.source.name}: otomatik toplama uygun değil; manuel giriş yöntemi tanımlı.`,
      'Yönetici panelinden manuel ilan ekleme veya resmî duyuru bağlantısı ile izleme.',
    );
  }
}
