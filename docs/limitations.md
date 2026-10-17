# Dürüst sınırlar ve bilinen eksikler

Bu belge, ürünün **yapamadıklarını** açıkça yazar. Arayüzde de aynı bilgiler
gösterilir; hiçbir yerde "tüm ilanlar toplanıyor" denmez.

Son denetim/uygulama turunun tam kaydı (ne yapıldı, ne test edildi, ne yapılamadı):
`docs/denetim-raporu-2026-10-15-devam.md` (PR #15) ve gerçek veriyle ölçüm planı
`docs/eval-gercek-veri.md`.

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
4. **SBB Kamu İlan (kamuilan.sbb.gov.tr)** için ortamlar arası tarihsel kanıt
   farklıdır: 12.10.2026'da bir sandbox isteği HTTP 403 "Geographic Restriction"
   döndürdü; 13.10.2026'da kullanıcı ağındaki koşum 4 ham kayıt bildirdi. Bu
   denetimde 14.10.2026'da canlı istek yapılmadı; bugünkü erişim bilinmiyor.
   Engel aşılmaya çalışılmaz.
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

1. Kaynakların kullanım koşulları ve `robots.txt` onboarding sırasında elle
   incelenmeli; CAPTCHA veya oturum duvarı aşılmamalıdır. Operatör staging komutu
   (`npm run staging:capture`) `config/source-terms.json` içindeki insan
   incelemesini **zorunlu** kılar ve inceleme yoksa ağa çıkmaz. Buna karşılık
   `start:worker`/zamanlanmış tarama yolu runtime'da ayrıca `robots.txt` sorgusu
   yapmaz; üretimde açmadan önce onboarding ve insan incelemesi gerekir. Bu
   politika kod düzeyinde genel bir erişim kontrolü değildir.
2. İlanın tam gövdesi kamu API'sinde yayımlanmaz. Gövde 500 karakterden uzunsa ilan ayrıntısında en çok 400 karakterlik metin alıntısı gösterilebilir; daha kısa duyurular tam kopyayı önlemek için gösterilmez. Alıntı ve kanıt parçalarında yaygın e-posta/Türkiye telefon biçimleri sezgisel olarak maskelenir. Bu desen tabanlı önlem tüm kişisel verileri yakaladığı garantisi değildir; özgün duyuruya bağlantı verilir, kaynak kullanım koşulları ayrıca değerlendirilmelidir.
3. Kişisel veri minimizasyonu uygulanır (bkz. [security-kvkk.md](./security-kvkk.md)).
   Kaynak bağı tam gövdeyi, kullanılmayan ham alıntıyı veya gövde hash'ini
   saklamaz; yakalama durumu/sınırlı karakter sayısı korunur. Arama, eşleştirme
   ve ilan ayrıntısı için ayrı, 2.500 karakterle sınırlı/redakte edilmiş ilan
   alıntısı ve onun normalize edilmiş arama kopyası tutulur; inceleme alıntıları
   1.500 karakterle sınırlıdır. `npm run db:migrate` eski kaynak bağı, ilan,
   arama kopyası, review payload'ı ve sürüm snapshot'larını düzeltir ve eski
   `contentHash` değerlerini yeniden üretir; çevrimiçi göçün her mevcut
   veritabanında çalıştırıldığı ayrıca kanıtlanmalıdır. Eski yedekler bu göç
   kapsamında değildir. Yaygın e-posta/telefon biçimleri alıntı ve kanıt
   parçalarında sezgisel olarak maskelenir; adlar, alışılmadık biçimler ve başka
   kişisel veriler için tam tespit garantisi yoktur. Yedekler yine de kişisel
   veri içerebilir; erişim kısıtlanmalı ve saklama süresi belirlenmelidir.

## Henüz yapılmamışlar (yol haritası niteliğinde)

- Günlük özet (digest) e-postasının toplu gönderimi altyapı olarak hazırdır
  (`mode: 'daily-digest'`, `digest` şablonu) ancak varsayılan olarak anlık
  bildirim kullanılır.
- Kaynak sayısı büyüdükçe sınıflandırma kural setlerinin otomatik kalibrasyonu.
- Taranmış PDF'ler için OCR hattı (bilinçli olarak eklenmedi; maliyet/doğruluk
  dengesi tartışılmalı).
- Çoklu dil (şimdilik yalnızca Türkçe).

## Telegram ve yapay zekâ önerileri

- **Telegram**: Bildirim metni düz HTML olarak gönderilir; bot yalnızca özel sohbeti kabul eder ve grup
  bildirimi yoktur. Telegram teslimi "sağlayıcı kabul etti" kaydıdır; kullanıcının okuduğu garanti edilmez.
- **Yapay zekâ önerileri**: Aday kümesi kural tabanlıdır (en çok 150 yeni açık ilan taranır, 12 aday
  gönderilir). Ilanı dışarıda kalan iyi bir eşleşme önerilmez. Model sıralaması ve gerekçeleri öneri
  niteliğindedir; başvuru koşullarının yerine geçmez ve kullanıcı resmî ilanı kontrol etmelidir.
- **Önbellek ve kota**: Öneri önbelleği süreç belleğindedir (20 dakika); birden fazla API sürecinde
  paylaşılmaz ve yeniden başlatmada sıfırlanır. Günlük kota da aynı kovada tutulur; yoğun dağıtımda
  yeniden başlatma sayacı düşürebilir.
- **Model kalitesi**: Sağlayıcı ve model değiştirilebilir; Türkçe kamu ilanı üzerindeki kalitesi
  kurulum öncesinde örnek ilanlarla ölçülmelidir. Uydurma ilan kimlikleri doğrulamada atılır, ancak
  metin içindeki yanlış gerekçeler doğrulanamaz.

## Üretim sertleştirme turu (15 Ekim 2026) — açık kalan sınırlar

1. **Gerçek etiketli küme yok.** `tests/fixtures/eval/labeled-set.json` 17 kayıttır; gövdeler
   sentetik, başlıklar kullanıcı spesifikasyonundan. Gerçek precision/recall raporlanmadı.
   `npm run eval:classification` gerçek örnek (`origin: "real"`) eklenince gerçek metrik verir.
   Bu boşluğu kapatmanın aracı eklendi: `npm run eval:build-set` depodaki gerçek kayıtlardan
   **salt okunur** etiketleme sayfası üretir (makine tahmini `machineSuggestion`da ayrı durur,
   `expectedContentType` boştur), `--import` doldurulmuş sayfayı doğrular ve **yalnızca
   `--apply`** kümeye yazar. İnsan etiketi olmayan, provenansı `human` olmayan veya
   `labeledBy/labeledAt` boş olan kayıt kabul edilmez; kapsam hedefinin altındaki kategoriler
   `EKSİK KATEGORİLER` olarak yazılır. Plan/hedefler: `docs/eval-gercek-veri.md`.
   Bu denetimde üretilen gerçek insan etiketi sayısı: **0** (ağ erişimi yok, bkz. madde 3).
2. **Haber sınıfı zayıf.** Başlığında haber ipucu olmayan ve kurala bağlanmayan redler `other`
   olarak etiketlenir. Etiketli kümede haber recall'u ölçüldü (bkz. eval çıktısı). Bu, yanlış ilan
   kabulü değildir, ama haber ayrımı eksiktir.
3. **Canlı kaynaklar bu turda doğrulanamadı.** Sandbox yalnızca github/npm/pypi'ye erişebilir.
   YÖK, ilan.gov.tr, İŞKUR ve diğer kurum sayfaları için canlı sonuç yoktur; `verified` etiketleri
   tarihsel kanıttır.
4. **LLM ingest hattında SINIRLI kullanılır.** Deterministik motor kabul/red kararlarını verir;
   LLM kapısı YALNIZCA `review` (belirsiz) kayıtlarda, kanıtı kaynak metinde birebir doğrulandığında
   çalışır ve başarısızlıkta kayıt incelemede kalır. Varsayılan KAPALIDIR (`LLM_CLASSIFIER_ENABLED=0`).
   Gerekçe ve koşullar: `docs/llm-karari.md`.
5. **Günlük özet gönderilmiyor.** Panelde yeni seçim sunulmuyor; bu moddaki mevcut tercihler
   "henüz kullanılamıyor" olarak gösterilir, bildirimler anında gönderilir.
6. **Veritabanı TLS doğrulaması artık varsayılan olarak AÇIKTIR** (15.10.2026 değişikliği).
   `POSTGRES_SSL_MODE` boşken ve CA dosyası verilmediğinde sunucu sertifikası Node'un gömülü +
   işletim sisteminin kök depolarıyla doğrulanır; Supabase'in sertifikası genel bir CA ile imzalı
   olduğu için ek dosya gerekmez. Doğrulamayı kapatmanın tek yolu açık tercihtir
   (`POSTGRES_SSL_MODE=no-verify` ya da `disable`); üretimde `npm run env:check` bu iki durumda
   bağlantıyı ENGELLER, geliştirmede uyarı verir. `POSTGRES_SSL_CA_FILE` okunamazsa hata yükselir,
   sessizce doğrulamasıza düşülmez. Kanıt: `tests/postgres-tls-config.test.ts` (self-signed
   sertifikaya karşı GERÇEK TLS el sıkışması). Yerel/Docker Postgres için `POSTGRES_SSL=false`
   (=`disable`) gerekir; `infra/docker/docker-compose.yml` bunu zaten veriyordu.
7. **Kuru çalıştırma sonuçları değişti.** Kabul kuralı güncellendi; 14 Ekim rakamları eski olabilir.
   Yeni kuru çalıştırma gerekir (`docs/veri-duzeltme-plani.md`).
8. **Ana metin ve menü temizliği genel değildir.** Menü metni sorunu için kullanıcıdan örnek
   bekleniyor; genel bir gövde temizleme kuralı eklenmedi.
9. **Telegram ve e-posta canlı teslimi test edilmedi.** Gönderim hataları kuyrukta izlenir, ama bu
   ortamda gerçek gönderim yapılmadı (gerçek kullanıcıya gönderim riski nedeniyle).
