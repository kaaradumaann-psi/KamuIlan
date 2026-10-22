/**
 * Tarama kimliği (K2, 22.10.2026): kendini gizlemez, tarayıcı taklidi yapmaz, "bot" kelimesi yok.
 * Kanıt: Resmî Gazete "KamuIlanBot" kimliğini 25 sn askıda bıraktı; "KamuIlan" 0,16 sn'de 200 aldı.
 */
import { describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';

describe('varsayılan SCRAPE_USER_AGENT', () => {
  const ua = getEnv({ NODE_ENV: 'test', SCRAPE_USER_AGENT: undefined }).SCRAPE_USER_AGENT;

  it('uygulama adı ve iletişim adresi açık', () => {
    expect(ua).toMatch(/KamuIlan\/\d/);
    expect(ua).toContain('+https://kamuilan.halilkaraduman.com.tr');
  });

  it('"bot" kelimesi yok ve gerçek bir tarayıcıyı taklit etmiyor', () => {
    expect(ua.toLowerCase()).not.toContain('bot');
    expect(ua).not.toMatch(/Chrome\/|Safari\/|Firefox\/|Edg\/|AppleWebKit/);
  });
});
