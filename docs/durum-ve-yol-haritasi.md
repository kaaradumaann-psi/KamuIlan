# Kamuİlan — Durum ve Yol Haritası

**Son güncelleme:** 13 Ekim 2026
**Kapsam:** Bugüne kadar yapılan her şey, canlı kanıt durumu, eksikler ve
gerekenler. Bu belge tek bakışta "neredeyiz, ne kaldı" sorusunu yanıtlar.
Ayrıntılı koşum günlüğü için `docs/dogrulama-2026-10-13.md`, mimari için
`docs/architecture.md`, kaynak politikası için `docs/sources.md`.

> Okuma notu: Bu projedeki temel kural **dürüstlük**tür. "Yapıldı"
> yalnızca canlıda kanıtlanmışsa yazılır; kod yazılmış ama kanıtlanmamış
> iş "hazır / kanıt bekliyor" diye işaretlenir. Aşağıdaki tablolar da
> böyle okunmalıdır.

---

## 1. Bugüne kadar yapılanlar

### 1.1 Ürün iskeleti (tamamlandı)

- **Giriş kapılı site:** Oturum açılmadan uygulama kabuğu hiç açılmaz;
  kullanıcı doğrudan giriş ekranına gelir, girişten sonra kaldığı
  sayfaya döner. Yalnızca giriş/parola/e-posta akış sayfaları ile
  bilgi sayfaları (SSS, gizlilik, kullanım) herkese açıktır
  (e-posta bağlantılarının çalışması için şart).
- **Kayıt modeli davetle:** Halka açık kayıt yoktur; hesap yalnızca
  yönetici davetiyle açılır (`ALLOW_PUBLIC_REGISTRATION=0`).
- **İlan arama:** Temel arama (kelime, il, tür, durum) önde; eğitim,
  bölüm, KPSS, kontenjan, tarih ve sıralama "Gelişmiş filtreler"
  altında isteğe bağlı. Filtre durumu bağlantıda taşınır
  (paylaşılan bağlantı aynı listeyi açar). Filtreleme mantığı
  uçtan uca testlerle kilitlidir (`tests/filters.test.ts`,
  `tests/jobs-filters-wiring.test.tsx`).
- **İlan detayı:** Kurum, unvan, kontenjan, il/ilçe, başvuru tarihleri,
  koşullar (eğitim, bölüm, KPSS, yaş, deneyim, dil, sertifika), ek
  belgeler, resmî ilana ve başvuru adresine bağlantılar, son gün
  için takvim (ICS) indirme. Çıkarılamayan alan tahmin edilmez;
  "belirtilmemiş" kalır.
- **Bildirimler:** Kullanıcı kriterlerini (kelime, unvan, kurum, il,
  tür, eğitim, KPSS taban puanı, son güne kalan süre) kaydeder; uyan
  yeni ilan ve değişiklikler e-posta ile gider. Duraklatma, test
  e-postası, geçmiş ekranı ve tek tıkla abonelikten çıkma vardır.
- **Kaydettiklerim:** İlan kartından tek tıkla takip listesi; son
  günü yaklaşan üstte.
- **Yönetim paneli:** Kaynak durumu, tarama geçmişi, inceleme
  kuyruğu (kararsız kayıtlar sessizce silinmez, insan onayına düşer),
  e-posta durumu, kullanıcı daveti, denetim kaydı, hesap silme
  (KVKK öz-yönetimi: anonimleştirme + onay diyaloğu).
- **Doğrulama kalkanları:** Tasarım sistemi sözleşmesi (paylaşılan
  CSS katmanları psikolog reposuyla bayt bayt aynı; sapma testte
  yakalanır), tanımsız sınıf yasağı, yardımcı (utility) sınıf yasağı.

### 1.2 Kaynaklar (tarama) — canlı kanıtla

13.10.2026'da beş canlı koşum yapıldı. Beşinci koşumun sonucu:
**23 etkin kaynağın 23'ü de çalıştı, 423 ham kayıt** üretildi.
("Ham kayıt" = adaptör çıktısı; sınıflandırma sonrası yayınlanan
ilan sayısı değildir.)

| Alan | Durum | Kanıt |
|---|---|---|
| Resmî Gazete (Çeşitli İlânlar) | ✅ Çalışıyor | Düz HTTP zaman aşımına uğrayınca tarayıcı yedeği bölüm + PDF'leri okuyor; 4. ve 5. koşumda kayıt üretti (koşum başına bütçeyle 5 PDF) |
| Kariyer Kapısı | ✅ Çalışıyor | Gerçek sayfa yapısına göre yazıldı; 5. koşumda listedeki 27 satırın tamamı (23 iç detay + 4 dış "İlana Git" başvurusu). Detayda ilan numarası, tür, tarihler, kontenjan, e-Devlet başvuru adresi okunuyor |
| ilan.gov.tr (BİK) | ✅ Çalışıyor | Tarayıcı yedeği + sayfalama canlıda kanıtlandı: 5 sayfa × 12 kart; üst sınırla koşum başına 40 kayıt |
| MEB Personel | ✅ Çalışıyor | Resmî RSS beslemesi; her koşumda 50 kayıttan 30 yeni kayıt işlendi |
| ÖSYM, İŞKUR (2), SBB Kamuİlan | ✅ Çalışıyor | Koşumlarda kayıt üretiyor |
| 17 kurum duyuru sayfası | ✅ Çalışıyor | Sağlık, Adalet, İçişleri, Göç, AFAD, SGK, DSİ, KGM, Tapu, TÜBİTAK, YÖK, BDDK, SPK, EPDK, TMSF ve diğerleri; genel adaptörle okunuyor |
| GİB, TÜİK, RTÜK, İŞKUR e-şube | ⏸ Bilerek kapalı | Sayfalar düz HTTP ile okunamıyor (JS uygulaması / oturum); CAPTCHA/WAF aşılmaz. İlanları merkezî kaynaklardan (RG, Kariyer Kapısı, ilan.gov.tr) dolaylı geliyor |

Tanımlı kaynak sayısı 27: 23 doğrulanmış etkin + 4 kapalı.
Koşum özeti: 1) 19/23 · 2) 19/23, 322 · 3) 22/23, 351 ·
4) 23/23, 391 · 5) 23/23, 423 ham kayıt. Ayrıntı:
`docs/dogrulama-2026-10-13.md`.

### 1.3 Bu turda (13.10, tasarım geçişi) yapılanlar

- Tüm aday sayfalarındaki metinler yazılım dili yerine günlük dile
  çevrildi ("adaptör", "çıkarım güveni", "sınıflandırma kararı",
  "boru hattı" gibi terimler kullanıcı ekranından kaldırıldı;
  dürüstlük notları duruyor ama sade anlatılıyor).
- İlan detayında mühendislik şeffaflık kartları (alan kaynağı izi,
  sınıflandırma kararı) aday ekranından kaldırıldı; bilgi kaybı yok,
  veriler yönetim/inceleme ekranında duruyor.
- Kaynaklar sayfası "İlanları nereden alıyoruz?" diliyle yeniden
  yazıldı: durumlar "İlanları düzenli okunuyor / Hazırlanıyor /
  Henüz başlamadı / Elle takip ediliyor" olarak gösteriliyor.
- Mobil: dokunma hedefleri en az 44 px, detay sayfası eylemleri
  dar ekranda tam genişlik, filtre ve istatistik ızgaraları tek
  kolona düşüyor. Paylaşılan CSS katmanlarına dokunulmadı; tüm
  düzenlemeler `src/styles/kamuilan.css` içinde.
- Dosya düzeni: kullanımı kanıtlanamayan tek dosya
  (`src/config/index.ts` kullanılmayan re-export kabuğu) kaldırıldı.
  Geri kalan her dosya ya kod ağacında ya komutlarda ya CI'da
  karşılığı olduğu için korundu (bkz. bölüm 3).

---

## 2. Eksikler ve gerekenler

### 2.1 Üretime çıkış için gerekenler (kod dışı)

| Gereken | Neden | Kim |
|---|---|---|
| `kamuilan.halilkaraduman.com.tr` alan adının yayına alınması | Site şu an bu adreste açık değil; üretim yayını ve gerçek e-posta bağlantıları buna bağlı | Halil (Cloudflare) |
| Gerçek e-posta gönderim hesabı (Resend vb.) + alan adı doğrulaması (SPF/DKIM) | Davet ve bildirim e-postalarının gerçekten gitmesi için | Halil |
| Üretim ortam değişkenleri (veritabanı, oturum anahtarı, `SOURCE_LIVE_FETCH=1`, Playwright/Chromium) | Taramanın zamanlanmış çalışması için | Kurulum sırasında |
| Yedekleme düzeni (veritabanı + `data/` yedeği) | İlan geçmişi ve kullanıcı tercihleri kaybolmasın | Kurulum sırasında |

### 2.2 Bilinen sınırlar (ürün içi)

- **"Tüm ilanlar" iddiası yok ve olmayacak:** Bazı kurumlar ilanını
  yalnızca kendi sayfasında duyurur. Site bunu her listede açıkça
  yazar; her kayıtta asıl kaynağa bağlantı vardır.
- **125 üniversite, üniversite hastaneleri ve belediyeler tek tek
  taranmıyor:** İlanları Resmî Gazete + ilan.gov.tr + Kariyer
  Kapısı üzerinden dolaylı geliyor. Kaynaklar sayfasında bu,
  "henüz başlamadığımız kurumlar" olarak açıkça gösteriliyor.
- **Genel kurum adaptörlerinde gürültü:** Kurum duyuru sayfalarından
  gezinme bağlantıları da ham kayıt olarak düşebiliyor (ör. "Şifremi
  Unuttum"). Bunlar sınıflandırmada eleniyor, yayınlanan sayıyı
  şişirmiyor; ama kaynak sağlık sayıları ham sayılardır. Kalıcı
  çözüm, adaptörde gezinme/altbilgi bağlantılarını kaynağında
  elemek — ayrı bir hassasiyet işi olarak planlandı.
- **Tarama hızları:** Resmî Gazete koşumu ~250 sn, BDDK ~290 sn
  sürüyor (kaynaklar yavaş). Zamanlanmış taramada sorun değil;
  elle tetiklemede bekleme olarak hissedilir.
- **Koşum üst sınırları:** ilan.gov.tr koşum başına 40 kayıt
  (5 sayfa); Kariyer Kapısı detay bütçesi koşum başına sınırlı —
  bütçe önce görülmemiş ilanlara harcandığı için her koşumda yeni
  dilim detaylanıyor, eksik kendiliğinden kapanıyor. Resmî Gazete
  PDF bütçesi de aynı mantıkla ilerliyor (bilinenler atlanır).
- **Kariyer Kapısı'nda düz HTTP satır vermiyor:** Sunucu tarayıcı
  dışı istemciye liste yerine başka sayfa döndürüyor görünüyor;
  alınan sayfanın başlığı artık tanı notuna yazılıyor. Tarayıcı
  yolu sorunsuz çalışıyor; kök neden bir sonraki koşumun notunda
  görülecek. Bu bir engel değil, izlenen bir konu.

### 2.3 Sonraki adımlar (önerilen sıra)

1. Alan adı + e-posta hesabı hazır olduğunda üretim yayını ve
   gerçek davetle ilk kullanıcılar.
2. Genel adaptör hassasiyet geçişi (gürültü bağlantılarının
   kaynağında elenmesi) — ham kayıt sayıları da dürüstleşir.
3. Kapalı 4 kaynağın (GİB/TÜİK/RTÜK/İŞKUR e-şube) izlenmesi:
   merkezî kapsama yetersiz kalırsa tarayıcı yöntemi değerlendirilir
   (CAPTCHA/oturum duvarı aşılmaz, yalnızca herkese açık liste
   okunur).
4. Üniversite/belediye doğrudan taraması ancak dolaylı kapsamda
   kaçırılan ilan görülürse gündeme alınır.

---

## 3. Dosya düzeni notu (13.10)

- Kök: yalnızca proje girişleri (`package.json`, `index.html`,
  `vite.config.ts`, `wrangler.jsonc`, yapılandırma dosyaları).
- `src/`: arayüz (`pages/`, `components/`, `styles/`), sunucu
  (`server/`), tarama (`sources/`), alan mantığı (`domain/`,
  `classification/`, `extraction/`, `ingest/`, `notifications/`),
  veri (`db/`), ortak (`lib/`, `config/`).
- `src/styles/`: psikolog/MMPI ile paylaşılan 9 katman **bayt bayt
  korunur** (sözleşme: `tests/design-system.test.ts`); uygulamaya
  özgü tek katman `kamuilan.css`, duyarlı katman her zaman son.
- `scripts/`: her dosya bir `package.json` komutuna bağlı.
- `docs/`: süreç ve durum belgeleri (bu dosya dahil) — silinmez.
- `data/`, `dist/`, `node_modules/`: çalışma/derleme çıktısı,
  sürüm kontrolü dışında (`.gitignore`).
- Kaldırılan: `src/config/index.ts` (hiçbir yerden çağrılmayan
  toplu re-export; tüm çağrılar doğrudan modüllere gidiyor).

## 4. Doğrulama (her değişiklikte koşulan kapılar)

```bash
npx tsc --noEmit   # tip denetimi
npm run lint       # eslint
npm test           # birim/entegrasyon süiti (tasarım sözleşmesi dahil)
npm run build      # üretim derlemesi
```

13.10 tasarım geçişi sonrası durum bu belgenin yayımlandığı
commit'te yeşildir; canlı tarama durumu için bölüm 1.2'ye bakın.
