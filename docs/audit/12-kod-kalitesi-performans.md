# 12 — Kod Kalitesi ve Performans (Phase 7)

**Ölçüm tarihi:** 21.10.2026 · Yalnızca **ölçülen** değerler. Ölçülmeyenler açıkça yazıldı.

## 1. Statik kalite (ölçüldü)

| Gösterge | Değer | Yorum |
| --- | --- | --- |
| `tsc --noEmit` | **0 hata** | `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals` açık |
| `eslint .` | **0 hata / 0 uyarı** | — |
| `any` kullanımı (`src`) | **0** | `: any` aramasında sonuç yok |
| `TODO` / `FIXME` / `HACK` | **0** | Ertelenmiş iş yorumu bırakılmamış |
| `console.log/debug` (`src`) | **3** | Betikler dışında; üretim yolu temiz |
| Kaynak dosya sayısı | 159 `.ts/.tsx` | — |
| Tek paket | 1 `package.json` | Monorepo değil |
| `npm audit` | **0 açık** | 402 paket (üretim 160) |
| Lisanslar | MIT 19 · Apache-2.0 2 · BSD-2-Clause 1 · MIT-0 1 | **copyleft yok** |

## 2. Test kalitesi (ölçüldü)

| Gösterge | Değer |
| --- | --- |
| Test dosyası / test | **122 / 1.409** |
| Kapsam (ifade / satır / dal / fonksiyon) | **%77,5 / %80,1 / %68,1 / %73,7** |
| En düşük kapsam | `src/components` %47,4 · `src/pages` %56,5 · `src/worker` %61,7 |
| En yüksek kapsam | `src/extraction` %92,8 · `src/ingest` %91,2 · `src/ai` %91,8 |
| Toplam süre | ~135 s (testler **sırayla**: `fileParallelism: false`) |
| Tarayıcı testi | **0 çalıştı** (Chromium yok) |

## 3. Paket boyutu ve arayüz (ölçüldü)

```
dist toplam           953 KB
assets/vendor-*.js    445 KB   (en büyük parça)
assets/index-*.js     281 KB
assets/index-*.css    158 KB
assets/query-*.js      63 KB   (dinamik parça)
```

- Parçalara ayırma **var** (`vendor`, `query` ayrı) → ilk yüklemede tüm ağırlık inmiyor.
- Gzip toplam ~145 KB (önceki ölçüm, `dist/` yeniden üretildi; sayı korunuyor [1]).
- **Görsel/ikon**: `public/` yalnızca `favicon.svg` → medya ağırlığı yok.
- **Ölçülmedi:** Lighthouse/Core Web Vitals, gerçek cihaz performansı (tarayıcı yok).

## 4. Sunucu tarafı performans riskleri (ölçüldü = tasarım gereği)

| Risk | Sayı / kanıt | Etki |
| --- | --- | --- |
| Postgres'te filtre/sıralama **bellekte** | `MAX_SCAN_ROWS = 20.000`; üstünde **hata** (sessiz kırpma yok) | ~20 bin ilanda liste/arama 500 verir |
| Her istekte hız sınırı **okuma+yazma** | `enforceRateLimit(repos.rateLimits, …)` | Yük altında ek DB trafiği |
| Testler sırayla | `vitest` config | 135 s; geri bildirim döngüsü yavaş |
| Liste yanıtı serileştirme | `toPublicJobSummary` her öğe için | 50 öğede ihmal edilebilir; ölçülmedi |
| Worker kalp atışı / kilit temizliği | Periyodik görevler | — |

**Öneri (R-03):** filtre → SQL `jsonb` operatörleri, sıralama + `LIMIT/OFFSET` SQL'de,
`count` ayrı sorgu; 50.000 kayıtlı yük testi.

## 5. Yapısal gözlemler

| Gözlem | Değerlendirme |
| --- | --- |
| Sorgu dili **tek kod yolunda** (`src/db/query.ts`) | İyi: üç sürücü aynı semantiği paylaşıyor. Bu denetimdeki `$exists` hatası **tek yerde** düzeltildi, üç sürücüde geçerli oldu |
| Sınıflandırma **saf fonksiyon** (ağ yok) | İyi: deterministik, test edilebilir |
| Her alan için **kanıt izi** (`fieldSources`) | İyi: "bu tarih nereden geldi" sorusu yanıtlanabilir |
| Sürücü başına ayrı dosya, ortak `StoragePort` | İyi: sürücü değişimi izole |
| 31 operasyon betiği (`scripts/`) | Orta: güçlü ama keşfedilebilirlik için `docs/` şart |
| `functions/api/[[path]].ts` içinde iş mantığı (başlık süzme) | Orta: ayrı test edilebilir olması için fonksiyon dışa açıldı (`buildForwardHeaders`) — bu denetimde yapıldı |
| `src/components` kapsamı %47 | Zayıf: UI hata durumları yeterince test edilmiyor |
| **Ölü kod** | Sistematik ölçülmedi (araç çalıştırılmadı); `noUnusedLocals` yalnızca yerel değişkeni yakalar |
| **Kopya kod** | Ölçülmedi (jscpd/benzeri çalıştırılmadı) |

## 6. Bu denetimde eklenen kodun kalitesi

| Değişiklik | Satır | Test |
| --- | --- | --- |
| `selectWithdrawalTarget` güçlendirme | ~35 | 6 + 4 (drenaj) |
| `detectNewsReport` + kurallar | ~125 | 6 |
| `hasApplicationUrl` ayrıştırma + repo filtresi | ~25 | 3 |
| `$exists` iki yönlü | ~6 | 4 |
| Vekil `buildForwardHeaders` | ~20 | 5 |
| CSRF muafiyeti kaldırma | −1 | 3 |

Tümü `typecheck` + `lint` + tam test kümesinden geçti; **0 `any`**, **0 TODO** eklendi.

## 7. Öncelikli iyileştirme listesi

1. **R-03** Postgres sorgularını SQL'e taşı (ölçek).
2. **R-11** Hız sınırı deposunu bellek/Redis'e al.
3. `src/components` ve `src/pages` test kapsamını %70'e çıkar (boş/hata durumları).
4. Testleri paralelleştir (paylaşılan durumu ayrıştır) → 135 s → hedef < 60 s.
5. Ölü kod taraması (ts-prune/knip) + kopya kod ölçümü ekle.
