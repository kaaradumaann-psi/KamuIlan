/**
 * Conservative, shared pagination discovery for official HTML listing pages.
 *
 * A missing "next" link alone is not proof that a source is exhaustive. The
 * caller may mark coverage complete only when `endConfirmed` is true (for
 * example, an explicit disabled next control or a self-referential rel="last" link).
 */
import { normalizeTr } from '../domain/text';
import { normalizeUrl, sameSite } from '../domain/urls';
import { loadHtml } from '../lib/html';

export interface PageNavigation {
  nextUrl: string | null;
  detected: boolean;
  endConfirmed: boolean;
}

const PAGER_SELECTOR =
  '.pagination, .pager, .page-numbers, .sayfalama, [class*="pagination"], [class*="pager"]';
const PAGE_QUERY_KEYS = /^(?:page|p|sayfa|currentpage|pageindex|sayfano)$/i;

function pageNumber(url: URL): number | null {
  for (const [key, value] of url.searchParams.entries()) {
    if (PAGE_QUERY_KEYS.test(key) && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  const match = /\/(?:page|sayfa)\/(\d+)\/?$/i.exec(url.pathname);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function pageValueFromLabel(value: string): number | null {
  const text = normalizeTr(value);
  const match = /^\d+$/.exec(text);
  if (!match?.[0]) return null;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function detectNextPage(html: string, currentUrl: string): PageNavigation {
  const $ = loadHtml(html);
  const pager = $(PAGER_SELECTOR);
  const hasPager = pager.length > 0;
  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return { nextUrl: null, detected: hasPager, endConfirmed: false };
  }
  const currentPage = pageNumber(current) ?? 1;
  let detected = hasPager || pageNumber(current) !== null;
  let endConfirmed = false;
  const candidates: { url: string; explicit: boolean; page: number | null }[] = [];

  $('a[href]').each((_index, element) => {
    const node = $(element);
    const href = normalizeUrl(node.attr('href') ?? '', currentUrl);
    if (!href) return;
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      return;
    }
    if (
      !sameSite(target.toString(), current.toString()) ||
      target.protocol !== current.protocol ||
      target.port !== current.port
    )
      return;

    const label = normalizeTr(
      `${node.text()} ${node.attr('aria-label') ?? ''} ${node.attr('title') ?? ''} ${node.attr('class') ?? ''} ${node.attr('rel') ?? ''}`,
    );
    const rel = (node.attr('rel') ?? '').toLowerCase().split(/\s+/);
    const explicit = rel.includes('next') || /\b(?:next|sonraki|ileri)\b/.test(label);
    const inPager = node.closest(PAGER_SELECTOR).length > 0;
    const page = pageNumber(target) ?? pageValueFromLabel(node.text());
    if (inPager || page !== null || explicit) detected = true;

    const disabled =
      node.attr('disabled') !== undefined ||
      node.attr('aria-disabled') === 'true' ||
      node.hasClass('disabled') ||
      node.closest('.disabled, [aria-disabled="true"]').length > 0;
    if (rel.includes('last') && href === (normalizeUrl(currentUrl) ?? currentUrl)) endConfirmed = true;
    if (explicit && disabled) endConfirmed = true;
    if (!disabled && (explicit || (inPager && page !== null && page === currentPage + 1))) {
      if (href !== (normalizeUrl(currentUrl) ?? currentUrl))
        candidates.push({ url: target.toString(), explicit, page });
    }
  });

  // Many portals render a disabled "next" button on the final page rather than
  // omitting the control. Treat only a visibly disabled next control as proof.
  pager.find('a, button, li, span').each((_index, element) => {
    const node = $(element);
    const label = normalizeTr(
      `${node.text()} ${node.attr('aria-label') ?? ''} ${node.attr('title') ?? ''} ${node.attr('class') ?? ''} ${node.attr('rel') ?? ''}`,
    );
    if (!/\b(?:next|sonraki|ileri)\b/.test(label)) return;
    const disabled =
      node.is(':disabled') ||
      node.attr('disabled') !== undefined ||
      node.attr('aria-disabled') === 'true' ||
      node.hasClass('disabled') ||
      node.closest('.disabled, [aria-disabled="true"]').length > 0;
    if (disabled) endConfirmed = true;
  });

  // A visible numeric range can be truncated; only an explicit disabled-next or
  // self-referential rel="last" control confirms the final page.
  candidates.sort(
    (a, b) =>
      Number(b.explicit) - Number(a.explicit) ||
      (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER),
  );
  const nextUrl = candidates[0]?.url ?? null;
  // A visible next link takes precedence over a generic active-page marker.
  if (nextUrl) endConfirmed = false;

  return { nextUrl, detected, endConfirmed };
}
