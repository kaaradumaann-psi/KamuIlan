/**
 * Telegram webhook yönetimi.
 *
 *   npm run telegram:webhook -- info     → bot kimliği ve webhook durumu
 *   npm run telegram:webhook -- set      → webhook'u APP_BASE_URL/api/telegram/webhook adresine kurar
 *   npm run telegram:webhook -- delete   → webhook'u kaldırır
 *
 * Gizli değer yazdırılmaz (token ve sır maskelenir). Webhook yalnızca https adresine
 * kurulabilir; `set` çalışmadan önce TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME,
 * TELEGRAM_WEBHOOK_SECRET ve APP_BASE_URL (https) tanımlı olmalıdır.
 */
import { getEnv } from '../src/config/env';
import { telegramConfig, TELEGRAM_ALLOWED_UPDATES } from '../src/telegram/config';
import { TelegramBotClient } from '../src/telegram/client';
import { TELEGRAM_WEBHOOK_PATH } from '../src/server/routes/telegram';

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'info';
  const env = getEnv();
  const config = telegramConfig(env);
  if (!config) fail('Telegram kapalı: TELEGRAM_BOT_TOKEN ve geçerli TELEGRAM_BOT_USERNAME gerekli.');
  const client = new TelegramBotClient({ token: config.token, apiBaseUrl: config.apiBaseUrl });

  if (command === 'info') {
    const me = await client.getMe();
    if (!me.ok) fail(`getMe başarısız: ${me.description}`);
    console.log(`Bot: @${me.result.username ?? '?'} (id ${me.result.id})`);
    const info = await client.getWebhookInfo();
    if (!info.ok) fail(`getWebhookInfo başarısız: ${info.description}`);
    console.log(`Webhook: ${info.result.url || '(kurulu değil)'}`);
    console.log(`Bekleyen güncelleme: ${info.result.pending_update_count}`);
    if (info.result.last_error_message) console.log(`Son hata: ${info.result.last_error_message}`);
    return;
  }

  if (command === 'set') {
    if (!config.webhookSecret) fail('TELEGRAM_WEBHOOK_SECRET tanımlı değil veya geçersiz (A-Z a-z 0-9 _ -).');
    const url = `${env.APP_BASE_URL.replace(/\/+$/, '')}${TELEGRAM_WEBHOOK_PATH}`;
    if (!url.startsWith('https://')) fail('Webhook yalnızca https adresine kurulabilir (APP_BASE_URL).');
    const result = await client.setWebhook({
      url,
      secretToken: config.webhookSecret,
      allowedUpdates: [...TELEGRAM_ALLOWED_UPDATES],
      dropPendingUpdates: false,
    });
    if (!result.ok) fail(`setWebhook başarısız: ${result.description}`);
    console.log(`✔ Webhook kuruldu: ${url}`);
    return;
  }

  if (command === 'delete') {
    const result = await client.deleteWebhook();
    if (!result.ok) fail(`deleteWebhook başarısız: ${result.description}`);
    console.log('✔ Webhook kaldırıldı.');
    return;
  }

  fail(`Bilinmeyen komut: ${command}. Kullanım: info | set | delete`);
}

main().catch((error: unknown) => {
  // Hata metninde token görünmesin diye yalnızca mesaj yazılır.
  fail(error instanceof Error ? error.message : String(error));
});
