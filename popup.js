/**
 * USPS Bulk Tracker — Popup Script
 */

const $ = id => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["lastTrackingNumbers", "lastResults", "lastResultTime"], data => {
    if (data.lastTrackingNumbers) $("trackingInput").value = data.lastTrackingNumbers;
    updateTNCount();

    // Restore saved results if they exist (survives popup close/reopen)
    if (data.lastResults && data.lastResultTime) {
      const ageMin = Math.round((Date.now() - data.lastResultTime) / 60000);
      if (ageMin < 1440) { // results less than 24 hours old
        allResults = data.lastResults;
        const tns = getTrackingNumbers();
        if (tns.length > 0) {
          showResults(tns, allResults);
          setStatus(`Results from ${ageMin < 60 ? ageMin + " min" : Math.round(ageMin / 60) + " hr"} ago. Ready to copy.`, "success");
        }
      }
    }
  });

  $("trackingInput").addEventListener("input", updateTNCount);
  $("btnTrack").addEventListener("click", startTracking);
  $("btnPaste").addEventListener("click", pasteFromClipboard);
  $("btnClear").addEventListener("click", clearAll);
  $("btnCopyTSV").addEventListener("click", () => copyResults("tsv"));
  $("btnCopyCSV").addEventListener("click", () => copyResults("csv"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "progress") updateProgress(msg);
  });
});

function parseTrackingInput() {
  const text = $("trackingInput").value;
  const lines = text.split(/[\r\n,;]+/);
  const tns = [];
  const seen = new Set();
  const duplicates = [];
  let unrecognized = 0;
  lines.forEach(line => {
    if (!line.trim()) return;
    // Tokenize per line by whitespace first, then strip dashes/dots inside
    // each token. Per-token matching prevents the parser from merging
    // tab-separated columns (TN + order# + date + ZIP) into a single
    // mega-digit string that produces chimera "TNs."
    const tokens = line.split(/\s+/).filter(Boolean);
    let lineMatched = false;
    tokens.forEach(token => {
      const stripped = token.replace(/[\-.]/g, "");
      const matches = stripped.match(/\d{20,34}/g);
      if (matches && matches.length > 0) {
        lineMatched = true;
        matches.forEach(m => {
          if (seen.has(m)) {
            duplicates.push(m);
          } else {
            seen.add(m);
            tns.push(m);
          }
        });
      }
    });
    if (!lineMatched) unrecognized++;
  });
  return { tns, duplicates, unrecognized };
}

function getTrackingNumbers() {
  return parseTrackingInput().tns;
}

function updateTNCount() {
  const { tns, duplicates, unrecognized } = parseTrackingInput();
  const batches = Math.ceil(tns.length / 35);
  let label = `${tns.length} tracking numbers detected`;
  if (tns.length > 0) label += ` (${batches} batch${batches > 1 ? "es" : ""} of 35)`;
  const skipped = [];
  if (duplicates.length > 0) skipped.push(`${duplicates.length} duplicate${duplicates.length > 1 ? "s" : ""}`);
  if (unrecognized > 0) skipped.push(`${unrecognized} unrecognized line${unrecognized > 1 ? "s" : ""}`);
  if (skipped.length > 0) label += ` · skipped ${skipped.join(", ")}`;
  $("tnCount").textContent = label;
  // Surface the actual dupe TNs so they're verifiable: tooltip on hover,
  // plus console.log for power-user inspection (right-click popup → Inspect).
  if (duplicates.length > 0) {
    $("tnCount").title = "Duplicate TNs flagged by parser:\n" + duplicates.join("\n");
    console.log("[USPS Bulk Tracker] " + duplicates.length + " duplicates:", duplicates);
  } else {
    $("tnCount").title = "";
  }
}

function pasteFromClipboard() {
  $("trackingInput").focus();
  $("trackingInput").select();
  setStatus("Text box selected — now hit Ctrl+V to paste.", "");
}

let allResults = {};

async function startTracking() {
  const tns = getTrackingNumbers();
  if (tns.length === 0) {
    setStatus("No valid tracking numbers found.", "error");
    return;
  }

  chrome.storage.local.set({ lastTrackingNumbers: $("trackingInput").value });

  $("btnTrack").disabled = true;
  $("btnTrack").textContent = "Tracking...";
  $("progressBar").classList.add("active");
  $("resultsSection").classList.remove("show");
  setStatus(`Starting... ${tns.length} tracking numbers in ${Math.ceil(tns.length / 35)} batches`);

  try {
    const response = await chrome.runtime.sendMessage({
      action: "trackAll",
      trackingNumbers: tns,
    });

    if (response.success) {
      allResults = response.results;
      showResults(tns, allResults);
      setStatus(`Done! ${tns.length} packages tracked.`, "success");
    } else {
      setStatus("Error: " + (response.error || "Unknown error"), "error");
    }
  } catch (err) {
    setStatus("Error: " + err.message, "error");
  }

  $("btnTrack").disabled = false;
  $("btnTrack").textContent = "Track All";
  $("progressBar").classList.remove("active");
}

function updateProgress(msg) {
  const pct = Math.round((msg.batch / msg.totalBatches) * 100);
  $("progressFill").style.width = pct + "%";
  setStatus(`Batch ${msg.batch}/${msg.totalBatches} — tracking...`);
}

function showResults(tns, results) {
  let transit = 0, ofd = 0, delivered = 0, notFound = 0, seized = 0;
  tns.forEach(tn => {
    const r = results[tn];
    if (!r) return;
    const s = r.status.toLowerCase();
    if (s === "delivered") delivered++;
    else if (s === "out for delivery") ofd++;
    else if (s === "seized/counterfeit postage" || s === "counterfeit postage") seized++;
    else if (s === "not found" || s === "error") notFound++;
    else transit++;
  });

  $("statTotal").textContent = tns.length;
  $("statTransit").textContent = transit;
  $("statOFD").textContent = ofd;
  $("statOFDBox").style.display = ofd > 0 ? "" : "none";
  $("statDelivered").textContent = delivered;
  $("statNotFound").textContent = notFound;
  $("statSeized").textContent = seized;
  $("statSeizedBox").style.display = seized > 0 ? "" : "none";

  const lines = ["Tracking\tOrigin\tDest\tDetail\tStatus\tTransit"];
  tns.forEach(tn => {
    const r = results[tn] || {};
    lines.push([
      tn,
      r.origin || "Unknown",
      r.dest || "Unknown",
      (r.detail || "").replace(/\t/g, " "),
      r.status || "Not found",
      r.transitDays || ""
    ].join("\t"));
  });

  $("resultsText").value = lines.join("\n");
  $("resultsSection").classList.add("show");
}

function copyResults(format) {
  const tns = getTrackingNumbers();
  let output = "";

  if (format === "tsv") {
    const lines = [];
    tns.forEach(tn => {
      const r = allResults[tn] || {};
      lines.push([
        tn,
        r.origin || "Unknown",
        r.dest || "Unknown",
        (r.detail || "").replace(/\t/g, " ").replace(/\n/g, " "),
        r.status || "Not found",
        r.transitDays || ""
      ].join("\t"));
    });
    output = lines.join("\n");
  } else {
    const lines = ["Tracking,Origin,Dest,Detail,Status,Transit"];
    tns.forEach(tn => {
      const r = allResults[tn] || {};
      lines.push([
        tn,
        csvEscape(r.origin || "Unknown"),
        csvEscape(r.dest || "Unknown"),
        csvEscape(r.detail || ""),
        csvEscape(r.status || "Not found"),
        csvEscape(r.transitDays || "")
      ].join(","));
    });
    output = lines.join("\n");
  }

  navigator.clipboard.writeText(output).then(() => {
    const btn = format === "tsv" ? $("btnCopyTSV") : $("btnCopyCSV");
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = orig; }, 2000);
    if (format === "tsv") {
      setStatus("TSV copied! Go to your sheet, click cell A2, Ctrl+V to paste.", "success");
    }
  }).catch(() => {
    setStatus("Failed to copy to clipboard.", "error");
  });
}

function csvEscape(val) {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function clearAll() {
  $("trackingInput").value = "";
  allResults = {};
  $("resultsSection").classList.remove("show");
  $("progressFill").style.width = "0%";
  $("progressBar").classList.remove("active");
  chrome.storage.local.remove(["lastTrackingNumbers", "lastResults", "lastResultTime"]);
  updateTNCount();
  setStatus("");
}

function setStatus(msg, type) {
  const el = $("status");
  el.textContent = msg;
  el.className = type || "";
}
