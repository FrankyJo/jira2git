import { MultipleSitesError } from '../checkpoints/errors';
import { jiraSiteFromUrl } from '../checkpoints/site';
import type { JiraSite } from '../checkpoints/types';
import { UsageError } from '../core/errors';

/**
 * Lineages (checkpoint history) are kept per Jira site. Manual mode needs no site, so
 * without one, reports are tracked under this placeholder (`.invalid` can never be a
 * real host). Configure `jira.site` to share one history across manual, MCP, and
 * API-token modes.
 */
export const PLACEHOLDER_SITE_URL = 'https://jira-site-not-configured.invalid';

export type SiteSource = 'option' | 'repository' | 'global' | 'history' | 'placeholder';

export interface ResolvedSite {
  site: JiraSite;
  placeholder: boolean;
  source: SiteSource;
}

/** `--site`, repository `jira.site`, global `jira.site`, the only site with history, placeholder. */
export function resolveDeliverySite(input: {
  mode: 'manual' | 'mcp';
  option?: string | undefined;
  repositorySite?: string | undefined;
  globalSite?: string | undefined;
  historySites: readonly JiraSite[];
}): ResolvedSite {
  const placeholder = jiraSiteFromUrl(PLACEHOLDER_SITE_URL);
  const explicit: [string | undefined, SiteSource][] = [
    [input.option, 'option'],
    [input.repositorySite, 'repository'],
    [input.globalSite, 'global'],
  ];
  for (const [url, source] of explicit) {
    if (url !== undefined) {
      const site = jiraSiteFromUrl(url);
      if (site.id === placeholder.id) throw new UsageError(`${url} is not a Jira site.`);
      return { site, placeholder: false, source };
    }
  }
  if (input.historySites.length > 1)
    throw new MultipleSitesError(input.historySites.map((s) => s.url));
  const [history] = input.historySites;
  if (history) {
    const isPlaceholder = history.id === placeholder.id;
    if (input.mode === 'mcp' && isPlaceholder) throw siteRequired();
    return { site: history, placeholder: isPlaceholder, source: 'history' };
  }
  if (input.mode === 'mcp') throw siteRequired();
  return { site: placeholder, placeholder: true, source: 'placeholder' };
}

function siteRequired(): UsageError {
  return new UsageError(
    'MCP mode needs the Jira site: pass --site with the URL from getAccessibleAtlassianResources, ' +
      'or set it with "git2jira config set jira.site <url>".',
  );
}
