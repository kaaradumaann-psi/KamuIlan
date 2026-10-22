# Kaynak şartları incelemesi — 22.10.2026

**Kapsam:** `src/config/sources.ts` içinde `enabled: true` olan ve elle takip (`manual-entry`) olmayan,
22.10.2026'ya kadar incelenmemiş 21 kaynak (20 kayıtsız + `osym-duyurular`). Daha önce incelenmiş
Resmî Gazete ve iki İŞKUR kaydına dokunulmadı. Kapalı kaynaklar (`iskur-esube-acik-is`, `gib-duyurular`,
`tuik-duyurular`, `rtuk-duyurular`) otomatik taranmadığı için kapsam dışı.

**Yöntem:** Bu bilgisayardan, kimlikli UA `Mozilla/5.0 (compatible; KamuIlan/0.3; +https://kamuilan.halilkaraduman.com.tr)`
ile, istekler arası ≥2,5 sn beklemeyle her hostun `/robots.txt` dosyası ve ana sayfası indirildi; ana sayfa
altbilgisinde yasal uyarı / kullanım koşulları / gizlilik / telif bağlantıları arandı ve bulunan sayfalar
okundu. CAPTCHA, giriş ya da erişim denetimi aşılmadı. Bu bir hukuki görüş değildir; kararlar sitelerin
yayımladığı metne dayanır.

**Karar kuralı:** robots.txt liste/detay yolunu yasaklamıyor ve şartlarda otomatik erişim ya da yeniden
kullanım için açık yasak yoksa `allowed`; açık yasak ya da önceden izin şartı varsa `blocked`; metin
okunamıyor ya da belirsizse `unknown`. Kamuİlan ticari olmayan bir hizmet olarak yalnız başlık, resmî
bağlantı ve temel alanları saklar; "kaynak gösterilerek, ticari olmayan kullanım serbest" şartları bu
kullanımla uyumlu sayıldı. Kamuİlan ticari kullanıma (ör. reklam) geçerse DSİ, BDDK ve TMSF yeniden
incelenmelidir.

## Sonuç

| Kaynak                         | robots.txt (22.10.2026)                                                                                                                              | Şartlar sayfası ve ilgili ifade                                                                                                                                                                                                            | Karar       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `ilan-gov-tr-personel`         | 200; `User-agent: *` altında bozuk satır `Disallow: Disallow: /*tebligat`; liste yolu serbest. Temkinle `/*tebligat` eklendi.                        | Ayrı sayfa statik değil; altbilgi (Angular paketi `main-es2015…js`): "Bu sitede bulunan yazı, görsel ve video gibi hiçbir içerik **izinsiz olarak kullanılamaz**."                                                                         | **blocked** |
| `ilan-gov-tr-api-personel`     | Aynı dosya; `/api/api/services/app` yasak değil.                                                                                                     | Aynı altbilgi ifadesi.                                                                                                                                                                                                                     | **blocked** |
| `osym-duyurular`               | Dosya yok (`/robots.txt` → `/Home/Index` HTML); `dokuman.osym.gov.tr` 404.                                                                           | Şartlar sayfası bulunamadı; altbilgide yalnız "© T.C. ÖSYM Başkanlığı".                                                                                                                                                                    | allowed     |
| `kariyerkapisi-isealim`        | 404.                                                                                                                                                 | Şartlar sayfası bulunamadı (sayfa istemci tarafında oluşuyor; statik HTML'de bağlantı yok).                                                                                                                                                | allowed     |
| `meb-personel-duyurular`       | 200; yalnız adı geçen botlar (ia_archiver, GPTBot, ClaudeBot, CCBot, AhrefsBot…) için `Disallow: /`; `User-agent: *` yok → RSS yolu serbest.         | Şartlar sayfası bulunamadı; "Tüm Hakları Saklıdır" genel ibaresi.                                                                                                                                                                          | allowed     |
| `kamuilan-sbb`                 | 404 (IIS).                                                                                                                                           | Altbilgideki "YASAL UYARI" → `http://www.dpb.gov.tr/tr-tr/yasal-uyari`; **dpb.gov.tr DNS'te çözülmüyor** (iki deneme). www.sbb.gov.tr'de de yasal uyarı yok. Metin okunamadı.                                                              | **unknown** |
| `saglik-bakanligi-personel`    | yhgm ve www.saglik: dosya yok ("Sayfa Bulunmadı" HTML).                                                                                              | Şartlar sayfası bulunamadı; yalnız çerez politikaları ve "Tüm hakları saklıdır".                                                                                                                                                           | allowed     |
| `adalet-bakanligi-duyurular`   | 200; `Disallow: /yonetim/` → `/arsiv` serbest; kural eklendi. pgm.adalet 404.                                                                        | Şartlar sayfası bulunamadı.                                                                                                                                                                                                                | allowed     |
| `icisleri-bakanligi-duyurular` | 200; `Disallow: /kullanicilar, /ortak_icerik, /kurumlar, /Kurumlar, /Kullanicilar`; `/duyurular` serbest; kurallar eklendi.                          | `/gizlilik-politikasi` (Gizlilik, Kullanım ve Telif Hakları): "bu sitedeki hiç bir malzemeyi değiştiremez, kopyalayamaz, çoğaltamaz, **yeniden yayımlayamaz** … ya da dağıtamazsınız."                                                     | **blocked** |
| `goc-idaresi-duyurular`        | İçişleri ile aynı dosya; kurallar eklendi.                                                                                                           | `/gizlilik-kullanim-ve-telif-haklari`: aynı kopyalama/yeniden yayımlama yasağı.                                                                                                                                                            | **blocked** |
| `afad-duyurular`               | İçişleri ile aynı dosya; kurallar eklendi (`/kurumlar/...` ekleri istenmez).                                                                         | Şartlar sayfası bulunamadı: yalnız Bilgi Güvenliği Politikası ve KVKK metni; `/gizlilik-kullanim-ve-telif-haklari` afad.gov.tr'de 404.                                                                                                     | allowed     |
| `sgk-duyurular`                | 404.                                                                                                                                                 | `/yasaluyari`: "hiçbir bilgi; **önceden izin alınmadan** ve kaynak gösterilmeden … yeniden yayımlanamaz"; "kaynak gösterilmeden başka bir web sitesinde izinsiz olarak kullanılamaz. Kullananlar hakkında yasal mevzuat süreci uygulanır." | **blocked** |
| `dsi-duyurular`                | 404.                                                                                                                                                 | `/Sayfa/Detay/787` (Yasal Uyarı): "kaynak gösterilmek suretiyle yayımlanabilir; ancak … ticari amaçlarla kullanımı DSİ'nün yazılı iznine tabidir."                                                                                         | allowed     |
| `kgm-duyurular`                | Dosya yok (SharePoint PageNotFound yönlendirmesi).                                                                                                   | `SiteKullanimSartlari.aspx` md.1: "Kaynak gösterilmek kaydıyla … bilgilendirme amacıyla kullanılabilir. … İçeriğin tamamı veya **bir bölümü** değiştirilemez, çoğaltılamaz, dağıtılamaz veya **başka bir platformda yayımlanamaz**."       | **blocked** |
| `tkgm-duyurular`               | 200; `Disallow: /intranet/, /api/, /login/, /preview/`; `/duyurular` serbest; kurallar eklendi.                                                      | Şartlar sayfası bulunamadı; "Tüm Hakları Saklıdır".                                                                                                                                                                                        | allowed     |
| `tubitak-duyurular`            | 200 (www → tubitak.gov.tr); Drupal varsayılanı (`/core/`, `/admin/`, `/search/`, `/user/…`, `/index.php/…`); `/tr` serbest; ilgili kurallar eklendi. | Şartlar sayfası bulunamadı (yalnız `/tr/kvkk`).                                                                                                                                                                                            | allowed     |
| `yok-duyurular`                | 200; `User-agent: *` / boş `Disallow:` (her şey serbest).                                                                                            | Şartlar sayfası bulunamadı (yalnız KVKK PDF'i).                                                                                                                                                                                            | allowed     |
| `bddk-duyurular`               | 404.                                                                                                                                                 | Ana sayfa altbilgisi: "kaynak gösterilmek suretiyle kısmen alıntı yapılabilir ancak … ticari amaçlarla kullanımı BDDK'nın yazılı iznine tabidir."                                                                                          | allowed     |
| `spk-duyurular`                | Dosya yok ("404 İçerik Bulunamadı" HTML).                                                                                                            | Şartlar sayfası bulunamadı.                                                                                                                                                                                                                | allowed     |
| `epdk-duyurular`               | Dosya yok (ana sayfaya yönleniyor).                                                                                                                  | Şartlar sayfası bulunamadı ("© 2018").                                                                                                                                                                                                     | allowed     |
| `tmsf-duyurular`               | Dosya yok (ana sayfaya yönleniyor).                                                                                                                  | `/tr/Tmsf/Info/kullanim.kosul/`: "kaynak gösterilmek suretiyle izinsiz olarak yayımlanabilir, ancak … ticari amaçlarla kullanımı TMSF'nin yazılı iznine tabidir."                                                                          | allowed     |

**Toplam (21 kaynak):** 14 allowed (osym dahil), 6 blocked, 1 unknown. Önceden onaylı 3 kayıtla birlikte üretimde
17 kaynak `SOURCE_TERMS_POLICY=enforce` kapısından geçer.

## Sonraki adımlar

- **Yazılı izin istenecekler:** Basın İlan Kurumu (ilan.gov.tr; kapsam açısından en önemli toplayıcı),
  İçişleri Bakanlığı, Göç İdaresi, SGK, KGM. Taslak: `docs/kaynak-izin-yazisi-taslak.md`. İzin gelince
  kayda `decision: "allowed"`, izin yazısının tarihi/sayısı `notes` alanına yazılır.
- **kamuilan-sbb:** SBB'den güncel yasal uyarı adresi ya da yazılı teyit alınınca yeniden değerlendirin.
- Kayıtlar 365 gün geçerli; en geç 22.10.2027'de yeniden inceleyin.
- Ham kanıtlar (robots.txt ve sayfa indirmeleri) depoya alınmadı; notlardaki alıntılar 22.10.2026 tarihli içeriktir.

## Ek (22.10.2026, okuyucu onarımı)

| iskur-kamu-memur-alim, iskur-kurumdisi-kamu-isci | robots.txt `Disallow: /*?*` ilan satırı adreslerini (`?idId=&il=`) yasaklıyor; sayfa yalnız il haritası veriyor | — | **blocked** (önceki allowed kararı geri alındı) |

## Ek (23.10.2026, İŞKUR e-Şube)

| Kaynak | Bulgu | Şartlar | Karar |
|---|---|---|---|
| iskur-esube-acik-is | robots.txt yalnız `Disallow: /Meslek/ViewMeslekDetayPopUp.aspx/`; arama formu (ASP.NET postback, "Kamu" seçeneği) ve `AcikIsIlanDetay.aspx?uiID=` girişsiz açılıyor, CAPTCHA yok; canlı denemede 90 kamu ilanı / 6 sayfa | Yayımlanmış kullanım şartları metni bulunamadı | **allowed** (site sahibi onayı 23.10.2026; istekler arası ≥5 sn) |

Eski iki `iskur-kamu-*` kaydı (www.iskur.gov.tr il haritası, robots `Disallow: /*?*`) **blocked** kalır.
