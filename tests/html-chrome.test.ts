/**
 * Sayfa iskeleti (menü, çerez/KVKK modali, erişilebilirlik araç çubuğu) temizliği.
 *
 * 2026-10-15 canlı çıktısında icisleri/goc/afad listeleri "Modal content × T.C.
 * İÇİŞLERİ BAKANLIĞI WEB SİTESİ GİZLİLİK VE ÇEREZ POLİTİKASI …", iskur listeleri
 * "Erişilebilirlik Menüsü Ekran Okuyucu Seçili Alan …" özetleriyle "Liste yapısı
 * tanınmadı" hatası vermişti; dizin metinleri aynı zamanda gövde kanıtı sayılıp
 * inceleme kuyruğunda %49'luk kayıtlar üretiyordu.
 */
import { describe, expect, it } from 'vitest';
import {
  chromeFreeText,
  describePageStructure,
  loadHtml,
  PAGE_CHROME_SELECTORS,
  readableAnnouncementText,
  stripPageChrome,
} from '../src/lib/html';

const CEREZ_MODALI = `
<div class="modal fade show" id="cerezModal" role="dialog" aria-modal="true" style="display: block;">
  <div class="modal-content">Modal content × T.C. İÇİŞLERİ BAKANLIĞI WEB SİTESİ GİZLİLİK VE ÇEREZ POLİTİKASI
    <a href="/gizlilik-politikasi">Gizlilik Politikası</a>
    <button type="button">Kabul Et</button>
  </div>
</div>`;

const ERISILEBILIRLIK = `
<div id="erisilebilirlikAracCubugu" class="accessibility-toolbar" role="toolbar" aria-label="Erişilebilirlik Menüsü">
  Erişilebilirlik Menüsü Ekran Okuyucu Seçili Alan Okuyucu Bağlantı Vurgula Büyük Metin Metni Sola Hizala
  İmleç Okuma Kılavuzu Okuma Maskesi Kontrast Solgunlaştır
</div>`;

const LISTE = `
<main id="content">
  <h1>Duyurular</h1>
  <ul class="duyuru-liste">
    <li><a href="/duyurular/sozlesmeli-personel-alimi-2026">Sözleşmeli personel alımı ilanı</a></li>
    <li><a href="/duyurular/isçi-alimi-2026">Sürekli işçi alımı kura ilanı</a></li>
  </ul>
</main>`;

const sayfa = (icerik: string) =>
  `<html><head><title>Portal</title></head><body>
    <nav class="navbar"><a href="/kurumsal">Kurumsal</a><a href="/sss">Sıkça Sorulan Sorular</a></nav>
    ${CEREZ_MODALI}
    ${ERISILEBILIRLIK}
    ${icerik}
    <footer><a href="/iletisim">İletişim</a> © 2026</footer>
  </body></html>`;

describe('PAGE_CHROME_SELECTORS', () => {
  it('çerez modali ve erişilebilirlik araç çubuğu iskelet sayılır', () => {
    const selectors = PAGE_CHROME_SELECTORS.join(' ');
    for (const beklenen of [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[role="toolbar"]',
      '.modal',
      '.modal-content',
      '[class*="cookie"]',
      '[class*="cerez"]',
      '[class*="kvkk"]',
      '[class*="consent"]',
      '[class*="accessibilit"]',
      '[class*="erisilebilirlik"]',
    ]) {
      expect(selectors, beklenen).toContain(beklenen);
    }
  });
});

describe('chromeFreeText', () => {
  it('özet metinde çerez modali ve erişilebilirlik araç çubuğu yer almaz', () => {
    const text = chromeFreeText(sayfa(LISTE), 4_000);
    expect(text).not.toContain('ÇEREZ POLİTİKASI');
    expect(text).not.toContain('GİZLİLİK');
    expect(text).not.toContain('Erişilebilirlik Menüsü');
    expect(text).not.toContain('Ekran Okuyucu');
    expect(text).not.toContain('Sıkça Sorulan Sorular');
    expect(text).not.toContain('İletişim');
    expect(text).toContain('Sözleşmeli personel alımı ilanı');
  });

  it('modali görünür kılan style="display:block" temizliği engellemez', () => {
    expect(chromeFreeText(sayfa('<p>Kısa içerik</p>'), 4_000)).not.toContain('Modal content');
  });
});

describe('stripPageChrome', () => {
  it('iskelet bağlantıları DOM’dan çıkarır', () => {
    const $ = loadHtml(sayfa(LISTE));
    stripPageChrome($.root());
    const hrefs = $('a[href]')
      .toArray()
      .map((node) => (node as { attribs: { href?: string } }).attribs.href ?? '');
    expect(hrefs).toEqual(['/duyurular/sozlesmeli-personel-alimi-2026', '/duyurular/isçi-alimi-2026']);
  });
});

describe('readableAnnouncementText', () => {
  const seciciler = ['#content', 'main', '.duyuru-liste'];

  it('gövde metninde iskelet bulunmaz', () => {
    const $ = loadHtml(sayfa(LISTE));
    const text = readableAnnouncementText($, seciciler, 10_000);
    expect(text).toContain('Sözleşmeli personel alımı');
    expect(text).not.toContain('ÇEREZ POLİTİKASI');
    expect(text).not.toContain('Erişilebilirlik Menüsü');
  });

  it('çağıranın DOM’unu değiştirmez: bağlantı taraması bozulmaz', () => {
    const $ = loadHtml(sayfa(LISTE));
    readableAnnouncementText($, seciciler, 10_000);
    // Metin çıkarımı kopya üzerinde çalıştığı için menü/modaldaki bağlantılar hâlâ yerinde.
    expect($('a[href]').length).toBe(6);
    expect($('nav a[href="/sss"]').length).toBe(1);
    expect($('#cerezModal a[href="/gizlilik-politikasi"]').length).toBe(1);
  });

  it('stripChrome:false verilirse eski davranış korunur', () => {
    const $ = loadHtml(sayfa(LISTE));
    const text = readableAnnouncementText($, seciciler, 10_000, { stripChrome: false });
    expect(text).toContain('Sözleşmeli personel alımı');
    expect($('a[href]').length).toBe(6);
  });

  it('tercih edilen kapsayıcı yoksa gövdeden iskeletsiz metin döner', () => {
    const $ = loadHtml(sayfa('<section><p>Genel duyuru metni burada yer alıyor ve en az seksen karakter uzunluğunda olması gerekiyor.</p></section>'));
    const text = readableAnnouncementText($, ['.olmayan-kapsayici'], 10_000);
    expect(text).toContain('Genel duyuru metni');
    expect(text).not.toContain('Ekran Okuyucu');
  });
});

describe('describePageStructure', () => {
  it('bağlantı sayımı ve sık geçen yolları raporlar', () => {
    const structure = describePageStructure(
      sayfa(LISTE),
      'https://www.icisleri.gov.tr/duyurular',
    );
    expect(structure.anchors).toBe(6);
    expect(structure.sameHostAnchors).toBe(6);
    expect(structure.topPathPrefixes.join(' ')).toContain('/duyurular');
    expect(structure.iframes).toBe(0);
    expect(structure.scripts).toBe(0);
    // Özet, iskelet temizlendikten sonraki metin uzunluğunu bildirir.
    expect(structure.bodyTextLength).toBeGreaterThan(0);
  });

  it('JS kabuğunda sıfır bağlantı raporlar', () => {
    const structure = describePageStructure('<html><body><div id="app"></div></body></html>', 'https://www.iskur.gov.tr/');
    expect(structure.anchors).toBe(0);
    expect(structure.sameHostAnchors).toBe(0);
    expect(structure.topPathPrefixes).toEqual([]);
    expect(structure.bodyTextLength).toBe(0);
  });
});
