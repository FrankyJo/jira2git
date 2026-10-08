import { createHash } from 'node:crypto';
import { InvalidSiteUrlError } from './errors';
import type { JiraSite } from './types';

/** Normalizes a site URL to its HTTPS origin and derives a stable id. */
export function jiraSiteFromUrl(raw: string): JiraSite {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidSiteUrlError(raw);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new InvalidSiteUrlError(raw);
  const origin = url.origin.toLowerCase();
  return { url: origin, id: createHash('sha256').update(origin).digest('hex').slice(0, 16) };
}
