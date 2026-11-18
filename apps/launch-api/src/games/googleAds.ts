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
  const rwName = `${propName} (web) rewarded_watched`;
  const bestUrl = site.domain ? `https://${site.domain}/best/` : '(site domain)/best/';
  const gaAdmin = env.GA4_ACCOUNT_ID && /^\d+$/.test(propertyId) ? `https://analytics.google.com/analytics/web/#/a${env.GA4_ACCOUNT_ID}p${propertyId}/admin/integrations/google-ads` : 'GA4 → Admin → Product links → Google Ads links';
  const steps: SetupStep[] = [];
  let n = 0;

  steps.push({
    step: ++n, id: 'ga4_key_event', title: 'Mark ad_shown and rewarded_watched as GA4 key events', where: `GA4 property ${propName} (${propertyId})`,
    status: opts.keyEventDone === true ? 'done' : opts.keyEventDone === false ? 'todo' : 'unknown',
    actions: ['Done by the API when Google Ads is turned on. If it failed: GA4 → Admin → Data display → Events → ad_shown and rewarded_watched → Mark as key event.'],
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
      step: ++n, id: 'ads_import_conversion', title: `Import ad_shown and rewarded_watched from ${propName} as conversions`, where: `Google Ads ${customerId} → Goals → Conversions`,
      status: 'unknown',
      note: 'An event can show "Inactive" or not be listed until GA4 has received it: ad_shown fires on page load, rewarded_watched when someone watches a rewarded video (game finder on /best/ or the Play gate). Import what is listed and come back for the other.',
      actions: [
        'Goals → Conversions → New conversion → tick "Conversions on a website".',
        `Edit data sources → Web page URL ${finalUrl} (use the address Google recommends) → untick "Google tag" → tick the GA4 property ${propName} (${propertyId}, "Linked to this account") → Done. Untick phone calls / app / offline.`,
        'Save and continue → Select events from ' + propName + ' → tick ad_shown (Conversion category: Page view) and rewarded_watched (Conversion category: Engagement) → Select events.',
        `Edit settings on "${convName}" and "${rwName}" (next step), then Save and continue → Finish. Ignore "See event snippet": the site already sends the events.`,
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
    step: ++n, id: 'conversion_settings', title: opts.sendTo ? `Settings for "${opts.sendTo}"` : `Settings for "${rwName}" and "${convName}"`, where: 'Conversion action → Edit settings',
    status: 'unknown',
    actions: [
      ...(opts.sendTo ? [] : [`"${rwName}" (Engagement): Primary; Count: Every conversion (one per watched video); Value: "Use the same value for each conversion" = rewarded revenue per watched video (rewarded eCPM ÷ 1000, account currency), or "Don't use a value" for Target CPA.`]),
      `"${opts.sendTo ? opts.sendTo : convName}" (Page view): Primary; Count: Every conversion (the site sends at most one per session); Value: average ad revenue per session, or none.`,
      'Both: Click-through conversion window Custom → 1 day; Engaged-view conversion window Custom → 1 day; Attribution: Data-driven.',
      'Both stay Primary: each campaign picks its own goal (next steps), so never leave a campaign on "Account-default".',
    ],
  });
  steps.push({
    step: ++n, id: 'clean_conversions', title: 'One Primary action per goal: Page views = ad_shown, Engagement = rewarded_watched', where: `Google Ads ${customerId} → Goals → Conversions → All conversions`,
    status: 'unknown',
    actions: [
      `Under "Page views", remove (or set to Secondary) every Primary action other than "${convName}", e.g. old Google-tag ad_shown actions or another site's tag. Under "Engagement", the same for everything other than "${rwName}".`,
      'Actions with a lock icon belong to a manager account: change them there, or rely on the campaign goal below.',
      'Optional: Tools → Data manager → Google tag → ⋮ → Unlink any tag for a site that is not yours.',
    ],
  });
  steps.push({
    step: ++n, id: 'campaign_goal', title: `Give each ${propName} campaign one goal`, where: 'Campaign → Settings → Conversion goals',
    status: 'unknown',
    actions: [
      ...(opts.sendTo ? [] : [`Campaigns optimising on rewarded watches (landing page ${bestUrl}, the game finder): Conversion goals → "Campaign-specific" → Choose campaign goals → tick only "Engagement (Website)" → Save. Bidding: Maximize conversions to start, then Target CPA (or Target ROAS with a value) after 15–30 watches. Budget: enough for 15–30 watches a month, or bidding cannot learn.`]),
      `Campaigns optimising on visits (landing pages like /topgames/… or ${finalUrl}): Conversion goals → "Campaign-specific" → tick only "Page views (Website)" → Save. Bidding: Maximize conversions, then Target CPA after 15–30 conversions.`,
      'If a goal lists other active actions in Goals → Conversions → Summary, use a custom goal instead: Conversion goals → Use a custom goal → Create new → only the one action → Save.',
      `Final URL: the exact https://${site.domain || '<domain>'}/… address (www included), so there is no redirect and the click ID (gclid) is kept.`,
    ],
  });
  steps.push({
    step: ++n, id: 'verify', title: 'Verify', where: 'GA4 Realtime and Google Ads → Conversions',
    status: 'unknown',
    actions: [
      `Open ${opts.sendTo ? finalUrl : bestUrl} in a private window → GA4 → Reports → Realtime → Event count by Event name shows ad_shown within a minute${opts.sendTo ? '' : ', and rewarded_watched after answering the questions and watching the video'}.`,
      `Google Ads: the conversion actions move from Inactive to "Recording conversions" within about 24 hours of the first conversion from an ad click.`,
    ],
  });

  const todo = steps.filter((s) => s.status !== 'done').length;
  const summary = opts.sendTo
    ? `${domain}: ad_shown is sent to GA4 and to ${opts.sendTo}. ${todo} step(s) to check in Google Ads ${customerId}.`
    : `${domain}: ad_shown and rewarded_watched are sent to GA4 property ${propertyId}. GA4 ↔ Google Ads ${customerId}: ${opts.link.status.replace('_', ' ')}. ${todo} step(s) left.`;
  return { summary, steps };
}
