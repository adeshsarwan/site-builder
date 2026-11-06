// Price Optimiser integration. Loaded once with `defer` after the SDK script (see Base.astro).
// Price Optimiser owns GPT, inventory mapping, sizes, floors, refresh, waterfalls and rewarded presentation.
// This file never defines GPT slots, never sets price targeting and never calls display/refresh itself.
//
// Two load modes, chosen per site (ads.sdkMode):
//  - "bundle": the site's dedicated experience bundle (e.g. /experiences/jobsthe.world.js). It auto-initialises;
//    we only resolve its public API (bounded wait) and check status().siteKey. Signatures per the jobsthe.world
//    handoff: preloadRewarded(), showRewarded(callbacks), showInterstitial(), preloadSlots(ids), revealSlots(ids).
//  - "publisher-sdk": shared publisher-sdk.js with data-auto-init="false"; we call init() once.
//
// The rest of the site talks only to window.siteAds (funnels, apply gate).
(function (window, document) {
  'use strict';
  const me = document.currentScript;
  const MODE = (me && me.dataset.poMode) || 'publisher-sdk';
  const SITE_KEY = (me && me.dataset.poSite) || '';
  const ALLOWED = ((me && me.dataset.poSlots) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const REQUIRED = ['preloadSlots', 'revealSlots', 'preloadRewarded', 'showRewarded'];

  // No CMP on these sites yet. If one is added, make this return its "ads allowed" state;
  // every ad call below checks it, and content is never blocked on it.
  const canRequestAds = () => {
    try { return typeof window.siteAdsConsent === 'function' ? window.siteAdsConsent() === true : true; } catch { return false; }
  };

  const camel = (s) => s.toLowerCase().replace(/[^a-z0-9]+([a-z0-9])/g, (_, c) => c.toUpperCase()); // jobsthe.world → jobstheWorld
  function resolveSDK() {
    const candidates = [
      window.PublisherExperienceSDK && window.PublisherExperienceSDK[camel(SITE_KEY)],
      window.PriceOptimiserExperience,
      window.PublisherExperience,
    ];
    return candidates.find((po) => {
      if (!po || !REQUIRED.every((n) => typeof po[n] === 'function')) return false;
      if (MODE !== 'bundle') return true;
      try { return po.status().siteKey === SITE_KEY; } catch { return false; }
    });
  }

  // Bounded readiness: up to 8 s for the public API. Never blocks content.
  let readyPromise = null;
  function ready(timeoutMs = 8000) {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      let po;
      while (!(po = resolveSDK()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      if (!po) throw new Error('Price Optimiser SDK unavailable');
      if (MODE !== 'bundle' && typeof po.init === 'function') await po.init(); // auto-init is off in this mode
      return po;
    })();
    readyPromise.catch((error) => { console.warn('Ads unavailable', error); });
    return readyPromise;
  }
  const adsReady = ready();

  // Exact, mapped, mounted, unique div IDs only. Unknown/absent IDs are dropped, duplicates are refused.
  function mountedIds(ids) {
    return [...new Set(ids)].filter((id) => {
      if (ALLOWED.length && !ALLOWED.includes(id)) return false;
      const n = document.querySelectorAll(`[id="${id}"]`).length;
      if (n > 1) { console.warn(`Duplicate ad div: ${id}`); return false; }
      return n === 1;
    });
  }
  const twoFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Display: preload into mounted (possibly hidden) destination divs — a real ad request.
  async function preloadNextViewAds(ids) {
    if (!canRequestAds()) return { status: 'consent_required' };
    const po = await adsReady;
    const mounted = mountedIds(ids);
    return mounted.length ? po.preloadSlots(mounted) : { status: 'no_mounted_slots' };
  }
  // Display: call AFTER the destination is visible (the caller unhides it first). Same div IDs as the preload.
  async function revealNextViewAds(ids) {
    await twoFrames();
    if (!canRequestAds()) return { status: 'content_visible_without_ads' };
    const po = await adsReady;
    const mounted = mountedIds(ids);
    return mounted.length ? po.revealSlots(mounted) : { status: 'no_mounted_slots' };
  }

  // Rewarded: preload while the visitor is in the question / waiting flow. Independent of display preload.
  let rewardWarm = null;
  function preloadReward() {
    if (!canRequestAds()) return Promise.resolve({ status: 'consent_required' });
    if (rewardWarm) return rewardWarm;
    rewardWarm = adsReady
      .then((po) => (MODE === 'bundle' ? po.preloadRewarded() : po.preloadRewarded('rewarded')))
      .catch((error) => ({ status: 'error', error }));
    return rewardWarm;
  }

  // Rewarded: only after an explicit user opt-in. Resolves after the ad's terminal outcome (closed / fallback),
  // never at onReady. `granted` is true only when onGranted fired AND the lifecycle settled as "granted".
  let rewardBusy = false;
  let interstitialBusy = false;
  async function showRewardAfterOptIn({ onGranted, onClosed, onFallback } = {}) {
    if (rewardBusy || interstitialBusy) return { status: 'busy', granted: false };
    rewardBusy = true;
    let grantedCb = false;
    let fellBack = false;
    const fallback = (r) => { if (fellBack) return; fellBack = true; try { onFallback && onFallback(r); } catch {} };
    try {
      if (!canRequestAds()) { fallback({ status: 'consent_required' }); return { status: 'consent_required', granted: false }; }
      const po = await adsReady;
      const callbacks = {
        onGranted(detail) {
          if (grantedCb) return;
          grantedCb = true;
          try { onGranted && onGranted(detail); } catch {} // record the entitlement once; no navigation here
        },
        onClosed(event) { try { onClosed && onClosed(event); } catch {} }, // closing alone is not a reward
        onFallback(result) { fallback(result); }, // unavailable, timeout, declined, busy, error
      };
      const result = (MODE === 'bundle' ? await po.showRewarded(callbacks) : await po.showRewarded('rewarded', callbacks)) || {};
      const status = String(result.status || (grantedCb ? 'granted' : 'unavailable'));
      const granted = grantedCb && status === 'granted';
      if (!granted) fallback({ status });
      return { ...result, status, granted };
    } catch (error) {
      fallback({ status: 'error' });
      return { status: 'error', granted: false };
    } finally {
      rewardWarm = null; // the preload is consumed; the next opportunity preloads afresh
      rewardBusy = false;
    }
  }

  // Interstitial: publisher-triggered only at an agreed break; never concurrently with rewarded.
  // (The jobsthe.world bundle installs its own /find/results/ triggers; we add none.)
  async function requestInterstitialOpportunity() {
    if (interstitialBusy || rewardBusy || !canRequestAds()) return { status: 'busy' };
    interstitialBusy = true;
    try {
      const po = await adsReady;
      if (typeof po.showInterstitial !== 'function') return { status: 'unavailable' };
      return (MODE === 'bundle' ? await po.showInterstitial() : await po.showInterstitial('interstitial')) || {};
    } catch {
      return { status: 'error' };
    } finally {
      interstitialBusy = false; // the caller always continues its flow
    }
  }

  window.siteAds = { mode: MODE, adsReady, ready, canRequestAds, preloadNextViewAds, revealNextViewAds, preloadReward, showRewardAfterOptIn, requestInterstitialOpportunity };
  document.dispatchEvent(new CustomEvent('siteads:ready'));
})(window, document);
