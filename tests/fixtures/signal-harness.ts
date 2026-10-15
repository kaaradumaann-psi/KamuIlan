/**
 * Sinyal kapanış kabuğu (test için).
 *
 * `process.on('SIGINT', …)` dinleyicisine Node'un SİNYAL ADINI geçirdiği
 * senaryoyu birebir kurar: değer doğrudan `process.exit`'e verilirse
 * `ERR_INVALID_ARG_TYPE` oluşur. Burada `signalExitCode` ile sayıya indirgenir.
 */
import { signalExitCode } from '../../scripts/lib/exit-codes';

process.on('SIGINT', (signal) => {
  process.exit(signalExitCode(signal));
});
process.on('SIGTERM', (signal) => {
  process.exit(signalExitCode(signal));
});

// Süreci ayakta tut; test dışarıdan sinyal gönderir.
setTimeout(() => process.exit(0), 20_000);
process.stdout.write('hazir\n');
