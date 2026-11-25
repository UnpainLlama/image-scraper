(() => {
  const $ = (id) => document.getElementById(id);
  let activeJobId = localStorage.getItem("image-scraper-active-job") || "";
  let currentSnapshot = null;
  let refreshTimer = null;
  let isAuthenticated = false;

  function lockDashboard(message, configured = true) {
    isAuthenticated = false;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    $("auth-panel").hidden = false;
    $("login-form").hidden = !configured;
    $("new-job-panel").hidden = true;
    $("job-panel").hidden = true;
    $("logout-button").hidden = true;
    $("auth-notice").textContent = message || "";
    $("app-password").value = "";
  }

  function enterDashboard() {
    isAuthenticated = true;
    $("auth-panel").hidden = true;
    $("logout-button").hidden = false;
    if (activeJobId) {
      $("recover-job-id").value = activeJobId;
      $("job-id").textContent = "Job " + activeJobId;
      $("job-panel").hidden = false;
      $("new-job-panel").hidden = true;
      refresh();
    } else {
      $("job-panel").hidden = true;
      $("new-job-panel").hidden = false;
    }
  }

  function bytes(value) {
    if (value < 1024) return value + " B";
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let number = value;
    let index = -1;
    do { number /= 1024; index += 1; } while (number >= 1024 && index < units.length - 1);
    return number.toFixed(2) + " " + units[index];
  }

  function notice(message, kind) {
    $("job-notice").textContent = message || "";
    $("job-notice").className = "notice " + (kind || "");
  }

  async function api(path, options) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { "content-type": "application/json", ...((options && options.headers) || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && data.error === "AUTH_REQUIRED") lockDashboard("Session expired. Enter the password to continue.");
      throw new Error(data.error || "REQUEST_FAILED");
    }
    return data;
  }

  function setButtonState(snapshot) {
    const tasks = snapshot.taskCounts || { pending: snapshot.pendingPages + snapshot.pendingImages, leased: 0 };
    const partialExportState = ["paused", "budget-paused", "verified"].includes(snapshot.status);
    const settled = tasks.leased === 0 && snapshot.bytesReserved === 0;
    const allDone = tasks.pending === 0 && snapshot.pendingPages === 0 && snapshot.pendingImages === 0;
    const canExport = ["completed", "cancelled"].includes(snapshot.status) ? settled && allDone : partialExportState && settled;
    $("pause-button").hidden = snapshot.status !== "running";
    $("resume-button").hidden = !["paused", "budget-paused", "verified"].includes(snapshot.status);
    $("cancel-button").disabled = ["completed", "cancelled", "clearing", "clearing_failed", "abandoned"].includes(snapshot.status);
    $("manifest-button").disabled = !canExport;
    $("verify-button").disabled = !$("verification-file").files.length || !canExport;
    $("clear-button").disabled = !(snapshot.status === "abandoned" || (snapshot.verified && allDone && tasks.leased === 0));
    $("verification-state").textContent = snapshot.verified
      ? "Attested by local export script. Clear is enabled when all queued work is drained."
      : "Not attested by the local export script.";
    const countdown = $("retention-countdown");
    if (snapshot.cleanupAt) {
      const remaining = Math.max(0, snapshot.cleanupAt - Date.now());
      const days = Math.floor(remaining / 86400000);
      const hours = Math.floor((remaining % 86400000) / 3600000);
      countdown.hidden = false;
      countdown.textContent = "Automatic deletion in " + days + " days, " + hours + " hours if this abandoned job is not resumed or cleared.";
    } else {
      countdown.hidden = true;
      countdown.textContent = "";
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
    $("storage-meter").style.width = Math.min(100, (snapshot.bytesStored / Math.max(1, snapshot.budgetBytes)) * 100) + "%";

    const errors = snapshot.failedByCode || [];
    $("error-list").hidden = errors.length === 0;
    $("error-list").innerHTML = "";
    if (errors.length) {
      const heading = document.createElement("strong");
      heading.textContent = "Error counts (no source URLs retained)";
      $("error-list").appendChild(heading);
      errors.forEach((item) => {
        const line = document.createElement("div");
        const code = document.createElement("span");
        const count = document.createElement("b");
        code.textContent = item.code;
        count.textContent = String(item.count);
        line.append(code, count);
        $("error-list").appendChild(line);
      });
    }
    setButtonState(snapshot);
  }

  async function refresh() {
    if (!activeJobId) return;
    try {
      const snapshot = await api("/api/jobs/" + encodeURIComponent(activeJobId), { method: "GET", headers: {} });
      render(snapshot);
      const queueDrained = snapshot.pendingPages === 0 && snapshot.pendingImages === 0 && snapshot.bytesReserved === 0;
      if (snapshot.status === "completed" || (snapshot.status === "cancelled" && queueDrained)) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      } else {
        refreshTimer = setTimeout(refresh, 4000);
      }
    } catch (error) {
      if (!isAuthenticated) return;
      notice(error.message || "STATUS_UNAVAILABLE", "error");
      refreshTimer = setTimeout(refresh, 8000);
    }
  }

  async function action(name) {
    if (!activeJobId) return;
    try {
      let body = {};
      if (name === "resume" && currentSnapshot &&
        ["budget-paused", "verified"].includes(currentSnapshot.status) &&
        currentSnapshot.bytesStored >= currentSnapshot.budgetBytes * 0.95) {
        const suggested = (currentSnapshot.budgetBytes / (1024 ** 3) + 1).toFixed(2);
        const value = window.prompt("New total storage budget in GiB", suggested);
        if (value === null) return;
        const budgetBytes = Math.floor(Number(value) * (1024 ** 3));
        if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= currentSnapshot.bytesStored) {
          throw new Error("BUDGET_MUST_EXCEED_STORED_BYTES");
        }
        body = { budgetBytes };
      }
      await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/" + name, {
        method: "POST",
        body: JSON.stringify(body)
      });
      notice(name === "cancel" ? "Stop requested. Queued tasks are being stopped." : "Job updated.", "success");
      await refresh();
    } catch (error) {
      notice(error.message || "REQUEST_FAILED", "error");
    }
  }

  async function openJob(jobId) {
    const candidate = String(jobId || "").trim();
    if (!/^[a-z0-9-]{16,64}$/.test(candidate)) {
      notice("Enter a valid job ID.", "error");
      return;
    }
    try {
      const snapshot = await api("/api/jobs/" + encodeURIComponent(candidate), { method: "GET", headers: {} });
      activeJobId = candidate;
      localStorage.setItem("image-scraper-active-job", activeJobId);
      $("job-id").textContent = "Job " + activeJobId;
      $("job-panel").hidden = false;
      $("new-job-panel").hidden = true;
      render(snapshot);
      notice("Existing job opened.", "success");
      refresh();
    } catch (error) {
      notice(error.message || "JOB_NOT_FOUND", "error");
    }
  }

  $("concurrency").addEventListener("input", () => {
    $("concurrency-value").textContent = $("concurrency").value;
  });
  $("mode").addEventListener("change", () => {
    $("depth-field").hidden = $("mode").value !== "crawl";
  });

  $("job-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const pages = $("pages").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    $("start-button").disabled = true;
    $("start-button").textContent = "Starting…";
    try {
      const result = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          siteUrl: $("site-url").value.trim(),
          pages,
          mode: $("mode").value,
          concurrency: Number($("concurrency").value),
          maxDepth: Number($("depth").value)
        })
      });
      activeJobId = result.jobId;
      localStorage.setItem("image-scraper-active-job", activeJobId);
      $("job-id").textContent = "Job " + activeJobId;
      $("job-panel").hidden = false;
      $("new-job-panel").hidden = true;
      $("verification-file").value = "";
      render(result.snapshot);
      notice("Job started.", "success");
      refreshTimer = setTimeout(refresh, 1500);
    } catch (error) {
      window.alert(error.message || "JOB_START_FAILED");
    } finally {
      $("start-button").disabled = false;
      $("start-button").textContent = "Start scraping";
    }
  });

  $("recover-button").addEventListener("click", () => openJob($("recover-job-id").value));
  $("recover-job-id").addEventListener("keydown", (event) => {
    if (event.key === "Enter") openJob($("recover-job-id").value);
  });
  $("pause-button").addEventListener("click", () => action("pause"));
  $("resume-button").addEventListener("click", () => action("resume"));
  $("cancel-button").addEventListener("click", () => {
    if (window.confirm("Stop this job? Already downloaded images will remain available for export.")) action("cancel");
  });

  $("manifest-button").addEventListener("click", async () => {
    if (!activeJobId) return;
    try {
      const response = await fetch("/api/jobs/" + encodeURIComponent(activeJobId) + "/manifest", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401 && data.error === "AUTH_REQUIRED") lockDashboard("Session expired. Enter the password to continue.");
        throw new Error(data.error || "MANIFEST_FAILED");
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = "manifest-" + activeJobId + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      notice("Manifest downloaded. Use scripts/export.sh, then scripts/verify.sh.", "success");
    } catch (error) {
      notice(error.message || "MANIFEST_FAILED", "error");
    }
  });

  $("verification-file").addEventListener("change", () => {
    if (currentSnapshot) setButtonState(currentSnapshot);
  });

  $("verify-button").addEventListener("click", async () => {
    const file = $("verification-file").files[0];
    if (!file) return;
    try {
      const report = JSON.parse(await file.text());
      const result = await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/verify", {
        method: "POST",
        body: JSON.stringify(report)
      });
      notice(result.verified ? "Local export script attestation accepted." : "Attestation did not pass.", result.verified ? "success" : "error");
      await refresh();
    } catch (error) {
      notice(error.message || "VERIFICATION_FAILED", "error");
    }
  });

  $("clear-button").addEventListener("click", async () => {
    if (!activeJobId || !currentSnapshot || !currentSnapshot.verified) return;
    if (!window.confirm("Delete all R2 objects for this job and erase its Durable Object state? This cannot be undone.")) return;
    $("clear-button").disabled = true;
    try {
      const receipt = await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/clear", { method: "POST", body: "{}" });
      clearTimeout(refreshTimer);
      $("job-status").textContent = "cleared";
      $("job-notice").textContent = "Cleared. " + receipt.deletedObjects + " R2 objects deleted; the prefix was confirmed empty and job state was deleted.";
      $("job-notice").className = "notice success";
      $("clear-button").disabled = true;
      $("manifest-button").disabled = true;
      $("pause-button").disabled = true;
      $("resume-button").disabled = true;
      $("cancel-button").disabled = true;
      currentSnapshot = null;
      activeJobId = "";
      localStorage.removeItem("image-scraper-active-job");
      $("job-panel").hidden = true;
      $("retention-countdown").hidden = true;
      $("new-job-panel").hidden = false;
      $("job-form").reset();
      $("concurrency-value").textContent = "5";
      $("depth-field").hidden = true;
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
      enterDashboard();
    } catch (error) {
      $("auth-notice").textContent = error.message === "LOGIN_RATE_LIMITED"
        ? "Too many attempts. Try again after the lockout expires."
        : error.message === "INVALID_PASSWORD"
          ? "Incorrect password."
          : "Login failed. Check the Worker secrets and try again.";
    } finally {
      $("login-button").disabled = false;
      $("login-button").textContent = "Unlock dashboard";
    }
  });

  $("logout-button").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      lockDashboard("Dashboard locked.");
    }
  });

  async function boot() {
    try {
      const status = await api("/api/auth/status", { method: "GET", headers: {} });
      if (!status.configured) {
        lockDashboard("Password login is not configured. Add APP_PASSWORD and SESSION_SECRET as Worker secrets.", false);
      } else if (status.authenticated) {
        enterDashboard();
      } else {
        lockDashboard("Enter the password to unlock the dashboard.");
      }
    } catch {
      lockDashboard("Unable to check authentication. Refresh the page to try again.");
    }
  }

  boot();
})();
