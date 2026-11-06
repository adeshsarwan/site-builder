// Price Optimiser integration (Rules API SDK on serve.thebesads.com). Loaded once with `defer`, after
// publisher-sdk.js (data-auto-init="false"), see Base.astro. This file is the single initialisation owner.
// Price Optimiser owns GPT, inventory mapping, sizes, floors, experiments, refresh and rewarded presentation.
// We never define GPT slots, set price targeting, or call display / refresh / makeRewardedVisible.
// The rest of the site talks only to window.siteAds (funnels, apply gate).
(function (window, document) {
  'use strict';
  const sdkTag = document.querySelector('script[data-po-site]');
  const SITE_KEY = (sdkTag && sdkTag.getAttribute('data-po-site')) || '';

  // There is no CMP on these sites yet. When one is added, define window.siteAdsConsent() returning its
  // "ads allowed" state: nothing below initialises the SDK or requests ads while it returns false.
  const canRequestAds = () => {
    try { return typeof window.siteAdsConsent === 'function' ? window.siteAdsConsent() === true : true; } catch { return false; }
  };
  const consentError = () => Object.assign(new Error('consent_required'), { status: 'consent_required' });

  // One-time initialisation, only once consent permits. A refusal is not cached, so a later call can init.
  let initPromise = null;
  function ready() {
    if (initPromise) return initPromise;
    if (!canRequestAds()) return Promise.reject(consentError());
    initPromise = (async () => {
      const ads = window.PublisherExperience;
      if (!ads) throw new Error('Price Optimiser SDK failed to load');
      await ads.init();
      const site = ads.status && ads.status().siteKey;
      if (SITE_KEY && site !== SITE_KEY) throw new Error(`Unexpected Price Optimiser site: ${site}`);
      return ads;
    })();
    initPromise.catch((error) => console.warn('Ads unavailable', error && error.message));
    return initPromise;
  }
  ready().catch(() => {}); // initialise display placements on load (consent permitting)

  // Display: exact, mounted, unique div IDs only; never an empty array (empty selectors widen the scope).
  function mountedIds(ids) {
    return [...new Set(ids || [])].filter((id) => {
      const n = document.querySelectorAll(`[id="${id}"]`).length;
      if (n > 1) console.warn(`Duplicate ad div: ${id}`);
      return n === 1;
    });
  }
  // Preload a near-term hidden destination's slots (real GAM requests into the mounted hidden divs).
  async function preloadNextViewAds(ids) {
    const mounted = mountedIds(ids);
    if (!mounted.length) return { status: 'skipped', results: [] };
    const ads = await ready();
    return ads.preloadSlots(mounted);
  }
  // Call after the caller has unhidden the destination; same IDs as the preload.
  async function revealNextViewAds(ids) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mounted = mountedIds(ids);
    if (!mounted.length) return { status: 'skipped', results: [] };
    const ads = await ready();
    return ads.revealSlots(mounted);
  }

  // Rewarded warm-up: one shared promise per flow, so duplicate callers reuse it.
  let rewardWarm = null;
  function preloadReward() {
    if (!rewardWarm) {
      rewardWarm = ready()
        .then((ads) => ads.preloadRewarded('rewarded'))
        .catch((error) => { rewardWarm = null; return { status: (error && error.status) || 'error' }; });
    }
    return rewardWarm;
  }

  // One in-flight guard across rewarded and interstitial.
  let busy = false;

  // Rewarded show, after the user's opt-in only. Resolves after the terminal outcome, never at onReady.
  //  - granted: onGranted fired (the only grant signal);
  //  - completed: granted AND closed, checked idempotently from both callbacks (order doesn't matter);
  //    if the lifecycle settles granted without an onClosed callback, settling counts as the close.
  // Callback errors are swallowed so they can't break the SDK's lifecycle.
  async function showRewardAfterOptIn({ onGranted, onClosed, onFallback, onComplete } = {}) {
    if (busy) return { status: 'busy', granted: false, completed: false };
    busy = true;
    let granted = false, closed = false, completed = false, fellBack = false;
    const safe = (fn, arg) => { try { fn && fn(arg); } catch {} };
    const complete = () => { if (completed || !granted || !closed) return; completed = true; safe(onComplete); };
    const fallback = (r) => { if (fellBack) return; fellBack = true; safe(onFallback, r); };
    try {
      const ads = await ready();
      const result = (await ads.showRewarded('rewarded', {
        onGranted(detail) { if (granted) return; granted = true; safe(onGranted, detail); complete(); },
        onClosed(event) { closed = true; safe(onClosed, event); complete(); },
        onFallback(r) { fallback(r); }, // unavailable, timeout, declined, busy, error…
      })) || {};
      const status = String(result.status || (granted ? 'granted' : 'unavailable'));
      if (granted && !closed) { closed = true; complete(); } // settled = terminal outcome
      if (!granted) fallback({ status });
      return { ...result, status, granted, closed, completed };
    } catch (error) {
      const status = (error && error.status) || 'error'; // SDK load / init failure, or consent
      fallback({ status });
      return { status, granted: false, closed, completed: false };
    } finally {
      rewardWarm = null; // a new flow preloads afresh
      busy = false;
    }
  }

  // Interstitial: only at the publisher's existing natural break; never overlapping rewarded.
  async function requestInterstitialOpportunity() {
    if (busy) return { status: 'busy' };
    busy = true;
    try {
      const ads = await ready();
      return (await ads.showInterstitial('interstitial')) || {};
    } catch (error) {
      return { status: (error && error.status) || 'error' };
    } finally {
      busy = false; // the caller always continues its flow
    }
  }

  window.siteAds = {
    get adsReady() { return ready(); },
    ready, canRequestAds, preloadNextViewAds, revealNextViewAds, preloadReward, showRewardAfterOptIn, requestInterstitialOpportunity,
  };
  document.dispatchEvent(new CustomEvent('siteads:ready'));
})(window, document);
