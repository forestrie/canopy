/**
 * Canopy onboard admin — request queue UI (FOR-181).
 * DOM-safe rendering; JSON admin API with problem-detail errors.
 */

const STORAGE_BASE = "canopyBaseUrl";
const STORAGE_TOKEN = "canopyOpsToken";

const baseUrlEl = document.getElementById("baseUrl");
const opsTokenEl = document.getElementById("opsToken");
const requestRowsEl = document.getElementById("requestRows");
const loadMoreEl = document.getElementById("loadMore");
const toastEl = document.getElementById("toast");
const rejectDialog = document.getElementById("rejectDialog");
const rejectForm = document.getElementById("rejectForm");
const rejectTargetEl = document.getElementById("rejectTarget");
const rejectReasonEl = document.getElementById("rejectReason");

/** @type {string | undefined} */
let listCursor;
/** @type {Array<Record<string, unknown>>} */
let allRequests = [];
/** @type {string} */
let statusFilter = "all";
/** @type {string | null} */
let pendingRejectId = null;

baseUrlEl.value = sessionStorage.getItem(STORAGE_BASE) || "";
opsTokenEl.value = sessionStorage.getItem(STORAGE_TOKEN) || "";

document.getElementById("saveConfig").addEventListener("click", () => {
  sessionStorage.setItem(STORAGE_BASE, baseUrlEl.value.trim());
  sessionStorage.setItem(STORAGE_TOKEN, opsTokenEl.value.trim());
  showToast("Config saved");
});

document.getElementById("refresh").addEventListener("click", () => {
  void reloadRequests(true);
});

loadMoreEl.addEventListener("click", () => {
  void loadRequests(false);
});

for (const chip of document.querySelectorAll(".chip[data-filter]")) {
  chip.addEventListener("click", () => {
    for (const c of document.querySelectorAll(".chip[data-filter]")) {
      c.classList.remove("active");
    }
    chip.classList.add("active");
    statusFilter = chip.getAttribute("data-filter") || "all";
    renderRequests();
  });
}

document.getElementById("rejectCancel").addEventListener("click", () => {
  rejectDialog.close();
  pendingRejectId = null;
});

rejectForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!pendingRejectId) return;
  const reason = rejectReasonEl.value.trim();
  void (async () => {
    try {
      await api(
        `/api/onboarding/admin/requests/${pendingRejectId}/reject`,
        "POST",
        reason ? { rejectReason: reason } : undefined,
      );
      rejectDialog.close();
      pendingRejectId = null;
      rejectReasonEl.value = "";
      showToast("Request rejected");
      await reloadRequests(true);
    } catch (err) {
      showToast(String(err), true);
    }
  })();
});

function apiBase() {
  const base = baseUrlEl.value.trim().replace(/\/$/, "");
  if (!base) throw new Error("Configure Canopy API base URL");
  const token = opsTokenEl.value.trim();
  if (!token) throw new Error("Configure ops admin token");
  return { base, token };
}

/**
 * @param {string} path
 * @param {string} [method]
 * @param {unknown} [jsonBody]
 */
async function api(path, method = "GET", jsonBody) {
  const { base, token } = apiBase();
  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
  if (jsonBody !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(jsonBody);
  }
  const res = await fetch(`${base}${path}`, init);
  const ct = res.headers.get("content-type") || "";
  /** @type {Record<string, unknown> | string | null} */
  let body = null;
  if (ct.includes("application/json")) {
    body = await res.json();
  } else {
    body = await res.text();
  }
  if (!res.ok) {
    const detail =
      typeof body === "object" && body && "detail" in body
        ? String(body.detail)
        : typeof body === "object" && body && "title" in body
          ? String(body.title)
          : `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return body;
}

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.remove("hidden");
  window.setTimeout(() => toastEl.classList.add("hidden"), 5000);
}

function truncate(value, max = 12) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatEpoch(sec) {
  if (typeof sec !== "number") return "";
  return new Date(sec * 1000).toLocaleString();
}

function textCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function statusClass(status) {
  return `status-${status}`;
}

/**
 * @param {Record<string, unknown>} row
 */
function renderRow(row, tbody) {
  const tr = document.createElement("tr");
  tr.append(
    textCell(String(row.label ?? "")),
    (() => {
      const td = document.createElement("td");
      const span = document.createElement("span");
      const status = String(row.status ?? "");
      span.textContent = status;
      span.className = statusClass(status);
      td.appendChild(span);
      return td;
    })(),
    textCell(String(row.chainBinding?.chainId ?? "")),
    textCell(truncate(row.chainBinding?.univocityAddr, 10)),
    textCell(String(row.contactEmail ?? "")),
    textCell(formatEpoch(row.createdAt)),
    textCell(formatEpoch(row.expiresAt)),
  );

  const actionsTd = document.createElement("td");
  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.textContent = "Detail";
  detailBtn.addEventListener("click", () => toggleDetail(row, tr));
  actionsTd.appendChild(detailBtn);

  if (row.status === "pending") {
    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => {
      void confirmApprove(String(row.requestId), String(row.label ?? ""));
    });
    actionsTd.appendChild(approveBtn);

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", () =>
      openReject(String(row.requestId), String(row.label ?? "")),
    );
    actionsTd.appendChild(rejectBtn);
  }

  tr.appendChild(actionsTd);
  tbody.appendChild(tr);
}

/**
 * @param {Record<string, unknown>} row
 * @param {HTMLTableRowElement} anchor
 */
function toggleDetail(row, anchor) {
  const next = anchor.nextElementSibling;
  if (next?.classList.contains("detail-row")) {
    next.remove();
    return;
  }
  const detailTr = document.createElement("tr");
  detailTr.className = "detail-row";
  const td = document.createElement("td");
  td.colSpan = 8;
  const lines = [
    `Request ID: ${row.requestId ?? ""}`,
    `Mandate origin: ${row.mandateOrigin ?? "—"}`,
    `Planned forest R: ${row.plannedForestR ?? "—"}`,
    `Reject reason: ${row.rejectReason ?? "—"}`,
    `Onboard token ref: ${row.onboardTokenRef ?? "—"}`,
  ];
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    p.style.margin = "0.25rem 0";
    td.appendChild(p);
  }
  detailTr.appendChild(td);
  anchor.insertAdjacentElement("afterend", detailTr);
}

async function confirmApprove(requestId, label) {
  if (!window.confirm(`Approve onboard request "${label}"?`)) return;
  try {
    await api(`/api/onboarding/admin/requests/${requestId}/approve`, "POST");
    showToast("Request approved");
    await reloadRequests(true);
  } catch (err) {
    showToast(String(err), true);
  }
}

function openReject(requestId, label) {
  pendingRejectId = requestId;
  rejectTargetEl.textContent = label;
  rejectReasonEl.value = "";
  rejectDialog.showModal();
}

function filteredRequests() {
  if (statusFilter === "all") return allRequests;
  return allRequests.filter((r) => r.status === statusFilter);
}

function renderRequests() {
  requestRowsEl.replaceChildren();
  const rows = filteredRequests();
  rows.sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (b.status === "pending" && a.status !== "pending") return 1;
    return Number(b.createdAt) - Number(a.createdAt);
  });
  for (const row of rows) {
    renderRow(row, requestRowsEl);
  }
}

async function loadRequests(reset) {
  try {
    const path =
      listCursor && !reset
        ? `/api/onboarding/admin/requests?cursor=${encodeURIComponent(listCursor)}`
        : "/api/onboarding/admin/requests";
    const data = await api(path);
    const batch = Array.isArray(data.requests) ? data.requests : [];
    if (reset) {
      allRequests = batch;
    } else {
      allRequests = allRequests.concat(batch);
    }
    listCursor = typeof data.cursor === "string" ? data.cursor : undefined;
    loadMoreEl.classList.toggle("hidden", !listCursor);
    renderRequests();
  } catch (err) {
    showToast(String(err), true);
  }
}

async function reloadRequests(reset) {
  if (reset) listCursor = undefined;
  await loadRequests(reset);
}

void reloadRequests(true);
