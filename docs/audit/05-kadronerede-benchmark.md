# 05 — KadroNerede.com Karşılaştırması (gözlemlenebilir kanıt)

**Gözlem tarihi:** 21 Ekim 2026, ~12:00 (TR)
**Yöntem:** Yalnızca herkese açık sayfalar, tek istek, kimlik doğrulama/oturum yok, kısıt aşımı yok.
**Araç sınırı [4]:** Tarayıcı/DevTools bu ortamda yok. Sayfalar **sunucudan dönen metin**
olarak okundu (`fetch_page`). Bu yüzden: gerçek HTML/CSS/JS kaynağı, JSON-LD, ağ istekleri,
Core Web Vitals, erişilebilirlik ağacı ve mobil düzen **doğrudan incelenmedi**. Aşağıdaki
her satırda kanıtın ne olduğu yazılı. KadroNerede'nin iç mimarisi, veri kaynakları ve
algoritmaları **bilinmiyor**; tahmin edilmedi.

## 1. Gözlemlenen sayfalar [1]

| Sayfa | Gözlem |
| --- | --- |
| `/` | "**122** ilanda başvuru açık", "**78** akademik ilan", "**146** ilan arşivde". "Son başvurusu yaklaşanlar", "Yeni eklenenler" blokları. Kartlarda: kalan gün ("Son gün", "1 gün"), tarih, kurum, başlık, **kadro sayısı**, tür (Memur/İşçi/Sözleşmeli/Akademik), öğrenim, **KPSS türü** (P3, EKPSS, "KPSS'siz"), il. |
| `/ilanlar` | "Başvurusu süren **200** ilan, **2.060** kadro; **32** ilanın son günü 3 gün içinde. **19** ilanın başvurusu yakında başlıyor." Sekmeler: açık / akademik / arşiv. Telegram kanalı daveti. |
| `/ilanlar?sekme=arsiv` | "**Süresi dolan ya da iptal edilen 146 ilan**" – her kartta "kapandı" etiketi + kapanış tarihi. Kapalı ilanlar **gizlenmiyor**, ayrı sekmede tutuluyor. |
| `/ilan/<slug>-<id>` | İlan özeti (yapay zekâ ile yazıldığı **açıkça yazılı**), toplam kadro, kadro türü, başvuru aralığı, başvuru yolu, sınav tarihi, yer listesi, "**Başvurmadan önce resmî ilanı okuyun**" uyarısı, **resmî ilan bağlantısı** (ilan.gov.tr), başvuru adresi, **takvime ekle** (Google Takvim + `.ics`), kaynak + "Son kontrol: 21 Ekim 2026 12:30". Ayrıca **kadro bazlı** tablolar: her kadro için öğrenim/bölüm/alım yöntemi/yaş/il dağılımı/cinsiyet/askerlik. İl, bölüm ve kurum sayfalarına iç bağlantılar. |
| `/robots.txt` | `Allow: /`; `Disallow: /admin, /api/, /bana-uygun, /favoriler, /hata-bildir, /abonelik/, /*/belge, /*/takvim`; `Sitemap: /sitemap.xml` ve `/taban-puanlar/sitemap.xml`; `Content-Signal: ai-train=yes`; başlıca AI tarayıcıları için ayrı blok; `/llms.txt` tanıtımı. |

**Doğrulanamayan [4]:** kayıt/favori/abonelik akışlarının gerçek davranışı (giriş gerektirebilir),
sayfa hızı, HTML semantiği, JSON-LD, gerçek veri tazeliği (kaç dakikada bir güncelleniyor).

## 2. Kamuİlan'ın bugünkü durumu (kod + yerel ölçüm) [1][2]

| Konu | Kamuİlan |
| --- | --- |
| Erişim | **Giriş kapılı**: oturum yoksa ilan listesi açılmaz (`src/App.tsx`, `tests/app-gate.test.tsx`). Hesap **yalnızca yönetici davetiyle** açılır. |
| İlan kartı | Kurum, yayım tarihi, başlık, tür, il, kontenjan, **son başvuru etiketi** ("3 gün kaldı"), kaynak sayısı, "Son kontrol", kaydet. (`src/components/JobCard.tsx`) |
| İlan detayı | Alan bazlı **kanıt ipuçları** (`fieldSources` + alıntı), resmî bağlantı, `.ics` indirme, kaydet, profil uyumu. (`src/pages/JobDetail.tsx`) |
| Filtreler | Metin, il, kurum, tür, süreç/ilan, durum, tarih aralığı, min. kontenjan, öğrenim, bölüm, KPSS türü, KPSS puanı, "başvuru bağlantısı var", sıralama (`src/components/Filters.tsx`). |
| Arşiv | Durum filtresi var; **ayrı "arşiv/iptal" sekmesi yok**; varsayılan görünümde durum seçilmemişse kapalı ilanlar da listeye girebilir. |
| Kaynak şeffaflığı | `/kaynaklar` sayfası + `GET /api/sources`, her kaynak için doğrulama/adaptör/tazelik etiketi. **KadroNerede'de eşdeğeri gözlenmedi.** |
| SEO | `public/robots.txt` = yalnızca `Allow: /`; **sitemap yok**; SPA olduğu için sayfa başına `<title>`/`meta` **yok** (`document.title` hiç güncellenmiyor — kod aramasında bulunamadı). |
| Bildirim | E-posta + Telegram (`/durum`, `/dur`, `/basla`, `/cik`), tercih eşleştirme, olay + outbox + yeniden deneme. |
| Yapay zekâ | İsteğe bağlı, açık rızalı öneri kartı; LLM sınıflandırma kapısı yalnızca `review` kayıtlarda ve **kanıt doğrulamalı**. |

## 3. Karşılaştırma tablosu

| # | Özellik | KadroNerede kanıtı | Kamuİlan bugün | Eksik / avantaj | Kullanıcıya etkisi | Karmaşıklık | Öneri | Doğrulama testi |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Herkese açık ilan görüntüleme** | Ana sayfa/liste oturumsuz açık; "Kayıt yok, ücret yok" | Giriş kapılı; hesap davetle | **Kritik eksik** | Kayıtlı olmayan hiç kimse ilan göremez → ürün fiilen kullanılamaz | Orta (rota kapısı + salt-okunur sayfalar) | Karar gerekiyor: ilan listesi/detayı **herkese açık**, kaydet/bildirim için giriş (bkz. 06/R-01) | `tests/app-gate.test.tsx` yeni beklenti: `/ilanlar` oturumsuz 200 ve kart listeler |
| 2 | **Ayrı arşiv/iptal sekmesi** | "Süresi dolan ya da iptal edilen 146 ilan" | Durum filtresi var, sekme yok | Eksik (küçük) | Kapanan ilanı bulmak zor; "açık" ve "kapalı" karışır | Düşük | `?sekme=arsiv` eşdeğeri: `status=closed,cancelled` hazır bağlantı + varsayılan `active,upcoming` | `tests/filters.test.ts` + API: `status` verilmezse varsayılan |
| 3 | **Kadro bazlı kırılım** (unvan × il × kontenjan) | Detayda 8 kadro bloğu, il dağılımı sayılarıyla | Tek `quota` + `cities`/`titles` alanları | Eksik | Aday "bana kaç kadro var, hangi ilde" sorusunu yanıtlayamaz | Yüksek (çıkarım + şema) | `jobOpenings[]` gibi ayrı koleksiyon; yalnızca metinde açıkça varsa | Yeni extraction testleri (gerçek TCDD ilanı) |
| 4 | **Takvim dışa aktarma** | Google Takvim + `.ics`, sınav tarihi ayrı | `deadline` için `.ics` var (`src/lib/calendar.ts`) | Kısmi | Sınav tarihi takvime eklenemiyor | Düşük | `.ics`'e sınav tarihi ekle (varsa) | `tests/calendar` benzeri birim testi |
| 5 | **"Son kontrol" / kaynak tazeliği** | "Kaynak: ilan.gov.tr. Son kontrol: 21 Ekim 2026 12:30" | `lastVerifiedAt` kart ve detayda | **Avantaj Kamuİlan** (kaynak sağlığı + tarama geçmişi API'de) | — | — | Koru; kartta "son kontrol" boşsa "henüz yapılmadı" yazıyor (doğru) | Mevcut testler |
| 6 | **Ayrı kurum / il / bölüm sayfaları** | `/kurum/...`, `/il/istanbul`, `/bolum/...` | Yok (filtre URL'leri var) | Eksik | Uzun kuyruk SEO ve gezinme kaybı | Orta | `/kurum/:slug`, `/il/:slug` salt-okunur sayfalar (filtre sayfasının sunucu tarafı ön ayarı) | Yeni E2E + birim testi |
| 7 | **Sitemap + sayfa metaverisi** | `sitemap.xml`, `taban-puanlar/sitemap.xml`, sayfa başına başlık (`… 2026 \| kadronerede`) | Sitemap yok; SPA tek `<title>` | **Eksik** | Arama motoru indekslemesi ~yok | Orta | Sitemap üretimi (API rotası) + istemci tarafı `document.title`/`og:` güncellemesi | `tests/page-meta.test.ts` (jsdom) |
| 8 | **Yapay zekâ şeffaflığı** | "Bu özet yapay zekâ ile yazıldı ve otomatik denetlendi" | LLM yalnızca sınıflandırma/öneri; kullanıcıya metin üretilmiyor | **Avantaj Kamuİlan** (daha muhafazakâr) | — | — | Koru | Mevcut `tests/llm-*` |
| 9 | **Resmî kaynağa yönlendirme** | Resmî ilan + başvuru adresi bağlantısı | `detailUrl` + `applicationUrl` + kaynak listesi | Eşdeğer | — | — | Koru | `tests/serializers` |
| 10 | **Kaydet / favori** | Var (`/favoriler`, giriş gerektirir) | Var (`/panel/kaydedilenler`) | Eşdeğer | — | — | — | Mevcut testler |
| 11 | **Bildirim kanalı** | Telegram kanalı (yayın) | E-posta + Telegram bot (kişisel tercih eşleştirme) | **Avantaj Kamuİlan** | — | — | Koru | `tests/email*`, `tests/telegram.test.ts` |
| 12 | **robots / AI politikası** | Açık `Content-Signal`, `/llms.txt`, AI bot listesi | `Allow: /` | Eksik (küçük) | Net politika yok | Düşük | robots.txt + `llms.txt` ekle | Dosya testi |
| 13 | **KVKK / çerez** | Çerez politikası sayfası, "çerezsiz kimliksiz istatistik" | Gizlilik/KVKK sayfaları, minimizasyon, saklama | Eşdeğer | — | — | — | Mevcut testler |
| 14 | **Hata/boş durum** | (gözlenmedi) | `EmptyState`, `ErrorNotice`, `StatusBanner` | **Avantaj Kamuİlan** (kanıtlı) | — | — | Koru | `tests/ui.test.tsx` |

## 4. Sonuç: en önemli üç fark

1. **Erişim modeli (P1, ürün kararı).** KadroNerede herkese açık; Kamuİlan giriş kapılı ve
   davetle hesap açıyor. Bugünkü hâliyle Kamuİlan **halka ulaşamaz**; SEO, ağızdan ağıza
   yayılma ve "kayıt yok" beklentisi tamamen kapalı. Bu bir hata değil, bilinçli bir politika
   (`ALLOW_PUBLIC_REGISTRATION=0`) — bu yüzden **tek taraflı değiştirilmedi**; karar gerekiyor.
2. **Kadro düzeyi veri.** KadroNerede, bir ilanın içindeki kadroları unvan/il/kontenjan
   kırılımıyla veriyor. Kamuİlan tek `quota` ve il listesi tutuyor. Veri modeli farkı;
   gerçek TCDD ilanı gibi çok kadrolu ilanlarda adayın sorusunu yanıtlamıyor.
3. **Keşfedilebilirlik.** Sitemap, sayfa metaverisi ve kurum/il sayfaları yok. Kamuİlan'ın
   buna karşılık **kanıt izi, kaynak sağlığı ve dürüstlük notları** gibi daha güçlü olduğu
   yerler var; fark "daha çok özellik" değil, "doğru kullanıcıya ulaşma + kadro ayrıntısı".

> KadroNerede'nin algoritması, veri kaynağı listesi veya güncelleme sıklığı **bilinmiyor**;
> hiçbir öneri onların iç işleyişini kopyalamaya dayanmıyor. Öneriler yalnızca gözlenen
> kullanıcı ihtiyacını Kamuİlan'ın kendi mimarisiyle karşılamayı amaçlıyor.
