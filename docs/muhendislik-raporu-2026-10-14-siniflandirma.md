# Kamuİlan — sınıflandırma kararları, süreç duyuruları ve mühendislik raporu

**Tarih:** 14 Ekim 2026 (Europe/Istanbul)
**Depo:** `kaaradumaann-psi/kamuradar`
**Dal:** `arena/834acf8c-kamuradar` (ana dal `main` `90c663e` üzerinden)
**Önceki commit'ler (bu dalda, uzak depoda):** `696886e`, `5a48f4e`, `5fab8aa`
**Bu rapor kapsamındaki çalışma:** `arena/834acf8c-kamuradar` dalındaki sonraki commit (bkz. §9)
**Merge durumu:** Birleştirme yapılmadı. PR açıldı; GitHub checks ve kullanıcı incelemesi bekleniyor.

> Bu rapor, `jobs:reclassify` kurallarının gözden geçirilmesinin, kullanıcı tarafından onaylanan A–E kararlarının uygulanmasının, testlerin ve açık kalan işlerin kaydıdır. Gerçek üretim verisi (Supabase) bu ortamdan erişilemediği için üzerinde **çalıştırılmamıştır**; `--apply` çalıştırılmadı, Supabase'e hiçbir yazma yapılmadı.
>
> `.env` değerleri bu raporda, commit'te, log'da veya testte yer almaz. Sohbette paylaşılmış sırlar için döndürme (rotation) önerisi §8'de.

---

## 1. Yönetici özeti

- Kullanıcının onayladığı beş karar (A–E) uygulandı:
  - **A** Kurum içi görevde yükselme sınavları → `süreç` (reddedilmez, iş ilanı değildir, bildirim üretmez).
  - **B** "5 Üniversite için Rektör Adaylığı" → reddedilmeye devam eder.
  - **C** Hazine Muhasebe Uzmanlığı Yeterlik Sınavı → yalnızca kurum içi (mevcut personel) bağlamı varsa `süreç`.
  - **D** Adalet "Başvuru Sonuçları" → yalnızca gövdede gerçek başvuru sonuçları ve sınava katılma listesi varsa `süreç`. Genel "sonuç" kuralı yoktur.
  - **E** Süreç kayıtları "Süreç duyurusu" etiketiyle gösterilir; "Açık/Aktif" etiketi ve son başvuru etiketi gösterilmez. Tarihi bilinmeyen kayıt "başvuru açık" sayılmaz.
- Süreç kayıtları akışta, filtrelerde ve kayıt deposunda kalır; **yeni ilan e-postası veya Telegram bildirimi üretmez** (test ile kanıtlı).
- Yerel test deposunda dry-run yapıldı (8 kayıt): iki iş ilanı kabul, dört süreç duyurusu türü değiştirilerek akışta kaldı, iki kayıt (Bank Mellat basın duyurusu, YÖK Rektör Adaylığı) reddedildi.
- Tam test paketi: **54 dosya, 624 test, hepsi geçti.** `tsc --noEmit`: çıkış 0. ESLint (değiştirilen dosyalar): çıkış 0.
- Gerçek 56 kayıtlık Supabase dry-run'ı **sandbox'ta çalıştırılamadı**; kullanıcı Windows makinesinde salt okunur olarak çalıştıracak (§7.1).

---

## 2. Kullanıcı kararları ve uygulama durumu

| Karar | Kapsam | Uygulama | Test | Durum |
|---|---|---|---|---|
| **A** Kurum içi görevde yükselme | İçişleri "Görevde Yükselme Ve Ünvan Değişikliği Sınav Duyurusu"; Çevre "GÖREVDE YÜKSELME SINAVI İLANI"; Adalet "Görevde Yükselme ve Ünvan Değişikliği Sınavlarında Başarılı Olanların Tercih Başvurularına İlişkin Duyuru" | `süreç.gorevde-yukselme-sinavi` (başlık ön eki + sınav/tercih sinyali; yer değiştirme, öğrenci tercihi ve yks dışarıda) | `tests/report-2026-10-14-decisions.test.ts` A bölümü; `tests/classification.test.ts` | Uygulandı |
| **B** Rektör adaylığı | "5 Üniversite için Rektör Adaylığı Başvuru İlanı" | Mevcut `ret-baslik` kuralı korundu | Test B bölümü; reclassify testinde reddedilmiş kalıyor | Uygulandı (değişiklik yok) |
| **C** Muhasebe yeterlik | Hazine ve Maliye Bakanlığı Muhasebe Uzmanlığı Yeterlik Sınavı | Eski `ret-baslik.hizmet-ici-yeterlik` reddi kaldırıldı; kurum içi bağlam (`kadrosunda bulunan`, `fiili hizmet süresi`, `Muhasebe Uzman Yardımcısı` vb.) varsa `süreç.kurum-ici-yeterlik` | `tests/classification.test.ts` (güncellendi), rapor testi C bölümü | Uygulandı. **Gerçek gövde ile doğrulanmadı** (§6.2) |
| **D** Adalet Başvuru Sonuçları | "Başvuru Sonuçları" içeren Adalet ilanı | Dar kural `süreç.basvuru-sonuclari-govde`: başlık personel alımı ifadesi içerir + "başvuru sonuçları" başlığı gövdenin ilk ~500 karakterinde + sınava katılma listesi | Rapor testi D bölümü (3 negatif senaryo dahil) | Uygulandı. **Gerçek gövde ile doğrulanmadı** (§6.2) |
| **E** Durum etiketi | Tüm süreç kayıtları | `computeStatus` tarihi bilinmeyen kaydı `unknown` yapar; süreç kaydının `statusLabel`'i "Süreç duyurusu"; kart ve detayda durum/son başvuru etiketi gösterilmez | Rapor testi E bölümü; mevcut `computeStatus` testleri geçti | Uygulandı |

### Koşullar kontrolü

| Koşul | Sonuç |
|---|---|
| 26 doğru ret korunsun | Rapor testinde 26 başlığın tamamı ayrı ayrı test edilir ve reddedilir (`CORRECT_REJECTS`). Geçti. |
| Rektör reddedilsin | Geçti. |
| Süreç kayıtları silinmesin, kaynak bağlantısı korunsun | Reclassify yalnızca `kind`/`decision` alanlarını günceller; kayıt silinmez. Yerel dry-run'da kayıt sayısı sabit. |
| Süreç bildirim üretmesin | `src/notifications/matcher.ts` süreç kayıtlarını eşleştirmeden çıkarır (ikinci savunma hattı); `tests/process-notice-notifications.test.ts` (yeni kayıt, güncelleme `job-changed`, tekrar tarama, eşleştirici, reclassify ile bekleyen bildirim bastırma) geçti. |
| Yanlış tarih koruması | `computeStatus`: bitiş tarihi bilinmiyorsa `unknown`; başlangıcı geçmiş olsa bile "açık" denmez. Bitiş tarihi gelecekte olan ilan hâlâ açık (regresyon testi). |
| Yeni testler, tam paket, tsc, ESLint | §4. |
| Supabase `--apply` yok | Yapılmadı. |
| Commit/PR/merge onayı | Commit ve PR kullanıcının ayrı onayıyla yapıldı; **merge yapılmadı**. |

---

## 3. Değişen dosyalar

### 3.1 Kaynak kodu

| Dosya | Değişiklik |
|---|---|
| `src/classification/rules.ts` | `INTERNAL_PROMOTION_CONTEXT/SIGNAL/EXCLUDE_PATTERN` (A), `RESULTS_HEADING_PATTERN`, `RESULTS_LIST_CUE_PATTERN`, `RESULTS_HEADING_WINDOW` (D) eklendi. Mevcut kurallar değişmedi. |
| `src/classification/engine.ts` | `incumbentExamContext` genişletildi (`kadrosunda bulunan…`, `fiili hizmet süresi`); `inServiceQualificationExam` reddetmek yerine `süreç.kurum-ici-yeterlik` döndürür (C); basın bülteni reddi ayrı dal; iç görevde yükselme süreç dalı (A); gövde sonuç süreç dalı "2c" (D) "3) Olumlu kanıtlar" işaretinden önce. D dalı çekimli biçimler için ayrı `titleHasPersonelAlim` kontrolü kullanır (§6.3). |
| `src/ingest/reclassify.ts` | Reddedilmiş kayıt yalnızca güncel kural onu **açık bir süreç duyurusu** olarak tanıyorsa `reject → accept` olur. Genel reddi açmaz; kabul/inceleme kararlarını genel olarak değiştirmez. |
| `src/ingest/jobs-service.ts` | `computeStatus`: bitiş tarihi yoksa her zaman `unknown` (eskiden başlangıcı geçmiş kayıtlar `active` alıyordu). |
| `src/server/serializers.ts` | Süreç kaydının `statusLabel` değeri "Süreç duyurusu" (`PROCESS_STATUS_LABEL`). |
| `src/domain/types.ts` | `PROCESS_STATUS_LABEL` sabiti. |
| `src/db/repos/jobs.ts` | Durum filtresi yalnızca iş ilanlarına uygulanır (süreç kaydını dışlar); `dashboardStats` süreç kayıtlarını saymaz. |
| `src/components/Filters.tsx` | Tür "süreç" seçilince durum filtresi sıfırlanır ve devre dışı kalır. |
| `src/components/JobCard.tsx` | Süreç kartında "Süreç duyurusu" etiketi; durum/son başvuru etiketi yok; açıklama notu. |
| `src/pages/JobDetail.tsx` | Süreç detayında "Süreç duyurusu (yeni ilan değil)" etiketi; durum ve son başvuru etiketleri ve "başvuru" butonu süreçte gösterilmez. |

### 3.2 Testler

| Dosya | Değişiklik |
|---|---|
| `tests/report-2026-10-14-decisions.test.ts` | **Yeni.** 52 test: A, B, C, D, 26 doğru ret, 5 süreç başlığı, E durum etiketleri, reclassify reject→süreç ve genel ret korunması, depoda filtre/istatistik. |
| `tests/classification.test.ts` | Muhasebe testi reddetmek yerine süreç bekler; görevde yükselme testi süreç bekler. Public-qualification testi değişmedi ve geçiyor. |
| `tests/non-job-filter.test.ts` | "Kurum İçi Görevde Yükselme Sınavı Sonuçları Açıklandı" süreç listesine taşındı (A kararı). |

### 3.3 Repo dışı çıktılar (commit'e girmez)

- `/home/user/tlsdemo/reclassify-report-2026-10-14.json` — yerel test deposu dry-run raporu.
- `/home/user/review/2026-10-14-decisions.patch` — tam fark yaması (772 satır).
- `/home/user/tlsdemo/data-2026-10-14/` — dry-run için geçici kopya (test verisi).

---

## 4. Doğrulama sonuçları

| Kontrol | Komut | Sonuç |
|---|---|---|
| Tam test paketi | `npx vitest run` | **54 dosya, 624 test: hepsi geçti** (önceki 572 + yeni 52) |
| Yeni karar testleri | `npx vitest run tests/report-2026-10-14-decisions.test.ts` | 52/52 geçti (ilk koşuda 1 hata: çekimli "Alımı" biçimi; düzeltildi) |
| Tip denetimi | `npx tsc --noEmit` | Çıkış 0 |
| Lint | `npx eslint <13 değişen dosya>` | Çıkış 0 |
| Biçim | `npx prettier --check <değişen dosyalar>` | Yalnızca `src/ingest/jobs-service.ts` uyarıyor; bu dosya `HEAD`'de de biçimlendirilmemiş. Önceki kararla yalnızca değiştirilen satırlar düzeltildi, dosyanın tamamı biçimlendirilmedi (gereksiz diff oluşmasın diye). |
| Gizli değer taraması | Yama ve commit içeriğinde anahtar/token/bağlantı dizgisi desenleri | Eşleşme yok |

Not: Prettier ile önceki bir çalıştırma `engine.ts` ve `JobDetail.tsx` dosyalarında yalnızca satır sarma farkları üretti; bunlar uygulandı, mantık değişmedi. Tam paket bu düzeltmelerden sonra yeniden koşturuldu.

---

## 5. Dry-run

### 5.1 Yerel test deposu (bu ortamda çalıştırıldı)

Komut: `DATABASE_DRIVER=file DATA_DIR=/home/user/tlsdemo/data-2026-10-14 npx tsx scripts/reclassify-jobs.ts --report /home/user/tlsdemo/reclassify-report-2026-10-14.json` (kuru çalıştırma; yazma yok).

| Metrik | Değer |
|---|---|
| Toplam kayıt | 8 |
| Akışta önce / sonra (kabul) | 8 / 6 |
| Akışta kalan iş ilanı | 2 |
| Akışta kalan süreç duyurusu | 4 |
| Reddedilecek | 2 |
| Yeni kabul | 0 |
| Türü değişecek | 4 |
| Durumu değişecek | 0 |
| Bastırılacak bildirim kaydı | 6 (bekleyen bildirim: 0) |

**Kabul edilen iş ilanları (2):**
- Savunma Sanayii Uzman Yardımcılığı Giriş Sınavı
- Sözleşmeli Bilişim Personeli Alımı İlanı

**Süreç duyurusu olarak akışta kalanlar (4):**
- Karayolları Genel Müdürlüğü 50 İşçi Alımına İlişkin Noter Kurası Duyurusu
- Sözleşmeli Bilişim Personeli Sözlü/Uygulama Sınavına Çağrılacak Adaylar Hakkında Duyuru
- Bakanlık Merkez Teşkilatı ve Ankara Bekir Bozdağ Personel Eğitim Merkezi Müdürlüğü Destek Personeli (Şoför) Uygulamalı Sınav Yeri ve Tarihlerine İlişkin Duyuru
- ÇEVRE, ŞEHİRCİLİK VE İKLİM DEĞİŞİKLİĞİ BAKANLIĞI GÖREVDE YÜKSELME SINAVI İLANI

**Reddedilenler (2):**
- Bank Mellat Basın Duyurusu (basın duyurusu/haber; personel alımı kanıtı yok)
- YÖK Rektör Adaylığı Duyurusu (öğrenci kabulü/yerleştirme değil; B kararı)

Bu rapor yalnızca 8 kayıtlık test deposunu kapsar. 56 kayıtlık gerçek veri bu ortamda yoktur.

### 5.2 Önceki gerçek veri (Windows, Supabase, 14:27:56Z, önceki kurallar)

Bu rapor artık geçerli değildir; referans olarak tutulur.

- Toplam 56; kabul önce 56 → sonra 26; iş ilanı 21; süreç 5; reddedilen 30; yeni kabul 0; durum değişecek 7; tür değişecek 5; toplam değişen 47.
- Süreç olarak kalanlar: KGM Noter Kurası; Adalet Sözleşmeli Zabıt Katibi uygulamalı sınav metinleri; Adalet Destek Personeli (Şoför) sınav yeri; MEB Sözleşmeli Bilişim sınav çağrısı; YÖK 35 Sözleşmeli Personel yedek aday duyurusu.
- Kullanıcının incelediği 30 reddin 26'sı doğru ret kabul edildi; A/B/C/D/E kararlarıyla birlikte Windows'ta yeni rapor gerekir.

---

## 6. Bilinen sınırlamalar ve riskler

### 6.1 Canlı veri doğrulanmadı
Bu ortamdan `ilan.gov.tr`, `bddk.org.tr`, `tmsf.org.tr`, `resmigazete.gov.tr`, `api.telegram.org`, Groq, Gemini ve Supabase hostlarına erişim yok. Canlı dry-run, Telegram webhook/teslimat ve AI yanıtları **doğrulanmadı**.

### 6.2 C ve D kararları gerçek gövdede doğrulanmadı
- C ve D testleri, raporda tarif edilen kanıta benzer **sentetik** gövdelerle yazıldı. Gerçek Muhasebe ve Adalet gövdeleri bu ortamda yok.
- Windows dry-run raporunda bu iki kaydın kararı kontrol edilmeli. Beklenen: C → süreç (kurum içi bağlam), D → süreç (gövde sonuç başlığı + katılma listesi). Beklenmeyen bir sonuç varsa gerçek gövdenin ilk ~200 karakteri (kişisel/gizli değerler silinmiş) paylaşılmalı.

### 6.3 Ortak başlık kuralındaki çekim sorunu (düzeltilmedi)
`titleHasRecruitmentCue` içindeki `\b` sınırı `alim` + `i` (Alımı) gibi çekimli biçimleri yakalamaz. Yeni D dalı bunu ayrı bir kontrolle çözer. Ortak kural bu turda değiştirilmedi; etkisi (başka hangi kayıtları etkilediği) ayrı bir incelemeyle belirlenmeli. Bu, bir sonraki turda ele alınacak bir teknik borçtur.

### 6.4 Durum etiketi değişikliği geniş etkili
`computeStatus` artık bitiş tarihi bilinmeyen kayıtları `unknown` yapar (önce başlangıcı geçmiş olanlar `active` oluyordu). Yayım tarihi eski olan (`isStalePublication`) kayıtlar değişmeden `closed` kalır. Bu, yalnızca süreç değil, tarihi eksik iş ilanlarının da etiketini değiştirir. Beklenen ve istenen davranış budur; ancak Windows dry-run'da durum değişikliklerinin (`statusChanged`) gözden geçirilmesi önerilir.

### 6.5 Menü metni (gövde kirliliği)
TMSF "TMSF Personel Alım İlanı 2026" (deadline null, durum unknown), KGM "50 İşçi Personel Alımı Hk." ve "Erzurum … 1 Engelli İşçi" kayıtlarının gövdesi site menüsü metniyle başlıyor. Kullanıcı kuralı gereği geniş gövde temizleme kuralı eklenmedi; örnek bekleniyor (§7.3).

### 6.6 Yeniden sınıflandırma politikası
Yalnızca `reject → accept` ve yalnızca yeni kural `süreç` veriyorsa izin verilir. Genel kabul/inceleme değişimi hâlâ yapılmaz. Kaynak kategorisi kayıtta saklanmadığı için bu bilinçli bir sınırlamadır.

---

## 7. Açık işler — yapılması gerekenler

| # | İş | Kim | Engel / gereken | Durum |
|---|---|---|---|---|
| 7.1 | **Windows'ta gerçek veri dry-run'ı**: `npm run jobs:reclassify -- --report reclassify-report.json` (salt okunur). Sonuçları (özet, süreç listesi, reddedilenler, durum değişimleri) paylaşın. | Kullanıcı | Supabase erişimi yalnız kullanıcı makinesinde | Bekliyor |
| 7.2 | C (Muhasebe) ve D (Adalet Başvuru Sonuçları) kararlarının gerçek kayıtta doğrulanması (§6.2). | Kullanıcı + ajan | 7.1 çıktısı | Bekliyor |
| 7.3 | Menü metni sorunu: TMSF, KGM ×2 kayıtları için gövdenin ilk ~200 karakteri (kişisel/gizli değerler silinmiş). | Kullanıcı | Örnek | Bekliyor |
| 7.4 | `--apply` (yalnız onaydan sonra): önce yedek, sonra uygulama. | Kullanıcı onayı | 7.1 onayı | Yapılmadı |
| 7.5 | PR incelemesi ve GitHub checks. Merge yalnız açık onayla. | Kullanıcı | — | PR açıldı, merge yok |
| 7.6 | Windows dry-run'ın yeniden çalıştırılması (önceki turdan kalan). | Kullanıcı | 7.1 ile birlikte | Bekliyor |
| 7.7 | `npm run probe:resmigazete` çıktısı. Resmî Gazete yalnız mevcut kimlik politikası içinde değerlendirilir; tarayıcı User-Agent taklidi yapılmaz, TLS doğrulaması kapatılmaz. | Kullanıcı (yerel çalıştırma) | Sandbox'tan erişim yok | Bekliyor |
| 7.8 | TLS: `ilan.gov.tr` (personel ve api), `bddk`, `tmsf` için tam sertifika zinciri (PEM) veya Windows'a manuel güven kurulumu. Mevcut Windows TLS düzeltmesi sandbox'ta yalnız kök+ara sertifika ile doğrulandı. | Kullanıcı (PEM) + ajan | PEM / yerel kurulum | Bekliyor |
| 7.9 | Seçici hataları: ISKUR ×2, sağlık, DSİ, KGM, TKGM, EPDK, İçişleri, Göç, AFAD. HTML yapısı gerekli. | Kullanıcı (örnek HTML) + ajan | Canlı HTML | Bekliyor |
| 7.10 | Bekleyen testler: günlük özet (daily digest); icisleri/goc/afad için yalnız çerez filtresi. (`job-changed` bastırma testi zaten `696886e` commit'inde vardı ve geçiyor; bu turda değişmedi.) | Ajan | — | Digest ve çerez filtresi bekliyor |
| 7.11 | **Paylaşılmış sırların döndürülmesi:** Önceki sohbette `.env` içeriği paylaşıldı. Bu değerler döndürülmelidir (Telegram token/webhook secret, veritabanı bağlantı dizgisi, APP_SECRET, AI API anahtarları). Bu raporda hiçbir değer yer almaz. | Kullanıcı | — | Öneri (zorunlu) |
| 7.12 | Ortak başlık kuralındaki `\b` çekim sorunu (§6.3). | Ajan (sonraki tur) | Etki analizi | Bekliyor |
| 7.13 | Telegram ve AI entegrasyonunun canlı doğrulaması: webhook `info`, HTTPS tünel, AI yanıtı. | Kullanıcı + ajan | Ağ erişimi | Bekliyor |

---

## 8. Güvenlik notları

- `.env` dosyası bu turda okunmadı, değiştirilmedi, commit'e alınmadı. `.gitignore` satır 5'te `.env` dosyasını dışlar; `git ls-files .env` boş döner.
- Yerel dry-run `DATABASE_DRIVER=file` ile yapıldı; Supabase bağlantısı kullanılmadı.
- Commit öncesi taramada gizli değer desenleri bulunmadı.
- Süreç bildirimleri e-posta ve Telegram'a gitmez; bu, yanlış bildirim riskini düşürür.
- Sohbette paylaşılan sırlar için döndürme zorunludur (7.11).

---

## 9. Commit ve PR

- Commit: bu raporla birlikte `arena/834acf8c-kamuradar` dalına eklenen tek commit (kaynak, test, bu rapor).
- Push: `origin arena/834acf8c-kamuradar`.
- PR: `arena/834acf8c-kamuradar` → `main`. Açıklamada bu raporun yolu ve test sonuçları yer alır.
- **Merge yapılmadı.** Merge için: GitHub checks yeşil, kullanıcı incelemesi ve 7.1 dry-run sonuçlarının değerlendirilmesi gerekir.
- Commit ve PR, kullanıcının açık onayıyla yapılmıştır; merge onayı verilmemiştir.

---

## 10. Yeniden üretme komutları

```bash
# Tip ve lint
npx tsc --noEmit
npx eslint src/classification src/ingest src/pages/JobDetail.tsx src/components/JobCard.tsx src/components/Filters.tsx src/db/repos/jobs.ts src/server/serializers.ts src/domain/types.ts

# Test
npx vitest run tests/report-2026-10-14-decisions.test.ts tests/classification.test.ts tests/non-job-filter.test.ts
npx vitest run                     # tam paket (624 test)

# Kuru çalıştırma (yazmaz). Gerçek veri için .env ile çalıştırın.
npm run jobs:reclassify -- --report reclassify-report.json

# Uygulama (YALNIZ onaydan sonra; önce yedek alınır)
npm run jobs:reclassify -- --apply
```

Her dry-run ve apply çıktısının ilk satırı, hangi veritabanına bağlandığını gösterir (`yerel dosya deposu` veya Postgres). Üretim kontrolünde bu satır kontrol edilmelidir.
