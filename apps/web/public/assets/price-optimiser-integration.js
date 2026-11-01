// Price Optimiser integration — follows the publisher integration guide (config v3).
// Loaded with `defer` AFTER publisher-sdk.js. The SDK owns GPT slots, sizes, floors and refresh:
// do not add GPT slot definitions, GAM paths or pricing anywhere else in the site.
const ads = window.PublisherExperience;
const adsReady = (async () => {
  if (!ads) throw new Error("Price Optimiser SDK failed to load");
  await ads.init();
  return ads;
})();
adsReady.catch(error => {
  console.warn("Ads unavailable", error);
  // Keep the publisher page usable if ad initialization fails.
});

// Display slots for a view that is mounted later (e.g. a funnel's result step).
// The destination DIVs must already exist in the document.
async function preloadNextViewAds(slots) {
  const a = await adsReady;
  return a.preloadSlots(slots);
}
async function revealNextViewAds(slots) {
  const a = await adsReady;
  // First mount/show the destination view with its registered DIVs.
  await new Promise(resolve => requestAnimationFrame(resolve));
  return a.revealSlots(slots);
}

// Rewarded — publisher-controlled. Show only after the user opts in.
async function preloadReward() {
  const a = await adsReady;
  return a.preloadRewarded("rewarded");
}
let rewardBusy = false;
let interstitialBusy = false;
async function showRewardAfterOptIn({ onGranted, onClosed, onFallback } = {}) {
  if (rewardBusy || interstitialBusy) return { status: "busy" };
  rewardBusy = true;
  let granted = false;
  try {
    const a = await adsReady;
    return await a.showRewarded("rewarded", {
      onGranted(detail) {
        if (granted) return;
        granted = true;
        onGranted?.(detail); // grant must be idempotent on the publisher side
      },
      onClosed() { onClosed?.(); }, // closure alone does not grant a reward
      onFallback(result) { onFallback?.(result); } // no-fill, decline, timeout, busy or error: no reward
    });
  } catch (error) {
    onFallback?.({ status: "error" });
    return { status: "error" };
  } finally {
    rewardBusy = false;
  }
}

// Interstitial — publisher-controlled; never concurrently with rewarded.
async function requestInterstitialOpportunity() {
  if (interstitialBusy || rewardBusy) return { status: "busy" };
  interstitialBusy = true;
  try {
    const a = await adsReady;
    return await a.showInterstitial("interstitial");
  } catch (error) {
    return { status: "error" };
  } finally {
    interstitialBusy = false; // continue the publisher flow even when no ad is available
  }
}

// Explicitly exposed to the site's own scripts (funnels, rewarded unlocks).
window.siteAds = { adsReady, preloadNextViewAds, revealNextViewAds, preloadReward, showRewardAfterOptIn, requestInterstitialOpportunity };
document.dispatchEvent(new CustomEvent("siteads:ready"));
