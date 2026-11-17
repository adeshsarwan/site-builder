// Google Ads setup guide for a games site's ad_shown conversion. Returned by GET/PUT /games/sites/:id/google-ads so the
// frontend can show the person exactly what to click in GA4 and Google Ads for this site (property, account, names,
// settings), with the steps the API can verify (GA4 ↔ Google Ads link, key event) already marked done.
import type { Env } from '../types';
import * as google from '../services/google';
import * as ga4 from './analytics';

const ADM = 'https://analyticsadmin.googleapis.com/v1beta';

export type StepStatus = 'done' | 'todo' | 'unknown';
export interface SetupStep { step: number; id: string; title: string; status: StepStatus; where: string; actions: string[]; note?: string }
export interface AdsLinkStatus { status: 'linked' | 'not_linked' | 'unknown'; link?: string; error?: string }

const digits = (cid: string) => cid.replace(/\D/g, '');

/** Is the GA4 property linked to this Google Ads customer? (GA4 Admin API, read-only.) */
export async function adsLinkStatus(env: Env, propertyIn: string | undefined, customerId: string): Promise<AdsLinkStatus> {
  if (!propertyIn || !ga4.gaConfigured(env)) return { status: 'unknown', error: !propertyIn ? 'site has no GA4 property' : 'GA4 API not configured' };
  try {
    const token = await ga4.gaToken(env);
    const r = await google.g<any>(token, `${ADM}/${ga4.normProperty(propertyIn)}/googleAdsLinks?pageSize=200`);
    const hit = (r.googleAdsLinks ?? []).find((l: any) => digits(String(l.customerId ?? '')) === digits(customerId));
    return hit ? { status: 'linked', link: hit.name } : { status: 'not_linked' };
  } catch (e: any) { return { status: 'unknown', error: e.message }; }
}

export function setupGuide(env: Env, site: any, customerId: string, opts: { sendTo?: string; link: AdsLinkStatus; keyEventDone: boolean | null }): { summary: string; steps: SetupStep[] } {
  const a = site.analytics ?? {};
  const propertyId = String(a.ga4Property ?? '').replace(/^properties\//, '') || '(run /analytics/setup)';
  const propName = site.name || site.domain || site.key;
  const domain = site.domain || '(no domain yet)';
  const finalUrl = site.domain ? `https://${site.domain}/` : '(site domain)';
  const convName = `${propName} (web) ad_shown`;
  const gaAdmin = env.GA4_ACCOUNT_ID && /^\d+$/.test(propertyId) ? `https://analytics.google.com/analytics/web/#/a${env.GA4_ACCOUNT_ID}p${propertyId}/admin/integrations/google-ads` : 'GA4 → Admin → Product links → Google Ads links';
  const steps: SetupStep[] = [];
  let n = 0;

  steps.push({
    step: ++n, id: 'ga4_key_event', title: 'Mark ad_shown as a GA4 key event', where: `GA4 property ${propName} (${propertyId})`,
    status: opts.keyEventDone === true ? 'done' : opts.keyEventDone === false ? 'todo' : 'unknown',
    actions: ['Done by the API when Google Ads is turned on. If it failed: GA4 → Admin → Data display → Events → ad_shown → Mark as key event.'],
  });

  if (!opts.sendTo) {
    const linked = opts.link.status === 'linked';
    steps.push({
      step: ++n, id: 'ga4_ads_link', title: `Link GA4 property ${propertyId} to Google Ads ${customerId}`, where: gaAdmin,
      status: linked ? 'done' : opts.link.status === 'not_linked' ? 'todo' : 'unknown',
      note: linked ? undefined : opts.link.error ? `Could not check the link: ${opts.link.error}` : 'Without this link Google Ads cannot import ad_shown.',
      actions: linked ? ['Already linked.'] : [
        `In GA4 (${propName}) open Admin → Product links → Google Ads links → Link.`,
        `If ${customerId} is listed under "Choose Google Ads accounts" (your GA login also has access to the Ads account): select it → Next.`,
        `Otherwise choose "Request access to other Google Ads accounts" → Send request → enter ${customerId} → Confirm → Next.`,
        'Configure settings: Personalised advertising On; Enable Auto-Tagging → "Enable auto-tagging"; Allow access to Analytics features from within Google Ads On → Next → Submit.',
        `If you sent a request: sign in to Google Ads ${customerId} with an admin login → Tools → Data manager → Google Analytics (GA4) → Received → ${propName} (${propertyId}) → Review → turn on "Import app and web metrics" → Save changes.`,
        'Check: GA4 → Google Ads links shows it under Completed, and Google Ads → Data manager → Google Analytics (GA4) shows "1 linked".',
        `To skip the approval step for future sites: in Google Ads ${customerId} → Admin → Access and security, add the GA4 login as Admin.`,
      ],
    });
    steps.push({
      step: ++n, id: 'ads_import_conversion', title: `Import ad_shown from ${propName} as a conversion`, where: `Google Ads ${customerId} → Goals → Conversions`,
      status: 'unknown',
      note: 'ad_shown can show "Inactive" or not be listed until GA4 has received the event (the site sends it on page load); try again a few hours after the site rebuild.',
      actions: [
        'Goals → Conversions → New conversion → tick "Conversions on a website".',
        `Edit data sources → Web page URL ${finalUrl} (use the address Google recommends) → untick "Google tag" → tick the GA4 property ${propName} (${propertyId}, "Linked to this account") → Done. Untick phone calls / app / offline.`,
        'Save and continue → Select events from ' + propName + ' → tick only ad_shown → Conversion category: Page view → Select events.',
        `Edit settings on "${convName}" (next step), then Save and continue → Finish. Ignore "See event snippet": the site already sends the event.`,
      ],
    });
  } else {
    steps.push({
      step: ++n, id: 'ads_tag_conversion', title: `Use the Google Ads conversion action ${opts.sendTo}`, where: `Google Ads ${customerId} → Goals → Conversions`,
      status: 'unknown',
      actions: [`The site sends ad_shown straight to ${opts.sendTo} once per session; no GA4 import is needed.`, 'Do not also import ad_shown from GA4 as a Primary action, or each view counts twice.'],
    });
  }

  steps.push({
    step: ++n, id: 'conversion_settings', title: `Settings for "${opts.sendTo ? opts.sendTo : convName}"`, where: 'Conversion action → Edit settings',
    status: 'unknown',
    actions: [
      'Action optimization: Primary action used for bidding optimization.',
      'Value: "Don\'t use a value" for Target CPA, or "Use the same value for each conversion" = average ad revenue per session (in the account currency) to use Target ROAS later.',
      'Count: Every conversion (the site already sends at most one per session).',
      'Click-through conversion window: Custom → 1 day. Engaged-view conversion window: Custom → 1 day.',
      'Attribution: Data-driven.',
    ],
  });
  steps.push({
    step: ++n, id: 'clean_conversions', title: 'Keep ad_shown the only Primary Page view action', where: `Google Ads ${customerId} → Goals → Conversions → All conversions`,
    status: 'unknown',
    actions: [
      `Under "Page views", remove (or set to Secondary) every Primary action other than "${convName}", e.g. old Google-tag ad_shown actions or another site's tag.`,
      'Actions with a lock icon belong to a manager account: change them there, or rely on the campaign goal below.',
      'Optional: Tools → Data manager → Google tag → ⋮ → Unlink any tag for a site that is not yours.',
    ],
  });
  steps.push({
    step: ++n, id: 'campaign_goal', title: `Point every ${propName} campaign at ad_shown only`, where: 'Campaign → Settings → Conversion goals',
    status: 'unknown',
    actions: [
      'Conversion goals: change "Account-default" to "Campaign-specific" → Choose campaign goals → tick only "Page views (Website)" → Save → Save.',
      `Check Goals → Conversions → Summary → Page views lists only "${convName}" as active. If it lists others, use a custom goal instead: Conversion goals → Use a custom goal → Create new → name "${propName} ad_shown" → only "${convName}" → Save.`,
      'Bidding: Maximize conversions to start; switch to Target CPA after 15–30 conversions.',
      `Final URL of every ad: ${finalUrl} (the exact address, so there is no redirect and the click ID (gclid) is kept).`,
    ],
  });
  steps.push({
    step: ++n, id: 'verify', title: 'Verify', where: 'GA4 Realtime and Google Ads → Conversions',
    status: 'unknown',
    actions: [
      `Open ${finalUrl} in a private window → GA4 → Reports → Realtime → Event count by Event name shows ad_shown within a minute.`,
      `Google Ads: "${opts.sendTo ? opts.sendTo : convName}" moves from Inactive to "Recording conversions" within about 24 hours of the first ad click.`,
    ],
  });

  const todo = steps.filter((s) => s.status !== 'done').length;
  const summary = opts.sendTo
    ? `${domain}: ad_shown is sent to GA4 and to ${opts.sendTo}. ${todo} step(s) to check in Google Ads ${customerId}.`
    : `${domain}: ad_shown is sent to GA4 property ${propertyId}. GA4 ↔ Google Ads ${customerId}: ${opts.link.status.replace('_', ' ')}. ${todo} step(s) left.`;
  return { summary, steps };
}
