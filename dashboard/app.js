(() => {
  const $ = (id) => document.getElementById(id);
  let activeJobId = "";
  let currentSnapshot = null;
  let refreshTimer = null;

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
    if (!response.ok) throw new Error(data.error || "REQUEST_FAILED");
    return data;
  }

  function setButtonState(snapshot) {
    const finished = snapshot.status === "completed" || snapshot.status === "cancelled";
    $("pause-button").hidden = snapshot.status !== "running";
    $("resume-button").hidden = snapshot.status !== "paused";
    $("cancel-button").disabled = finished || snapshot.status === "clearing";
    $("manifest-button").disabled = !finished || snapshot.pendingPages > 0 || snapshot.pendingImages > 0 || snapshot.bytesReserved > 0;
    $("verify-button").disabled = !$("verification-file").files.length || !finished;
    $("clear-button").disabled = !snapshot.verified || !finished;
    $("verification-state").textContent = snapshot.verified ? "Local verification passed. Clear is enabled." : "Verification has not passed.";
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
      if (snapshot.status === "completed" || snapshot.status === "cancelled") {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      } else {
        refreshTimer = setTimeout(refresh, 4000);
      }
    } catch (error) {
      notice(error.message || "STATUS_UNAVAILABLE", "error");
      refreshTimer = setTimeout(refresh, 8000);
    }
  }

  async function action(name) {
    if (!activeJobId) return;
    try {
      await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/" + name, { method: "POST", body: "{}" });
      notice(name === "cancel" ? "Stop requested. Queued tasks are being drained." : "Job updated.", "success");
      await refresh();
    } catch (error) {
      notice(error.message || "REQUEST_FAILED", "error");
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
      notice(result.verified ? "Verification passed." : "Verification did not pass.", result.verified ? "success" : "error");
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
    } catch (error) {
      notice(error.message || "CLEAR_FAILED", "error");
      if (currentSnapshot) setButtonState(currentSnapshot);
    }
  });
})();