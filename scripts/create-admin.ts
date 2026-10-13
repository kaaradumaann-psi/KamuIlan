/**
 * İlk yönetici hesabı: `npm run seed:admin`
 *
 * Neden ayrı bir komut: yönetim paneli (kaynak CRUD, inceleme kuyruğu, e-posta
 * kuyruğu) RBAC ile korunur; ilk yönetici hiçbir zaman arayüzden oluşturulamaz.
 * Bu betik yalnızca ortam değişkenlerindeki kimlik bilgileriyle çalışır
 * (ADMIN_EMAIL / ADMIN_PASSWORD) ve şifreyi asla ekrana yazmaz/loglamaz.
 *
 * Davranış:
 *  - Kullanıcı yoksa oluşturur (e-posta doğrulanmış, rol: admin).
 *  - Kullanıcı varsa rolü admin yapar ve e-postayı doğrulanmış işaretler;
 *    şifreyi DEĞİŞTİRMEZ (beklenmeyen şifre sıfırlaması olmasın).
 *  - Parola gücü kurallarına uymayan değer kabul edilmez.
 */
import { initStore, closeStore, describeDriver } from '../src/db/store';
import { createRepos } from '../src/db/repos';
import { getEnv, inspectEnvironment } from '../src/config/env';
import { hashPassword, validatePasswordStrength } from '../src/server/passwords';
import { maskEmail } from '../src/domain/text';
import { createLogger } from '../src/lib/logger';

const log = createLogger('seed-admin');

async function main(): Promise<void> {
  const env = getEnv();
  const inspection = inspectEnvironment(env);

  const email = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      'ADMIN_EMAIL ve ADMIN_PASSWORD tanımlanmalı. Örnek:\n' +
        '  ADMIN_EMAIL=yonetici@example.com ADMIN_PASSWORD="uzun-rastgele-bir-parola" npm run seed:admin',
    );
    process.exitCode = 1;
    return;
  }

  const strength = validatePasswordStrength(password, { email });
  if (!strength.valid) {
    console.error(`ADMIN_PASSWORD zayıf: ${strength.problems.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  for (const warning of inspection.warnings) log.warn({ warning }, 'yapılandırma uyarısı');

  const store = await initStore();
  const repos = createRepos(store);

  try {
    const existing = await repos.users.findByEmail(email);
    if (existing) {
      await repos.users.update(existing.id, { role: 'admin' });
      if (!existing.emailVerified) await repos.users.markEmailVerified(existing.id);
      console.log(
        `• Yönetici yetkisi güncellendi: ${maskEmail(existing.email)} ` +
          `(depo: ${describeDriver(store.driver)}; şifre değiştirilmedi)`,
      );
      console.log(
        '  Şifreyi de belirlemek/ değiştirmek için:\n' +
          `    npm run user:create -- --email ${existing.email} --password "Güçlü-Parola1" --force`,
      );
      return;
    }

    const hashed = await hashPassword(password);
    const { user } = await repos.users.create({
      email,
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt,
      displayName: env.APP_DISPLAY_NAME ?? 'Yönetici',
      role: 'admin',
      emailVerified: true,
    });

    console.log(`• Yönetici oluşturuldu: ${maskEmail(user.email)} (depo: ${describeDriver(store.driver)})`);
    console.log('  Giriş: /giris → /yonetim');
  } finally {
    await closeStore();
  }
}

main().catch(async (error: unknown) => {
  console.error('Yönetici oluşturulamadı:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await closeStore().catch(() => undefined);
});
