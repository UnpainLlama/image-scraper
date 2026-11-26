(() => {
  const $ = (id) => document.getElementById(id);
  const ACTIVE_JOB_KEY = "image-scraper-active-job";
  const RECOVERY_JOB_KEY = "image-scraper-recovery-job";

  let activeJobId = localStorage.getItem(ACTIVE_JOB_KEY) || "";
  let recoveryJobId = localStorage.getItem(RECOVERY_JOB_KEY) || "";
  let currentSnapshot = null;
  let isAuthenticated = false;
  let refreshTimer = null;
  let flow = null;
  let lastProgressLine = "";

  function appendLine(message, kind = "") {
    const line = document.createElement("div");
    line.className = "terminal-line" + (kind ? " " + kind : "");
    line.textContent = String(message);
    $("terminal-output").appendChild(line);
    while ($("terminal-output").childNodes.length > 2500) {
      $("terminal-output").removeChild($("terminal-output").firstChild);
    }
    $("terminal-output").scrollTop = $("terminal-output").scrollHeight;
  }

  function appendBlock(lines, kind = "") {
    lines.forEach((line) => appendLine(line, kind));
  }

  function setPrompt(label, hint, placeholder = "Type here") {
    $("terminal-prompt-label").textContent = label;
    $("terminal-hint").textContent = hint || "";
    $("terminal-input").placeholder = placeholder;
    $("terminal-input").value = "";
    $("terminal-input").disabled = false;
    $("terminal-submit").disabled = false;
    $("terminal-form").hidden = false;
    $("terminal-input").focus();
  }

  function disablePrompt(message) {
    $("terminal-input").disabled = true;
    $("terminal-submit").disabled = true;
    $("terminal-prompt-label").textContent = message || "Session active";
    $("terminal-hint").textContent = "";
  }

  function lockConsole(message, configured = true) {
    isAuthenticated = false;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    $("auth-panel").hidden = false;
    $("login-form").hidden = !configured;
    $("terminal-panel").hidden = true;
    $("job-panel").hidden = true;
    $("logout-button").hidden = true;
    $("auth-notice").textContent = message || "";
    $("app-password").value = "";
    currentSnapshot = null;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && data.error === "AUTH_REQUIRED") {
        lockConsole("Session expired. Enter the password again.");
      }
      const error = new Error(data.error || "REQUEST_FAILED");
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function enterConsole() {
    isAuthenticated = true;
    $("auth-panel").hidden = true;
    $("logout-button").hidden = false;
    $("terminal-panel").hidden = false;
    $("recover-job-id").value = recoveryJobId || "";
    if (!$("terminal-output").childNodes.length) {
      appendBlock([
        "pscraper — image and animated GIF scraper",
        "TypeScript Worker runtime · queue-backed downloads · R2 object storage",
        "Tor and browser-cookie paste are not available in this hosted runtime.",
        ""
      ], "muted");
    }
    if (activeJobId) {
      openJob(activeJobId, true).catch(() => startNewFlow(true));
    } else {
      startNewFlow(true);
    }
  }

  function startNewFlow(initial = false) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    currentSnapshot = null;
    flow = {
      step: "site",
      site: "auto",
      input: "",
      maxPages: 100,
      concurrency: 3,
      eliteBabesMode: "galleries",
      prepared: null
    };
    $("job-panel").hidden = true;
    $("terminal-panel").hidden = false;
    $("terminal-state").textContent = "interactive";
    $("verification-file").value = "";
    $("job-notice").textContent = "";
    $("job-guidance").hidden = true;
    if (!initial) appendLine("", "muted");
    appendBlock([
      "============================================================",
      " MEDIA SCRAPER",
      "============================================================",
      " [1] sex.com     (GIF API search / list)",
      " [2] rule34      (tag search / list)",
      " [3] realbooru   (tag search / list)",
      " [4] elitebabes  (tag / gallery)",
      " [5] buondua     (home / hot / tag / album)",
      " [6] static      (image / GIF URLs from HTML; follows next link)",
      " [A] auto        (detect site from URL; search defaults to sex.com)",
      "",
      "Free limits: up to 100 pages, 2,000 image / GIF files and 1 GiB per job.",
      ""
    ]);
    setPrompt("Choose site [1-6 / A]", "Enter a number or site name. A detects the site from a URL.", "A");
  }

  function siteChoice(raw) {
    const value = String(raw || "").trim().toLowerCase();
    const choices = {
      "1": "sex.com", sex: "sex.com", sexcom: "sex.com", "sex.com": "sex.com",
      "2": "rule34", r34: "rule34", rule: "rule34", rule34: "rule34",
      "3": "realbooru", rb: "realbooru", real: "realbooru", realbooru: "realbooru",
      "4": "elitebabes", eb: "elitebabes", elite: "elitebabes", elitebabes: "elitebabes",
      "5": "buondua", bd: "buondua", buon: "buondua", buondua: "buondua",
      "6": "static", static: "static", image: "static", html: "static",
      a: "auto", auto: "auto", "": "auto"
    };
    return choices[value] || null;
  }

  function looksLikeEliteBabes(value) {
    try { return /(^|\.)elitebabes\.com$/i.test(new URL(/^https?:\/\//i.test(value) ? value : "https://" + value).hostname); }
    catch { return false; }
  }

  function advanceAfterTarget() {
    flow.step = "pages";
    appendLine("Target: " + flow.input, "prompt");
    setPrompt("Maximum pages [Enter = 100]", "Choose 1–100. The Free runtime caps one job at 100 pages.", "100");
  }

  async function prepareTarget() {
    flow.step = "probing";
    $("terminal-state").textContent = "probing";
    disablePrompt("Checking target");
    appendLine("Checking target HTTP response…", "muted");
    try {
      flow.prepared = await api("/api/terminal/probe", {
        method: "POST",
        body: JSON.stringify({
          site: flow.site,
          input: flow.input,
          maxPages: flow.maxPages,
          eliteBabesMode: flow.eliteBabesMode
        })
      });
      const target = flow.prepared.target;
      appendLine("Probe passed · HTTP " + flow.prepared.probe.status + " · " + (flow.prepared.probe.contentType || "content type unavailable"), "good");
      appendBlock([
        "",
        "============================================================",
        " READY",
        "============================================================",
        " Site       : " + target.label,
        " Target     : " + target.siteUrl,
        " Target type: " + target.targetType,
        " Pages      : " + flow.maxPages,
        " Workers    : " + flow.concurrency,
        target.site === "elitebabes" ? " Media mode : " + target.eliteBabesMode : "",
        target.site === "static" ? " Pagination : next-link only" : " Pagination : source adapter",
        "",
        "[Enter] start  [b] change target  [q] cancel",
        ""
      ].filter(Boolean));
      flow.step = "ready";
      $("terminal-state").textContent = "ready";
      setPrompt("Start this scrape? [Enter / B / Q]", "Press Enter to queue the job, B to change target, or Q to cancel.", "Enter");
    } catch (error) {
      const status = error.data && error.data.status ? " (HTTP " + error.data.status + ")" : "";
      appendLine("Probe failed: " + (error.message || "SITE_PROBE_FAILED") + status, "error");
      appendLine("The target was not queued. Check the URL/site choice, then retry or go back.", "warn");
      flow.step = "probeFailed";
      $("terminal-state").textContent = "probe failed";
      setPrompt("Retry [R], change target [B], or cancel [Q]", "", "R");
    }
  }

  async function startJob() {
    if (!flow || !flow.prepared) return;
    const target = flow.prepared.target;
    $("terminal-state").textContent = "starting";
    disablePrompt("Submitting job");
    appendLine("Creating queue-backed job…", "muted");
    try {
      const result = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          siteUrl: target.siteUrl,
          mode: "exact",
          pages: [],
          concurrency: flow.concurrency,
          maxPages: flow.maxPages,
          eliteBabesMode: target.eliteBabesMode,
          followNextPage: target.site === "static"
        })
      });
      if (activeJobId && activeJobId !== result.jobId) rememberRecoveryJob(activeJobId);
      activeJobId = result.jobId;
      localStorage.setItem(ACTIVE_JOB_KEY, activeJobId);
      appendLine("Job started: " + activeJobId, "good");
      $("job-id").textContent = "Job " + activeJobId;
      $("terminal-state").textContent = "running";
      $("job-panel").hidden = false;
      $("verification-file").value = "";
      render(result.snapshot);
      flow.step = "running";
      disablePrompt("Job running — use the controls below");
      refreshTimer = setTimeout(refresh, 1500);
    } catch (error) {
      appendLine("Could not start job: " + (error.message || "JOB_START_FAILED"), "error");
      $("terminal-state").textContent = "error";
      flow.step = "ready";
      setPrompt("Press Enter to retry or Q to cancel", "", "Enter");
    }
  }

  $("terminal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!flow) return;
    const raw = $("terminal-input").value.trim();
    appendLine("> " + (raw || "[Enter]"), "prompt");
    const value = raw.toLowerCase();

    if (flow.step === "site") {
      const selected = siteChoice(raw);
      if (!selected) {
        appendLine("Choose 1–6 or A.", "error");
        setPrompt("Choose site [1-6 / A]", "Enter a number or site name.", "A");
        return;
      }
      flow.site = selected;
      appendLine("Selected site: " + selected, "good");
      flow.step = "target";
      const prompt = selected === "static" ? "Page URL" :
        selected === "rule34" || selected === "realbooru" ? "Tags or list URL" :
        selected === "elitebabes" ? "Tag, home, or gallery URL" :
        selected === "buondua" ? "Home / hot / tag / album URL or ID" :
        selected === "sex.com" ? "Search query or list URL" : "URL or search query";
      setPrompt(prompt, "Enter a URL or a site-specific search term.", "https://… or search term");
      return;
    }

    if (flow.step === "target") {
      if (!raw) {
        appendLine("A target is required.", "error");
        setPrompt("URL or search query", "This field cannot be empty.");
        return;
      }
      flow.input = raw;
      advanceAfterTarget();
      return;
    }

    if (flow.step === "pages") {
      const pages = raw ? Number(raw) : 100;
      if (!Number.isInteger(pages) || pages < 1 || pages > 100) {
        appendLine("Enter a whole number from 1 to 100, or press Enter for 100.", "error");
        setPrompt("Maximum pages [Enter = 100]", "Allowed range: 1–100.", "100");
        return;
      }
      flow.maxPages = pages;
      flow.step = "workers";
      appendLine("Page limit: " + pages, "muted");
      setPrompt("Parallel workers [Enter = 3]", "Choose 1–5. The queue and each job are capped at five workers.", "3");
      return;
    }

    if (flow.step === "workers") {
      const workers = raw ? Number(raw) : 3;
      if (!Number.isInteger(workers) || workers < 1 || workers > 5) {
        appendLine("Enter a whole number from 1 to 5, or press Enter for 3.", "error");
        setPrompt("Parallel workers [Enter = 3]", "Allowed range: 1–5.", "3");
        return;
      }
      flow.concurrency = workers;
      if (flow.site === "elitebabes" || (flow.site === "auto" && looksLikeEliteBabes(flow.input))) {
        flow.step = "eliteMode";
        appendBlock(["", "EliteBabes mode:", " [1] images    (listing thumbnails — faster)", " [2] galleries (open each gallery — full-size)"]);
        setPrompt("EliteBabes mode [1 / 2]", "Choose listing thumbnails or full-size gallery images.", "2");
      } else {
        await prepareTarget();
      }
      return;
    }

    if (flow.step === "eliteMode") {
      if (["1", "i", "img", "image", "images"].includes(value)) flow.eliteBabesMode = "images";
      else if (["2", "g", "gallery", "galleries", "full", "hq", ""].includes(value)) flow.eliteBabesMode = "galleries";
      else {
        appendLine("Enter 1 for images or 2 for galleries.", "error");
        setPrompt("EliteBabes mode [1 / 2]", "", "2");
        return;
      }
      await prepareTarget();
      return;
    }

    if (flow.step === "probeFailed") {
      if (["r", "retry", ""].includes(value)) await prepareTarget();
      else if (["b", "back"].includes(value)) startNewFlow();
      else if (["q", "quit", "cancel"].includes(value)) startNewFlow();
      else setPrompt("Retry [R], change target [B], or cancel [Q]", "", "R");
      return;
    }

    if (flow.step === "ready") {
      if (["q", "quit", "cancel"].includes(value)) {
        appendLine("Cancelled. No job was created.", "muted");
        startNewFlow();
      } else if (["b", "back"].includes(value)) {
        startNewFlow();
      } else if (["", "y", "yes", "start"].includes(value)) {
        await startJob();
      } else {
        setPrompt("Start this scrape? [Enter / B / Q]", "Press Enter or type Y to start. B changes target; Q cancels.", "Enter");
      }
    }
  });

  function rememberRecoveryJob(jobId) {
    if (!jobId) return;
    recoveryJobId = jobId;
    localStorage.setItem(RECOVERY_JOB_KEY, jobId);
    $("recover-job-id").value = jobId;
  }

  function bytes(value) {
    if (value < 1024) return value + " B";
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let number = value;
    let index = -1;
    do { number /= 1024; index += 1; } while (number >= 1024 && index < units.length - 1);
    return number.toFixed(2) + " " + units[index];
  }

  function notice(message, kind = "") {
    $("job-notice").textContent = message || "";
    $("job-notice").className = "notice " + kind;
  }

  function setButtonState(snapshot) {
    const tasks = snapshot.taskCounts || { pending: snapshot.pendingPages + snapshot.pendingImages, leased: 0 };
    const activePermits = Number(snapshot.activePermits || 0);
    const settled = tasks.leased === 0 && activePermits === 0 && snapshot.bytesReserved === 0;
    const allDone = tasks.pending === 0 && snapshot.pendingPages === 0 && snapshot.pendingImages === 0;
    const terminal = ["completed", "cancelled", "abandoned", "verified"].includes(snapshot.status);
    const drained = settled && allDone;
    const canStartNew = terminal && (snapshot.status === "abandoned" ? settled : drained);
    const partialExport = ["paused", "budget-paused", "verified"].includes(snapshot.status);
    const canExport = ["completed", "cancelled"].includes(snapshot.status) ? drained : partialExport && settled;
    const canClear = snapshot.status === "abandoned" ? settled : snapshot.verified && allDone && settled;

    $("pause-button").hidden = snapshot.status !== "running";
    $("resume-button").hidden = !["paused", "budget-paused"].includes(snapshot.status) && !(snapshot.status === "verified" && !allDone);
    $("new-attempt-button").hidden = !canStartNew;
    $("cancel-button").hidden = !["running", "paused", "budget-paused"].includes(snapshot.status) && !(snapshot.status === "verified" && !allDone);
    $("manifest-button").disabled = !canExport;
    $("verify-button").disabled = !$("verification-file").files.length || !canExport;
    $("clear-button").disabled = !canClear;
    $("export-panel").hidden = !canExport && !canClear;
    $("clear-button").textContent = snapshot.status === "abandoned" ? "Delete abandoned job" : "Clear verified job";
    $("verification-state").textContent = snapshot.verified ? "Verification accepted." : "Not verified.";

    let guidance = "";
    if (snapshot.status === "cancelled") guidance = drained ? "Stopped. Export this partial job or start a new scrape." : "Stopped. Waiting for active work to finish.";
    else if (snapshot.status === "completed" && snapshot.failedImages > 0) guidance = "Finished with " + snapshot.failedImages.toLocaleString() + " failed downloads. Export the results or start a new scrape.";
    else if (snapshot.status === "completed") guidance = "Finished. Export and verify your image and GIF files before clearing this job.";
    else if (snapshot.status === "abandoned") guidance = settled ? "This job is abandoned. Delete it or start a new scrape." : "This job is abandoned. Waiting for active work to finish.";
    else if (snapshot.status === "verified" && allDone) guidance = "Image and GIF files verified. You can clear this job or start a new scrape.";
    $("job-guidance").textContent = guidance;
    $("job-guidance").hidden = !guidance;

    if (snapshot.cleanupAt) {
      const remaining = Math.max(0, snapshot.cleanupAt - Date.now());
      const days = Math.floor(remaining / 86400000);
      const hours = Math.floor((remaining % 86400000) / 3600000);
      $("retention-countdown").hidden = false;
      $("retention-countdown").textContent = "Automatic deletion in " + days + " days, " + hours + " hours if this abandoned job is not resumed or cleared.";
    } else {
      $("retention-countdown").hidden = true;
    }
  }

  function render(snapshot) {
    currentSnapshot = snapshot;
    $("job-status").textContent = snapshot.status.replace(/-/g, " ");
    $("pages-count").textContent = snapshot.pagesCompleted + " / " + snapshot.pagesDiscovered;
    $("images-count").textContent = snapshot.imagesDiscovered.toLocaleString();
    $("stored-count").textContent = snapshot.imagesStored.toLocaleString();
    $("failed-count").textContent = snapshot.failedImages.toLocaleString();
    $("storage-count").textContent = bytes(snapshot.bytesStored) + " / " + bytes(snapshot.budgetBytes);
    $("storage-meter").style.width = Math.min(100, snapshot.bytesStored / Math.max(1, snapshot.budgetBytes) * 100) + "%";

    const errors = snapshot.failedByCode || [];
    $("error-list").hidden = errors.length === 0;
    $("error-list").replaceChildren();
    if (errors.length) {
      const heading = document.createElement("strong");
      heading.textContent = "Error counts (source URLs are not displayed)";
      $("error-list").appendChild(heading);
      errors.forEach((item) => {
        const row = document.createElement("div");
        const code = document.createElement("span");
        const count = document.createElement("b");
        code.textContent = item.code;
        count.textContent = String(item.count);
        row.append(code, count);
        $("error-list").appendChild(row);
      });
    }
    setButtonState(snapshot);

    const progress = snapshot.status + " · pages " + snapshot.pagesCompleted + "/" + snapshot.pagesDiscovered +
      " · images " + snapshot.imagesStored + "/" + snapshot.imagesDiscovered +
      " · failed " + snapshot.failedImages + " · " + bytes(snapshot.bytesStored);
    if (progress !== lastProgressLine) {
      appendLine(progress, snapshot.status === "completed" ? "good" : "muted");
      lastProgressLine = progress;
    }
  }

  async function refresh() {
    if (!activeJobId) return;
    try {
      const snapshot = await api("/api/jobs/" + encodeURIComponent(activeJobId), { method: "GET", headers: {} });
      render(snapshot);
      const queueDrained = snapshot.pendingPages === 0 && snapshot.pendingImages === 0 &&
        (snapshot.taskCounts?.pending || 0) === 0 && (snapshot.taskCounts?.leased || 0) === 0 &&
        Number(snapshot.activePermits || 0) === 0 && snapshot.bytesReserved === 0;
      const noActiveWorkers = Number(snapshot.activePermits || 0) === 0 &&
        (snapshot.taskCounts?.leased || 0) === 0;
      const settledVerified = snapshot.status === "verified" && noActiveWorkers && snapshot.bytesReserved === 0;
      const settledAbandoned = snapshot.status === "abandoned" && noActiveWorkers;
      if (settledAbandoned || settledVerified || (["completed", "cancelled"].includes(snapshot.status) && queueDrained)) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
        $("terminal-state").textContent = snapshot.status;
      } else {
        refreshTimer = setTimeout(refresh, 4000);
      }
    } catch (error) {
      if (!isAuthenticated) return;
      notice(error.message || "STATUS_UNAVAILABLE", "error");
      refreshTimer = setTimeout(refresh, 8000);
    }
  }

  async function jobAction(name) {
    if (!activeJobId) return;
    try {
      let body = {};
      if (name === "resume" && currentSnapshot &&
        ["budget-paused", "verified"].includes(currentSnapshot.status) &&
        currentSnapshot.bytesStored >= currentSnapshot.budgetBytes * 0.95) {
        if (currentSnapshot.bytesStored >= 1024 ** 3) throw new Error("FREE_TIER_BUDGET_LIMIT");
        const suggested = Math.min(1, currentSnapshot.budgetBytes / (1024 ** 3) + 0.1).toFixed(2);
        const value = window.prompt("New total storage budget in GiB (maximum 1.00 on Free)", suggested);
        if (value === null) return;
        const budgetBytes = Math.floor(Number(value) * 1024 ** 3);
        if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= currentSnapshot.bytesStored) throw new Error("BUDGET_MUST_EXCEED_STORED_BYTES");
        if (budgetBytes > 1024 ** 3) throw new Error("FREE_TIER_BUDGET_LIMIT");
        body = { budgetBytes };
      }
      await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/" + name, {
        method: "POST", body: JSON.stringify(body)
      });
      notice(name === "cancel" ? "Stop requested. Queued work is stopping." : "Job updated.", "success");
      await refresh();
    } catch (error) {
      notice(error.message === "FREE_TIER_BUDGET_LIMIT"
        ? "The Free-tier job limit is 1 GiB. Export, verify and clear this job before starting another."
        : error.message || "REQUEST_FAILED", "error");
    }
  }

  async function openJob(jobId, quiet = false) {
    const candidate = String(jobId || "").trim();
    if (!/^[a-z0-9-]{16,64}$/.test(candidate)) throw new Error("Enter a valid job ID.");
    try {
      const snapshot = await api("/api/jobs/" + encodeURIComponent(candidate), { method: "GET", headers: {} });
      if (activeJobId && activeJobId !== candidate) rememberRecoveryJob(activeJobId);
      activeJobId = candidate;
      localStorage.setItem(ACTIVE_JOB_KEY, activeJobId);
      $("job-id").textContent = "Job " + activeJobId;
      $("job-panel").hidden = false;
      $("verification-file").value = "";
      lastProgressLine = "";
      render(snapshot);
      if (!quiet) appendLine("Reopened job " + activeJobId, "good");
      $("terminal-state").textContent = snapshot.status;
      flow = { step: "running" };
      disablePrompt("Job open — use the controls below");
      if (!["completed", "cancelled", "verified", "abandoned"].includes(snapshot.status)) {
        refreshTimer = setTimeout(refresh, 1500);
      }
      return snapshot;
    } catch (error) {
      if (!quiet) appendLine("Could not open job: " + (error.message || "JOB_NOT_FOUND"), "error");
      throw error;
    }
  }

  $("recover-button").addEventListener("click", async () => {
    try { await openJob($("recover-job-id").value); }
    catch (error) { appendLine(error.message || "JOB_NOT_FOUND", "error"); }
  });
  $("recover-job-id").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("recover-button").click();
  });

  $("pause-button").addEventListener("click", () => jobAction("pause"));
  $("resume-button").addEventListener("click", () => jobAction("resume"));
  $("cancel-button").addEventListener("click", () => {
    if (window.confirm("Stop this job? Downloaded images will remain available for export.")) jobAction("cancel");
  });
  $("new-attempt-button").addEventListener("click", () => {
    if (!activeJobId) return;
    rememberRecoveryJob(activeJobId);
    activeJobId = "";
    localStorage.removeItem(ACTIVE_JOB_KEY);
    lastProgressLine = "";
    startNewFlow();
  });

  $("manifest-button").addEventListener("click", async () => {
    if (!activeJobId) return;
    try {
      const response = await fetch("/api/jobs/" + encodeURIComponent(activeJobId) + "/manifest", {
        credentials: "same-origin", cache: "no-store"
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "MANIFEST_FAILED");
      }
      const file = await response.blob();
      const link = document.createElement("a");
      const objectUrl = URL.createObjectURL(file);
      link.href = objectUrl;
      link.download = "manifest-" + activeJobId + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      notice("Manifest downloaded. Export and verify it with the repository scripts.", "success");
    } catch (error) { notice(error.message || "MANIFEST_FAILED", "error"); }
  });

  $("verification-file").addEventListener("change", () => {
    if (currentSnapshot) setButtonState(currentSnapshot);
  });
  $("verify-button").addEventListener("click", async () => {
    const file = $("verification-file").files[0];
    if (!file || !activeJobId) return;
    try {
      const report = JSON.parse(await file.text());
      const result = await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/verify", {
        method: "POST", body: JSON.stringify(report)
      });
      notice(result.verified ? "Local export verification accepted." : "Verification did not pass.", result.verified ? "success" : "error");
      await refresh();
    } catch (error) { notice(error.message || "VERIFICATION_FAILED", "error"); }
  });

  $("clear-button").addEventListener("click", async () => {
    if (!activeJobId || !currentSnapshot ||
      (currentSnapshot.status !== "abandoned" && !currentSnapshot.verified)) return;
    if (!window.confirm("Delete all R2 objects for this job and erase its job state? This cannot be undone.")) return;
    $("clear-button").disabled = true;
    try {
      const receipt = await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/clear", {
        method: "POST", body: "{}"
      });
      clearTimeout(refreshTimer);
      appendLine("Cleared " + receipt.deletedObjects + " R2 objects. Job state was deleted.", "good");
      currentSnapshot = null;
      activeJobId = "";
      localStorage.removeItem(ACTIVE_JOB_KEY);
      $("job-panel").hidden = true;
      $("retention-countdown").hidden = true;
      startNewFlow();
    } catch (error) {
      notice(error.message || "CLEAR_FAILED", "error");
      if (currentSnapshot) setButtonState(currentSnapshot);
    }
  });

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("app-password").value;
    $("login-button").disabled = true;
    $("login-button").textContent = "Checking…";
    $("auth-notice").textContent = "";
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password })
      });
      $("app-password").value = "";
      $("terminal-output").replaceChildren();
      enterConsole();
    } catch (error) {
      $("auth-notice").textContent = error.message === "LOGIN_RATE_LIMITED"
        ? "Too many attempts. Try again after the lockout expires."
        : error.message === "INVALID_PASSWORD"
          ? "Incorrect password."
          : "Login failed. Check the Worker secrets and try again.";
    } finally {
      $("login-button").disabled = false;
      $("login-button").textContent = "Unlock console";
    }
  });

  $("logout-button").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); }
    finally { lockConsole("Console locked."); }
  });

  async function boot() {
    try {
      const status = await api("/api/auth/status", { method: "GET", headers: {} });
      if (!status.configured) {
        lockConsole("Password login is not configured. Add APP_PASSWORD and SESSION_SECRET as Worker secrets.", false);
      } else if (status.authenticated) {
        $("terminal-output").replaceChildren();
        enterConsole();
      } else {
        lockConsole("Enter the password to unlock the remote console.");
      }
    } catch {
      lockConsole("Unable to check authentication. Refresh the page to try again.");
    }
  }

  boot();
})();
