import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, test } from "node:test";

if (!globalThis.Buffer) {
  globalThis.Buffer = (await import("buffer")).Buffer;
}
if (!globalThis.process) {
  globalThis.process = (await import("process")).default;
}

function createJwt(expOffsetSeconds) {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSeconds;
  const header  = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

// ---------------------------------------------------------------------------
// Shared module state — loaded ONCE in before(), shared across all tests.
// Order-dependent tests are noted with a comment.
// ---------------------------------------------------------------------------

let dispatch;
const fetchCalls = [];
const tabsCreated = [];
const storage = {
  servers: [{ id: "server-1", name: "Local", url: "https://vtt.local", serverCode: "join-code" }],
  activeServerId: "server-1"
};

// Swap this to override individual responses for a test, then restore.
let fetchOverride = null;

function resetBetweenTests() {
  fetchCalls.length = 0;
  tabsCreated.length = 0;
  fetchOverride = null;
}

before(async () => {
  const listeners = [];

  globalThis.atob = (b64) => Buffer.from(b64, "base64").toString("utf8");

  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    fetchCalls.push({ url: urlStr, options });

    if (fetchOverride) {
      for (const [pat, res] of Object.entries(fetchOverride)) {
        if (urlStr.includes(pat)) return res;
      }
    }

    if (urlStr.endsWith("/api/platform/status"))
      return { ok: true, json: async () => ({ online: true, maintenanceMode: false }) };
    if (urlStr.includes("/api/campaigns/invite/") && urlStr.endsWith("/validate"))
      return { ok: true, json: async () => ({ valid: true, campaign: { id: "camp-uuid", name: "Lost Mines" } }) };
    if (urlStr.endsWith("/api/auth/extension/preflight"))
      return { ok: true, json: async () => ({ accountStatus: "none", suggestedFlow: "guest" }) };
    if (urlStr.endsWith("/api/auth/extension/guest-login"))
      return {
        ok: true,
        json: async () => ({
          token: createJwt(3600),
          user: { campaignId: "camp-uuid", authType: "GUEST", role: "PLAYER" },
          character: { externalCharacterId: "char-1", name: "Aragorn" },
          deviceCredential: "device-cred-1"
        })
      };
    if (urlStr.endsWith("/api/auth/login"))
      return {
        ok: true,
        json: async () => ({
          token: createJwt(3600),
          user: { id: "user-1", campaignId: "camp-uuid", role: "PLAYER", authType: "FULL" }
        })
      };
    if (urlStr.endsWith("/api/integrations/external/sync"))
      return { ok: true, json: async () => ({ message: "ok" }) };
    if (urlStr.includes("/session/ensure"))
      return { ok: true, json: async () => ({ sessionId: "session-uuid" }) };
    if (urlStr.includes("/session-status"))
      return { ok: true, json: async () => ({ campaignDisplayState: "ACTIVE" }) };
    if (urlStr.endsWith("/api/auth/extension/credential/exchange"))
      return {
        ok: true,
        json: async () => ({
          token: createJwt(3600),
          credential: "renewed-cred",
          user: { campaignId: "camp-uuid" }
        })
      };
    if (urlStr.endsWith("/api/integrations/external/avatar-upload"))
      return { ok: true, json: async () => ({ avatarUrl: "https://hosted/avatar.webp" }) };

    return { ok: false, json: async () => ({ message: `Unhandled: ${urlStr}` }) };
  };

  globalThis.browser = {
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storage[k]]));
          if (typeof keys === "string") return { [keys]: storage[keys] };
          return { ...storage };
        },
        async set(partial) { Object.assign(storage, partial); }
      },
      session: { async get() { return {}; }, async set() {} }
    },
    tabs: {
      create(opts) { tabsCreated.push(opts); },
      get: async () => ({ url: "https://www.dndbeyond.com/characters/12345" }),
      query: async () => [],
      sendMessage: async () => {}
    },
    webRequest: { onCompleted: { addListener() {} } }
  };
  globalThis.chrome = globalThis.browser;

  const url = pathToFileURL(path.join(process.cwd(), "src/background.js")).href;
  await import(url);

  assert.ok(listeners.length > 0, "Expected background listener");
  dispatch = (msg) => listeners[0](msg);
});

// ---------------------------------------------------------------------------
// Auth state — MUST run before any login test
// ---------------------------------------------------------------------------

test("get-auth-state returns no token before any login", async () => {
  resetBetweenTests();
  const r = await dispatch({ type: "get-auth-state" });
  assert.equal(r.ok, true);
  assert.equal(r.hasAuthToken, false);
  assert.equal(r.authType, null);
});

// ---------------------------------------------------------------------------
// Session status — no session required
// ---------------------------------------------------------------------------

test("check-session-status reports idle when no campaignId provided", async () => {
  resetBetweenTests();
  const r = await dispatch({ type: "check-session-status", payload: { serverUrl: "https://vtt.local" } });
  assert.equal(r.ok, true);
  assert.equal(r.serverOnline, true);
  assert.equal(r.active, false);
});

test("check-session-status reports active when campaign is running", async () => {
  resetBetweenTests();
  const r = await dispatch({ type: "check-session-status", payload: { serverUrl: "https://vtt.local", campaignId: "camp-uuid" } });
  assert.equal(r.ok, true);
  assert.equal(r.active, true);
  assert.equal(r.campaignDisplayState, "ACTIVE");
});

test("check-session-status reports offline when platform is down", async () => {
  resetBetweenTests();
  fetchOverride = { "/api/platform/status": { ok: false, json: async () => ({}) } };
  const r = await dispatch({ type: "check-session-status", payload: { serverUrl: "https://vtt.local" } });
  assert.equal(r.ok, false);
  assert.equal(r.serverOnline, false);
});

// ---------------------------------------------------------------------------
// Preflight — no session required
// ---------------------------------------------------------------------------

test("run-preflight performs required Stage 13.4 call sequence", async () => {
  resetBetweenTests();
  const r = await dispatch({
    type: "run-preflight",
    payload: { inviteCode: "join-code", email: "player@example.com", externalUserId: "ddb-user-1" }
  });
  assert.equal(r.ok, true);
  assert.deepEqual(fetchCalls.map(c => c.url), [
    "https://vtt.local/api/platform/status",
    "https://vtt.local/api/campaigns/invite/join-code/validate",
    "https://vtt.local/api/auth/extension/preflight"
  ]);
  const body = JSON.parse(fetchCalls[2].options.body);
  assert.equal(body.externalSystem, "dndbeyond");
  assert.equal(body.inviteCode, "join-code");
  assert.equal(body.externalUserId, "ddb-user-1");
});

test("run-preflight returns platform error when server is offline", async () => {
  resetBetweenTests();
  fetchOverride = { "/api/platform/status": { ok: true, json: async () => ({ online: false }) } };
  const r = await dispatch({ type: "run-preflight", payload: { inviteCode: "join-code", email: "p@p.com", externalUserId: "u1" } });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "platform");
  assert.equal(fetchCalls.length, 1);
});

test("run-preflight returns invite error when code is invalid", async () => {
  resetBetweenTests();
  fetchOverride = { "/validate": { ok: false, json: async () => ({ valid: false, message: "Invite expired" }) } };
  const r = await dispatch({ type: "run-preflight", payload: { inviteCode: "bad-code", email: "p@p.com", externalUserId: "u1" } });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "invite");
});

// ---------------------------------------------------------------------------
// Relaunch — MUST run before any login that sets guestSession
// ---------------------------------------------------------------------------

test("relaunch-session returns error when no session stored", async () => {
  resetBetweenTests();
  const r = await dispatch({ type: "relaunch-session" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("No recent session"));
});

test("relaunch-session exchanges stored credential and opens tab", async () => {
  resetBetweenTests();
  Object.assign(storage, {
    lastSession: { serverId: "server-1", campaignId: "camp-uuid", inviteCode: "join-code", authType: "GUEST" },
    deviceId: "test-device-id",
    "dc:server-1": "saved-cred"
  });
  const r = await dispatch({ type: "relaunch-session" });
  assert.equal(r.ok, true);
  assert.ok(fetchCalls.some(c => c.url.endsWith("/api/auth/extension/credential/exchange")));
  assert.equal(tabsCreated.length, 1);
  // guestSession is now set from the exchange
});

// ---------------------------------------------------------------------------
// Full login — no guest session yet after credential exchange above
// ---------------------------------------------------------------------------

test("full-login returns error when credentials are missing", async () => {
  resetBetweenTests();
  const r = await dispatch({ type: "full-login", payload: { email: "dm@example.com" } });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("full-login returns FULL authType and persists session", async () => {
  resetBetweenTests();
  const r = await dispatch({ type: "full-login", payload: { email: "dm@example.com", password: "secret", role: "DM" } });
  assert.equal(r.ok, true);
  assert.equal(r.authType, "FULL");
  assert.ok(r.token);
  assert.equal(storage.lastSession.authType, "FULL");
});

// ---------------------------------------------------------------------------
// Guest login — establishes GUEST guestSession for all following tests
// ---------------------------------------------------------------------------

test("guest-login submits character and campaign packet contract fields", async () => {
  resetBetweenTests();
  Object.assign(storage, {
    ddbUser: { id: "ddb-user-1", email: "player@example.com", displayName: "Player" },
    ddbActiveContext: { externalCampaignId: "ddb-campaign-1", campaignName: "Lost Mines", dmExternalUserId: "ddb-dm-1", members: [] }
  });
  const r = await dispatch({
    type: "guest-login",
    payload: {
      inviteCode: "join-code", email: "player@example.com", externalUserId: "ddb-user-1",
      character: { externalCharacterId: "ddb-char-1", name: "Aragorn", race: "Human", className: "Ranger", level: 5 },
      campaignPacket: { externalCampaignId: "ddb-campaign-1", campaignName: "Lost Mines", dmExternalUserId: "ddb-dm-1", members: [] }
    }
  });
  assert.equal(r.ok, true);
  const call = fetchCalls.find(c => c.url.endsWith("/api/auth/extension/guest-login"));
  assert.ok(call);
  const body = JSON.parse(call.options.body);
  assert.equal(body.externalSystem, "dndbeyond");
  assert.equal(body.character.externalCharacterId, "ddb-char-1");
  assert.equal(body.character.class, "Ranger");
  assert.equal(body.campaignPacket.externalCampaignId, "ddb-campaign-1");
});

test("guest-login stores device credential in storage", async () => {
  assert.equal(storage["dc:server-1"], "device-cred-1");
});

// ---------------------------------------------------------------------------
// Auth state — after GUEST login guestSession should be present
// ---------------------------------------------------------------------------

test("get-auth-state returns GUEST token after login", async () => {
  resetBetweenTests();
  const r = await dispatch({ type: "get-auth-state" });
  assert.equal(r.ok, true);
  assert.equal(r.hasAuthToken, true);
  assert.equal(r.authType, "GUEST");
});

// ---------------------------------------------------------------------------
// Character sync — requires guestSession from guest-login above
// ---------------------------------------------------------------------------

test("character-data-updated triggers full character sync", async () => {
  resetBetweenTests();
  dispatch({
    type: "character-data-updated",
    payload: { externalCharacterId: "char-1", name: "Aragorn", level: 5, stats: { hp: { current: 38, max: 42, temp: 0 }, ac: 16 } }
  });
  await new Promise(r => setTimeout(r, 10));
  const call = fetchCalls.find(c => c.url.endsWith("/api/integrations/external/sync"));
  assert.ok(call);
  const body = JSON.parse(call.options.body);
  assert.equal(body.characterUpdate.externalCharacterId, "char-1");
  assert.equal(body.characterUpdate.stats.ac, 16);
});

// ---------------------------------------------------------------------------
// Launch flows
// ---------------------------------------------------------------------------

test("guest-login-and-launch creates tab and syncs character", async () => {
  resetBetweenTests();
  await dispatch({
    type: "guest-login-and-launch",
    payload: { inviteCode: "join-code", email: "p@p.com", externalUserId: "u1", character: { externalCharacterId: "char-1", name: "Aragorn", level: 5 } }
  });
  assert.equal(tabsCreated.length, 1);
  assert.ok(tabsCreated[0].url.includes("ext-launch"));
  assert.ok(fetchCalls.some(c => c.url.endsWith("/api/integrations/external/sync")));
});

test("full-login-and-launch creates tab after full account login", async () => {
  resetBetweenTests();
  await dispatch({ type: "full-login-and-launch", payload: { email: "dm@p.com", password: "secret", role: "DM", inviteCode: "join-code" } });
  assert.equal(tabsCreated.length, 1);
  assert.ok(tabsCreated[0].url.includes("ext-launch"));
});

// ---------------------------------------------------------------------------
// Connect — triggered by content script inject button; covers handleConnect
// ---------------------------------------------------------------------------

test("connect message runs already-authenticated flow and launches tab", async () => {
  resetBetweenTests();
  // Preflight returns already-authenticated — guestSession exists from previous tests
  fetchOverride = {
    "/api/auth/extension/preflight": {
      ok: true,
      json: async () => ({ accountStatus: "authenticated", suggestedFlow: "already-authenticated" })
    }
  };
  dispatch({
    type: "connect",
    payload: {
      ddbUser: { id: "ddb-user-1", email: "player@example.com", displayName: "Player", avatarUrl: null },
      character: { ddbCharacterId: "ddb-char-1", name: "Aragorn", level: 5 },
      ddbCampaignId: "camp-uuid",
      ddbCampaignName: "Lost Mines"
    }
  });
  await new Promise(r => setTimeout(r, 30));
  // already-authenticated flow: sync + launch tab
  assert.ok(fetchCalls.some(c => c.url.endsWith("/api/integrations/external/sync")));
  assert.equal(tabsCreated.length, 1);
});

test("connect message with guest flow runs full guest-login + launch", async () => {
  resetBetweenTests();
  fetchOverride = {
    "/api/auth/extension/preflight": {
      ok: true,
      json: async () => ({ accountStatus: "none", suggestedFlow: "guest" })
    }
  };
  dispatch({
    type: "connect",
    payload: {
      ddbUser: { id: "ddb-user-1", email: "player@example.com", displayName: "Player", avatarUrl: null },
      character: { ddbCharacterId: "char-1", name: "Aragorn", level: 5 },
      ddbCampaignId: "camp-uuid", ddbCampaignName: "Lost Mines",
      isDm: false
    }
  });
  await new Promise(r => setTimeout(r, 30));
  assert.ok(fetchCalls.some(c => c.url.endsWith("/api/auth/extension/guest-login")));
  assert.equal(tabsCreated.length, 1);
});
