if (typeof browser === "undefined") var browser = chrome;

const RELAUNCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const CHAR_COLORS = [
  "#c53131", "#2d5aa0", "#2d8a5e", "#8a4f2d",
  "#6e2d8a", "#8a7a2d", "#2d7a8a", "#8a2d4a"
];

// In-memory session status cache (not persisted)
const sessionStatuses = {};

// Which character's expand form is currently open, and in which mode
let expandedCharId = null;
let expandedMode = null; // "join" | "password"

// Which DM campaign's expand form is currently open
let expandedDmCampaignId = null;

// Dev override: show all owned campaigns regardless of dmId filter (in-memory only)
let dmDevOverride = false;

// ---------------------------------------------------------------------------
// Invite URL parsing
// ---------------------------------------------------------------------------

function parseInviteUrl(urlStr) {
  try {
    const u = new URL((urlStr || "").trim());
    const m = u.pathname.match(/^\/join\/(.+)$/);
    if (!m) return null;
    return { serverUrl: `${u.protocol}//${u.host}`, inviteCode: decodeURIComponent(m[1]) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function getState() {
  const defaults = {
    servers: [], activeServerId: null, lastSession: null,
    ddbUser: null, ddbCharacterList: null,
    savedEmail: "", campaignConnections: [],
    ddbOwnedCampaigns: [], dmConnections: []
  };
  const data = await browser.storage.local.get(Object.keys(defaults));
  return { ...defaults, ...data };
}

async function saveState(patch) {
  await browser.storage.local.set(patch);
}

// ---------------------------------------------------------------------------
// Server management (internal)
// ---------------------------------------------------------------------------

async function ensureServer(serverUrl) {
  const norm = serverUrl.replace(/\/$/, "");
  const { servers } = await getState();
  const hit = servers.find(s => s.url.replace(/\/$/, "") === norm);
  if (hit) { await saveState({ activeServerId: hit.id }); return hit.id; }
  const id = crypto.randomUUID();
  const srv = { id, name: new URL(norm).hostname, url: norm, serverCode: "" };
  await saveState({ servers: [...servers, srv], activeServerId: id });
  return id;
}

// ---------------------------------------------------------------------------
// Campaign connections
// ---------------------------------------------------------------------------

async function saveCampaignConnection({ ddbCharacterId, serverUrl, inviteCode, inviteUrl, campaignName, campaignId }) {
  const serverId = await ensureServer(serverUrl);
  const { campaignConnections: conns } = await getState();
  const existing = conns.find(c => c.ddbCharacterId === ddbCharacterId);
  const conn = {
    id: existing?.id ?? crypto.randomUUID(),
    serverId, serverUrl, inviteCode, inviteUrl,
    ddbCharacterId,
    campaignName: campaignName || existing?.campaignName || null,
    campaignId: campaignId || existing?.campaignId || null,
    lastConnectedAt: Date.now()
  };
  const next = existing
    ? conns.map(c => c.ddbCharacterId === ddbCharacterId ? conn : c)
    : [...conns, conn];
  await saveState({ campaignConnections: next, savedInviteCode: inviteCode });
  return conn;
}

async function deleteCampaignConnection(connId) {
  const { campaignConnections } = await getState();
  await saveState({ campaignConnections: campaignConnections.filter(c => c.id !== connId) });
}

function findConn(connections, ddbCharacterId) {
  return connections.find(c => c.ddbCharacterId === ddbCharacterId) || null;
}

async function saveDmConnection({ ddbCampaignId, serverUrl, inviteCode, inviteUrl, campaignName, campaignId }) {
  const serverId = await ensureServer(serverUrl);
  const { dmConnections: conns } = await getState();
  const existing = conns.find(c => c.ddbCampaignId === ddbCampaignId);
  const conn = {
    id: existing?.id ?? crypto.randomUUID(),
    serverId, serverUrl, inviteCode, inviteUrl,
    ddbCampaignId,
    campaignName: campaignName || existing?.campaignName || null,
    campaignId: campaignId || existing?.campaignId || null, // VTT-Chat campaign ID
    lastConnectedAt: Date.now()
  };
  const next = existing
    ? conns.map(c => c.ddbCampaignId === ddbCampaignId ? conn : c)
    : [...conns, conn];
  await saveState({ dmConnections: next, savedInviteCode: inviteCode });
  return conn;
}

function findDmConn(dmConnections, ddbCampaignId) {
  return dmConnections.find(c => c.ddbCampaignId === ddbCampaignId) || null;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function byId(id) { return document.getElementById(id); }

function showStatus(text, kind) {
  const el = byId("status");
  el.textContent = text;
  el.className = `status-box ${kind || ""}`;
  el.style.display = "block";
}

function hideStatus() { byId("status").style.display = "none"; }

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function charColor(id) {
  return CHAR_COLORS[Math.abs(Number(id) || 0) % CHAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// User bar + email toggle
// ---------------------------------------------------------------------------

let emailExpanded = false;

function renderUser(ddbUser, savedEmail) {
  const nameEl  = byId("user-name");
  const subEl   = byId("user-sub");
  const imgEl   = byId("user-avatar-img");
  const initEl  = byId("user-avatar-init");
  const chevron = byId("user-chevron");
  const bar     = byId("user-bar");

  if (!ddbUser) {
    nameEl.textContent = "Not signed in to D&D Beyond";
    subEl.textContent  = "Open a D&D Beyond page first";
    initEl.textContent = "?"; initEl.style.display = "flex"; imgEl.style.display = "none";
    chevron.style.display = "none";
    bar.className = "user-bar no-user";
    openEmailSection(true, savedEmail);
    return;
  }

  bar.className = "user-bar";
  nameEl.textContent = ddbUser.displayName || "D&D Beyond User";
  subEl.textContent  = ddbUser.email || savedEmail || `User #${ddbUser.id}`;

  if (ddbUser.avatarUrl) {
    imgEl.src = ddbUser.avatarUrl;
    imgEl.style.display = "block"; initEl.style.display = "none";
  } else {
    initEl.textContent = (ddbUser.displayName || "?")[0].toUpperCase();
    initEl.style.display = "flex"; imgEl.style.display = "none";
  }

  chevron.style.display = "block";
  chevron.className = `user-chevron${emailExpanded ? " open" : ""}`;

  // Auto-open if no email is known at all
  const needsEmail = !ddbUser.email && !savedEmail;
  openEmailSection(emailExpanded || needsEmail, ddbUser.email || savedEmail);
}

function openEmailSection(show, prefill) {
  const section = byId("email-section");
  section.style.display = show ? "block" : "none";
  if (show && prefill && !byId("user-email").value) byId("user-email").value = prefill;
}

function setupUserBarToggle(ddbUser) {
  byId("user-bar").addEventListener("click", () => {
    if (!ddbUser) return;
    emailExpanded = !emailExpanded;
    byId("user-chevron").className = `user-chevron${emailExpanded ? " open" : ""}`;
    openEmailSection(emailExpanded, ddbUser?.email || "");
    if (emailExpanded) setTimeout(() => byId("user-email")?.focus(), 50);
  });

  byId("user-email").addEventListener("change", async () => {
    const v = byId("user-email").value.trim();
    if (v) await saveState({ savedEmail: v });
  });
}

// ---------------------------------------------------------------------------
// Character list
// ---------------------------------------------------------------------------

function renderCharacters(ddbCharacterList, campaignConnections) {
  const container = byId("character-list");
  container.innerHTML = "";

  if (!ddbCharacterList?.length) {
    container.innerHTML = `
      <p style="color:#555;font-size:12px;margin:6px 0 10px;">
        No characters found — open a D&amp;D Beyond character or campaign page.
      </p>`;
    return;
  }

  for (const char of ddbCharacterList) {
    const conn   = findConn(campaignConnections, char.id);
    const status = conn ? (sessionStatuses[conn.id] ?? "saved") : "none";
    container.appendChild(buildCard(char, conn, status));
    container.appendChild(buildExpandForm(char, conn));
  }

  // Restore any previously open form (e.g. after rerender)
  if (expandedCharId != null) {
    const card = document.querySelector(`.char-card[data-char-id="${expandedCharId}"]`);
    const form = byId(`expand-form-${expandedCharId}`);
    if (card && form) {
      card.classList.add("selected");
      form.classList.add("open");
      applyExpandMode(expandedCharId, expandedMode);
    }
  }
}

function renderDmCampaigns(ddbOwnedCampaigns, dmConnections, ddbUser) {
  const section = byId("dm-section");
  const container = byId("dm-campaign-list");

  // Only show campaigns where the logged-in user is the DM.
  // If dmId is null (API didn't return it) we include it to be safe.
  const filtered = dmDevOverride
    ? (ddbOwnedCampaigns || [])
    : (ddbOwnedCampaigns || []).filter(c =>
        c.dmId == null || String(c.dmId) === String(ddbUser?.id || "")
      );

  if (!filtered.length) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";

  // Rebuild the section label with optional dev-override toggle
  const existingLabel = section.querySelector(".section-label");
  if (existingLabel) {
    existingLabel.innerHTML = "";
    existingLabel.appendChild(document.createTextNode("Your Campaigns (DM)"));
    const devBtn = document.createElement("button");
    devBtn.textContent = dmDevOverride ? "DEV: All" : "DEV";
    devBtn.title = "Toggle dev override — show all campaigns regardless of DM filter";
    devBtn.style.cssText =
      "margin-left:8px;padding:1px 6px;font-size:9px;font-weight:700;" +
      `background:${dmDevOverride ? "#7a2d8a" : "#2a2a4a"};color:#aaa;` +
      "border:1px solid #555;border-radius:3px;cursor:pointer;vertical-align:middle;";
    devBtn.addEventListener("click", () => {
      dmDevOverride = !dmDevOverride;
      renderDmCampaigns(ddbOwnedCampaigns, dmConnections, ddbUser);
    });
    existingLabel.appendChild(devBtn);
  }

  container.innerHTML = "";

  for (const campaign of filtered) {
    const conn = findDmConn(dmConnections, campaign.id);
    container.appendChild(buildDmCard(campaign, conn));
    container.appendChild(buildDmExpandForm(campaign, conn));
  }

  if (expandedDmCampaignId != null) {
    const card = document.querySelector(`.char-card[data-dm-campaign-id="${expandedDmCampaignId}"]`);
    const form = byId(`dm-expand-form-${expandedDmCampaignId}`);
    if (card && form) {
      card.classList.add("selected");
      form.classList.add("open");
    }
  }
}

function buildDmCard(campaign, conn) {
  const card = document.createElement("div");
  card.className = "char-card";
  card.dataset.dmCampaignId = String(campaign.id);

  const badge = document.createElement("div");
  badge.className = "dm-badge";
  badge.textContent = "DM";

  const info = document.createElement("div");
  info.className = "char-info";

  const nameEl = document.createElement("div");
  nameEl.className = "char-name";
  nameEl.textContent = campaign.name || `Campaign #${campaign.id}`;
  info.appendChild(nameEl);

  const det = document.createElement("div");
  det.className = "char-detail";
  const memberStr = campaign.memberCount != null
    ? `${campaign.memberCount} member${campaign.memberCount !== 1 ? "s" : ""}`
    : "Dungeon Master";
  const dmStr = campaign.dmUsername ? ` · DM: ${campaign.dmUsername}` : "";
  det.textContent = memberStr + dmStr;
  info.appendChild(det);

  if (conn) {
    const camp = document.createElement("div");
    camp.className = "char-campaign";
    camp.textContent = conn.campaignName || conn.serverUrl;
    info.appendChild(camp);
  }

  const right = document.createElement("div");
  right.className = "char-right";

  if (conn) {
    if (conn.campaignId) {
      const syncBtn = document.createElement("button");
      syncBtn.className = "char-edit-btn";
      syncBtn.id = `dm-sync-btn-${campaign.id}`;
      syncBtn.title = "Re-sync campaign & party data to VTT-Chat";
      syncBtn.textContent = "↻";
      syncBtn.style.fontSize = "16px";
      syncBtn.addEventListener("click", e => {
        e.stopPropagation();
        handleDmSync(campaign, conn, syncBtn);
      });
      right.appendChild(syncBtn);
    }

    const editBtn = document.createElement("button");
    editBtn.className = "char-edit-btn";
    editBtn.title = "Change connection";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", e => {
      e.stopPropagation();
      toggleDmExpand(campaign.id);
    });
    right.appendChild(editBtn);
  }

  card.appendChild(badge);
  card.appendChild(info);
  card.appendChild(right);

  card.addEventListener("click", () => handleDmCardClick(campaign, conn));
  return card;
}

function buildDmExpandForm(campaign, conn) {
  const wrap = document.createElement("div");
  wrap.className = "char-expand-form";
  wrap.id = `dm-expand-form-${campaign.id}`;

  const urlLabel = document.createElement("label");
  urlLabel.textContent = "Invite URL";
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.id = `dm-invite-url-${campaign.id}`;
  urlInput.placeholder = "https://server/join/CODE";
  urlInput.autocomplete = "off";
  if (conn?.inviteUrl) urlInput.value = conn.inviteUrl;
  urlLabel.appendChild(urlInput);
  wrap.appendChild(urlLabel);

  const preview = document.createElement("div");
  preview.className = "url-preview";
  preview.id = `dm-url-preview-${campaign.id}`;
  wrap.appendChild(preview);

  if (conn) {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:#555;margin-top:4px;";
    hint.textContent = `Current: ${conn.campaignName || conn.serverUrl} — paste a new URL to switch.`;
    wrap.appendChild(hint);
  }

  const launchBtn = document.createElement("button");
  launchBtn.className = "btn-primary mt8";
  launchBtn.id = `dm-launch-btn-${campaign.id}`;
  launchBtn.textContent = conn ? "Update & Launch as DM" : "Connect & Launch as DM";
  wrap.appendChild(launchBtn);

  setTimeout(() => {
    urlInput.addEventListener("input", () => updatePreview(urlInput.value, preview));
    if (urlInput.value) updatePreview(urlInput.value, preview);
    launchBtn.addEventListener("click", () => handleDmJoinLaunch(campaign, urlInput));
  }, 0);

  return wrap;
}

function buildCard(char, conn, status) {
  const card = document.createElement("div");
  card.className = "char-card";
  card.dataset.charId = String(char.id);

  // Avatar
  const av = document.createElement("div");
  av.className = "char-avatar";
  av.style.background = charColor(char.id);
  if (char.avatar) {
    const img = document.createElement("img");
    img.src = char.avatar; img.alt = "";
    img.onerror = () => { av.textContent = (char.name || "?")[0].toUpperCase(); };
    av.appendChild(img);
  } else {
    av.textContent = (char.name || "?")[0].toUpperCase();
  }

  // Info
  const info = document.createElement("div");
  info.className = "char-info";

  const nameEl = document.createElement("div");
  nameEl.className = "char-name";
  nameEl.textContent = char.name;
  info.appendChild(nameEl);

  const parts = [char.class, char.race, char.level ? `Level ${char.level}` : null].filter(Boolean);
  if (parts.length) {
    const det = document.createElement("div");
    det.className = "char-detail";
    det.textContent = parts.join(" · ");
    info.appendChild(det);
  }

  if (conn) {
    const camp = document.createElement("div");
    camp.className = "char-campaign";
    camp.textContent = conn.campaignName || conn.serverUrl;
    info.appendChild(camp);
  }

  // Right: edit button (for connected chars) + status dot
  const right = document.createElement("div");
  right.className = "char-right";

  if (conn) {
    const editBtn = document.createElement("button");
    editBtn.className = "char-edit-btn";
    editBtn.title = "Change connection";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", e => {
      e.stopPropagation();
      toggleExpand(char.id, conn, "join");
    });
    right.appendChild(editBtn);
  }

  const dot = document.createElement("div");
  dot.className = `status-dot ${status}`;
  dot.id = `status-dot-${char.id}`;
  dot.title = statusLabel(status);
  right.appendChild(dot);

  card.appendChild(av);
  card.appendChild(info);
  card.appendChild(right);

  card.addEventListener("click", () => handleCardClick(char, conn));
  return card;
}

function statusLabel(s) {
  if (s === "none")     return "No campaign connection — click to add one";
  if (s === "saved")    return "Connection saved — click to launch";
  if (s === "active")   return "Session active — click to launch";
  if (s === "offline")  return "Server appears offline";
  if (s === "checking") return "Checking…";
  return "Connected";
}

function buildExpandForm(char, conn) {
  const wrap = document.createElement("div");
  wrap.className = "char-expand-form";
  wrap.id = `expand-form-${char.id}`;

  // ── Join section ──
  const joinSec = document.createElement("div");
  joinSec.id = `join-section-${char.id}`;

  const urlLabel = document.createElement("label");
  urlLabel.textContent = "Invite URL";
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.id = `invite-url-${char.id}`;
  urlInput.placeholder = "https://server/join/CODE";
  urlInput.autocomplete = "off";
  if (conn?.inviteUrl) urlInput.value = conn.inviteUrl;
  urlLabel.appendChild(urlInput);
  joinSec.appendChild(urlLabel);

  const preview = document.createElement("div");
  preview.className = "url-preview";
  preview.id = `url-preview-${char.id}`;
  joinSec.appendChild(preview);

  if (conn) {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:#555;margin-top:4px;";
    hint.textContent = `Current: ${conn.campaignName || conn.serverUrl} — paste a new URL to switch campaigns.`;
    joinSec.appendChild(hint);
  }

  const joinBtn = document.createElement("button");
  joinBtn.className = "btn-primary mt8";
  joinBtn.id = `join-btn-${char.id}`;
  joinBtn.textContent = conn ? "Update & Launch" : "Connect & Launch";
  joinSec.appendChild(joinBtn);
  wrap.appendChild(joinSec);

  // ── Password section ──
  const pwSec = document.createElement("div");
  pwSec.id = `pw-section-${char.id}`;
  pwSec.style.display = "none";

  const pwLabel = document.createElement("label");
  pwLabel.textContent = "Password";
  const pwInput = document.createElement("input");
  pwInput.type = "password";
  pwInput.id = `password-${char.id}`;
  pwInput.placeholder = "Your VTT-Chat password";
  pwLabel.appendChild(pwInput);
  pwSec.appendChild(pwLabel);

  const pwBtn = document.createElement("button");
  pwBtn.className = "btn-primary mt8";
  pwBtn.id = `pw-btn-${char.id}`;
  pwBtn.textContent = "Login & Launch";
  pwSec.appendChild(pwBtn);
  wrap.appendChild(pwSec);

  // Wire events after elements exist in DOM (timeout ensures IDs are reachable)
  setTimeout(() => {
    urlInput.addEventListener("input", () => updatePreview(urlInput.value, preview));
    if (urlInput.value) updatePreview(urlInput.value, preview);
    joinBtn.addEventListener("click", () => handleJoinLaunch(char, urlInput, conn));
    pwBtn.addEventListener("click", () => handlePasswordLaunch(char));
  }, 0);

  return wrap;
}

function updatePreview(val, previewEl) {
  if (!val.trim()) { previewEl.className = "url-preview"; previewEl.textContent = ""; return; }
  const parsed = parseInviteUrl(val);
  if (!parsed) {
    previewEl.className = "url-preview error";
    previewEl.textContent = "Expected format: https://server/join/CODE";
  } else {
    previewEl.className = "url-preview ok";
    previewEl.textContent = `${parsed.serverUrl}  ·  Code: ${parsed.inviteCode}`;
  }
}

// ---------------------------------------------------------------------------
// Expand form management
// ---------------------------------------------------------------------------

function applyExpandMode(charId, mode) {
  const joinSec = byId(`join-section-${charId}`);
  const pwSec   = byId(`pw-section-${charId}`);
  if (joinSec) joinSec.style.display = mode === "join" ? "" : "none";
  if (pwSec)   pwSec.style.display   = mode === "password" ? "" : "none";
}

function toggleExpand(charId, conn, mode) {
  const alreadyOpen = expandedCharId === charId && expandedMode === mode;

  // Close the current open form
  if (expandedCharId != null) {
    const oldForm = byId(`expand-form-${expandedCharId}`);
    const oldCard = document.querySelector(`.char-card[data-char-id="${expandedCharId}"]`);
    oldForm?.classList.remove("open");
    oldCard?.classList.remove("selected");
  }

  expandedCharId = null;
  expandedMode = null;

  if (alreadyOpen) return; // was already open → just close

  expandedCharId = charId;
  expandedMode = mode;

  const form = byId(`expand-form-${charId}`);
  const card = document.querySelector(`.char-card[data-char-id="${charId}"]`);
  form?.classList.add("open");
  card?.classList.add("selected");
  applyExpandMode(charId, mode);

  const focusId = mode === "join" ? `invite-url-${charId}` : `password-${charId}`;
  setTimeout(() => byId(focusId)?.focus(), 50);
}

function toggleDmExpand(campaignId) {
  const alreadyOpen = expandedDmCampaignId === campaignId;

  if (expandedDmCampaignId != null) {
    byId(`dm-expand-form-${expandedDmCampaignId}`)?.classList.remove("open");
    document.querySelector(`.char-card[data-dm-campaign-id="${expandedDmCampaignId}"]`)?.classList.remove("selected");
  }
  expandedDmCampaignId = null;

  if (alreadyOpen) return;

  expandedDmCampaignId = campaignId;
  byId(`dm-expand-form-${campaignId}`)?.classList.add("open");
  document.querySelector(`.char-card[data-dm-campaign-id="${campaignId}"]`)?.classList.add("selected");
  setTimeout(() => byId(`dm-invite-url-${campaignId}`)?.focus(), 50);
}

// ---------------------------------------------------------------------------
// Card click handling
// ---------------------------------------------------------------------------

async function handleCardClick(char, conn) {
  // If this card's join form is open (from ✎ edit button), close it
  if (expandedCharId === char.id && expandedMode === "join") {
    toggleExpand(char.id, conn, "join");
    return;
  }

  // No connection → open join form
  if (!conn) {
    toggleExpand(char.id, null, "join");
    return;
  }

  // Password form already open for this card → don't re-run preflight
  if (expandedCharId === char.id && expandedMode === "password") return;

  // Has connection → launch
  const card = document.querySelector(`.char-card[data-char-id="${char.id}"]`);
  card?.classList.add("launching");
  showStatus("Connecting…", "info");
  await launchConnected(char, conn, card);
}

async function handleDmCardClick(campaign, conn) {
  if (expandedDmCampaignId === campaign.id) {
    toggleDmExpand(campaign.id);
    return;
  }

  if (!conn) {
    toggleDmExpand(campaign.id);
    return;
  }

  // Has a saved connection → launch directly
  const card = document.querySelector(`.char-card[data-dm-campaign-id="${campaign.id}"]`);
  card?.classList.add("launching");
  showStatus("Connecting as DM…", "info");

  const state = await getState();
  if (!state.ddbUser?.id) {
    showStatus("No D&D Beyond user detected — open a D&D Beyond page first.", "error");
    card?.classList.remove("launching");
    return;
  }

  await ensureServer(conn.serverUrl);
  const email = resolveEmail(state);
  const pre = await browser.runtime.sendMessage({
    type: "run-preflight",
    payload: { inviteCode: conn.inviteCode, email, externalUserId: String(state.ddbUser.id) }
  });

  if (!pre?.ok) {
    showStatus(pre?.error || "Could not reach the server.", "error");
    card?.classList.remove("launching");
    return;
  }

  const campaignName = pre.invite?.campaign?.name || conn.campaignName || "";
  await doGuestLaunchAsDm(campaign, state, email, conn.inviteCode, campaignName);
}

async function launchConnected(char, conn, card) {
  const state = await getState();
  const email = resolveEmail(state);

  if (!state.ddbUser?.id) {
    showStatus("No D&D Beyond user detected — open a D&D Beyond page first.", "error");
    card?.classList.remove("launching");
    return;
  }

  await ensureServer(conn.serverUrl);

  const pre = await browser.runtime.sendMessage({
    type: "run-preflight",
    payload: { inviteCode: conn.inviteCode, email, externalUserId: String(state.ddbUser.id) }
  });

  if (!pre?.ok) {
    showStatus(pre?.error || "Could not reach the server.", "error");
    card?.classList.remove("launching");
    return;
  }

  const campaignName = pre.invite?.campaign?.name || conn.campaignName || "";
  const flow = pre.preflight?.suggestedFlow || "guest";

  if (flow === "authenticate") {
    showStatus("Password required — enter it below.", "info");
    card?.classList.remove("launching");
    toggleExpand(char.id, conn, "password");
    return;
  }

  await doGuestLaunch(char, state, email, conn.inviteCode, campaignName);
}

// ---------------------------------------------------------------------------
// Join form launch (new connection or update)
// ---------------------------------------------------------------------------

async function handleJoinLaunch(char, urlInput) {
  const urlVal = urlInput.value.trim();
  const parsed = parseInviteUrl(urlVal);
  if (!parsed) {
    showStatus("Please enter a valid invite URL (https://server/join/CODE).", "error");
    return;
  }

  const state = await getState();
  const email = resolveEmail(state);

  if (!state.ddbUser?.id) {
    showStatus("No D&D Beyond user detected.", "error");
    return;
  }

  const btn = byId(`join-btn-${char.id}`);
  if (btn) btn.disabled = true;
  hideStatus();
  showStatus("Checking server & invite…", "info");

  const emailInput = byId("user-email");
  if (emailInput?.value.trim()) await saveState({ savedEmail: emailInput.value.trim() });

  await ensureServer(parsed.serverUrl);

  const pre = await browser.runtime.sendMessage({
    type: "run-preflight",
    payload: { inviteCode: parsed.inviteCode, email, externalUserId: String(state.ddbUser.id) }
  });

  if (!pre?.ok) {
    showStatus(pre?.error || "Server check failed.", "error");
    if (btn) btn.disabled = false;
    return;
  }

  const campaignName = pre.invite?.campaign?.name || null;
  const flow = pre.preflight?.suggestedFlow || "guest";

  await saveCampaignConnection({
    ddbCharacterId: char.id,
    serverUrl: parsed.serverUrl,
    inviteCode: parsed.inviteCode,
    inviteUrl: urlVal,
    campaignName
  });

  if (flow === "authenticate") {
    showStatus(`Invite valid for "${campaignName || parsed.inviteCode}". Enter your password.`, "info");
    if (btn) btn.disabled = false;
    // Switch to password section within same expand form
    expandedMode = "password";
    applyExpandMode(char.id, "password");
    setTimeout(() => byId(`password-${char.id}`)?.focus(), 50);
    return;
  }

  const freshState = await getState();
  await doGuestLaunch(char, freshState, email, parsed.inviteCode, campaignName || "");
  if (btn) btn.disabled = false;
}

// ---------------------------------------------------------------------------
// DM join + launch
// ---------------------------------------------------------------------------

async function handleDmJoinLaunch(campaign, urlInput) {
  const urlVal = urlInput.value.trim();
  const parsed = parseInviteUrl(urlVal);
  if (!parsed) {
    showStatus("Please enter a valid invite URL (https://server/join/CODE).", "error");
    return;
  }

  const state = await getState();
  const email = resolveEmail(state);

  if (!state.ddbUser?.id) {
    showStatus("No D&D Beyond user detected.", "error");
    return;
  }

  const btn = byId(`dm-launch-btn-${campaign.id}`);
  if (btn) btn.disabled = true;
  showStatus("Checking server & invite…", "info");

  const emailInput = byId("user-email");
  if (emailInput?.value.trim()) await saveState({ savedEmail: emailInput.value.trim() });

  await ensureServer(parsed.serverUrl);

  const pre = await browser.runtime.sendMessage({
    type: "run-preflight",
    payload: { inviteCode: parsed.inviteCode, email, externalUserId: String(state.ddbUser.id) }
  });

  if (!pre?.ok) {
    showStatus(pre?.error || "Server check failed.", "error");
    if (btn) btn.disabled = false;
    return;
  }

  const campaignName = pre.invite?.campaign?.name || campaign.name || null;
  await saveDmConnection({
    ddbCampaignId: campaign.id,
    serverUrl: parsed.serverUrl,
    inviteCode: parsed.inviteCode,
    inviteUrl: urlVal,
    campaignName
  });

  const freshState = await getState();
  await doGuestLaunchAsDm(campaign, freshState, email, parsed.inviteCode, campaignName || "");
  if (btn) btn.disabled = false;
}

async function doGuestLaunchAsDm(campaign, state, email, inviteCode, campaignName) {
  const result = await browser.runtime.sendMessage({
    type: "guest-login-and-launch",
    payload: {
      inviteCode,
      email,
      externalUserId: String(state.ddbUser?.id || ""),
      displayName: state.ddbUser?.displayName || "",
      avatarUrl: state.ddbUser?.avatarUrl || null,
      isDm: true,
      externalCampaignId: String(campaign.id),
      campaignName: campaign.name || campaignName || ""
    }
  });

  if (!result?.ok) {
    showStatus(result?.error || "DM login failed.", "error");
    document.querySelector(`.char-card[data-dm-campaign-id="${campaign.id}"]`)?.classList.remove("launching");
    return;
  }

  // Persist VTT-Chat campaign ID so the re-sync button can use it later
  if (result.user?.campaignId) {
    const freshState = await getState();
    const conn = findDmConn(freshState.dmConnections, campaign.id);
    if (conn) await saveDmConnection({ ...conn, campaignId: result.user.campaignId });
  }

  showStatus(`Connected to "${campaignName || campaign.name || "campaign"}" as DM! VTT-Chat is opening…`, "ok");
  setTimeout(() => window.close(), 800);
}

async function handleDmSync(campaign, conn, btn) {
  if (!conn?.campaignId) {
    showStatus("No active session found — connect first to enable sync.", "error");
    return;
  }

  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  showStatus("Syncing campaign & party data…", "info");

  const result = await browser.runtime.sendMessage({
    type: "dm-campaign-sync",
    payload: { ddbCampaignId: String(campaign.id), campaignId: conn.campaignId }
  });

  if (btn) { btn.disabled = false; btn.textContent = origText; }

  if (result?.ok) {
    showStatus("Campaign data synced to VTT-Chat!", "ok");
  } else {
    showStatus(result?.error || "Sync failed — is a D&D Beyond tab open?", "error");
  }
}

// ---------------------------------------------------------------------------
// Password launch
// ---------------------------------------------------------------------------

async function handlePasswordLaunch(char) {
  const pwInput = byId(`password-${char.id}`);
  const password = pwInput?.value || "";
  if (!password) { showStatus("Please enter your password.", "error"); return; }

  const state = await getState();
  const conn  = findConn(state.campaignConnections, char.id);
  if (!conn) { showStatus("No connection found for this character.", "error"); return; }

  const email = resolveEmail(state);
  const btn = byId(`pw-btn-${char.id}`);
  if (btn) btn.disabled = true;
  showStatus("Logging in…", "info");

  const result = await browser.runtime.sendMessage({
    type: "full-login-and-launch",
    payload: {
      inviteCode: conn.inviteCode,
      email,
      externalUserId: String(state.ddbUser?.id || ""),
      displayName: state.ddbUser?.displayName || "",
      password,
      character: buildCharPayload(char)
    }
  });

  if (!result?.ok) {
    showStatus(result?.error || "Login failed.", "error");
    if (btn) btn.disabled = false;
    return;
  }

  if (result.user?.campaignId) {
    const freshState = await getState();
    const freshConn = findConn(freshState.campaignConnections, char.id);
    if (freshConn) {
      await saveCampaignConnection({ ...freshConn, campaignId: result.user.campaignId });
    }
  }

  showStatus("Connected! VTT-Chat is opening…", "ok");
  setTimeout(() => window.close(), 800);
}

// ---------------------------------------------------------------------------
// Guest launch
// ---------------------------------------------------------------------------

async function doGuestLaunch(char, state, email, inviteCode, campaignName) {
  const result = await browser.runtime.sendMessage({
    type: "guest-login-and-launch",
    payload: {
      inviteCode,
      email,
      externalUserId: String(state.ddbUser?.id || ""),
      displayName: state.ddbUser?.displayName || "",
      avatarUrl: state.ddbUser?.avatarUrl || null,
      externalCharacterId: String(char.id),
      externalCampaignId: String(char.campaignId || ""),
      campaignName: char.campaignName || campaignName || "",
      character: buildCharPayload(char)
    }
  });

  if (!result?.ok) {
    showStatus(result?.error || "Login failed.", "error");
    document.querySelector(`.char-card[data-char-id="${char.id}"]`)?.classList.remove("launching");
    return;
  }

  // Persist the VTT-Chat campaignId so session-status polls can use it
  if (result.user?.campaignId) {
    const freshState = await getState();
    const conn = findConn(freshState.campaignConnections, char.id);
    if (conn) {
      await saveCampaignConnection({ ...conn, campaignId: result.user.campaignId });
    }
  }

  showStatus(`Connected to "${campaignName || "campaign"}"! VTT-Chat is opening…`, "ok");
  setTimeout(() => window.close(), 800);
}

function buildCharPayload(char) {
  if (!char) return null;
  return {
    externalCharacterId: String(char.id),
    ddbCharacterId: char.id,
    name: char.name,
    race: char.race || null,
    class: char.class || null,
    level: char.level || null,
    avatarUrl: char.avatar || null,
    characterUrl: `https://www.dndbeyond.com/characters/${char.id}`
  };
}

function resolveEmail(state) {
  return state.ddbUser?.email
    || byId("user-email")?.value.trim()
    || state.savedEmail
    || "";
}

// ---------------------------------------------------------------------------
// Campaign connections list (details section)
// ---------------------------------------------------------------------------

function renderConnections(campaignConnections, ddbCharacterList) {
  const container = byId("conn-list");
  container.innerHTML = "";

  if (!campaignConnections.length) {
    container.innerHTML = '<p style="color:#555;font-size:11px;margin:4px 0;">No connections saved yet.</p>';
    return;
  }

  for (const conn of campaignConnections) {
    const char = ddbCharacterList?.find(c => c.id === conn.ddbCharacterId);
    const row  = document.createElement("div");
    row.className = "conn-row";

    const info = document.createElement("div");
    info.className = "conn-row-info";
    const nameDiv = document.createElement("div");
    nameDiv.className = "conn-row-name";
    nameDiv.textContent = char?.name || `Character #${conn.ddbCharacterId}`;
    const urlDiv = document.createElement("div");
    urlDiv.className = "conn-row-url";
    urlDiv.textContent = conn.campaignName ? `${conn.campaignName} — ${conn.serverUrl}` : (conn.inviteUrl || conn.serverUrl);
    info.appendChild(nameDiv);
    info.appendChild(urlDiv);

    const del = document.createElement("button");
    del.className = "conn-del";
    del.title = "Remove this connection";
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      const name = char?.name || "this character";
      if (!confirm(`Remove the campaign connection for ${name}?`)) return;
      await deleteCampaignConnection(conn.id);
      await rerender();
    });

    row.appendChild(info);
    row.appendChild(del);
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Session status checks
// ---------------------------------------------------------------------------

async function checkSessionStatuses(campaignConnections) {
  if (!campaignConnections?.length) return;

  for (const conn of campaignConnections) {
    const dot = byId(`status-dot-${conn.ddbCharacterId}`);
    if (dot) { dot.className = "status-dot checking"; dot.title = "Checking…"; }

    try {
      const result = await browser.runtime.sendMessage({
        type: "check-session-status",
        payload: { serverUrl: conn.serverUrl, campaignId: conn.campaignId || null }
      });

      const status = result?.active ? "active"
        : result?.serverOnline ? "saved"
        : "offline";

      sessionStatuses[conn.id] = status;
      if (dot) { dot.className = `status-dot ${status}`; dot.title = statusLabel(status); }
    } catch {
      sessionStatuses[conn.id] = "saved";
      if (dot) { dot.className = "status-dot saved"; dot.title = statusLabel("saved"); }
    }
  }
}

// ---------------------------------------------------------------------------
// Reopen last session
// ---------------------------------------------------------------------------

function setupRelaunch(lastSession, servers) {
  const btn = byId("relaunch");
  const canRelaunch =
    lastSession &&
    Date.now() - lastSession.connectedAt <= RELAUNCH_MAX_AGE_MS &&
    servers.some(s => s.id === lastSession.serverId);

  btn.disabled = !canRelaunch;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const result = await browser.runtime.sendMessage({ type: "relaunch-session" });
    if (!result?.ok) {
      showStatus(result?.error || "Could not reopen session — please reconnect.", "error");
      btn.disabled = false;
      return;
    }
    window.close();
  });
}

// ---------------------------------------------------------------------------
// Re-render after state changes
// ---------------------------------------------------------------------------

async function rerender() {
  const state = await getState();
  renderCharacters(state.ddbCharacterList, state.campaignConnections);
  renderDmCampaigns(state.ddbOwnedCampaigns, state.dmConnections, state.ddbUser);
  renderConnections(state.campaignConnections, state.ddbCharacterList);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function initPopup() {
  const state = await getState();
  const { servers, lastSession, ddbUser, ddbCharacterList, savedEmail, campaignConnections, ddbOwnedCampaigns, dmConnections } = state;

  renderUser(ddbUser, savedEmail);
  setupUserBarToggle(ddbUser);
  renderCharacters(ddbCharacterList, campaignConnections);
  renderDmCampaigns(ddbOwnedCampaigns, dmConnections, ddbUser);
  renderConnections(campaignConnections, ddbCharacterList);
  setupRelaunch(lastSession, servers);

  if (campaignConnections.length) checkSessionStatuses(campaignConnections);
}

initPopup();
