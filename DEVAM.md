# DEVAM — hat kaybı denetimi (denetim/hat-kaybi)

**Durum:** İş tamamlandı. Commit 10fe897 push edildi, PR #93 açık (base main; #92'ye bağlı). Birleştirme yapılmadı.

## Ölçüm (23.10.2026, yerel, file DB, canlı, terms=enforce, OCR açık)
Değerler bulunan/kabul/ret/inceleme. Oklar düzeltme sonrası yeniden ölçümü gösterir. Hata: 0.
- RG 25/6→9/15/4→1 · Kariyer Kapısı 12/7→8/4→0/1→4 · ÖSYM 8/0→5 (süreç)/8→0/0→1
- Adalet 5/3/1/1 · AFAD 8/4/1/3 · DSİ 8/1/6/1 · MEB 8/1/7/0 · Sağlık 8/0/6/2 · TKGM 6/0/5/1
- TÜBİTAK 8/0/7/1 · YÖK 8/1/7/0 · BDDK 8/1/7/0 · SPK 8/0/8/0 · EPDK 8/0/8/0 · TMSF 4/1/3/0

## Kayıp nedenleri (düzeltildi)
1. Kariyer Kapısı dış ilanlarının adresi liste sayfasıydı; liste muhafızı bunları reddediyordu (4/12).
2. `ret-baslik.yargi` (`icra\w*`) "Açıktan İcra Müdür(Yrd.) Sınav İlanı"nı reddediyordu.
3. "Meslek Personel Yardımcılığı" ve "İşçi İstihdamı" başlık kanıtı sayılmıyordu.
4. RG'de başlığı gövdeden türetilen "… öğretim üyesi alınacaktır" ilanları incelemeye düşüyordu.
5. RG'de 3'lük OCR bütçesi ihale yasağı kararlarına gidiyordu; taranmış personel ilanı okunmuyordu.
6. Detay bütçesi (8) menü bağlantılarına gidiyordu (ÖSYM, SPK); alım olası başlıklar artık öne alınıyor.

## Test durumu
tsc ✔ · eslint ✔ · vitest 1700/1700 ✔ (1 atlandı)

## Sıradaki adımlar (açık kalanlar)
- Kariyer Kapısı dış ilanlarının gövdesi yok, incelemede kalıyor. Kurum sayfası okunmadan otomatik yayın yok.
- SPK ve EPDK seçicileri menü topluyor; listContainers düzeltilmeli.
- TKGM detay sayfasından metin çıkmıyor ("Sözleşmeli Bilişim Personel Alım İlanı").
- #92 birleşince PR #93'ü yeniden doğrula.
