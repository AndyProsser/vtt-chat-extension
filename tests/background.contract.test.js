import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Polyfill Buffer and process for ESM/test environments
let _Buffer = globalThis.Buffer;
if (!_Buffer) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  globalThis.Buffer = (await import('buffer')).Buffer;
}
if (!globalThis.process) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  globalThis.process = (await import('process')).default;
}

function createJwt(expEpochSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expEpochSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function loadBackgroundWithMocks(initialState = {}) {
  const fetchCalls = [];
  const listeners = [];
  const storage = {
    servers: [
      {
        id: "server-1",
        name: "Local",
        url: "https://vtt.local",
        serverCode: "join-code"
      }
    ],
    activeServerId: "server-1",
    ...initialState
  };

  globalThis.atob = (b64) => Buffer.from(b64, "base64").toString("utf8");
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });

    if (String(url).endsWith("/api/platform/status")) {
      return {
        ok: true,
        json: async () => ({ online: true, maintenanceMode: false })
      };
    }

    if (String(url).includes("/api/campaigns/invite/") && String(url).endsWith("/validate")) {
      return {
        ok: true,
        json: async () => ({ valid: true, campaign: { name: "Lost Mines" } })
      };
    }

    if (String(url).endsWith("/api/auth/extension/preflight")) {
      return {
        ok: true,
        json: async () => ({ accountStatus: "none", suggestedFlow: "guest" })
      };
    }

    if (String(url).endsWith("/api/auth/extension/guest-login")) {
      return {
        ok: true,
        json: async () => ({
          token: createJwt(Math.floor(Date.now() / 1000) + 3600),
          user: { campaignId: "camp-uuid", authType: "GUEST", role: "PLAYER" },
          character: { id: "char-1", name: "Aragorn" }
        })
      };
    }

    if (String(url).endsWith("/api/auth/login")) {
      return {
        ok: true,
        json: async () => ({
          token: createJwt(Math.floor(Date.now() / 1000) + 3600),
          user: { id: "user-1", role: "PLAYER", authType: "FULL" }
        })
      };
    }

    if (String(url).endsWith("/api/integrations/external/sync")) {
      return {
        ok: true,
        json: async () => ({ message: "ok" })
      };
    }

    return {
      ok: false,
      json: async () => ({ message: "Unhandled fetch in test" })
    };
  };

  globalThis.browser = {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    },
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) {
              result[key] = storage[key];
            }
            return result;
          }
          if (typeof keys === "string") {
            return { [keys]: storage[keys] };
          }
          return { ...storage };
        },
        async set(partial) {
          Object.assign(storage, partial);
        }
      }
    },
    tabs: {
      create() {}
    }
  };
  globalThis.chrome = globalThis.browser;

  const modulePath = pathToFileURL(path.join(process.cwd(), "src/background.js")).href;
  await import(`${modulePath}?test=${Date.now()}-${Math.random()}`);

  assert.equal(listeners.length > 0, true, "Expected background listener to be registered");

  return {
    storage,
    fetchCalls,
    dispatch: (message) => listeners[0](message)
  };
}

test("run-preflight performs required Stage 13.4 call sequence", async () => {
  const ctx = await loadBackgroundWithMocks({
    ddbUser: { id: "ddb-user-1", email: "player@example.com", displayName: "Player" }
  });

  const result = await ctx.dispatch({
    type: "run-preflight",
    payload: {
      inviteCode: "join-code",
      email: "player@example.com",
      externalUserId: "ddb-user-1"
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    ctx.fetchCalls.map(call => call.url),
    [
      "https://vtt.local/api/platform/status",
      "https://vtt.local/api/campaigns/invite/join-code/validate",
      "https://vtt.local/api/auth/extension/preflight"
    ]
  );

  const preflightBody = JSON.parse(ctx.fetchCalls[2].options.body);
  assert.equal(preflightBody.externalSystem, "dndbeyond");
  assert.equal(preflightBody.inviteCode, "join-code");
  assert.equal(preflightBody.email, "player@example.com");
  assert.equal(preflightBody.externalUserId, "ddb-user-1");
});

test("guest-login submits character and campaign packet contract fields", async () => {
  const ctx = await loadBackgroundWithMocks({
    ddbUser: { id: "ddb-user-1", email: "player@example.com", displayName: "Player" },
    ddbActiveContext: {
      externalCampaignId: "ddb-campaign-1",
      campaignName: "Lost Mines",
      dmExternalUserId: "ddb-dm-1",
      members: []
    }
  });

  const result = await ctx.dispatch({
    type: "guest-login",
    payload: {
      inviteCode: "join-code",
      email: "player@example.com",
      externalUserId: "ddb-user-1",
      character: {
        externalCharacterId: "ddb-char-1",
        name: "Aragorn",
        race: "Human",
        className: "Ranger",
        level: 5,
        avatarUrl: "https://img"
      },
      campaignPacket: {
        externalCampaignId: "ddb-campaign-1",
        campaignName: "Lost Mines",
        dmExternalUserId: "ddb-dm-1",
        members: []
      }
    }
  });

  assert.equal(result.ok, true);

  const guestLoginCall = ctx.fetchCalls.find(call => call.url.endsWith("/api/auth/extension/guest-login"));
  assert.ok(guestLoginCall, "Expected guest-login call");

  const body = JSON.parse(guestLoginCall.options.body);
  assert.equal(body.externalSystem, "dndbeyond");
  assert.equal(body.character.externalCharacterId, "ddb-char-1");
  assert.equal(body.character.class, "Ranger");
  assert.equal(body.campaignPacket.externalCampaignId, "ddb-campaign-1");
  assert.equal(body.campaignPacket.dmExternalUserId, "ddb-dm-1");
});

test("character update sends sync contract payload after guest auth", async () => {
  const ctx = await loadBackgroundWithMocks({
    ddbUser: { id: "ddb-user-1", email: "player@example.com", displayName: "Player" }
  });

  await ctx.dispatch({
    type: "guest-login",
    payload: {
      inviteCode: "join-code",
      email: "player@example.com",
      externalUserId: "ddb-user-1"
    }
  });

  await ctx.dispatch({
    type: "character-update-detected",
    payload: {
      source: "player",
      externalCharacterId: "ddb-char-1",
      level: 6,
      className: "Ranger",
      subclass: "Hunter"
    }
  });

  // Background handles this message asynchronously via `void`; wait a tick for fetch.
  await new Promise(resolve => setTimeout(resolve, 0));

  const syncCall = ctx.fetchCalls.find(call => call.url.endsWith("/api/integrations/external/sync"));
  assert.ok(syncCall, "Expected external sync request");

  const syncBody = JSON.parse(syncCall.options.body);
  assert.equal(syncBody.campaignId, "camp-uuid");
  assert.equal(syncBody.externalSystem, "dndbeyond");
  assert.equal(syncBody.source, "player");
  assert.equal(syncBody.characterUpdate.externalCharacterId, "ddb-char-1");
  assert.equal(syncBody.characterUpdate.level, 6);
  assert.equal(syncBody.characterUpdate.class, "Ranger");
  assert.equal(syncBody.characterUpdate.subclass, "Hunter");
});
