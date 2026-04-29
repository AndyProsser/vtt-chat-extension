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

  if (msg.type === "full-login") {
    return runFullLoginForPopup(msg.payload || {});
  }

  if (msg.type === "get-auth-state") {
    return getAuthStateForPopup();
  }

  if (msg.type === "character-update-detected") {
    void handleCharacterUpdate(msg.payload || {});
    return;
  }
});

async function getState() {
  const {
    servers = [],
    activeServerId = null,
    lastSession = null,
    lastPreflight = null,
    ddbUser = null,
    ddbCharacterList = null,
    ddbActiveContext = null
  } = await browser.storage.local.get([
    "servers",
    "activeServerId",
    "lastSession",
    "lastPreflight",
    "ddbUser",
    "ddbCharacterList",
    "ddbActiveContext"
  ]);
  return { servers, activeServerId, lastSession, lastPreflight, ddbUser, ddbCharacterList, ddbActiveContext };
}

async function getActiveServer() {
  const { servers, activeServerId } = await getState();
  return servers.find(s => s.id === activeServerId) || null;
}

function baseServerUrl(url) {
  return String(url || "").trim().replace(/\/$/, "");
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = atob(padded);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function tokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return null;
  return payload.exp * 1000;
}

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

function isTokenNearExpiry(session) {
  if (!session || !session.expiresAt) return false;
  return session.expiresAt - Date.now() <= TOKEN_RENEWAL_WINDOW_MS;
}

async function apiJson(server, path, options = {}) {
  const response = await fetch(`${baseServerUrl(server.url)}${path}`, options);
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

function buildPopupContext(state, payload) {
  const ddbUser = state.ddbUser || {};
  const ddbActiveContext = state.ddbActiveContext || {};

  return {
    email: payload.email || ddbUser.email || "",
    externalUserId: String(payload.externalUserId || ddbUser.id || "").trim(),
    displayName: payload.displayName || ddbUser.displayName || "",
    avatarUrl: payload.avatarUrl || ddbUser.avatarUrl || null,
    inviteCode: payload.inviteCode || "",
    campaignName: payload.campaignName || ddbActiveContext.campaignName || "",
    externalCampaignId: String(payload.externalCampaignId || ddbActiveContext.externalCampaignId || "").trim(),
    dmExternalUserId: String(payload.dmExternalUserId || ddbActiveContext.dmExternalUserId || "").trim()
  };
}

function buildCampaignPacket(payload, ddbActiveContext) {
  if (payload.campaignPacket && typeof payload.campaignPacket === "object") {
    return payload.campaignPacket;
  }

  const externalCampaignId = String(payload.externalCampaignId || ddbActiveContext?.externalCampaignId || "").trim();
  const dmExternalUserId = String(payload.dmExternalUserId || ddbActiveContext?.dmExternalUserId || "").trim();
  const campaignName = payload.campaignName || ddbActiveContext?.campaignName || undefined;
  const members = Array.isArray(ddbActiveContext?.members) ? ddbActiveContext.members : undefined;

  if (!externalCampaignId && !dmExternalUserId) {
    return undefined;
  }

  return {
    externalCampaignId: externalCampaignId || undefined,
    campaignName,
    dmExternalUserId: dmExternalUserId || undefined,
    members
  };
}

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
  if (currentToken) {
    headers.Authorization = `Bearer ${currentToken}`;
  }

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

async function ensureRenewedGuestToken(server) {
  if (!guestSession || !guestSession.token || !isTokenNearExpiry(guestSession)) {
    return guestSession?.token || null;
  }

  if (!guestSession.renewalPayload) {
    return guestSession.token;
  }

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
    return guestSession.token;
  }

  return guestSession.token;
}

async function runPreflightForPopup(payload) {
  const server = await getActiveServer();
  if (!server) {
    return { ok: false, error: "No active server configured" };
  }

  const state = await getState();
  const context = buildPopupContext(state, payload);
  if (!context.inviteCode || !context.email || !context.externalUserId) {
    return {
      ok: false,
      error: "inviteCode, email, and external user ID are required"
    };
  }

  const currentToken = await ensureRenewedGuestToken(server);
  const result = await runPreflightSequence(server, context, currentToken);
  await persistPreflightResult({ ...result, checkedAt: Date.now(), serverId: server.id });
  return result;
}

async function runGuestLoginForPopup(payload) {
  const server = await getActiveServer();
  if (!server) {
    return { ok: false, error: "No active server configured" };
  }

  const state = await getState();
  const context = buildPopupContext(state, payload);
  if (!context.inviteCode || !context.email || !context.externalUserId) {
    return {
      ok: false,
      error: "inviteCode, email, and external user ID are required"
    };
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
        level:
          typeof payload.character.level === "number"
            ? payload.character.level
            : undefined,
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
    character: payloadCharacter && payloadCharacter.externalCharacterId
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
    campaignPacket: buildCampaignPacket(payload, state.ddbActiveContext)
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

async function runFullLoginForPopup(payload) {
  const server = await getActiveServer();
  if (!server) {
    return { ok: false, error: "No active server configured" };
  }

  const email = String(payload.email || "").trim();
  const password = String(payload.password || "");
  const role = payload.role === "DM" ? "DM" : "PLAYER";

  if (!email || !password) {
    return { ok: false, error: "email and password are required" };
  }

  const login = await apiJson(server, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: email,
      email,
      password,
      role,
      displayName: payload.displayName || undefined,
      avatarUrl: payload.avatarUrl || undefined
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
    campaignId: null,
    inviteCode: null,
    renewalPayload: null,
    user: login.json.user,
    character: null,
    authType: "FULL"
  };

  await browser.storage.local.set({
    lastSession: {
      serverId: server.id,
      token: login.json.token,
      campaignId: null,
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

async function handleCharacterUpdate(payload) {
  const server = await getActiveServer();
  if (!server || !guestSession?.token) {
    return;
  }

  const token = await ensureRenewedGuestToken(server);
  if (!token || !guestSession?.campaignId || !payload.externalCharacterId) {
    return;
  }

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
      },
      campaignUpdate: null
    })
  });
}

async function handleConnect(payload) {
  const server = await getActiveServer();
  if (!server) {
    console.warn("No active VTT-Chat server configured");
    return;
  }

  const context = {
    email: String(payload?.ddbUser?.email || "").trim(),
    externalUserId: String(payload?.ddbUser?.id || "").trim(),
    displayName: payload?.ddbUser?.displayName || "",
    avatarUrl: payload?.ddbUser?.avatarUrl || null,
    inviteCode: String(server.serverCode || "").trim()
  };

  const preflightResult = await runPreflightSequence(server, context, await ensureRenewedGuestToken(server));
  await persistPreflightResult({
    ...preflightResult,
    checkedAt: Date.now(),
    serverId: server.id
  });

  if (!preflightResult.ok || !preflightResult.preflight) {
    return;
  }

  const flow = preflightResult.preflight.suggestedFlow;
  if (flow === "already-authenticated") {
    browser.tabs.create({
      url: `${baseServerUrl(server.url)}/join/${encodeURIComponent(context.inviteCode)}`
    });
    return;
  }

  if (flow !== "guest" && flow !== "auto-login") {
    return;
  }

  const guestLoginResult = await runGuestLoginForPopup({
    inviteCode: context.inviteCode,
    email: context.email,
    externalUserId: context.externalUserId,
    displayName: context.displayName,
    avatarUrl: context.avatarUrl,
    externalCharacterId: payload?.character?.ddbCharacterId || payload?.character?.externalCharacterId || null,
    character: payload?.character || null,
    externalCampaignId: payload?.ddbCampaignId || payload?.externalCampaignId || "",
    campaignName: payload?.ddbCampaignName || payload?.campaignName || "",
    dmExternalUserId: payload?.dmExternalUserId || ""
  });

  if (!guestLoginResult?.ok) {
    return;
  }

  browser.tabs.create({
    url: `${baseServerUrl(server.url)}/join/${encodeURIComponent(context.inviteCode)}`
  });
}

