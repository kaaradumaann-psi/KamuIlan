# 08 — Yayına Hazırlık Değerlendirmesi

**Tarih:** 21.10.2026 · **Karar:** **KOŞULLU — iç/demo kullanım için hazır, halka açık
yayın için HAZIR DEĞİL.**

Bu belge "derleniyor, o hâlde hazır" demiyor. Her boyut ayrı ölçüldü.

## 1. Boyut bazında durum

| Boyut | Durum | Gerekçe (kanıt) |
| --- | --- | --- |
| Derleme/tip/lint | **PASS** | `typecheck`, `lint`, `build` çıkış 0 |
| Otomatik testler | **PASS** | 122 dosya / 1409 test; kapsam %77,5 ifade |
| Veri doğruluğu (kural düzeyi) | **KISMİ** | İptal, haber dili, `$exists`, filtre sözleşmesi düzeltildi; **gerçek insan etiketli ölçüm yok** (R-04) |
| Güvenlik (uygulama katmanı) | **KISMİ-PASS** | CSRF, oturum, scrypt, SSRF/DNS, admin RBAC, hız sınırı, vekil IP; **RLS yok** (R-02) |
| Bağımlılıklar/lisans | **PASS** | `npm audit` 0 açık; tüm lisanslar izin verici |
| KVKK/gizlilik | **KISMİ** | Veri minimizasyonu, saklama temizliği, hesap silme, rıza akışı var; **RLS ve silme provası yok** |
| Gözlemlenebilirlik | **KISMİ** | Sağlık uçları, heartbeat, denetim kaydı var; **üretim doğrulanmadı** (R-08) |
| Ölçek | **ZAYIF** | Filtre SQL'de (R-03 kısmi); sıralama/sayfalama bellekte; 20.000 eşleşen satır sınırı; yük testi yok |
| Erişilebilirlik/UX | **PASS (CI)** | Playwright 4 spec / 20 test CI'da geçiyor (run `39597847874`); yerel sandbox'ta koşulamıyor (R-10) |
| Dokümantasyon | **PASS** | `docs/` + bu denetim seti (01–08) |
| Halka açık erişim / keşfedilebilirlik | **FAIL** | Giriş kapılı, sitemap/meta yok (R-01, R-16) |

## 2. Yayın kapıları (gate)

### A. İç/demo ortamı (davetli kullanıcılar, dosya deposu) — **AÇILABİLİR**
- [x] Derleme + test yeşil
- [x] Gizli değerler repoda değil (`.env` gitignore'da)
- [x] Zamanlayıcı/canlı ağ varsayılan kapalı
- [x] Yönetici uçları RBAC korumalı
- [ ] Yönetici hesabı oluşturuldu ve parola güvenli biçimde iletildi (bu ortamda yapılmadı)

### B. Halka açık yayın — **HAZIR DEĞİL**, şu kapılar kapalı:
1. **R-01** Herkese açık ilan sayfaları (ürün/politika kararı) — *yok*
2. **R-02** DB rolü ayrımı / RLS — *yok*
3. **R-04** Gerçek insan etiketli kalite ölçümü (kesinlik ≥ 0,95) — *yok*
4. **R-03** Ölçek: SQL düzeyi filtre — *var (PGlite ile test)*; sıralama/sayfalama — *yok*
5. **R-08** Üretim sağlık doğrulaması — *yapılmadı*
6. ~~R-10 Tarayıcı E2E~~ — **CI'da geçiyor**; yerel ortamda kurulum gerekli
7. **R-16** Sitemap/meta/`llms.txt` — *yok*
8. Yasal: KVKK aydınlatma/çerez metinleri yayın modeliyle uyumlu — *güncellenmeli*

## 3. Bu dalın yayına etkisi

| Değişiklik | Etki | Geri alma |
| --- | --- | --- |
| İptal hedefi kanıt kuralı | Daha az otomatik kapatma, daha çok inceleme | Tek fonksiyon geri alınır (`selectWithdrawalTarget`) |
| CSRF muafiyeti kaldırıldı | Daha sıkı güvenlik | Muafiyet satırı geri eklenir |
| Haber dili kapısı | Yanlış ilan yayımlama riski düşer; bazı gerçek ilanlar `review`a düşebilir | `detectNewsReport` çağrısı kaldırılır |
| `$exists` / filtre düzeltmeleri | Sorgu sonuçları düzelir | `src/db/query.ts` + `routes/jobs.ts` |
| Vekil IP düzeltmesi | Hız sınırı doğru çalışır | `buildForwardHeaders` geri alınır |

**Veri göçü gerekmez.** Hiçbir şema değişikliği yok; mevcut kayıtlar olduğu gibi okunur.
Geri alma veri kaybına yol açmaz.

## 4. Kullanıcıya söylenmesi gereken üç cümle

1. Sistem **çalışıyor ve testleri geçiyor**, ama bugün **halka kapalı**: ilanları yalnızca
   davetli hesaplar görebiliyor.
2. **Yanlış ilan yayımlama riski** bu denetimde ölçülebilir biçimde azaltıldı; ancak gerçek
   dünya kesinliği **henüz ölçülmedi** (insan etiketli set yok).
3. Halka açık yayın için gereken üç büyük iş: **herkese açık sayfalar**, **veritabanı yetki
   ayrımı**, **gerçek kalite ölçümü**. İlk ikisi karar/izin, üçüncüsü insan emeği gerektiriyor.

## 5. Önerilen sıradaki üç adım

1. **Karar paketi (tek onay):** herkese açık listeleme + RLS/DB rolü + sitemap.
2. **Etiketleme:** 150 gerçek ilanın insan tarafından işaretlenmesi → ilk gerçek kesinlik ölçümü.
3. **Ölçek:** Postgres sorgularının SQL'e taşınması + 50.000 kayıtlı yük testi.
