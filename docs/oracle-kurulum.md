# Oracle Cloud kurulumu (API + worker)

Mimari: arayüz Cloudflare Workers'ta (`wrangler.jsonc`); API ve worker Oracle Always Free
sunucusunda systemd ile çalışır. API dışarıya **Cloudflare Tunnel** ile çıkar
(`api.kamuilan.halilkaraduman.com.tr` → `http://127.0.0.1:3000`); sunucuda SSH dışında gelen
port açılmaz, TLS'i Cloudflare yapar. Sırlar repoya ve cloud-init'e girmez.

## 1. Hesap (kullanıcı)

- Cloud Account Name: `kamuilan` · Home Region: **Germany Central (Frankfurt)** (sonradan değişmez).
- Pay As You Go'ya **yükseltme** (ücretsiz kota aşımı faturalanır).

## 2. Ağ (konsol → Networking → Virtual cloud networks)

**Actions → Start VCN Wizard → Create VCN with Internet Connectivity**, ad `kamuilan-vcn`, varsayılanlar.
Önce ağı ayrı kurmak gerekir: makine formunda "Create new virtual cloud network" seçilince public IP
kutusu işaretlenemedi ve oluşturma "API Error: Incorrectly formatted request" verdi (22.10.2026).

## 3. Sunucu (konsol → Compute → Instances → Create instance)

| Alan | Değer |
|---|---|
| Name | `kamuilan-1` |
| Image | Canonical **Ubuntu 24.04** (varsayılan 20.04 gelebilir; değiştir) |
| Shape | **Ampere** → `VM.Standard.A1.Flex`, **1 OCPU / 6 GB** ("Always Free-eligible"). Küçük şekil kasıtlı: Always Free'de 7 gün boyunca kullanımı çok düşük makine geri alınabilir. |
| Networking | **Select existing** → `kamuilan-vcn` → `public subnet-kamuilan-vcn`, **Automatically assign public IPv4 address** açık |
| SSH keys | **Upload public key file (.pub)** → `~/.ssh/kamuilan_oracle.pub` (yapıştırırken iki kez eklenip bozulabiliyor) |
| Boot volume | Varsayılan (≈47 GB) |
| Management / cloud-init | Boş bırakılabilir; betik SSH ile de çalıştırılır (aşağıda) |

"Out of host capacity": başka Availability Domain ya da sonra dene. Oluşunca **Public IP**'yi not et.

**cloud-init konsolda verilmediyse** (gerçek kurulum böyle yapıldı): `infra/oracle/cloud-init.yaml`
içindeki `write_files` + `runcmd` adımları kabuk betiğine çevrilip `sudo bash` ile çalıştırılır.
İlk açılışta `unattended-upgrades` apt kilidini tutar → apt komutlarına `-o DPkg::Lock::Timeout=900`.
Bitti işareti: `/var/lib/kamuilan-hazir` (konsol cloud-init'inde `/var/lib/cloud/instance/kamuilan-hazir`).

## 4. Cloudflare Tunnel (kullanıcı, ücretsiz)

Cloudflare → **Networking → Tunnels** (eski adı Zero Trust → Networks → Tunnels) → Create → Cloudflared →
ad `kamuilan-api`. Ortam: **Debian + arm64** (Windows seçiliyken verilen komut bu PC'ye bağlayıcı kurar).
Rota: tünel → **Routes → Add route → Published application** → `api.kamuilan.halilkaraduman.com.tr` →
`http://127.0.0.1:3000` (CNAME'i Cloudflare oluşturur).
Jetonu **sohbete yazmadan** kullanıcı ortam değişkenine koy:
`[Environment]::SetEnvironmentVariable('CLOUDFLARE_TUNNEL_TOKEN', '<jeton>', 'User')`.
Jeton bir yere sızdıysa tünelde yenile; eski jeton "Invalid tunnel secret" ile reddedilir.

## 5. Ortam dosyası + tünel servisi

```powershell
powershell -File infra\oracle\ortam-gonder.ps1 -Sunucu <IP>
```

Kullanıcı ortam değişkenlerinden `/etc/kamuilan/kamuilan.env` (0640, değerler tek tırnaklı) üretir,
Supabase CA'yı koyar, `CLOUDFLARE_TUNNEL_TOKEN` varsa `/etc/cloudflared/token` (0600) yazıp tünel
servisini başlatır. Hiçbir değeri ekrana yazmaz; uygulama sırları sunucuda varsa korunur.
API `HOST=127.0.0.1` dinler, `TRUST_PROXY=loopback`.

## 6. İlk çalıştırma (onaylı adımlar)

`/opt/kamuilan` yalnız `kamuilan` kullanıcısına açık; komutlar onun adına çalışır:

```bash
ssh -i ~/.ssh/kamuilan_oracle ubuntu@<IP>
K='cd /opt/kamuilan/app && set -a && . /etc/kamuilan/kamuilan.env && set +a'
sudo -u kamuilan bash -c "$K && npm run -s env:check && npm run -s db:tls-doctor"
sudo systemctl start kamuilan-api kamuilan-worker
curl -s http://127.0.0.1:3000/api/health
# İlk yönetici (parola yalnız sunucuda girilir, ekranda görünmez):
sudo -u kamuilan bash -c "$K"' && read -rp "E-posta: " ADMIN_EMAIL && read -rsp "Parola: " ADMIN_PASSWORD && echo && export ADMIN_EMAIL ADMIN_PASSWORD && npm run -s seed:admin'
sudo -u kamuilan bash -c "$K && npm run -s telegram:webhook -- set"
```

Veritabanı şeması Frankfurt'ta zaten kurulu (`db:indexes` + `db:migrate`, 22.10.2026).

## 7. Cloudflare arayüzü

Workers Builds (`main` → `npm run build` + `npx wrangler deploy`). `API_ORIGIN` varsayılanı
`wrangler.jsonc` içinde `https://api.kamuilan.halilkaraduman.com.tr`; farklıysa
`npx wrangler secret put API_ORIGIN`. PR dallarında derleme 0 sn'de düşüyorsa: Settings → Build →
Branch control → non-production branch builds kapalı.

## Bakım

- Güncelleme: `sudo kamuilan-guncelle` (git pull + npm ci + yeniden başlatma).
- Loglar: `journalctl -u kamuilan-worker -f` · `/var/log/kamuilan/*.log`
- Durum: `sudo -u kamuilan sh -c 'cd /opt/kamuilan/app; set -a; . /etc/kamuilan/kamuilan.env; set +a; npm run durum -- --log /var/log/kamuilan/api.log --log /var/log/kamuilan/worker.log'`
- Güvenlik güncellemeleri `unattended-upgrades` ile kendiliğinden kurulur.
