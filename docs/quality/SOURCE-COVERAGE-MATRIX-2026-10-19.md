# Kaynak kapsam matrisi (statik envanter)

Üretim: 2026-10-19T12:12:31.180Z · Mod: **offline-static**

> Bu tablo yalnızca depo içindeki kaynak tanımlarını, adaptör eşleşmesini,
> izinli hostları ve doğrulanmış fixture manifestini gösterir. **Canlı HTTP,
> kaynak sağlığı, ilan sayısı, sayfalama, detay/PDF başarısı ve seçici
> doğruluğu ölçülmemiştir.** Fixture yokluğu "test edildi" değil, açık
> kapsam boşluğudur.

- Kaynak tanımı: **28** (etkin **24**)
- Adaptör: **10** · eksik: **0**
- Doğrulanmış fixture snapshot: **0** (manifest: none)
- Planlanan kapsam grubu: **4**

| sourceKey | Kurum / ad | Resmî URL | İzinli hostlar | Adaptör / yöntem | Envanter | Etkin | Fixture | Canlı kanıt |
|---|---|---|---|---|---|---|---|---|
| resmigazete-cestili-ilanlar | T.C. Resmî Gazete / Resmî Gazete — Çeşitli İlânlar (personel alım ilanları) | https://www.resmigazete.gov.tr/ilanlar | resmigazete.gov.tr, www.resmigazete.gov.tr | resmigazete-cestili / pdf-index | verified (son kayıt: 2026-10-12) | evet | YOK | NOT RUN / UNKNOWN |
| ilan-gov-tr-personel | Basın İlan Kurumu / ilan.gov.tr — Kamu / Akademik Personel kategorisi | https://www.ilan.gov.tr/ilan/tum-ilanlar/personel-alimi | ilan.gov.tr, www.ilan.gov.tr, medya.ilan.gov.tr | ilan-gov-tr / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| ilan-gov-tr-api-personel | Basın İlan Kurumu / ilan.gov.tr — Personel alımı havuzu (JSON API) | https://www.ilan.gov.tr/ilan/tum-ilanlar/personel-alimi | ilan.gov.tr, www.ilan.gov.tr, medya.ilan.gov.tr | ilan-gov-tr-api / json-api | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| osym-duyurular | ÖSYM Başkanlığı / ÖSYM — Duyurular (sınav ve alım duyuruları) | https://www.osym.gov.tr/Duyurular/Index | osym.gov.tr, www.osym.gov.tr, dokuman.osym.gov.tr | osym-duyuru / html-list | verified (son kayıt: 2026-10-12) | evet | YOK | NOT RUN / UNKNOWN |
| iskur-kamu-memur-alim | Türkiye İş Kurumu (İŞKUR) / İŞKUR — Kamu Memur Alım İlanları | https://www.iskur.gov.tr/ilanlar/kamu-memur-alim-ilanlari/ | iskur.gov.tr, www.iskur.gov.tr | iskur-ilan-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| iskur-kurumdisi-kamu-isci | Türkiye İş Kurumu (İŞKUR) / İŞKUR — Kurum Dışı Kamu İşçi Alım İlanları | https://www.iskur.gov.tr/ilanlar/kurumdisi-kamu-isci-alim-ilanlari/ | iskur.gov.tr, www.iskur.gov.tr | iskur-ilan-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| kariyerkapisi-isealim | T.C. Cumhurbaşkanlığı (Kariyer Kapısı) / Kariyer Kapısı — Kamu İşe Alım | https://kariyerkapisi.gov.tr/isealim | kariyerkapisi.gov.tr, www.kariyerkapisi.gov.tr | kariyer-kapisi-isealim / html-list | verified (son kayıt: 2026-10-12) | evet | YOK | NOT RUN / UNKNOWN |
| meb-personel-duyurular | T.C. Millî Eğitim Bakanlığı / MEB Personel Genel Müdürlüğü — Duyurular | https://personel.meb.gov.tr/meb_iys_dosyalar/xml/rss_duyurular.xml | personel.meb.gov.tr | meb-duyuru-listesi / html-list | verified (son kayıt: 2026-10-12) | evet | YOK | NOT RUN / UNKNOWN |
| kamuilan-sbb | T.C. Cumhurbaşkanlığı Strateji ve Bütçe Başkanlığı / Kamu İlan (Strateji ve Bütçe Başkanlığı) | https://kamuilan.sbb.gov.tr/ | kamuilan.sbb.gov.tr | sbb-kamuilan / http-html | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| iskur-esube-acik-is | Türkiye İş Kurumu (İŞKUR) / İŞKUR e-Şube — Açık İş İlanları | https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx | esube.iskur.gov.tr | manual-entry / manual-entry | needs-manual-method (son kayıt: 2026-10-12) | hayır | YOK | NOT RUN / UNKNOWN |
| saglik-bakanligi-personel | T.C. Sağlık Bakanlığı / Sağlık Bakanlığı (YHGM) — Personel Alım Duyuruları | https://yhgm.saglik.gov.tr/ | yhgm.saglik.gov.tr, www.saglik.gov.tr | kurum-duyuru-listesi / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| adalet-bakanligi-duyurular | T.C. Adalet Bakanlığı / Adalet Bakanlığı — Duyurular | https://www.adalet.gov.tr/arsiv | www.adalet.gov.tr, adalet.gov.tr, pgm.adalet.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| icisleri-bakanligi-duyurular | T.C. İçişleri Bakanlığı / İçişleri Bakanlığı — Duyurular | https://www.icisleri.gov.tr/duyurular | www.icisleri.gov.tr, icisleri.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| goc-idaresi-duyurular | Göç İdaresi Başkanlığı / Göç İdaresi Başkanlığı — Duyurular | https://www.goc.gov.tr/duyurular | www.goc.gov.tr, goc.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| afad-duyurular | Afet ve Acil Durum Yönetimi Başkanlığı / AFAD — Duyurular | https://www.afad.gov.tr/duyurular | www.afad.gov.tr, afad.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| sgk-duyurular | Sosyal Güvenlik Kurumu / Sosyal Güvenlik Kurumu — Duyurular | https://www.sgk.gov.tr/duyuru | www.sgk.gov.tr, sgk.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| gib-duyurular | Gelir İdaresi Başkanlığı / Gelir İdaresi Başkanlığı — Duyurular | https://www.gib.gov.tr/duyuru-arsivi/guncel | www.gib.gov.tr, gib.gov.tr | kurum-duyuru-listesi / html-list | needs-manual-method (son kayıt: 2026-10-13) | hayır | YOK | NOT RUN / UNKNOWN |
| tuik-duyurular | Türkiye İstatistik Kurumu / TÜİK — Duyurular | https://www.tuik.gov.tr/duyurular | www.tuik.gov.tr, tuik.gov.tr | kurum-duyuru-listesi / html-list | needs-manual-method (son kayıt: 2026-10-13) | hayır | YOK | NOT RUN / UNKNOWN |
| dsi-duyurular | Devlet Su İşleri Genel Müdürlüğü / DSİ — Duyurular | https://www.dsi.gov.tr/duyuru/duyuruListe | www.dsi.gov.tr, dsi.gov.tr | kurum-duyuru-listesi / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| kgm-duyurular | Karayolları Genel Müdürlüğü / Karayolları — Duyurular | https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Root/Duyurular.aspx | www.kgm.gov.tr, kgm.gov.tr | kurum-duyuru-listesi / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| tkgm-duyurular | Tapu ve Kadastro Genel Müdürlüğü / Tapu ve Kadastro — Duyurular | https://www.tkgm.gov.tr/duyurular | www.tkgm.gov.tr, tkgm.gov.tr | kurum-duyuru-listesi / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| tubitak-duyurular | TÜBİTAK / TÜBİTAK — Duyurular | https://www.tubitak.gov.tr/tr | www.tubitak.gov.tr, tubitak.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| yok-duyurular | Yükseköğretim Kurulu / YÖK — Duyurular | https://www.yok.gov.tr/announcements | www.yok.gov.tr, yok.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| bddk-duyurular | Bankacılık Düzenleme ve Denetleme Kurumu / BDDK — Duyurular | https://www.bddk.org.tr/Duyuru/Liste | www.bddk.org.tr, bddk.org.tr | kurum-duyuru-listesi / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| spk-duyurular | Sermaye Piyasası Kurulu / SPK — Duyurular | https://www.spk.gov.tr/duyurular | www.spk.gov.tr, spk.gov.tr | kurum-duyuru-listesi / html-list | verified (son kayıt: 2026-10-13) | evet | YOK | NOT RUN / UNKNOWN |
| epdk-duyurular | Enerji Piyasası Düzenleme Kurumu / EPDK — Duyurular | https://www.epdk.gov.tr/ | www.epdk.gov.tr, epdk.gov.tr | kurum-duyuru-listesi / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |
| rtuk-duyurular | Radyo ve Televizyon Üst Kurulu / RTÜK — Duyurular | https://www.rtuk.gov.tr/duyurular | www.rtuk.gov.tr, rtuk.gov.tr | kurum-duyuru-listesi / html-list | needs-manual-method (son kayıt: 2026-10-13) | hayır | YOK | NOT RUN / UNKNOWN |
| tmsf-duyurular | Tasarruf Mevduatı Sigorta Fonu / TMSF — Duyurular | https://www.tmsf.org.tr/tr/Basin/List | www.tmsf.org.tr, tmsf.org.tr | kurum-duyuru-listesi / html-list | scraper-built (kayıt yok) | evet | YOK | NOT RUN / UNKNOWN |

## Bu matrisin kanıtlamadığı şeyler

- Kaynağın bugün erişilebilir olduğunu veya HTTP 200 döndüğünü.
- Liste kartı, detay, PDF veya sayfalama sayılarını.
- Sıfır sonucun nedeni (`not-observed`, `blocked`, `parse-failure`, `unknown`).
- Adaptör seçicilerinin canlı sayfada hâlâ doğru olduğunu.

Canlı kanıt için yetkili operatör `npm run staging:capture` akışını kullanmalıdır;
robots/ToS kapısı ve dar istek bütçesi zorunludur.
