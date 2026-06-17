// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

const TOKEN_RENEWAL_WINDOW_MS = 15 * 60 * 1000;
const EXTERNAL_SYSTEM = "dndbeyond";

let guestSession = null;

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "connect") {
    void handleConnect(msg.payload);
    return;
  }

  if (msg.type === "run-preflight") {
    return runPreflightForPopup(msg.payload || {});
  }

  if (msg.type === "guest-login") {
    return runGuestLoginForPopup(msg.payload || {});
  }

  if (msg.type === "guest-login-and-launch") {
    return runGuestLoginAndLaunch(msg.payload || {});
  }

  if (msg.type === "full-login") {
    return runFullLoginForPopup(msg.payload || {});
  }

  if (msg.type === "full-login-and-launch") {
    return runFullLoginAndLaunch(msg.payload || {});
  }

  if (msg.type === "get-auth-state") {
    return getAuthStateForPopup();
  }

  if (msg.type === "character-update-detected") {
    void handleCharacterUpdate(msg.payload || {});
    return;
  }

  if (msg.type === "check-session-status") {
    return checkSessionStatus(msg.payload || {});
  }
});

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getState() {
  const {
    servers = [],
    activeServerId = null,
    lastSession = null,
    lastPreflight = null,
    ddbUser = null,
    ddbCharacterList = null,
    ddbActiveContext = null,
    savedInviteCode = "",
    savedEmail = ""
  } = await browser.storage.local.get([
    "servers",
    "activeServerId",
    "lastSession",
    "lastPreflight",
    "ddbUser",
    "ddbCharacterList",
    "ddbActiveContext",
    "savedInviteCode",
    "savedEmail"
  ]);
  return { servers, activeServerId, lastSession, lastPreflight, ddbUser, ddbCharacterList, ddbActiveContext, savedInviteCode, savedEmail };
}

async function getActiveServer() {
  const { servers, activeServerId } = await getState();
  return servers.find(s => s.id === activeServerId) || null;
}

function baseServerUrl(url) {
  return String(url || "").trim().replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// JWT utilities
// ---------------------------------------------------------------------------

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function tokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return null;
  return payload.exp * 1000;
}

function isTokenNearExpiry(session) {
  if (!session || !session.expiresAt) return false;
  return session.expiresAt - Date.now() <= TOKEN_RENEWAL_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function setGuestSession(result, context) {
  if (!result || !result.token) return;
  guestSession = {
    token: result.token,
    expiresAt: tokenExpiryMs(result.token),
    campaignId: result.user?.campaignId || context?.campaignId || null,
    inviteCode: context?.inviteCode || null,
    renewalPayload: context?.renewalPayload || null,
    user: result.user || null,
    character: result.character || null,
    authType: result.user?.authType || "GUEST"
  };
}

async function ensureRenewedGuestToken(server) {
  if (!guestSession || !guestSession.token || !isTokenNearExpiry(guestSession)) {
    return guestSession?.token || null;
  }
  if (!guestSession.renewalPayload) return guestSession.token;

  const renewed = await apiJson(server, "/api/auth/extension/guest-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(guestSession.renewalPayload)
  });

  if (renewed.response.ok && renewed.json.token) {
    setGuestSession(renewed.json, {
      inviteCode: guestSession.inviteCode,
      campaignId: renewed.json.user?.campaignId || guestSession.campaignId,
      renewalPayload: guestSession.renewalPayload
    });
  }
  return guestSession.token;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiJson(server, path, options = {}) {
  const response = await fetch(`${baseServerUrl(server.url)}${path}`, options);
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

// ---------------------------------------------------------------------------
// Avatar upload (with session-storage fingerprint cache)
// ---------------------------------------------------------------------------

async function getAvatarFingerprint(externalCharacterId) {
  try {
    const key = `avatarFP:${externalCharacterId}`;
    const data = await browser.storage.session.get(key);
    return data[key] || null;
  } catch {
    return null;
  }
}

async function setAvatarFingerprint(externalCharacterId, sourceUrl, hostedUrl) {
  try {
    const key = `avatarFP:${externalCharacterId}`;
    await browser.storage.session.set({ [key]: { sourceUrl, hostedUrl } });
  } catch {
    // storage.session not available on older Firefox — silently skip
  }
}

async function uploadAvatarIfNeeded(server, token, ddbAvatarUrl, externalCharacterId) {
  if (!ddbAvatarUrl || !token) return null;

  const cached = await getAvatarFingerprint(externalCharacterId);
  if (cached && cached.sourceUrl === ddbAvatarUrl && cached.hostedUrl) {
    return cached.hostedUrl;
  }

  let imageBlob;
  try {
    const imgRes = await fetch(ddbAvatarUrl);
    if (!imgRes.ok) return null;
    imageBlob = await imgRes.blob();
  } catch {
    return null;
  }

  if (imageBlob.size > 2 * 1024 * 1024) return null;

  const formData = new FormData();
  formData.append("image", imageBlob, "avatar.webp");

  let uploadRes;
  try {
    uploadRes = await fetch(
      `${baseServerUrl(server.url)}/api/integrations/external/avatar-upload`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData }
    );
  } catch {
    return null;
  }

  if (!uploadRes.ok) return null;
  const uploadJson = await uploadRes.json().catch(() => ({}));
  const hostedUrl = uploadJson.avatarUrl || null;

  if (hostedUrl) {
    await setAvatarFingerprint(externalCharacterId, ddbAvatarUrl, hostedUrl);
  }
  return hostedUrl;
}

// ---------------------------------------------------------------------------
// Character + campaign sync
// ---------------------------------------------------------------------------

async function syncCharacterAndCampaign(server, token, campaignId, payload) {
  if (!token || !campaignId) return;

  const character = payload?.character || null;
  const campaignPacket = payload?.campaignPacket || null;
  const isDm = Boolean(payload?.isDm);

  if (!character && !campaignPacket) return;

  let avatarUrl = character?.avatarUrl || null;
  if (avatarUrl && character?.externalCharacterId) {
    const hosted = await uploadAvatarIfNeeded(
      server, token, avatarUrl, character.externalCharacterId
    );
    if (hosted) avatarUrl = hosted;
  }

  const characterUpdate = character ? {
    externalCharacterId: String(character.externalCharacterId || character.ddbCharacterId || ""),
    name: character.name || undefined,
    race: character.race || undefined,
    class: character.class || undefined,
    subclass: character.subclass || undefined,
    level: typeof character.level === "number" ? character.level : undefined,
    avatarUrl: avatarUrl || undefined,
    characterUrl: character.characterUrl || undefined,
    stats: character.stats || undefined
  } : undefined;

  if (characterUpdate && !characterUpdate.externalCharacterId) return;

  const campaignUpdate = campaignPacket ? {
    externalCampaignId: campaignPacket.externalCampaignId || undefined,
    campaignName: campaignPacket.campaignName || undefined,
    dmExternalUserId: campaignPacket.dmExternalUserId || undefined,
    members: campaignPacket.members || undefined
  } : undefined;

  await apiJson(server, "/api/integrations/external/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      campaignId,
      externalSystem: EXTERNAL_SYSTEM,
      source: isDm ? "dm" : "player",
      characterUpdate,
      campaignUpdate
    })
  });
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

function buildPopupContext(state, payload) {
  const ddbUser = state.ddbUser || {};
  const ddbActiveContext = state.ddbActiveContext || {};
  return {
    email: payload.email || ddbUser.email || state.savedEmail || "",
    externalUserId: String(payload.externalUserId || ddbUser.id || "").trim(),
    displayName: payload.displayName || ddbUser.displayName || "",
    avatarUrl: payload.avatarUrl || ddbUser.avatarUrl || null,
    inviteCode: payload.inviteCode || "",
    campaignName: payload.campaignName || ddbActiveContext.campaignName || "",
    externalCampaignId: String(payload.externalCampaignId || ddbActiveContext.externalCampaignId || "").trim(),
    dmExternalUserId: String(payload.dmExternalUserId || ddbActiveContext.dmExternalUserId || "").trim()
  };
}

function buildCampaignPacketFromPayload(payload, ddbActiveContext) {
  if (payload.campaignPacket && typeof payload.campaignPacket === "object") {
    return payload.campaignPacket;
  }
  const externalCampaignId = String(payload.externalCampaignId || ddbActiveContext?.externalCampaignId || "").trim();
  const dmExternalUserId = String(payload.dmExternalUserId || ddbActiveContext?.dmExternalUserId || "").trim();
  if (!externalCampaignId && !dmExternalUserId) return undefined;
  return {
    externalCampaignId: externalCampaignId || undefined,
    campaignName: payload.campaignName || ddbActiveContext?.campaignName || undefined,
    dmExternalUserId: dmExternalUserId || undefined,
    members: Array.isArray(ddbActiveContext?.members) ? ddbActiveContext.members : undefined
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function runPreflightSequence(server, context, currentToken) {
  const platform = await apiJson(server, "/api/platform/status");
  if (!platform.response.ok) {
    return {
      ok: false,
      stage: "platform",
      platformStatus: null,
      code: platform.json.code || null,
      error: platform.json.message || "Failed to reach platform"
    };
  }

  if (!platform.json.online || platform.json.maintenanceMode) {
    return {
      ok: false,
      stage: "platform",
      platformStatus: platform.json,
      error: "Platform is offline or in maintenance mode"
    };
  }

  const invite = await apiJson(
    server,
    `/api/campaigns/invite/${encodeURIComponent(context.inviteCode)}/validate`
  );
  if (!invite.response.ok || !invite.json.valid) {
    return {
      ok: false,
      stage: "invite",
      platformStatus: platform.json,
      invite: invite.json,
      code: invite.json.code || null,
      error: invite.json.message || invite.json.reason || "Invite is invalid or expired"
    };
  }

  const headers = { "Content-Type": "application/json" };
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;

  const preflight = await apiJson(server, "/api/auth/extension/preflight", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: context.email,
      externalSystem: EXTERNAL_SYSTEM,
      externalUserId: context.externalUserId,
      inviteCode: context.inviteCode
    })
  });
  if (!preflight.response.ok) {
    return {
      ok: false,
      stage: "preflight",
      platformStatus: platform.json,
      invite: invite.json,
      code: preflight.json.code || null,
      error: preflight.json.message || "Preflight failed"
    };
  }

  return {
    ok: true,
    platformStatus: platform.json,
    invite: invite.json,
    preflight: preflight.json,
    context
  };
}

async function persistPreflightResult(data) {
  await browser.storage.local.set({ lastPreflight: data });
}

async function runPreflightForPopup(payload) {
  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  const state = await getState();
  const context = buildPopupContext(state, payload);
  if (!context.inviteCode || !context.externalUserId) {
    return { ok: false, error: "Invite code and D&D Beyond user ID are required" };
  }

  const currentToken = await ensureRenewedGuestToken(server);
  const result = await runPreflightSequence(server, context, currentToken);
  await persistPreflightResult({ ...result, checkedAt: Date.now(), serverId: server.id });
  return result;
}

// ---------------------------------------------------------------------------
// Guest login
// ---------------------------------------------------------------------------

async function runGuestLoginForPopup(payload) {
  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  const state = await getState();
  const context = buildPopupContext(state, payload);
  if (!context.inviteCode || !context.externalUserId) {
    return { ok: false, error: "Invite code and D&D Beyond user ID are required" };
  }

  const selectedCharacter = Array.isArray(state.ddbCharacterList)
    ? state.ddbCharacterList.find(c => String(c.id) === String(payload.externalCharacterId || "")) || null
    : null;

  const payloadCharacter = payload.character && typeof payload.character === "object"
    ? {
        externalCharacterId: String(
          payload.character.externalCharacterId || payload.character.ddbCharacterId || ""
        ).trim(),
        name: payload.character.name || undefined,
        race: payload.character.race || undefined,
        class: payload.character.class || payload.character.className || undefined,
        subclass: payload.character.subclass || undefined,
        level: typeof payload.character.level === "number" ? payload.character.level : undefined,
        avatarUrl: payload.character.avatarUrl || undefined,
        characterUrl: payload.character.characterUrl || undefined
      }
    : null;

  const guestPayload = {
    inviteCode: context.inviteCode,
    externalSystem: EXTERNAL_SYSTEM,
    externalUserId: context.externalUserId,
    email: context.email,
    displayName: context.displayName || undefined,
    avatarUrl: context.avatarUrl || undefined,
    character: payloadCharacter?.externalCharacterId
      ? payloadCharacter
      : selectedCharacter
      ? {
          externalCharacterId: String(selectedCharacter.id),
          name: selectedCharacter.name,
          class: selectedCharacter.class || undefined,
          level: typeof selectedCharacter.level === "number" ? selectedCharacter.level : undefined,
          avatarUrl: selectedCharacter.avatar || undefined,
          characterUrl: `https://www.dndbeyond.com/characters/${selectedCharacter.id}`
        }
      : undefined,
    campaignPacket: buildCampaignPacketFromPayload(payload, state.ddbActiveContext)
  };

  const login = await apiJson(server, "/api/auth/extension/guest-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(guestPayload)
  });

  if (!login.response.ok) {
    return {
      ok: false,
      error: login.json.message || "Guest login failed",
      code: login.json.code || null
    };
  }

  setGuestSession(login.json, {
    inviteCode: context.inviteCode,
    campaignId: login.json.user?.campaignId || null,
    renewalPayload: guestPayload
  });

  await browser.storage.local.set({
    lastSession: {
      serverId: server.id,
      token: login.json.token,
      campaignId: login.json.user?.campaignId || null,
      inviteCode: context.inviteCode,
      role: login.json.user?.role || null,
      connectedAt: Date.now(),
      authType: login.json.user?.authType || "GUEST"
    }
  });

  return {
    ok: true,
    authType: "GUEST",
    token: login.json.token,
    user: login.json.user,
    character: login.json.character || null,
    campaignBootstrapped: Boolean(login.json.campaignBootstrapped)
  };
}

// ---------------------------------------------------------------------------
// Full account login
// ---------------------------------------------------------------------------

async function runFullLoginForPopup(payload) {
  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  const email = String(payload.email || "").trim();
  const password = String(payload.password || "");
  if (!email || !password) return { ok: false, error: "email and password are required" };

  const state = await getState();
  const ddbUser = state.ddbUser || {};

  const login = await apiJson(server, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: email,
      email,
      password,
      role: payload.role === "DM" ? "DM" : "PLAYER",
      displayName: payload.displayName || ddbUser.displayName || undefined,
      avatarUrl: payload.avatarUrl || ddbUser.avatarUrl || undefined
    })
  });

  if (!login.response.ok) {
    return {
      ok: false,
      error: login.json.message || "Full account login failed",
      code: login.json.code || null
    };
  }

  guestSession = {
    token: login.json.token,
    expiresAt: tokenExpiryMs(login.json.token),
    campaignId: login.json.user?.campaignId || null,
    inviteCode: String(payload.inviteCode || "").trim() || null,
    renewalPayload: null,
    user: login.json.user,
    character: null,
    authType: "FULL"
  };

  await browser.storage.local.set({
    lastSession: {
      serverId: server.id,
      token: login.json.token,
      campaignId: login.json.user?.campaignId || null,
      inviteCode: String(payload.inviteCode || "").trim() || null,
      role: login.json.user?.role || null,
      connectedAt: Date.now(),
      authType: "FULL"
    }
  });

  return {
    ok: true,
    authType: "FULL",
    token: login.json.token,
    user: login.json.user
  };
}

// ---------------------------------------------------------------------------
// Login-and-launch helpers (login + sync + open tab)
// ---------------------------------------------------------------------------

async function launchTab(server, inviteCode, token) {
  const base = `${baseServerUrl(server.url)}/join/${encodeURIComponent(inviteCode)}`;
  const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
  browser.tabs.create({ url });
}

async function runGuestLoginAndLaunch(payload) {
  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  const loginResult = await runGuestLoginForPopup(payload);
  if (!loginResult?.ok) return loginResult;

  const campaignId = loginResult.user?.campaignId;
  if (campaignId) {
    await syncCharacterAndCampaign(server, loginResult.token, campaignId, payload);
  }

  await launchTab(server, payload.inviteCode || "", loginResult.token);
  return loginResult;
}

async function runFullLoginAndLaunch(payload) {
  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  const loginResult = await runFullLoginForPopup(payload);
  if (!loginResult?.ok) return loginResult;

  const campaignId = loginResult.user?.campaignId;
  if (campaignId) {
    const state = await getState();
    await syncCharacterAndCampaign(server, loginResult.token, campaignId, {
      ...payload,
      campaignPacket: buildCampaignPacketFromPayload(payload, state.ddbActiveContext)
    });
  }

  await launchTab(server, payload.inviteCode || "", loginResult.token);
  return loginResult;
}

// ---------------------------------------------------------------------------
// Auth state (popup query)
// ---------------------------------------------------------------------------

async function getAuthStateForPopup() {
  const { lastPreflight } = await getState();
  return {
    ok: true,
    lastPreflight,
    hasAuthToken: Boolean(guestSession?.token),
    authType: guestSession?.authType || null,
    tokenExpiresAt: guestSession?.expiresAt || null,
    user: guestSession?.user || null
  };
}

// ---------------------------------------------------------------------------
// Live character update (content script diff detection)
// ---------------------------------------------------------------------------

async function handleCharacterUpdate(payload) {
  const server = await getActiveServer();
  if (!server || !guestSession?.token) return;

  const token = await ensureRenewedGuestToken(server);
  if (!token || !guestSession?.campaignId || !payload.externalCharacterId) return;

  await apiJson(server, "/api/integrations/external/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      campaignId: guestSession.campaignId,
      externalSystem: EXTERNAL_SYSTEM,
      source: payload.source === "dm" ? "dm" : "player",
      characterUpdate: {
        externalCharacterId: String(payload.externalCharacterId),
        level: typeof payload.level === "number" ? payload.level : undefined,
        class: payload.className || undefined,
        subclass: payload.subclass || undefined
      }
    })
  });
}

// ---------------------------------------------------------------------------
// Session status check (popup polling)
// ---------------------------------------------------------------------------

async function checkSessionStatus({ serverUrl, inviteCode }) {
  if (!serverUrl) return { ok: false, serverOnline: false };
  const base = String(serverUrl).replace(/\/$/, "");
  try {
    const platformRes = await fetch(`${base}/api/platform/status`);
    if (!platformRes.ok) return { ok: false, serverOnline: false };
    const platform = await platformRes.json().catch(() => ({}));
    if (!platform.online) return { ok: false, serverOnline: false };

    // Attempt per-campaign session status (endpoint may not exist yet)
    if (inviteCode) {
      try {
        const sessRes = await fetch(
          `${base}/api/campaigns/invite/${encodeURIComponent(inviteCode)}/session-status`
        );
        if (sessRes.ok) {
          const sess = await sessRes.json().catch(() => ({}));
          return {
            ok: true, serverOnline: true,
            active: sess.active ?? Boolean(sess.playerCount > 0),
            playerCount: sess.playerCount ?? null
          };
        }
      } catch { /* endpoint not yet available — fall through */ }
    }

    return { ok: true, serverOnline: true, active: false };
  } catch {
    return { ok: false, serverOnline: false };
  }
}

// ---------------------------------------------------------------------------
// Connect (triggered by content script inject button)
// ---------------------------------------------------------------------------

async function handleConnect(payload) {
  const server = await getActiveServer();
  if (!server) {
    console.warn("[VTT-Chat] No active server configured");
    return;
  }

  const state = await getState();

  // Resolve invite code: prefer server's stored code, fall back to last session or popup-saved code
  const inviteCode =
    String(server.serverCode || "").trim() ||
    String(state.lastSession?.inviteCode || "").trim() ||
    String(state.savedInviteCode || "").trim();

  const context = {
    email: String(payload?.ddbUser?.email || "").trim(),
    externalUserId: String(payload?.ddbUser?.id || "").trim(),
    displayName: payload?.ddbUser?.displayName || "",
    avatarUrl: payload?.ddbUser?.avatarUrl || null,
    inviteCode
  };

  const preflightResult = await runPreflightSequence(
    server, context, await ensureRenewedGuestToken(server)
  );
  await persistPreflightResult({ ...preflightResult, checkedAt: Date.now(), serverId: server.id });

  if (!preflightResult.ok || !preflightResult.preflight) return;

  const flow = preflightResult.preflight.suggestedFlow;

  if (flow === "already-authenticated") {
    const token = await ensureRenewedGuestToken(server);
    const campaignId = guestSession?.campaignId
      || preflightResult.invite?.campaign?.id;
    if (token && campaignId) {
      await syncCharacterAndCampaign(server, token, campaignId, payload);
    }
    await launchTab(server, context.inviteCode, token);
    return;
  }

  if (flow !== "guest" && flow !== "auto-login") return;

  const loginResult = await runGuestLoginForPopup({
    inviteCode: context.inviteCode,
    email: context.email,
    externalUserId: context.externalUserId,
    displayName: context.displayName,
    avatarUrl: context.avatarUrl,
    externalCharacterId: payload?.character?.ddbCharacterId || payload?.character?.externalCharacterId || null,
    character: payload?.character || null,
    campaignPacket: payload?.campaignPacket || null,
    externalCampaignId: payload?.ddbCampaignId || "",
    campaignName: payload?.ddbCampaignName || "",
    dmExternalUserId: payload?.dmExternalUserId || "",
    isDm: payload?.isDm || false
  });

  if (!loginResult?.ok) return;

  const campaignId = loginResult.user?.campaignId
    || preflightResult.invite?.campaign?.id;
  if (campaignId) {
    await syncCharacterAndCampaign(server, loginResult.token, campaignId, payload);
  }

  await launchTab(server, context.inviteCode, loginResult.token);
}
