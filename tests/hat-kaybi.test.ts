/**
 * 23.10.2026 yerel uçtan uca hat ölçümü (izinli 17 kaynak, canlı) ile bulunan kayıp nedenleri.
 * Örnekler gerçek ilan başlıklarından/ilk cümlelerinden kısaltılmıştır; kişisel veri yoktur.
 * Hiçbir test ağa çıkmaz.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classification/engine';
import { SOURCE_DEFINITIONS } from '../src/config/sources';
import { createLogger } from '../src/lib/logger';
import { KariyerKapisiAdapter, KARIYER_API_LIST_URL } from '../src/sources/adapters/kariyerkapisi';
import { textLayerTitleRejected } from '../src/sources/adapters/resmigazete';
import { prioritizeByListingTitle } from '../src/sources/listing-utils';
import type { FetchResponse, HttpClient } from '../src/sources/fetcher';

const KK = 'personel alımı'; // Kariyer Kapısı adaptörünün kaynak kategorisi

describe('sınıflandırıcı: canlı ölçümde reddedilen/incelemeye düşen gerçek alım ilanları', () => {
  it('Açıktan İcra Müdür(Yardımcılığı) sınav ilanı yargı/icra ilanı sayılmaz', () => {
    const kk = classify({
      title: 'ADALET BAKANLIĞI - 2026 Yılı Açıktan İcra Müdür ve İcra Müdür Yardımcılığı Sınav İlanı',
      body: '',
      sourceCategory: KK,
      documentTextMissing: true,
    });
    expect(kk.decision).not.toBe('reject');
    const osym = classify({
      title: '2026 Adalet Bakanlığı İcra Müdür ve İcra Müdür Yardımcılarını Seçme Sınavı: Başvuruların Alınması',
      body: '',
    });
    expect(osym.rules).not.toContain('ret-baslik.yargi');
  });

  it('icra müdürlüğü ilanları yine reddedilir (yanlış kabul koruması)', () => {
    for (const title of [
      'İstanbul 8. İcra Müdürlüğünden: Taşınmazın Açık Artırma İlanı',
      'Ankara 3. İcra Dairesinden: Dosya Kaybı İlanı',
    ]) {
      expect(classify({ title, body: '' }).decision).toBe('reject');
    }
  });

  it('Kariyer Kapısı dış bağlantılı ilan (metin yok): başlık alım kanıtıdır → inceleme (ret değil)', () => {
    // Proje kuralı: gövdesiz kayıt yayımlanmaz (senaryo-toplama-akisi 3). Kayıp ret/ölü kayıttı;
    // doğru sonuç inceleme kuyruğudur. "İşçi İstihdamı" artık başlık kanıtıdır.
    for (const title of [
      'KIYI EMNİYETİ GENEL MÜDÜRLÜĞÜ - PERSONEL ALIM İLANI (9 KİŞİLİK)',
      'TÜRKİYE CUMHURİYETİ DEVLET DEMİRYOLLARI TAŞIMACILIK ANONİM ŞİRKETİ GENEL MÜDÜRLÜĞÜ - 166 SÜREKLİ İŞÇİ İSTİHDAMI',
      'JANDARMA VE SAHİL GÜVENLİK AKADEMİSİ BAŞKANLIĞI - 2027 YILI J.GN.K.LIĞI MUVAZZAF SUBAY TEMİNİ',
    ]) {
      const result = classify({ title, body: '', sourceCategory: KK, documentTextMissing: true });
      expect(result.decision, title).toBe('review');
      expect(result.rules.some((rule) => rule.startsWith('pozitif.') && rule !== 'pozitif.kaynak-kategorisi'), title).toBe(true);
    }
  });

  it('başlık gövdeden bağımsızsa giriş cümlesi kuralı uygulanmaz (LLM kapısı senaryosu korunur)', () => {
    const result = classify({
      title: '2026 Yılı Ekim Dönemi İşlemleri',
      body: 'Kurumumuz merkez ve taşra teşkilatında istihdam edilmek üzere sözleşmeli personel alınacaktır. Kontenjan 12 olup başvurular 01.11.2026 - 14.11.2026 tarihleri arasındadır.',
      sourceCategory: 'Genel',
    });
    expect(result.decision).toBe('review');
  });

  it('metin yoksa kategori tek başına kabul ettirmez; sonuç/ihale başlığı yine reddedilir', () => {
    expect(classify({ title: 'X KURUMU - DUYURU', body: '', sourceCategory: KK, documentTextMissing: true }).decision).not.toBe(
      'accept',
    );
    for (const title of [
      'X ÜNİVERSİTESİ - SÖZLEŞMELİ PERSONEL ALIMI SINAV SONUÇLARI',
      'X GENEL MÜDÜRLÜĞÜ - PERSONEL TAŞIMA HİZMET ALIMI İHALESİ',
    ]) {
      const result = classify({ title, body: '', sourceCategory: KK, documentTextMissing: true });
      // Sonuç başlığı en fazla süreç duyurusu olur; iş ilanı olarak kabul edilmez.
      expect(result.decision === 'accept' && result.kind === 'job', title).toBe(false);
    }
  });

  it('"Meslek Personel Yardımcılığı Giriş Sınavı" başlıkta alım kanıtıdır', () => {
    const result = classify({
      title: 'SERMAYE PİYASASI KURULU BAŞKANLIĞI - SERMAYE PİYASASI KURULU MESLEK PERSONEL YARDIMCILIĞI GİRİŞ SINAVI 2026',
      body:
        'Sermaye Piyasası Kurulu Başkanlığı meslek personeli kadrolarına atanmak üzere giriş sınavı ile 10 kişi alınacaktır. ' +
        'Başvurular 01.11.2026 - 15.11.2026 tarihleri arasında e-Devlet üzerinden yapılacaktır. KPSS puanı esas alınır.',
      // Detay sayfasının kendi ilan türü (canlıda bu kategoriyle incelemeye düşmüştü).
      sourceCategory: 'A Grubu Memur (Kariyer Meslek)',
    });
    expect(result.decision).toBe('accept');
  });

  it('RG: başlığı ilk cümleden türetilen akademik alım ilanı ("öğretim üyesi alınacaktır") kabul edilir', () => {
    const lead =
      'Adıyaman Üniversitesi Rektörlüğünden: Üniversitemize, 2547 sayılı Kanun, “Öğretim Üyeliğine Yükseltilme ve Atanma Yönetmeliği” ' +
      'hükümlerine göre devamlı statüde çalıştırılmak üzere öğretim üyesi alınacaktır.';
    const result = classify({
      title: `${lead.slice(0, 160)}…`,
      body:
        `${lead} Adayların, 657 sayılı Kanun’un 48. maddesindeki şartları taşımaları gerekmektedir. ` +
        'Başvuru Tarihleri: 23.10.2026 - 06.11.2026. Başvuru şartları ve kadro sayısı ekteki tablodadır.',
      sourceCategory: 'resmi-gazete-cesitli-ilanlar',
      documentTextMissing: false,
    });
    expect(result.decision).toBe('accept');
  });

  it('gövde başında "alınacaktır" geçse de sonuç/iptal başlığı ve haber metni kabul edilmez', () => {
    const results = classify({
      title: 'Sözleşmeli Personel Alımı Sınav Sonuçları',
      body: 'Kurumumuza sözleşmeli personel alınacaktır ilanımızın sınav sonuçları ekte yer almaktadır.',
    });
    expect(results.decision === 'accept' && results.kind === 'job').toBe(false);
    expect(
      classify({
        title: 'Vali Yılmaz: Gelecek yıl il genelinde istihdam artacak',
        body: 'Vali Yılmaz, yaptığı açıklamada gelecek yıl kuruma personel alınacaktır dedi. Toplantıya kurum müdürleri katıldı.',
      }).decision,
    ).not.toBe('accept');
  });
});

describe('Kariyer Kapısı: dış bağlantılı ilan kaynak liste sayfası adresiyle yazılmaz', () => {
  it('url başvuru adresidir; liste adresi (isealim) ilan kaydı olarak reddedilmez', async () => {
    const src = SOURCE_DEFINITIONS.find((entry) => entry.key === 'kariyerkapisi-isealim')!;
    const list = readFileSync(fileURLToPath(new URL('./fixtures/kaynak-html/kariyerkapisi-GetIseAlimPage.json', import.meta.url)), 'utf8');
    const http = {
      async fetchText(url: string): Promise<FetchResponse> {
        if (url !== KARIYER_API_LIST_URL) throw new Error(`Beklenmeyen istek: ${url}`);
        const body = Buffer.from(list, 'utf8');
        return {
          url, finalUrl: url, status: 200, headers: { 'content-type': 'application/json' }, body,
          contentType: 'application/json', etag: null, lastModified: null, notModified: false,
          decoded: { text: list, charset: 'utf-8', charsetGuessed: false }, bytes: body.byteLength,
        };
      },
      async fetchBinary(): Promise<FetchResponse> {
        throw new Error('yok');
      },
      async close(): Promise<void> {},
    } as unknown as HttpClient;
    const result = await new KariyerKapisiAdapter(async () => {
      throw new Error('tarayıcı çağrılmamalı');
    }).run({
      source: src, http, logger: createLogger('test', { level: 'silent' }), liveFetch: true,
      fetchedAt: new Date('2026-10-20T09:00:00Z'), maxDetailFetches: 0,
    });
    const external = result.items.filter((item) => !/IlanDetay\?i=/.test(item.url));
    expect(external.length).toBeGreaterThan(0);
    for (const item of external) {
      expect(new URL(item.url).pathname.replace(/\/$/, '')).not.toBe('/isealim');
      expect(item.url).toBe(item.applicationUrl);
    }
  });
});

describe('bütçe önceliği', () => {
  it('liste başlığı alım olası kayıtlar detay bütçesinde önce gelir (menü bağlantıları sona)', () => {
    const ordered = prioritizeByListingTitle(
      ['Dilekçe Hakkında', 'Şifremi Unuttum', 'Uzman Yardımcılığı Giriş Sınavı İlanı', 'Faaliyet Bülteni', 'Sözleşmeli Personel Alım İlanı'].map(
        (title) => ({ title }),
      ),
      (entry) => entry.title,
    );
    expect(ordered.slice(0, 2).map((entry) => entry.title)).toEqual([
      'Uzman Yardımcılığı Giriş Sınavı İlanı',
      'Sözleşmeli Personel Alım İlanı',
    ]);
    expect(ordered).toHaveLength(5);
  });

  it('RG: metin katmanı başlığı kesin ret olan belge (ihale yasağı) OCR bütçesini harcamaz', () => {
    expect(textLayerTitleRejected('Akdeniz Üniversitesi Rektörlüğünden: İHALELERE KATILMAKTAN YASAKLAMA KARARI 10911/1-1')).toBe(true);
    expect(textLayerTitleRejected('Marmara Üniversitesi Rektörlüğünden: SÖZLEŞMELİ PERSONEL ALIM İLANI 10974/1-1')).toBe(false);
    expect(textLayerTitleRejected('Türkiye Cumhuriyet Merkez Bankasından: 11018/1-1')).toBe(false);
  });
});
