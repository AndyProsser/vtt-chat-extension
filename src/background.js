// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

const TOKEN_RENEWAL_WINDOW_MS = 15 * 60 * 1000;
const EXTERNAL_SYSTEM = "dndbeyond";
const DM_SYNC_THROTTLE_MS = 10 * 60 * 1000;

let guestSession = null;

browser.runtime.onMessage.addListener((msg, sender) => {
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

  if (msg.type === "character-data-updated") {
    void handleCharacterDataUpdated(msg.payload || {});
    return;
  }

  if (msg.type === "check-session-status") {
    return checkSessionStatus(msg.payload || {});
  }

  if (msg.type === "relaunch-session") {
    return handleRelaunchSession();
  }

  if (msg.type === "dm-campaign-sync") {
    return runDmCampaignSync(msg.payload || {});
  }

  if (msg.type === "validate-invite-code") {
    return validateInviteCode(msg.payload?.inviteCode || "");
  }

  if (msg.type === "dm-link-init") {
    return handleDmLinkInit(msg.payload || {});
  }

  if (msg.type === "dm-returning-launch") {
    return handleDmReturningLaunch(msg.payload || {});
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
// Device credential helpers (stored in browser.storage.local)
// ---------------------------------------------------------------------------

async function getDeviceId() {
  const { deviceId } = await browser.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ deviceId: id });
  return id;
}

// Player credential helpers — keyed per DDB campaign, not per server.
// Shape: { campaignId: string, deviceCredential: { credential: string, deviceId: string } }

async function getPlayerCredential(externalCampaignId) {
  const key = `player:${externalCampaignId}:dndbeyond`;
  const data = await browser.storage.local.get(key);
  return data[key] || null;
}

async function setPlayerCredential(externalCampaignId, record) {
  if (!externalCampaignId || !record) return;
  await browser.storage.local.set({ [`player:${externalCampaignId}:dndbeyond`]: record });
}

async function clearPlayerCredential(externalCampaignId) {
  await browser.storage.local.remove(`player:${externalCampaignId}:dndbeyond`);
}

// ---------------------------------------------------------------------------
// DM link credential helpers (stored per DDB campaign in browser.storage.local)
// ---------------------------------------------------------------------------

async function getDmLinkRecord(externalCampaignId) {
  const key = `dmlink:${externalCampaignId}:dndbeyond`;
  const data = await browser.storage.local.get(key);
  return data[key] || null;
}

async function setDmLinkRecord(externalCampaignId, record) {
  await browser.storage.local.set({ [`dmlink:${externalCampaignId}:dndbeyond`]: record });
}

async function clearDmLinkRecord(externalCampaignId) {
  await browser.storage.local.remove(`dmlink:${externalCampaignId}:dndbeyond`);
}

async function isDmSyncThrottled(campaignId) {
  const data = await browser.storage.local.get(`dmsync:${campaignId}`);
  const lastSyncAt = data[`dmsync:${campaignId}`]?.lastSyncAt;
  if (!lastSyncAt) return false;
  return Date.now() - new Date(lastSyncAt).getTime() < DM_SYNC_THROTTLE_MS;
}

async function recordDmSync(campaignId) {
  await browser.storage.local.set({ [`dmsync:${campaignId}`]: { lastSyncAt: new Date().toISOString() } });
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
    externalCampaignId: context?.externalCampaignId || null,
    inviteCode: context?.inviteCode || null,
    renewalPayload: context?.renewalPayload || null,
    user: result.user || null,
    character: result.character || null,
    authType: result.user?.authType || "GUEST"
  };
}

async function ensureRenewedGuestToken(server) {
  if (!guestSession || !guestSession.token) return null;
  if (!isTokenNearExpiry(guestSession)) return guestSession.token;

  const extCampaignId = guestSession.externalCampaignId;
  const record = extCampaignId ? await getPlayerCredential(extCampaignId) : null;
  if (!record?.deviceCredential) return guestSession.token;

  const { credential, deviceId } = record.deviceCredential;
  const renewed = await apiJson(server, "/api/auth/extension/credential/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential, deviceId })
  });

  if (renewed.response.ok && renewed.json.token) {
    if (renewed.json.credential) {
      await setPlayerCredential(extCampaignId, {
        campaignId: record.campaignId,
        deviceCredential: { credential: renewed.json.credential, deviceId }
      });
    }
    guestSession.token = renewed.json.token;
    guestSession.expiresAt = tokenExpiryMs(renewed.json.token);
    guestSession.campaignId = renewed.json.user?.campaignId || guestSession.campaignId;
  }
  return guestSession.token;
}

// Rehydrates guestSession from storage + credential exchange when the service
// worker has been killed and restarted since the user last connected.
async function ensureGuestSession() {
  if (guestSession?.token && !isTokenNearExpiry(guestSession)) return guestSession;

  const state = await getState();
  const { lastSession } = state;
  if (!lastSession?.serverId || !lastSession?.campaignId) return null;

  const server = state.servers.find(s => s.id === lastSession.serverId);
  if (!server) return null;

  // In-memory token still present but near-expiry — return it anyway for now
  if (guestSession?.token) return guestSession;

  // Prefer a fresh token via player credential exchange
  const extCampaignId = lastSession.externalCampaignId || null;
  const record = extCampaignId ? await getPlayerCredential(extCampaignId) : null;
  if (record?.deviceCredential) {
    const { credential, deviceId } = record.deviceCredential;
    const exchanged = await apiJson(server, "/api/auth/extension/credential/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential, deviceId })
    });

    if (exchanged.response.ok && exchanged.json.token) {
      if (exchanged.json.credential) {
        await setPlayerCredential(extCampaignId, {
          campaignId: record.campaignId,
          deviceCredential: { credential: exchanged.json.credential, deviceId }
        });
      }
      guestSession = {
        token: exchanged.json.token,
        expiresAt: tokenExpiryMs(exchanged.json.token),
        campaignId: exchanged.json.user?.campaignId || lastSession.campaignId,
        externalCampaignId: extCampaignId,
        inviteCode: lastSession.inviteCode,
        renewalPayload: null,
        user: exchanged.json.user || null,
        character: null,
        authType: lastSession.authType || "GUEST"
      };
      return guestSession;
    }

    // Credential rejected — clear it so the user hits the first-time flow
    await clearPlayerCredential(extCampaignId);
  }

  // No credential (or exchange failed) — restore from the last known token.
  // If it has since expired the backend will reject the sync; the user can then
  // reconnect from the popup to get a fresh one.
  if (!lastSession.token) return null;
  guestSession = {
    token: lastSession.token,
    expiresAt: null,
    campaignId: lastSession.campaignId,
    externalCampaignId: extCampaignId,
    inviteCode: lastSession.inviteCode || null,
    renewalPayload: null,
    user: null,
    character: null,
    authType: lastSession.authType || "GUEST"
  };
  return guestSession;
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
    multiclass: typeof character.multiclass === "boolean" ? character.multiclass : undefined,
    classes: Array.isArray(character.classes) ? character.classes : undefined,
    avatarUrl: avatarUrl || undefined,
    characterUrl: character.characterUrl || undefined,
    stats: character.stats || undefined,
    conditions: Array.isArray(character.conditions) ? character.conditions : undefined,
    features: Array.isArray(character.features) ? character.features : undefined
  } : undefined;

  const inventoryUpdate = (character && character.inventory) ? {
    externalCharacterId: String(character.externalCharacterId || character.ddbCharacterId || ""),
    items: Array.isArray(character.inventory.items) ? character.inventory.items : undefined
  } : undefined;

  const currencyUpdate = (character && character.inventory) ? {
    externalCharacterId: String(character.externalCharacterId || character.ddbCharacterId || ""),
    currency: character.inventory.currency || undefined
  } : undefined;

  if (characterUpdate && !characterUpdate.externalCharacterId) return;

  const partyInventoryUpdate = Array.isArray(payload?.partyInventory?.items)
    ? { items: payload.partyInventory.items }
    : undefined;

  const partyCurrencyUpdate = payload?.partyInventory?.currency
    ? { currency: payload.partyInventory.currency }
    : undefined;

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
      inventoryUpdate,
      currencyUpdate,
      partyInventoryUpdate,
      partyCurrencyUpdate,
      campaignUpdate
    })
  });
}

// ---------------------------------------------------------------------------
// DM campaign sync
// ---------------------------------------------------------------------------

async function syncDmCampaignData(server, token, campaignId, dmPayload) {
  if (!token || !campaignId || !dmPayload) return;
  await apiJson(server, "/api/integrations/external/dm-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      campaignId,
      externalSystem: EXTERNAL_SYSTEM,
      externalCampaignId: dmPayload.externalCampaignId,
      campaignData: dmPayload.campaignData,
      characters: dmPayload.characters,
      partyData: dmPayload.partyData || undefined
    })
  });
}

// Reads the DDB session cookies from the browser store and exchanges them for
// a Cobalt auth token — works without a DDB tab being open.
async function fetchCobaltTokenFromBackground() {
  try {
    const cookies = await browser.cookies.getAll({ url: "https://www.dndbeyond.com" });
    if (!cookies.length) return null;
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const res = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", {
      method: "POST",
      headers: { Cookie: cookieHeader }
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.token || null;
  } catch {
    return null;
  }
}

// Background-native DM campaign payload builder — no content script / DDB tab needed.
// Fetches campaign details and basic member data using DDB cookies directly.
// Full character stat extraction (which requires content.js helpers) is skipped;
// each character entry contains the data available from the campaign & character APIs.
async function buildDmCampaignPayloadDirect(ddbCampaignId) {
  const cobaltToken = await fetchCobaltTokenFromBackground();
  if (!cobaltToken) return null;

  const authHeaders = { Authorization: `Bearer ${cobaltToken}`, Accept: "application/json" };

  let details;
  try {
    const res = await fetch(
      `https://api.dndbeyond.com/campaigns/v1/details/${ddbCampaignId}`,
      { headers: authHeaders }
    );
    if (!res.ok) return null;
    const json = await res.json();
    details = json.data;
  } catch {
    return null;
  }
  if (!details) return null;

  const members = Array.isArray(details.activeCharacters) ? details.activeCharacters : [];

  const [characters, partyData] = await Promise.all([
   Promise.all(members.map(async member => {
    const charId = member.id;
    try {
      const res = await fetch(
        `https://character-service.dndbeyond.com/character/v5/character/${charId}?includeCustomItems=true`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const json = await res.json();
        const d = json.data;
        if (d) {
          const totalLevel = (d.classes || []).reduce((s, c) => s + (c.level || 0), 0);
          return {
            externalCharacterId: String(charId),
            externalUserId: String(member.userId || ""),
            displayName: member.userName || member.displayName || null,
            name: d.name || member.name || null,
            level: totalLevel || member.level || null,
            avatarUrl: d.avatarUrl || member.avatarUrl || null,
            characterUrl: `https://www.dndbeyond.com/characters/${charId}`
          };
        }
      }
    } catch { /* character fetch failed — fall back to basic member data */ }
    return {
      externalCharacterId: String(charId),
      externalUserId: String(member.userId || ""),
      displayName: member.userName || member.displayName || null,
      name: member.name || null,
      level: member.level ?? null,
      avatarUrl: member.avatarUrl || null,
      characterUrl: `https://www.dndbeyond.com/characters/${charId}`
    };
   })),
   (async () => {
     try {
       const res = await fetch(
         `https://character-service.dndbeyond.com/character/v5/party/inventory/${ddbCampaignId}`,
         { headers: authHeaders }
       );
       if (!res.ok) return null;
       const json = await res.json();
       const pd = json.data;
       if (!pd) return null;
       return {
         items: (pd.partyItems || []).map(item => ({
           id: item.id,
           name: item.definition?.name || null,
           type: item.definition?.filterType || null,
           subtype: item.definition?.subType || null,
           rarity: item.definition?.rarity || null,
           quantity: item.quantity || 1,
           ownerId: item.ownerId || null,
           weight: item.definition?.weight || 0,
           cost: item.definition?.cost ?? null
         })),
         currency: pd.currency || { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 }
       };
     } catch {
       return null;
     }
   })()
  ]);

  return {
    externalCampaignId: String(details.id || ddbCampaignId),
    campaignData: {
      name: details.name || null,
      description: details.description || null,
      publicNotes: details.publicNotes || null,
      dmExternalUserId: String(details.dmId || ""),
      dmUsername: details.dmUsername || null,
      dateCreated: details.dateCreated || null,
      memberCount: members.length
    },
    characters,
    partyData: partyData || null
  };
}

// Fetches DM campaign data (live DDB tab first, cookie fallback) and syncs it.
// Returns true on success, false if data could not be fetched.
async function fetchAndSyncDmCampaign(server, token, campaignId, ddbCampaignId) {
  let dmPayload = null;
  try {
    const tabs = await browser.tabs.query({ url: "*://*.dndbeyond.com/*" });
    for (const tab of tabs) {
      try {
        dmPayload = await browser.tabs.sendMessage(tab.id, { type: "dm-fetch-campaign-data", ddbCampaignId });
        if (dmPayload) break;
      } catch { /* tab may not have content script */ }
    }
  } catch { /* tabs query failure */ }
  if (!dmPayload) dmPayload = await buildDmCampaignPayloadDirect(ddbCampaignId);
  if (!dmPayload) return false;
  await syncDmCampaignData(server, token, campaignId, dmPayload);
  return true;
}

async function runDmCampaignSync({ ddbCampaignId, campaignId, bypassThrottle }) {
  if (!ddbCampaignId) return { ok: false, error: "No DDB campaign ID provided" };

  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  let token = null;
  let resolvedCampaignId = campaignId || null;

  // Try DM link credential first (full-account token — preferred for DM ops)
  const dmLink = await getDmLinkRecord(ddbCampaignId);
  if (dmLink?.deviceCredential?.credential && dmLink?.campaignId) {
    const { credential, deviceId } = dmLink.deviceCredential;
    const exchanged = await apiJson(server, "/api/auth/extension/credential/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential, deviceId })
    });
    if (exchanged.response.ok && exchanged.json.token) {
      token = exchanged.json.token;
      resolvedCampaignId = resolvedCampaignId || dmLink.campaignId;
      if (exchanged.json.credential) {
        await setDmLinkRecord(ddbCampaignId, {
          ...dmLink,
          deviceCredential: { credential: exchanged.json.credential, deviceId }
        });
      }
    }
  }

  // Fall back to guest session (backward compat)
  if (!token) {
    const session = await ensureGuestSession();
    if (!session) return { ok: false, error: "No active DM session — please reconnect" };
    token = await ensureRenewedGuestToken(server);
    resolvedCampaignId = resolvedCampaignId || session.campaignId;
  }

  if (!token || !resolvedCampaignId) {
    return { ok: false, error: "No active DM session — please reconnect" };
  }

  if (!bypassThrottle && await isDmSyncThrottled(resolvedCampaignId)) {
    return { ok: true, throttled: true };
  }

  const ok = await fetchAndSyncDmCampaign(server, token, resolvedCampaignId, String(ddbCampaignId));
  if (ok) await recordDmSync(resolvedCampaignId);
  if (!ok) return { ok: false, error: "Could not fetch campaign data — ensure you are signed in to D&D Beyond" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// DM link flow handlers
// ---------------------------------------------------------------------------

// Exchanges the stored DM credential for a fresh token, fires throttled dm-sync, and opens the campaign tab.
async function handleDmReturningLaunch({ externalCampaignId }) {
  const record = await getDmLinkRecord(externalCampaignId);
  if (!record?.deviceCredential?.credential || !record?.campaignId) {
    return { ok: false, error: "No DM link found — please re-link", credentialExpired: true };
  }

  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  const { credential, deviceId } = record.deviceCredential;
  const exchanged = await apiJson(server, "/api/auth/extension/credential/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential, deviceId })
  });

  if (!exchanged.response.ok) {
    const code = exchanged.json?.code;
    if (code === "CREDENTIAL_INVALID" || code === "CREDENTIAL_EXPIRED_GUEST") {
      await clearDmLinkRecord(externalCampaignId);
      return { ok: false, error: "DM link expired — please re-link", credentialExpired: true };
    }
    return { ok: false, error: exchanged.json?.message || "DM authentication failed — please re-link" };
  }

  const token = exchanged.json.token;
  const campaignId = record.campaignId;

  if (exchanged.json.credential) {
    await setDmLinkRecord(externalCampaignId, {
      ...record,
      deviceCredential: { credential: exchanged.json.credential, deviceId }
    });
  }

  // Throttled DM sync — runs in background, doesn't block launch
  const shouldSync = !await isDmSyncThrottled(campaignId);
  if (shouldSync) {
    void (async () => {
      const ok = await fetchAndSyncDmCampaign(server, token, campaignId, String(externalCampaignId));
      if (ok) await recordDmSync(campaignId);
    })();
  }

  const session = await ensureSession(server, token, campaignId);
  await launchTab(server, campaignId, token, session?.sessionId || null);
  return { ok: true };
}

// Validates a player invite code against the active server.
async function validateInviteCode(inviteCode) {
  if (!inviteCode) return { ok: false, error: "Invite code is required" };
  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };
  const result = await apiJson(server, `/api/campaigns/invite/${encodeURIComponent(inviteCode)}/validate`);
  if (!result.response.ok || !result.json.valid) {
    return { ok: false, error: result.json.message || "This code isn't valid" };
  }
  return { ok: true, campaign: result.json.campaign || null, dev: result.json.dev || null };
}

// Calls dm-link-init on the backend (auth + link + sync + session in one shot),
// stores the returned credential, then opens the campaign tab.
async function handleDmLinkInit({ inviteCode, campaignId, username, password, externalCampaignId, campaignName }) {
  if (!campaignId || !password || !externalCampaignId) {
    return { ok: false, error: "Missing required parameters" };
  }

  const server = await getActiveServer();
  if (!server) return { ok: false, error: "No active server configured" };

  const state = await getState();
  const ddbUser = state.ddbUser || {};
  const email = ddbUser.email || state.savedEmail || "";
  const resolvedUsername = username || email;
  const deviceId = await getDeviceId();

  const result = await apiJson(server, "/api/auth/extension/dm-link-init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: resolvedUsername,
      password,
      campaignId,
      externalSystem: EXTERNAL_SYSTEM,
      externalUserId: String(ddbUser.id || ""),
      externalCampaignId: String(externalCampaignId || ""),
      email,
      displayName: ddbUser.displayName || null,
      deviceId,
      campaignName: campaignName || undefined
    })
  });

  if (!result.response.ok) {
    return {
      ok: false,
      error: result.json?.message || "Could not link your account. Please try again.",
      code: result.json?.code || null
    };
  }

  const { token, deviceCredential, sessionId } = result.json;
  const strId = String(externalCampaignId);

  await setDmLinkRecord(strId, {
    campaignId,
    externalCampaignId: strId,
    serverUrl: server.url,
    inviteCode: inviteCode || null,
    campaignName: campaignName || null,
    deviceCredential
  });

  const { dmConnections: conns = [] } = await browser.storage.local.get("dmConnections");
  const existing = conns.find(c => String(c.ddbCampaignId) === strId);
  const updated = {
    id: existing?.id ?? crypto.randomUUID(),
    ddbCampaignId: strId,
    campaignId,
    serverUrl: server.url,
    serverId: server.id,
    inviteCode: inviteCode || null,
    campaignName: campaignName || null,
    lastConnectedAt: Date.now()
  };
  await browser.storage.local.set({
    dmConnections: existing
      ? conns.map(c => String(c.ddbCampaignId) === strId ? updated : c)
      : [...conns, updated]
  });

  await launchTab(server, campaignId, token, sessionId || null);
  return { ok: true };
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

  const deviceId = await getDeviceId();
  const guestPayload = {
    inviteCode: context.inviteCode,
    externalSystem: EXTERNAL_SYSTEM,
    externalUserId: context.externalUserId,
    email: context.email,
    displayName: context.displayName || undefined,
    avatarUrl: context.avatarUrl || undefined,
    deviceId,
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

  if (login.json.deviceCredential && context.externalCampaignId) {
    await setPlayerCredential(context.externalCampaignId, {
      campaignId: login.json.user?.campaignId || null,
      deviceCredential: login.json.deviceCredential
    });
  }

  setGuestSession(login.json, {
    inviteCode: context.inviteCode,
    campaignId: login.json.user?.campaignId || null,
    externalCampaignId: context.externalCampaignId || null,
    renewalPayload: null
  });

  await browser.storage.local.set({
    lastSession: {
      serverId: server.id,
      token: login.json.token,
      campaignId: login.json.user?.campaignId || null,
      externalCampaignId: context.externalCampaignId || null,
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
// Session ensure
// ---------------------------------------------------------------------------

async function ensureSession(server, token, campaignId) {
  if (!token || !campaignId) return null;
  const result = await apiJson(
    server,
    `/api/campaigns/${encodeURIComponent(campaignId)}/session/ensure`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!result.response.ok) return null;
  return result.json; // { sessionId, sessionState, campaignDisplayState }
}

// ---------------------------------------------------------------------------
// Login-and-launch helpers (login + sync + open tab)
// ---------------------------------------------------------------------------

async function launchTab(server, campaignId, token, sessionId, emailHint) {
  const params = new URLSearchParams();
  if (campaignId) params.set("campaignId", campaignId);
  if (token) {
    params.set("token", token);
  } else if (emailHint) {
    params.set("hint", emailHint);
  }
  if (sessionId) params.set("sessionId", sessionId);
  browser.tabs.create({ url: `${baseServerUrl(server.url)}/ext-launch?${params}` });
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

  if (payload.isDm && payload.externalCampaignId && campaignId) {
    // Fire-and-forget rich DM sync — party data fetched from DnD Beyond in the background
    void runDmCampaignSync({ ddbCampaignId: String(payload.externalCampaignId), campaignId });
  } else {
    void triggerInitialCharacterSync(
      guestSession?.character?.externalCharacterId || payload.externalCharacterId
    );
  }

  const session = campaignId ? await ensureSession(server, loginResult.token, campaignId) : null;
  await launchTab(server, campaignId, loginResult.token, session?.sessionId || null);
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

  void triggerInitialCharacterSync(payload.character?.externalCharacterId);

  const session = campaignId ? await ensureSession(server, loginResult.token, campaignId) : null;
  await launchTab(server, campaignId, loginResult.token, session?.sessionId || null);
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
// Initial full character sync (broadcast to all open DDB tabs)
// ---------------------------------------------------------------------------

async function triggerInitialCharacterSync(characterId) {
  if (!characterId) return;
  const id = Number(characterId);
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      browser.tabs.sendMessage(tab.id, { type: "refetch-character", characterId: id }).catch(() => {});
    }
  } catch {
    // tabs API unavailable in this context — skip
  }
}

// ---------------------------------------------------------------------------
// Manual character sync (triggered by the sync button in the content script)
// ---------------------------------------------------------------------------

async function handleCharacterDataUpdated(payload) {
  const session = await ensureGuestSession();
  if (!session) return;

  const server = await getActiveServer();
  if (!server) return;

  const token = await ensureRenewedGuestToken(server);
  if (!token || !session.campaignId) return;

  await syncCharacterAndCampaign(server, token, session.campaignId, {
    character: payload
  });
}

// ---------------------------------------------------------------------------
// Session status check (popup polling)
// ---------------------------------------------------------------------------

async function checkSessionStatus({ serverUrl, campaignId }) {
  if (!serverUrl) return { ok: false, serverOnline: false };
  const base = String(serverUrl).replace(/\/$/, "");
  try {
    const platformRes = await fetch(`${base}/api/platform/status`);
    if (!platformRes.ok) return { ok: false, serverOnline: false };
    const platform = await platformRes.json().catch(() => ({}));
    if (!platform.online) return { ok: false, serverOnline: false };

    if (campaignId) {
      try {
        const sessRes = await fetch(
          `${base}/api/campaigns/${encodeURIComponent(campaignId)}/session-status`
        );
        if (sessRes.ok) {
          const sess = await sessRes.json().catch(() => ({}));
          const state = sess.campaignDisplayState || null;
          const active = state != null && state !== "IDLE";
          return { ok: true, serverOnline: true, active, campaignDisplayState: state };
        }
      } catch { /* endpoint not yet available — fall through */ }
    }

    return { ok: true, serverOnline: true, active: false };
  } catch {
    return { ok: false, serverOnline: false };
  }
}

// ---------------------------------------------------------------------------
// Relaunch last session (popup relaunch button)
// ---------------------------------------------------------------------------

async function handleRelaunchSession() {
  const state = await getState();
  const { lastSession } = state;
  if (!lastSession) return { ok: false, error: "No recent session found" };

  const server = state.servers.find(s => s.id === lastSession.serverId);
  if (!server) return { ok: false, error: "Server not found" };

  const campaignId = lastSession.campaignId;
  if (!campaignId) return { ok: false, error: "No campaign ID in last session — please reconnect" };

  // Use in-memory token if still valid, otherwise exchange credential
  let token = guestSession?.token && !isTokenNearExpiry(guestSession)
    ? guestSession.token
    : null;

  if (!token) {
    const extCampaignId = lastSession.externalCampaignId || null;
    const record = extCampaignId ? await getPlayerCredential(extCampaignId) : null;
    if (record?.deviceCredential) {
      const { credential, deviceId } = record.deviceCredential;
      const exchanged = await apiJson(server, "/api/auth/extension/credential/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, deviceId })
      });
      if (exchanged.response.ok && exchanged.json.token) {
        token = exchanged.json.token;
        if (exchanged.json.credential) {
          await setPlayerCredential(extCampaignId, {
            campaignId: record.campaignId,
            deviceCredential: { credential: exchanged.json.credential, deviceId }
          });
        }
        guestSession = {
          token,
          expiresAt: tokenExpiryMs(token),
          campaignId: exchanged.json.user?.campaignId || campaignId,
          externalCampaignId: extCampaignId,
          inviteCode: lastSession.inviteCode,
          renewalPayload: null,
          user: exchanged.json.user || null,
          character: null,
          authType: lastSession.authType || "GUEST"
        };
      }
    }
  }

  if (!token) return { ok: false, error: "Session expired — please reconnect from the popup" };

  const session = await ensureSession(server, token, campaignId);
  await launchTab(server, campaignId, token, session?.sessionId || null);
  return { ok: true };
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
      void triggerInitialCharacterSync(
        guestSession?.character?.externalCharacterId ||
        payload.character?.ddbCharacterId ||
        payload.character?.externalCharacterId
      );
      const session = await ensureSession(server, token, campaignId);
      await launchTab(server, campaignId, token, session?.sessionId || null);
    }
    return;
  }

  if (flow === "authenticate") {
    const campaignId = preflightResult.invite?.campaign?.id || null;
    if (campaignId) {
      await launchTab(server, campaignId, null, null, context.email);
    }
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

  void triggerInitialCharacterSync(
    guestSession?.character?.externalCharacterId ||
    payload.character?.ddbCharacterId ||
    payload.character?.externalCharacterId
  );

  const session = campaignId ? await ensureSession(server, loginResult.token, campaignId) : null;
  await launchTab(server, campaignId, loginResult.token, session?.sessionId || null);
}


