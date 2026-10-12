# Dürüst sınırlar ve bilinen eksikler

Bu belge, ürünün **yapamadıklarını** açıkça yazar. Arayüzde de aynı bilgiler
gösterilir; hiçbir yerde "tüm ilanlar toplanıyor" denmez.

## Kapsam

1. **Kapsam eksiktir.** Türkiye'de kamu personel alım ilanları yüzlerce farklı
   yerde yayımlanır (bakanlıklar, üniversiteler, belediyeler, hastaneler, il özel
   idareleri...). Kayıtlı kaynaklar merkezî olanlar ve doğrulanabilenlerdir;
   geri kalanı `PLANNED_SOURCES` listesinde açıkça durur.
2. **Dolaylı kapsam her zaman tam değildir.** Resmî Gazete ve ilan.gov.tr birçok
   kurumu dolaylı kapsar; ancak bazı kurumlar yalnızca kendi sayfalarında duyuru
   yapar ve o sayfalar doğrulanmadan kapsama alınmaz.
3. **Kariyer Kapısı** sayfası JavaScript ile doludur ve başvuru akışı e-Devlet
   oturumu gerektirir. Otomatik çekim yalnızca tarayıcı (Playwright) kuruluysa ve
   sayfa genel erişime açıksa mümkündür; aksi halde kaynak "yoğun/erişim kısıtlı"
   olarak işaretlenir. **Sahte ilan üretilmez.**
4. **SBB Kamu İlan (kamuilan.sbb.gov.tr)** bu geliştirme ortamından HTTP 403
   "Geographic Restriction" (WAF) ile engellendi. Engel AŞILMAYA ÇALIŞILMADI;
   Türkiye'den çalışan bir kurulumda açılabilir.
5. **İŞKUR e-şube arama ekranı** oturum/arama tabanlıdır; otomatik çekim kapalıdır,
   kaynak kaydı yalnızca kapsam raporunda görünür.

## Veri kalitesi

1. **Her alan her ilanda yoktur.** Unvan, kontenjan, il, KPSS taban puanı,
   başvuru tarihleri gibi alanlar yalnızca metinde açıkça yazıyorsa doldurulur.
   Aksi hâlde `null` kalır ve arayüzde "belirtilmemiş" görünür.
2. **PDF taranmışsa metin yoktur.** OCR yapılmaz; PDF ek olarak saklanır ve kayıt
   "metin katmanı yok" notuyla incelemeye düşer.
3. **Tarih yorumu muhafazakârdır.** "Başvurular Ekim ayında" gibi ifadelerden
   kesin tarih üretilmez; belirsizlik olarak listelenir.
4. **Çıkarım hataları olabilir.** Bu yüzden her alanın kaynağı (`listing` / `detail`)
   gösterilir, belirsizlik uyarıları listelenir ve şüpheli kayıtlar inceleme
   kuyruğuna düşer. Kullanıcı her zaman resmî ilan bağlantısına yönlendirilir.
5. **Örnek veriler gerçek değildir.** `npm run seed:demo` ile eklenen kayıtlar
   `provenance: 'sample'` taşır ve arayüzde "örnek veri" olarak etiketlenir.

## İşletim

1. **Saatlik tarama garantisi ortama bağlıdır.** Zamanlama veritabanında tutulur ve
   worker süreci tarafından yürütülür; kullanıcının uygulamayı açık tutması
   gerekmez. Ancak sunucu/konteyner uyku moduna giriyorsa (ücretsiz PaaS
   planları, kapalı dizüstü) tarama yapılmaz. Worker 7/24 çalışan bir ortamda
   koşmalıdır; kesintiler `scheduleLagWarning` ve worker kalp atışı ile görünür
   hale gelir.
2. **Gerçek gönderim anahtarı bu depoda yoktur.** Üretim yolu Resend HTTPS
   API'sidir (`RESEND_API_KEY` + doğrulanmış alan adı) ve dağıtımda sağlanır;
   bu depoda test edilen şey istek biçimi, hata yorumu ve yeniden deneme
   davranışıdır, sağlayıcının teslim performansı değildir. Geliştirmede iletiler
   yalnızca diske yazılır; hiçbir yerde "teslim edildi" denmez.
3. **Gerçek kaynak davranışı ortama bağlıdır.** Bazı kurumlar coğrafi kısıt, WAF
   veya bakım nedeniyle dönemsel olarak erişilemez olur; bu durum kaynak
   sağlığında görünür ve mevcut ilanlar SİLİNMEZ.
4. **Ölçek**: Tarama hızı kaynak başına bilinçli olarak düşük tutulur
   (`minRequestIntervalMs`). Yüzlerce kaynağı çok sık taramak için daha fazla
   worker ve kaynak başına aralık ayarı gerekir.

## Güvenlik/hukuk

1. Kaynakların kullanım koşullarına ve `robots.txt` kurallarına uyulur; CAPTCHA
   veya oturum duvarı aşılmaz. Bu nedenle bazı kaynaklar kapsam dışında kalır.
2. İlan içerikleri yeniden yayımlanmaz; yalnızca özet ve resmî bağlantı gösterilir.
3. Kişisel veri minimizasyonu uygulanır (bkz. [security-kvkk.md](./security-kvkk.md));
   yedekler kişisel veri içerdiği için erişim kısıtlanmalı ve saklama süresi
   belirlenmelidir.

## Henüz yapılmamışlar (yol haritası niteliğinde)

- Günlük özet (digest) e-postasının toplu gönderimi altyapı olarak hazırdır
  (`mode: 'daily-digest'`, `digest` şablonu) ancak varsayılan olarak anlık
  bildirim kullanılır.
- Kaynak sayısı büyüdükçe sınıflandırma kural setlerinin otomatik kalibrasyonu.
- Taranmış PDF'ler için OCR hattı (bilinçli olarak eklenmedi; maliyet/doğruluk
  dengesi tartışılmalı).
- Çoklu dil (şimdilik yalnızca Türkçe).
