/**
 * USPS Bulk Tracker — Chrome Extension Background Service Worker
 * ───────────────────────────────────────────────────────────────
 * Opens real browser tabs to USPS tracking pages (35 TNs each),
 * waits for render, injects DOM scraper, returns results.
 */

const USPS_BATCH_SIZE = 35;
const PAGE_LOAD_EXTRA_DELAY_MS = 4000;
const BATCH_DELAY_MS = 2000;

// ─── MESSAGE HANDLER ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "trackAll") {
    handleTrackAll(msg.trackingNumbers)
      .then(results => sendResponse({ success: true, results }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─── BATCH ALL TRACKING NUMBERS ──────────────────────────────────
async function handleTrackAll(trackingNumbers) {
  const batches = chunkArray(trackingNumbers, USPS_BATCH_SIZE);
  const allResults = {};
  let processed = 0;

  for (let i = 0; i < batches.length; i++) {
    const pct = Math.round(((i + 1) / batches.length) * 100);
    chrome.action.setBadgeText({ text: `${pct}%` });
    chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });

    chrome.runtime.sendMessage({
      action: "progress",
      batch: i + 1,
      totalBatches: batches.length,
      processed: processed,
      total: trackingNumbers.length,
    }).catch(() => {});

    try {
      const batchResults = await trackBatchViaTab(batches[i]);
      Object.assign(allResults, batchResults);
    } catch (err) {
      console.error(`Batch ${i + 1} failed:`, err);
      batches[i].forEach(tn => {
        allResults[tn] = {
          status: "Error", detail: err.message,
          origin: "Unknown", dest: "Unknown", transitDays: "",
        };
      });
    }

    processed += batches[i].length;

    if (i < batches.length - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Save results to storage so popup can retrieve them after closing/reopening
  chrome.storage.local.set({ lastResults: allResults, lastResultTime: Date.now() });

  chrome.action.setBadgeText({ text: "Done" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
  return allResults;
}

// ─── TRACK A BATCH VIA REAL BROWSER TAB ──────────────────────────
async function trackBatchViaTab(trackingNumbers) {
  const tLabels = trackingNumbers.join(",");
  const url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tLabels}`;

  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await waitForTabLoad(tab.id, 30000);
    await sleep(PAGE_LOAD_EXTRA_DELAY_MS);

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeUSPSPage,
      args: [trackingNumbers],
    });

    if (injectionResults && injectionResults[0] && injectionResults[0].result) {
      return injectionResults[0].result;
    }

    throw new Error("Script injection returned no results");
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

// ─── WAIT FOR TAB TO FINISH LOADING ──────────────────────────────
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timeout"));
    }, timeoutMs);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }

    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === "complete") {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  });
}

// ─── DOM SCRAPER (injected into USPS page) ───────────────────────
// Runs in the USPS page context with full DOM access.
// Targets .product_summary containers (1:1 with tracking numbers).
function scrapeUSPSPage(trackingNumbers) {
  const results = {};

  trackingNumbers.forEach(tn => {
    results[tn] = {
      status: "Not found", detail: "",
      origin: "Unknown", dest: "Unknown", transitDays: "",
    };
  });

  // Check for outage
  if (window.location.href.includes("outage") || window.location.href.includes("apology")) {
    trackingNumbers.forEach(tn => {
      results[tn].status = "Error";
      results[tn].detail = "USPS.com is currently unavailable";
    });
    return results;
  }

  const gt = (el, sel) =>
    el?.querySelector(sel)?.textContent?.trim()?.replace(/\s+/g, " ") || "";

  const summaries = document.querySelectorAll(".product_summary");

  if (summaries.length === 0) {
    const bodyText = document.body?.textContent?.trim()?.slice(0, 200) || "";
    if (bodyText.length < 100) {
      trackingNumbers.forEach(tn => {
        results[tn].status = "Error";
        results[tn].detail = "Page did not load tracking data. Visit USPS.com manually first to establish session, then retry.";
      });
    }
    return results;
  }

  summaries.forEach(summary => {
    const tnEl = summary.querySelector(".tracking-number");
    const tn = tnEl?.getAttribute("value") || tnEl?.textContent?.trim() || "";
    if (!tn || !results[tn]) return;

    const bannerHeader = gt(summary, ".banner-header");
    const bannerContent = gt(summary, ".banner-content");

    let eta = gt(summary, ".expected_delivery h2") || gt(summary, ".expected-delivery");
    eta = eta.replace(/Expected Delivery.*$/i, "").trim();

    const events = [];
    summary.querySelectorAll(".tb-step").forEach(step => {
      const date = gt(step, ".tb-date");
      const statusDetail = gt(step, ".tb-status-detail");
      const location = gt(step, ".tb-location");
      const statusLabel = gt(step, ".tb-status");
      if (date || statusDetail) {
        events.push({ date, status: statusDetail, location, label: statusLabel });
      }
    });

    // Map status — check banner, green/red banner classes, event details, AND banner content
    let status = "Not found";
    const bh = (bannerHeader || "").toLowerCase();
    const bc = (bannerContent || "").toLowerCase();
    const hasGreenBanner = !!summary.querySelector(".green-banner");
    const hasRedBanner = !!summary.querySelector(".red-banner");
    const latestEventText = events.length > 0 ? (events[0].status || "").toLowerCase() : "";
    const latestLabel = events.length > 0 ? (events[0].label || "").toLowerCase() : "";
    // Counterfeit postage signal — distinct from generic "Not Available".
    // Waterfall: header MUST say "Tracking Not Displayed" AND content MUST
    // confirm the counterfeit-postage message. Both required = high confidence,
    // verbatim full bc preserved as the detail. Fallback covers edge cases
    // where USPS tweaks header wording but keeps "counterfeit" in content.
    const headerSaysNotDisplayed = /tracking not displayed/.test(bh);
    const contentConfirmsCounterfeit =
      /counterfeit postage|shipped with counterfeit|will not be displayed/.test(bc);
    const isCounterfeit =
      (headerSaysNotDisplayed && contentConfirmsCounterfeit) ||
      /counterfeit/.test(bc);

    // Check ALL sources for "delivered" — banner header, banner content, green banner, event text
    // bc check excludes future-tense phrasing ("on track to be delivered by...") that USPS
    // shows on in-transit packages, which previously caused false-positive Delivered status.
    const bcDeliveredPastTense =
      /\bdelivered\b/.test(bc) &&
      !/\b(?:to be|will be|would be|expected to be|on track to be|going to be) delivered\b/.test(bc);
    if (/delivered/.test(bh) || bcDeliveredPastTense || /delivered/.test(latestEventText) || /delivered/.test(latestLabel) || hasGreenBanner) {
      status = "Delivered";
    } else if (/out.?for.?delivery/.test(bh) || /out.?for.?delivery/.test(latestEventText)) {
      status = "Out for delivery";
    } else if (isCounterfeit) {
      status = "Seized/Counterfeit Postage";
    } else if (/alert|exception|return|undeliverable|refused|dead letter/.test(bh) || /alert|exception|return|undeliverable|refused/.test(latestEventText)) {
      status = "Exception";
    } else if (hasRedBanner && /not available|not found|no record/.test(bc)) {
      status = "Not found";
    } else if (/in.?transit|expected|on its way|arriving/.test(bh)) {
      status = "In transit";
    } else if (/pre.?shipment|label|accepted/.test(bh) || /accepted/.test(latestEventText)) {
      status = "In transit";
    } else if (/not available|not found|no record/.test(bh) || /not available/.test(bc)) {
      status = "Not found";
    } else if (events.length > 0) {
      status = "In transit";
    }

    // Build 17track-format detail
    let detail = "";
    if (events.length > 0) {
      const latest = events[0];
      const parts = [];

      if (latest.date) {
        try {
          const cleaned = latest.date.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim();
          const d = new Date(cleaned);
          if (!isNaN(d.getTime())) {
            const pad = n => String(n).padStart(2, "0");
            parts.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
          } else {
            parts.push(cleaned);
          }
        } catch {
          parts.push(latest.date.replace(/\s+/g, " "));
        }
      }

      if (latest.location) parts.push(latest.location + ", US");
      if (latest.status) parts.push(latest.status);
      detail = parts.join(" ");
      if (bannerContent) detail += " -> " + bannerContent;
    } else if (bannerContent) {
      detail = bannerContent;
    }

    // Transit days
    let transitDays = "";
    if (events.length > 0) {
      const oldest = events[events.length - 1];
      if (oldest.date) {
        try {
          const cleaned = oldest.date.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim();
          const d = new Date(cleaned);
          if (!isNaN(d.getTime())) {
            const days = Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
            transitDays = `(${days} Days)`;
          }
        } catch {}
      }
    }

    const hasEvents = events.length > 0;
    results[tn] = {
      status, detail,
      origin: hasEvents ? "United States" : "Unknown",
      dest: hasEvents ? "United States" : "Unknown",
      transitDays,
    };
  });

  return results;
}

// ─── HELPERS ─────────────────────────────────────────────────────
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
