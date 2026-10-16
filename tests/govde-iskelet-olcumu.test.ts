/**
 * Gövde metni ilan metni mi, sayfa iskeleti mi? — GERÇEK kayıtlarla kalibrasyon.
 *
 * Kaynak: kullanıcının 16.10.2026 tarihli Supabase verisi (`tani:ilan --kaynak …`
 * çıktısı). Pozitif örnekler, kaydın 2500 karakterlik gövdesinin baştan sona
 * menü/çerez/erişilebilirlik metni olduğu kayıtlardır; negatif örnekler aynı
 * veritabanındaki gerçek ilan metinleridir.
 *
 * Amaç: bu kayıtların "şehir/kadro/son tarih yok + durum bilinmiyor" olmasının
 * nedeni görünür olsun ve menü metni içerik kanıtı sayılmasın.
 */
import { describe, expect, it } from 'vitest';
import { looksLikePageChromeText, pageChromeShare } from '../src/domain/text';

// --- Pozitif: kayıtlarda gövde = sayfa iskeleti (birebir alındı) ---

const KGM_GOVDE =
  'Daha yüksek erişilebilirlik modunu aç Daha yüksek erişilebilirlik modunu kapat Şerit Komutlarını Atla ' +
  'Ana içeriğe atla Animasyonları Kapat Animasyonları Aç SharePoint Oturum Aç Takip Et Karayolları Genel Müdürlüğü' +
  'Şu anda seçili DuyuruDetay ANA SAYFA KURUMSAL Tarihçe Görevleri Yönetim Genel Müdürümüz Genel Müdür Yardımcılarımız ' +
  'Personel Personel Bilgileri Organizasyon Yapısı Merkez Teşkilatı Bölgeler Kanun ve Yönetmelikler Bütçe Ödenekleri ' +
  'Yol Ağı Bilgileri Stratejik Planlama 2019-2023 Stratejik Plan Yıllar İtibariyle Performans Programı ' +
  'Yıllar İtibariyle Faaliyet Raporu 2019 Yılı Global Projeler Detayı Kurumsal Mali Durum ve Beklentiler Raporu ' +
  'Uluslararası Karayolu Güzergahları Etik Komisyonu Kamu Hizmet Standartları Karayolları Sözlüğü Faaliyetler Yayınlar ' +
  'OTOYOLLAR Otoyollar Haritası HGS Yabancı Plakalı Araçlar Otoyol ve Köprü Geçiş Ücretleri İhlalli Geçiş Sorgulama ' +
  've Ödeme Otoyol Hizmet Tesisleri Kullanıcı Dilek ve Şikayet Bildirim Formu TRAFİK Trafik Kaza Kara Noktaları ' +
  'Trafik Kazaları Özeti Trafik ve Ulaşım Bilgileri Trafik Hacim Haritaları Trafik İşaretleri Kanun ve Yönetmelikler ' +
  'Hız Sınırları İSTATİSTİKLER Devlet ve İl Yolları Envanteri Otoyol Envanter Bilgisi Köprü ve Tünel Bilgileri ' +
  'Trafik ve Ulaşım Bilgileri Ulusal Veri Yayınlama Takvimi İLETİŞİM Duyuru Detayı Tüm Haberler ' +
  'KARAYOLLARI GENEL MÜDÜRLÜĞÜ 50 İŞÇİ ALIMINA İLİŞKİN NOTER KURASI DUYURUSU Kurumumuz taşra teşkilatı hizmet ' +
  'birimlerine 4857 sayılı İş Kanunu';

const TMSF_GOVDE =
  'EN İLETİŞİM HAKKIMIZDATarihsel YolculuğuGörev ve SorumluluklarımızFon KuruluOrganizasyon Şeması MevzuatKanunlar' +
  'Kanun Hükmünde Kararnameler (KHK)Yönetmelikler Düzenleyici Kararlar ve Genel YazılarMevduat Sigortacılığı İle ' +
  'İlgili KararlarZaman Aşımı İle İlgili Yazı & Duyurularİlgili Diğer MevzuatUluslararası İlişkilerFinansal Güvenlik ' +
  'Ağı İlişkileriKurumsal KimlikBilgi Güvenliği PolitikamızKişisel Verilerin İşlenmesi ve Korunması Etik Komisyonu' +
  'Etik Komisyon ÜyeleriEtik Rehberi Etik SözleşmesiMevzuatFaaliyet Raporları MEVDUAT SİGORTACILIĞI Mevduat ' +
  'SigortacılığıMevduat ve Katılım Fonu SigortacılığıRisk Esaslı Sigorta Prim Tarifesiİlgili Mevzuat Zaman Aşımı' +
  'Zaman Aşımı Nedir?Zaman Aşımı Süreci Nasıl İşler?İlgili Mevzuat BANKA ÇÖZÜMLEMEBankanın TMSF\'ye Devir Süreci' +
  'Banka Çözümleme SüreciBanka Çözümleme Faaliyetleri Faaliyet İzni Kaldırılan Bankalar Banka İletişim Bilgileri ' +
  'Temettü Hariç Ortaklık Hakları Fona Devredilen Bankalar Çözümleme Şeması BANK ASYA İlgili Mevzuat KAYYIMLIK' +
  'OHAL Süreci ve Kayyımlık Kayyımlık FaaliyetleriKayyım Olunan Şirketlere İlişkin VerilerKayyım Olunan Şirketler ' +
  'ListesiMedya ve Basın Kuruluşlarına İlişkin Faaliyetler İlgili Mevzuatı TAS. FİN. ŞİRKETLERİSıkça Sorulan Sorular ' +
  'RAPORLAR Faaliyet RaporlarıÜç Aylık RaporlarYıllık RaporlarMali Tablolar İstatistiklerSunumlar Başkanın Mesajı ' +
  'Vizyonumuz; Misyonumuz; Mevduatınız Güvence Altında';

const DSI_GOVDE =
  'HızlıErişim Anasayfa Tarım ve Orman Bakanlığı TR TR ANA SAYFA KURUMSAL YAPI HAKKIMIZDA DSİ MEVZUATI TOPRAK VE SU ' +
  'KAYNAKLARI BAKAN BAKAN YARDIMCISI GENEL MÜDÜR YÖNETİM MERKEZ TEŞKİLATI ORGANİZASYON ŞEMASI BÖLGELERİMİZ ' +
  'BAŞKANLIKLARIMIZ TEFTİŞ KURULU BAŞKANLIĞI İÇ DENETİM BİRİMİ BAŞKANLIĞI HUKUK MÜŞAVİRLİĞİ ETÜT, PLANLAMA VE ' +
  'TAHSİSLER DAİRESİ BAŞKANLIĞI SULAMA DAİRESİ BAŞKANLIĞI BARAJLAR VE HİDROELEKTRİK SANTRALLAR DAİRESİ BAŞKANLIĞI ' +
  'İÇMESUYU VE ATIKSU DAİRESİ BAŞKANLIĞI TAŞKIN KONTROL DAİRESİ BAŞKANLIĞI EMLAK VE KAMULAŞTIRMA DAİRESİ BAŞKANLIĞI ' +
  'JEOTEKNİK HİZMETLER DAİRESİ BAŞKANLIĞI YERALTISULARI DAİRESİ BAŞKANLIĞI ARAZİ TOPLULAŞTIRMASI ETÜT VE ' +
  'PROJELENDİRME DAİRESİ BAŞKANLIĞI DIŞ İLİŞKİLER DAİRESİ BAŞKANLIĞI STRATEJİ GELİŞTİRME DAİRESİ BAŞKANLIĞI ' +
  'BİLGİ TEKNOLOJİLERİ DAİRESİ BAŞKANLIĞI PERSONEL DAİRESİ BAŞKANLIĞI DESTEK HİZMETLERİ DAİRESİ BAŞKANLIĞI ' +
  'BASIN VE HALKLA İLİŞKİLER MÜŞAVİRLİĞİ HİZMET ALANLARI ENERJİ TARIM HİZMET ÇEVRE VE TAŞKIN FAALİYETLER ' +
  'DSİ BİRİM FİYATLAR TEKNİK ŞARTNAMELER SU YAPILARI DENETİM HİZMETLERİ LABORATUVAR İŞLEMLERİ ' +
  'GENERAL TECHNICAL SPECIFICATIONS SEMPOZYUM VE SERGİLER ÖDÜLLER İKLİM DEĞİŞİKLİĞİ BİLGİ EDİNME ENGELSİZ DSİ ' +
  'HİZMET STANDARTLARIMIZ BARAJ DOLULUK ORANLARI İLETİŞİM Aranacak Metni giriniz Anasayfa > Personel Dairesi ' +
  'Başkanlığı Bağlı Şube Müdürlükleri Personel Şube Müdürlüğü Özlük İşleri Şube Müdürlüğü Veri Analizi ve Yönetimi ' +
  'Şube Müdürlüğü Mevzuat ve Teşkilatlanma Şube Müdürlüğü Eğitim Şube Müdürlüğü';

const ISKUR_GOVDE =
  'Erişilebilirlik Menüsü Ekran Okuyucu Seçili Alan Okuyucu Bağlantı Vurgula Büyük Metin Metni Sola Hizala ' +
  'İmleç Okuma Kılavuzu Okuma Maskesi Kontrast Solgunlaştırma Düşük Doygunluk Yüksek Doygunluk Erişilebilirlik ' +
  'Ayarlarını Temizle Web sitemizde sunulan ve açıkça talep etmiş olduğunuz hizmetler için kesinlikle gerekli, ' +
  'birinci taraf oturum çerezleri ve kalıcı çerezler kullanılmaktadır. Daha fazla bilgi için Çerez Aydınlatma Metni ' +
  'Kabul Ediyorum Çerez Ayarları Kabul Etmiyorum × Çerez Ayarları Zorunlu Çerezler Web sitemizin çalışması için ' +
  'gerekli çerezler. Bu çerezler kapatılamaz. Kaydet TR EN KURUMSAL Bakan Genel Müdür Teşkilat Şeması Yönetim Kurulu ' +
  'Mevzuat Hakkında Tarihçe Etik Komisyonu Kurumsal Kimlik İhaleler Raporlar Faaliyetler İstatistikler Protokol ' +
  'Yayınlar İç Kontrol Uluslararası İlişkiler ve Projeler Bilgi Sayfaları Aktif İşgücü Dökümanları Bilgi Güvenliği ' +
  'Yönetim Sistemi Hizmet Standartları Bilgi Edinme Türkiye İş Kurumu Çerez Politikası Sıkça Sorulan Sorular ' +
  'Görüş & Öneri İl Müdürlükleri İŞ ARAYAN Kayıt İş Arama Aktif İşgücü Programları Mesleki Eğitim Kursları İşbaşı ' +
  'Eğitim Programları İŞVEREN Kayıt İşveren Danışmanlığı Eleman Arama İşsizlik Sigortası İşsizlik Ödeneği ' +
  'ÖZEL İSTİHDAM BÜROLARI Başvuru Bilgileri Büro Liste İstihdam Bürosu Listesi Geçici İş İlişkisi İzni';

// --- Negatif: aynı veritabanındaki gerçek ilan gövdeleri (birebir alıntı) ---

const SPK_ILAN =
  'SERMAYE PİYASASI KURULU MESLEK PERSONEL YARDIMCILIĞI GİRİŞ SINAVI Sermaye Piyasası Kurulu (Kurul) Ankara Merkez ' +
  've/veya İstanbul Temsilciliğinde görevlendirilmek üzere Genel İdare Hizmetleri sınıfında bulunan 8. derece kadrolu ' +
  '40 adete kadar Uzman Yardımcısı kadrolarına başarı durumları dikkate alınarak yeter sayıda aday personel seçimi ' +
  'için giriş sınavı yapılacaktır. SINAVA KATILMA KOŞULLARI 1- 657 sayılı Devlet Memurları Kanunu’nun 48 inci ' +
  'maddesinin (A) bendinde yer alan genel şartları taşımak, 2- 40 adet Uzman Yardımcısı kadrosu için; ÖSYM tarafından ' +
  '2025 veya 2026 yıllarında yapılan Kamu Personel Seçme Sınavından KPSSP1 puan türünde en az 70 puan almış olmak';

const VAKIFLAR_ILAN =
  'Genel Müdürlüğümüz merkez teşkilatında istihdam edilmek üzere Genel İdare Hizmetler sınıfında boş bulunan 5 adet ' +
  '7. derece Vakıf Uzman Yardımcısı kadrosuna atama yapılması için yazılı ve sözlü olmak üzere iki aşamalı sınav ' +
  'yapılacaktır. Öğrenim bölümleri itibarıyla alınacak Vakıf Uzman Yardımcısı sayıları aşağıdaki tabloda ' +
  'belirtilmektedir. 1.GİRİŞ SINAVINA BAŞVURU ŞARTLARI 1.1. 657 sayılı Devlet Memurları Kanununun 48. maddesinde ' +
  'belirtilen şartları taşımak, 1.2. En az 4 yıllık lisans eğitimi veren fakültelerin tabloda belirtilen bölümlerinden ' +
  'mezun olmak';

const GOC_ILAN =
  'İçişleri Bakanlığı’na bağlı Göç İdaresi Başkanlığı taşra teşkilatında boş bulunan Genel İdare Hizmetleri sınıfından ' +
  '8’inci ve 9’uncu derecelerden toplam 40 (kırk) adet il göç uzman yardımcısı kadrosuna 11 Temmuz 2013 tarihli ve ' +
  '28704 sayılı Resmî Gazete’de yayımlanan İl Göç Uzmanlığı Yönetmeliği hükümleri uyarınca giriş sınavı ile il göç ' +
  'uzman yardımcısı alınacaktır. Giriş sınavı yazılı ve sözlü olmak üzere iki aşamalı yapılacaktır. Yazılı sınav Göç ' +
  'İdaresi Başkanlığı tarafından Ankara Sosyal Bilimler Üniversitesi Sürekli Eğitim Uygulama ve Araştırma Merkezi’ne ' +
  'yaptırılacaktır.';

const MARKA_ILAN =
  'Doğu Marmara Kalkınma Ajansı (MARKA) 4 No’lu Cumhurbaşkanlığı Kararnamesi ile Kalkınma Ajansları Personel ' +
  'Yönetmeliği hükümleri çerçevesinde; Bolu, Düzce, Kocaeli, Sakarya ve Yalova illerinde çalıştırılmak üzere; bölge ' +
  've ülkesinin kalkınmasına hizmet etmeye gönüllü, iletişime açık ve kendine güvenen, başarma azmine sahip, ' +
  'çevresindeki olaylara duyarlı, öğrenmeye ve kendisini yetiştirmeye açık, sorumluluk alabilen, yenilikçi, çözüm ' +
  'odaklı, analitik ve stratejik düşünme becerisine sahip, değişen çalışma şartlarına uyum sağlayabilen adaylar ' +
  'arasından sözlü sınav sonucuna göre istihdam edilecektir.';

describe('gövde metni sayfa iskeleti mi? (gerçek kayıtlar)', () => {
  it.each([
    ['Karayolları (kgm-duyurular)', KGM_GOVDE],
    ['TMSF (tmsf-duyurular)', TMSF_GOVDE],
    ['DSİ (dsi-duyurular)', DSI_GOVDE],
    ['İŞKUR (iskur-kamu-memur-alim)', ISKUR_GOVDE],
  ])('%s kaydının gövdesi iskelet sayılır', (_ad, metin) => {
    expect(looksLikePageChromeText(metin)).toBe(true);
    expect(pageChromeShare(metin)).toBeGreaterThanOrEqual(0.15);
  });

  it.each([
    ['SPK ilanı', SPK_ILAN],
    ['Vakıflar Genel Müdürlüğü ilanı', VAKIFLAR_ILAN],
    ['Göç İdaresi giriş sınavı ilanı', GOC_ILAN],
    ['MARKA personel alım ilanı', MARKA_ILAN],
  ])('%s gerçek ilan metni sayılır (yanlış pozitif yok)', (_ad, metin) => {
    expect(looksLikePageChromeText(metin)).toBe(false);
    expect(pageChromeShare(metin)).toBeLessThan(0.1);
  });

  it('gerçek ilan ile menü dökümü arasında ölçüm boşluğu var (eşik 0,15)', () => {
    // Ayrım: gerçek ilanlar 0,00–0,03; menü dökümleri 0,18–0,54.
    const gercek = Math.max(...[SPK_ILAN, VAKIFLAR_ILAN, GOC_ILAN, MARKA_ILAN].map(pageChromeShare));
    const iskelet = Math.min(...[KGM_GOVDE, TMSF_GOVDE, DSI_GOVDE, ISKUR_GOVDE].map(pageChromeShare));
    expect(gercek).toBeLessThan(0.1);
    expect(iskelet).toBeGreaterThan(gercek * 5);
  });

  it('kısa metinler bu ölçümle yargılanmaz', () => {
    expect(looksLikePageChromeText('Kısa duyuru: sınav 12 Ekim 2026 tarihinde yapılacaktır.')).toBe(false);
    expect(looksLikePageChromeText('')).toBe(false);
  });
});
