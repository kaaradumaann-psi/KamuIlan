/**
 * Panel yapay zekâ önerileri uçları (yalnızca oturum sahibi).
 *
 * Koşullar (sırayla denetlenir):
 *  1. Operatör AI_ASSISTANT_ENABLED=1 yapmış olmalı (aksi halde 503).
 *  2. Kullanıcı AÇIK RIZA vermiş olmalı (aiConsentAt). Rıza yoksa 403.
 *  3. Profil en az bir alanla dolu olmalı. Boşsa 409.
 *
 * Denetim: her öneri isteği denetim kaydına yazılır (kullanıcı, mod, aday sayısı);
 * profil içeriği ve ilan metinleri denetime YAZILMAZ.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv, type Env } from '../../config/env';
import type { Repos } from '../../db/repos';
import { hasProfileSignal } from '../../ai/candidates';
import { clearSuggestionCache, generateSuggestions } from '../../ai/suggest';
import type { LlmConfig } from '../../ai/llm';
import { createLlmBudgetFromEnv } from '../../ai/budget';
import { audit, requireUser } from '../context';
import { ApiError } from '../errors';

const EMPTY_PROFILE = {
  profession: '',
  educationLevel: null,
  departments: [],
  skills: [],
  experienceYears: null,
} as const;

function llmConfigFrom(env: Env): LlmConfig | null {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) return null;
  return {
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
  };
}

function requireEnabled(env: Env): void {
  if (!env.AI_ASSISTANT_ENABLED) {
    throw ApiError.unavailable('Yapay zekâ destekli öneriler bu kurulumda etkin değil.');
  }
}

export function registerAiRoutes(app: FastifyInstance, repos: Repos): void {
  app.get(
    '/api/ai/status',
    { schema: { tags: ['ai'], summary: 'Yapay zekâ önerisi durumum (rıza, profil, kota)' } },
    async (request) => {
      const user = requireUser(request);
      const env = getEnv();
      const preference = await repos.notifications.getPreference(user.id);
      const profile = preference?.candidateProfile ?? { ...EMPTY_PROFILE, departments: [], skills: [] };
      const used = await repos.rateLimits.peek(`ai-daily:${user.id}`, 24 * 3_600);
      return {
        enabled: env.AI_ASSISTANT_ENABLED,
        providerLabel: env.AI_PROVIDER_LABEL,
        consent: {
          given: Boolean(preference?.aiConsentAt),
          at: preference?.aiConsentAt ?? null,
        },
        profileReady: hasProfileSignal(profile),
        dailyLimit: env.AI_DAILY_LIMIT_PER_USER,
        remainingToday: Math.max(0, env.AI_DAILY_LIMIT_PER_USER - used),
      };
    },
  );

  app.put(
    '/api/ai/consent',
    { schema: { tags: ['ai'], summary: 'Yapay zekâ önerileri için açık rızamı ver / geri çek' } },
    async (request) => {
      const user = requireUser(request);
      const env = getEnv();
      requireEnabled(env);
      const body = z
        .object({ granted: z.boolean() })
        .strict()
        .parse(request.body ?? {});
      const now = repos.clock.now().toISOString();
      const preference = await repos.notifications.upsertPreference(user.id, {
        aiConsentAt: body.granted ? now : null,
      });
      if (!body.granted) clearSuggestionCache(user.id);
      await audit(repos.audit, request, {
        action: body.granted ? 'ai.consent-granted' : 'ai.consent-withdrawn',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
      });
      return {
        consent: { given: Boolean(preference.aiConsentAt), at: preference.aiConsentAt },
        message: body.granted
          ? 'Rızanız kaydedildi. Artık profilinize uygun ilan önerileri alabilirsiniz.'
          : 'Rızanız geri çekildi. Profiliniz artık yapay zekâ hizmetine gönderilmez.',
      };
    },
  );

  app.post(
    '/api/ai/suggestions',
    { schema: { tags: ['ai'], summary: 'Profilime uygun ilan önerileri' } },
    async (request) => {
      const user = requireUser(request);
      const env = getEnv();
      requireEnabled(env);
      const preference = await repos.notifications.getPreference(user.id);
      if (!preference?.aiConsentAt) {
        throw ApiError.forbidden('Yapay zekâ önerileri için önce açık rıza vermeniz gerekir.');
      }
      if (!hasProfileSignal(preference.candidateProfile)) {
        throw ApiError.conflict(
          'Önce profilinizi doldurun: meslek/unvan, eğitim düzeyi veya beceri ekleyin.',
        );
      }

      const outcome = await generateSuggestions({
        repos,
        userId: user.id,
        preference,
        now: repos.clock.now(),
        llm: llmConfigFrom(env),
        dailyLimit: env.AI_DAILY_LIMIT_PER_USER,
        budget: createLlmBudgetFromEnv(repos, env, {
          maxCallsPerRun: 1,
          additionalDailyCallBucket: 'llm-assistant-daily',
        }),
      });

      await audit(repos.audit, request, {
        action: 'ai.suggestions',
        targetType: 'user',
        targetId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
        // Denetim: yalnızca sayılar ve kip. Profil ve ilan içeriği yazılmaz.
        meta: {
          mode: outcome.result.mode,
          candidateCount: outcome.result.candidateCount,
          suggestionCount: outcome.result.suggestions.length,
          cached: outcome.result.cached,
          modelCalled: outcome.modelCalled,
        },
      });

      return {
        ...outcome.result,
        providerLabel: env.AI_PROVIDER_LABEL,
        remainingToday: outcome.remainingToday,
        dailyLimit: env.AI_DAILY_LIMIT_PER_USER,
      };
    },
  );
}
