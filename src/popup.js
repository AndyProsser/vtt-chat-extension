// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

const RELAUNCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Invite URL parsing
// Expected format: https://<host>/join/<code>
// ---------------------------------------------------------------------------

function parseInviteUrl(urlString) {
  const trimmed = (urlString || "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/^\/join\/(.+)$/);
    if (!match) return null;
    return {
      serverUrl: `${url.protocol}//${url.host}`,
      inviteCode: decodeURIComponent(match[1])
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function getState() {
  const {
    servers = [],
    activeServerId = null,
    lastSession = null,
    ddbUser = null,
    ddbCharacterList = null,
    savedInviteUrl = "",
    savedEmail = ""
  } = await browser.storage.local.get([
    "servers",
    "activeServerId",
    "lastSession",
    "ddbUser",
    "ddbCharacterList",
    "savedInviteUrl",
    "savedEmail"
  ]);
  return { servers, activeServerId, lastSession, ddbUser, ddbCharacterList, savedInviteUrl, savedEmail };
}

async function saveState(partial) {
  await browser.storage.local.set(partial);
}

// ---------------------------------------------------------------------------
// Server auto-registration
// Finds an existing server matching the URL or creates a new one.
// Returns the server id and sets it as active.
// ---------------------------------------------------------------------------

async function ensureServer(serverUrl) {
  const normalised = serverUrl.replace(/\/$/, "");
  const { servers } = await getState();
  const existing = servers.find(s => s.url.replace(/\/$/, "") === normalised);
  if (existing) {
    await saveState({ activeServerId: existing.id });
    return existing.id;
  }

  const hostname = new URL(normalised).hostname;
  const id = crypto.randomUUID();
  const newServer = { id, name: hostname, url: normalised, serverCode: "" };
  const newServers = [...servers, newServer];
  await saveState({ servers: newServers, activeServerId: id });
  return id;
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

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderUser(ddbUser, savedEmail) {
  const nameEl = byId("user-name");
  const subEl  = byId("user-sub");
  const avatarImg = byId("user-avatar");
  const placeholder = byId("user-avatar-placeholder");
  const emailSection = byId("email-section");
  const emailInput   = byId("user-email");

  if (!ddbUser) {
    nameEl.textContent = "Not logged in to D&D Beyond";
    subEl.textContent  = "Open a D&D Beyond page first";
    avatarImg.style.display = "none";
    placeholder.style.display = "flex";
    emailSection.style.display = "block";
    if (savedEmail) emailInput.value = savedEmail;
    return;
  }

  nameEl.textContent = ddbUser.displayName || "D&D Beyond User";

  if (ddbUser.email) {
    subEl.textContent = ddbUser.email;
    emailSection.style.display = "none";
  } else {
    subEl.textContent = `User #${ddbUser.id}`;
    emailSection.style.display = "block";
    if (savedEmail && !emailInput.value) emailInput.value = savedEmail;
  }

  if (ddbUser.avatarUrl) {
    avatarImg.src = ddbUser.avatarUrl;
    avatarImg.style.display = "block";
    placeholder.style.display = "none";
  } else {
    avatarImg.style.display = "none";
    placeholder.textContent  = (ddbUser.displayName || "?")[0].toUpperCase();
    placeholder.style.display = "flex";
  }
}

function renderCharacters(ddbCharacterList) {
  const select = byId("character-select");
  select.innerHTML = '<option value="">— select a character —</option>';

  const chars = (ddbCharacterList || []).filter(c => c.campaignId);
  if (!chars.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "No campaign characters found"; opt.disabled = true;
    select.appendChild(opt);
    return;
  }

  chars.forEach(c => {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    const parts = [c.race, c.class, c.level ? `Lv${c.level}` : null].filter(Boolean).join(" · ");
    opt.textContent = `${c.name}${c.campaignName ? ` — ${c.campaignName}` : ""}${parts ? ` (${parts})` : ""}`;
    select.appendChild(opt);
  });
}

function renderServers(servers, activeServerId) {
  const container = byId("servers");
  container.innerHTML = "";
  if (!servers.length) {
    container.innerHTML = '<p style="color:#666;font-size:11px;margin:4px 0;">No saved servers.</p>';
    return;
  }
  servers.forEach(server => {
    const row = document.createElement("div");
    row.className = "server-row";

    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "activeServer"; radio.value = server.id;
    radio.checked = server.id === activeServerId;
    radio.addEventListener("change", () => saveState({ activeServerId: server.id }));

    const info = document.createElement("div");
    info.style.flex = "1";
    info.innerHTML = `<div class="server-row-name">${escHtml(server.name)}</div>
                      <div class="server-row-url">${escHtml(server.url)}</div>`;

    row.appendChild(radio);
    row.appendChild(info);
    row.addEventListener("click", e => { if (e.target !== radio) radio.click(); });
    container.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Invite URL input — live parse feedback
// ---------------------------------------------------------------------------

function updateUrlPreview(urlString) {
  const preview = byId("url-preview");
  const parsed = parseInviteUrl(urlString);
  if (!urlString.trim()) {
    preview.className = "url-preview";
    preview.textContent = "";
    return null;
  }
  if (!parsed) {
    preview.className = "url-preview error";
    preview.textContent = "Doesn't look like a VTT-Chat invite link — expected https://server/join/CODE";
    return null;
  }
  preview.className = "url-preview ok";
  preview.textContent = `Server: ${parsed.serverUrl}   ·   Code: ${parsed.inviteCode}`;
  return parsed;
}

// ---------------------------------------------------------------------------
// Build the character payload for the background
// ---------------------------------------------------------------------------

function buildLaunchPayload(ddbUser, ddbCharacterList, inviteCode, selectedCharId, emailOverride) {
  const char = selectedCharId
    ? (ddbCharacterList || []).find(c => String(c.id) === selectedCharId) || null
    : null;

  return {
    inviteCode,
    email: ddbUser?.email || emailOverride || "",
    externalUserId: String(ddbUser?.id || ""),
    displayName: ddbUser?.displayName || "",
    avatarUrl: ddbUser?.avatarUrl || null,
    externalCharacterId: char ? String(char.id) : null,
    externalCampaignId: char ? String(char.campaignId || "") : "",
    campaignName: char ? (char.campaignName || "") : "",
    character: char ? {
      externalCharacterId: String(char.id),
      ddbCharacterId: char.id,
      name: char.name,
      race: char.race || null,
      class: char.class || null,
      level: char.level || null,
      avatarUrl: char.avatar || null,
      characterUrl: `https://www.dndbeyond.com/characters/${char.id}`
    } : null
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function initPopup() {
  let state = await getState();
  let { servers, activeServerId, lastSession, ddbUser, ddbCharacterList, savedInviteUrl, savedEmail } = state;

  renderUser(ddbUser, savedEmail);
  renderCharacters(ddbCharacterList);
  renderServers(servers, activeServerId);

  const inviteUrlInput  = byId("invite-url");
  const characterSelect = byId("character-select");
  const connectBtn      = byId("connect-launch");
  const passwordSection = byId("password-section");
  const passwordInput   = byId("login-password");
  const launchPwBtn     = byId("launch-with-password");
  const relaunchBtn     = byId("relaunch");

  // Restore last used invite URL
  if (savedInviteUrl) {
    inviteUrlInput.value = savedInviteUrl;
    updateUrlPreview(savedInviteUrl);
  }

  // Live URL parse feedback
  inviteUrlInput.addEventListener("input", () => {
    updateUrlPreview(inviteUrlInput.value);
    passwordSection.style.display = "none";
    hideStatus();
  });

  // Remove selected server
  byId("remove-server").addEventListener("click", async () => {
    const fresh = await getState();
    if (!fresh.activeServerId) return;
    if (!confirm("Remove the selected server?")) return;
    const next = fresh.servers.filter(s => s.id !== fresh.activeServerId);
    const nextActive = next.length ? next[next.length - 1].id : null;
    await saveState({ servers: next, activeServerId: nextActive });
    servers = next; activeServerId = nextActive;
    renderServers(next, nextActive);
  });

  // Relaunch
  const canRelaunch =
    lastSession &&
    Date.now() - lastSession.connectedAt <= RELAUNCH_MAX_AGE_MS &&
    servers.some(s => s.id === lastSession.serverId);
  relaunchBtn.disabled = !canRelaunch;
  relaunchBtn.addEventListener("click", async () => {
    const { servers: sv, lastSession: ls } = await getState();
    if (!ls) return;
    const server = sv.find(s => s.id === ls.serverId);
    if (!server) return;
    const code = ls.inviteCode || server.serverCode || "";
    browser.tabs.create({
      url: `${server.url.replace(/\/$/, "")}/join/${encodeURIComponent(code)}`
    });
  });

  // ---------------------------------------------------------------------------
  // Connect & Launch
  // ---------------------------------------------------------------------------
  connectBtn.addEventListener("click", async () => {
    const parsed = parseInviteUrl(inviteUrlInput.value);
    if (!parsed) {
      showStatus("Please paste a valid VTT-Chat invite link (https://server/join/CODE).", "error");
      return;
    }

    const fresh = await getState();
    const fallbackEmail = byId("user-email")?.value.trim() || "";

    if (!fresh.ddbUser?.id) {
      showStatus("No D&D Beyond user detected — open any D&D Beyond page first, then try again.", "error");
      return;
    }

    const email = fresh.ddbUser?.email || fallbackEmail;
    if (!email) {
      showStatus("Please enter your email address above so we can check for an existing account.", "error");
      byId("user-email")?.focus();
      return;
    }

    connectBtn.disabled = true;
    passwordSection.style.display = "none";
    showStatus("Checking server & invite…", "info");

    // Persist invite URL + code + fallback email, and auto-register the server
    await saveState({
      savedInviteUrl: inviteUrlInput.value.trim(),
      savedInviteCode: parsed.inviteCode,
      savedEmail: fallbackEmail || undefined
    });
    await ensureServer(parsed.serverUrl);

    // Refresh server list display
    const afterEnsure = await getState();
    renderServers(afterEnsure.servers, afterEnsure.activeServerId);

    // Run preflight
    const preflightResult = await browser.runtime.sendMessage({
      type: "run-preflight",
      payload: {
        inviteCode: parsed.inviteCode,
        email,
        externalUserId: String(fresh.ddbUser.id || "")
      }
    });

    if (!preflightResult?.ok) {
      showStatus(preflightResult?.error || "Could not reach the server or invite is invalid.", "error");
      connectBtn.disabled = false;
      return;
    }

    const campaignName = preflightResult.invite?.campaign?.name || "the campaign";
    const flow = preflightResult.preflight?.suggestedFlow || "guest";

    if (flow === "authenticate") {
      showStatus(
        `Invite valid for "${campaignName}". You have an existing account — enter your password below.`,
        "info"
      );
      passwordSection.style.display = "block";
      connectBtn.disabled = false;
      return;
    }

    // Guest / auto-login: proceed automatically
    showStatus(`Joining "${campaignName}"…`, "info");
    await doGuestLaunch(fresh, parsed.inviteCode, campaignName, email);
  });

  // ---------------------------------------------------------------------------
  // Login & Launch (full account)
  // ---------------------------------------------------------------------------
  launchPwBtn.addEventListener("click", async () => {
    const parsed = parseInviteUrl(inviteUrlInput.value);
    if (!parsed) return;

    const password = passwordInput.value;
    if (!password) {
      showStatus("Please enter your password.", "error");
      return;
    }

    launchPwBtn.disabled = true;
    showStatus("Logging in…", "info");

    const fresh = await getState();
    const fallbackEmail = byId("user-email")?.value.trim() || "";
    const selectedCharId = characterSelect.value || null;
    const launchPayload = {
      ...buildLaunchPayload(fresh.ddbUser, fresh.ddbCharacterList, parsed.inviteCode, selectedCharId, fallbackEmail),
      password
    };

    const result = await browser.runtime.sendMessage({
      type: "full-login-and-launch",
      payload: launchPayload
    });

    if (!result?.ok) {
      showStatus(result?.error || "Login failed.", "error");
      launchPwBtn.disabled = false;
      return;
    }

    showStatus("Connected! VTT-Chat is opening…", "ok");
    launchPwBtn.disabled = false;
    passwordSection.style.display = "none";
    passwordInput.value = "";
  });

  // ---------------------------------------------------------------------------
  // Helper: guest login + launch
  // ---------------------------------------------------------------------------
  async function doGuestLaunch(freshState, inviteCode, campaignName, emailOverride) {
    const selectedCharId = characterSelect.value || null;
    const launchPayload = buildLaunchPayload(
      freshState.ddbUser,
      freshState.ddbCharacterList,
      inviteCode,
      selectedCharId,
      emailOverride
    );

    const result = await browser.runtime.sendMessage({
      type: "guest-login-and-launch",
      payload: launchPayload
    });

    if (!result?.ok) {
      showStatus(result?.error || "Login failed.", "error");
      connectBtn.disabled = false;
      return;
    }

    showStatus(`Connected to "${campaignName}"! VTT-Chat is opening…`, "ok");
    connectBtn.disabled = false;
  }
}

initPopup();
