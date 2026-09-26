/**
 * Can this site be added? The check behind "Add a status page".
 *
 * Two steps, split around the one network request:
 *
 * 1. `normalizeCandidate` turns whatever was typed into the status page's
 *    origin, or says why it can't. No network.
 * 2. `judgeCandidate` looks at what the page's Statuspage API answered and
 *    either produces the service to add, or says specifically why not.
 *
 * "Supported" means one thing: `/api/v2/summary.json` answers with a summary
 * the adapter actually parses. Anything less is refused with a reason, because
 * a service added on hope would sit in the panel as `unknown` forever and teach
 * you to ignore the row.
 */

import { parseStatuspageSummary, readPageName } from './adapters/statuspage.ts';
import type { FetchOutcome, ServiceConfig } from './services.ts';
import { LEVEL_LABELS, type Level } from './status.ts';

export type Normalized = { ok: true; origin: string } | { ok: false; error: string };

/**
 * The origin of the status page someone typed or pasted.
 *
 * Forgiving about how it was written (no scheme, a trailing path, a link to one
 * incident), strict about what it is: a public web host. Plain `http://` is
 * upgraded, because a status page served without TLS is one a network can
 * rewrite, and every Statuspage page answers on https.
 */
export function normalizeCandidate(input: string): Normalized {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'Enter the address of a status page.' };

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `“${text}” isn’t a web address.` };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only web addresses (https://…) can be watched.' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'Leave the username and password out of the address.' };
  }
  const host = url.hostname.toLowerCase();
  // A status page is on the public internet. A bare name or `localhost` is a
  // typo or a machine on this network, and either way not a vendor.
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, error: `“${host}” isn’t a public web address.` };
  }

  const port = url.port === '' || url.port === '443' ? '' : `:${url.port}`;
  return { ok: true, origin: `https://${host}${port}` };
}

/** The check's answer: the service to add, or why it can't be. */
export type Verdict =
  | {
      readonly ok: true;
      readonly service: ServiceConfig;
      /** What the page says right now, e.g. "operational" or "degraded". */
      readonly level: Level;
      readonly componentCount: number;
    }
  | { readonly ok: false; readonly error: string };

/** Already watching this origin? Compared by origin, so a trailing slash or path doesn't matter. */
export function findExisting(
  origin: string,
  services: readonly ServiceConfig[],
): ServiceConfig | undefined {
  return services.find((service) => originOf(service.pageUrl) === origin);
}

/** The judgement on one fetch of `origin`'s Statuspage API. */
export function judgeCandidate(
  origin: string,
  outcome: FetchOutcome,
  existing: readonly ServiceConfig[],
): Verdict {
  const host = new URL(origin).host;

  if (outcome.kind === 'error') {
    return {
      ok: false,
      error: `Couldn’t reach ${host}. Check the address, or try again if you’re offline. (${outcome.message})`,
    };
  }

  // Where the request actually ended up: `status.github.com` redirects to
  // `www.githubstatus.com`, and the page is the one that answered.
  const resolved = resolvedOrigin(outcome.url) ?? origin;

  if (outcome.status === 404 || outcome.status === 410) {
    return { ok: false, error: unsupported(host) };
  }
  if (outcome.status !== 200) {
    return {
      ok: false,
      error: `${host} answered ${String(outcome.status)}. Try again in a minute, or check the address.`,
    };
  }

  const parsed = parseStatuspageSummary(outcome.body);
  if (!parsed.ok) return { ok: false, error: unsupported(host) };

  const already = findExisting(resolved, existing);
  if (already !== undefined) {
    return { ok: false, error: `You’re already watching this page, as “${already.name}”.` };
  }

  const resolvedHost = new URL(resolved).host;
  const name = readPageName(outcome.body) ?? resolvedHost;
  return {
    ok: true,
    service: { id: resolvedHost, name, kind: 'statuspage', pageUrl: resolved },
    level: parsed.snapshot.level,
    componentCount: parsed.snapshot.components.length,
  };
}

/** One line saying what was found, for the moment it is added. */
export function describeFound(verdict: Extract<Verdict, { ok: true }>): string {
  const components = `${String(verdict.componentCount)} component${verdict.componentCount === 1 ? '' : 's'}`;
  return `Added ${verdict.service.name}: ${components}, currently ${LEVEL_LABELS[verdict.level]}.`;
}

function unsupported(host: string): string {
  return `${host} isn’t a supported status page. Only Atlassian Statuspage pages (the kind GitHub and Cursor use) can be watched so far.`;
}

/** The origin of the URL a fetch landed on, if it is a web URL. */
function resolvedOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function originOf(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return null;
  }
}
