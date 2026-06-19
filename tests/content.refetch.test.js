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

// ---------------------------------------------------------------------------
// Fixture character data
// ---------------------------------------------------------------------------

// Silk — Elf Warlock L4. Expected: AC=14, HP max=23, initiative=+3, passivePerc=14
const SILK = {
  stats: [
    { id: 1, value: 10 }, { id: 2, value: 15 }, { id: 3, value: 10 },
    { id: 4, value: 8  }, { id: 5, value: 14 }, { id: 6, value: 14 }
  ],
  bonusStats: [], overrideStats: [],
  modifiers: {
    race:       [{ type: "proficiency", subType: "perception", value: null, fixedValue: null }],
    class:      [], background: [], item: [],
    feat: [
      { type: "bonus", subType: "dexterity-score", value: 1, fixedValue: null },
      { type: "bonus", subType: "charisma-score",  value: 2, fixedValue: null },
      { type: "bonus", subType: "charisma-score",  value: 1, fixedValue: null }
    ],
    condition: []
  },
  classes: [{ level: 4, subclassDefinition: null }],
  baseHitPoints: 23, removedHitPoints: 0, bonusHitPoints: null, overrideHitPoints: null, temporaryHitPoints: 0,
  inventory: [{
    id: 101, equipped: true, quantity: 1, isAttuned: false, chargesUsed: 0,
    definition: { name: "Leather Armor", filterType: "Armor", armorTypeId: 1, armorClass: 11, weight: 10, cost: 10, rarity: "Common", subType: null }
  }],
  customItems: [],
  currencies: { cp: 5, sp: 10, gp: 50, ep: 0, pp: 1 },
  spellSlots: [], pactMagic: [{ level: 2, available: 2, used: 0 }], conditions: [],
  actions: { class: [{ name: "Eldritch Blast" }] }, options: { class: [] },
  race: { fullName: "High Elf", weightSpeeds: { normal: { walk: 30 } } }
};

const SILK_DAMAGED = { ...SILK, removedHitPoints: 8, conditions: [{ id: 11 }] };
const SILK_EXHAUSTED = { ...SILK, conditions: [{ id: 4, level: 2 }] };

// Barbarian L1 — Unarmored Defense (CON). AC = 10 + DEX(+2) + CON(+3) = 15
const BARBARIAN = {
  stats: [
    { id: 1, value: 16 }, { id: 2, value: 14 }, { id: 3, value: 16 },
    { id: 4, value: 8  }, { id: 5, value: 12 }, { id: 6, value: 10 }
  ],
  bonusStats: [], overrideStats: [],
  modifiers: {
    race: [], background: [], item: [], feat: [], condition: [],
    class: [{ type: "set", subType: "unarmored-armor-class", statId: 3, value: null, fixedValue: null }]
  },
  classes: [{ level: 1, subclassDefinition: null }],
  baseHitPoints: 12, removedHitPoints: 0, bonusHitPoints: null, overrideHitPoints: null, temporaryHitPoints: 5,
  inventory: [], customItems: [], currencies: { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 },
  spellSlots: [], pactMagic: [], conditions: [],
  actions: { class: [] }, options: { class: [] },
  race: { fullName: "Human", weightSpeeds: { normal: { walk: 30 } } }
};

// Wizard L5 — standard spell slots
const WIZARD = {
  stats: [
    { id: 1, value: 8  }, { id: 2, value: 14 }, { id: 3, value: 12 },
    { id: 4, value: 17 }, { id: 5, value: 14 }, { id: 6, value: 10 }
  ],
  bonusStats: [], overrideStats: [],
  modifiers: { race: [], class: [], background: [], item: [], feat: [], condition: [] },
  classes: [{ level: 5, subclassDefinition: null }],
  baseHitPoints: 27, removedHitPoints: 0, bonusHitPoints: null, overrideHitPoints: null, temporaryHitPoints: 0,
  inventory: [], customItems: [], currencies: { cp: 0, sp: 0, gp: 100, ep: 0, pp: 0 },
  spellSlots: [
    { level: 1, available: 2, used: 2 },
    { level: 2, available: 2, used: 1 },
    { level: 3, available: 2, used: 0 }
  ],
  pactMagic: [], conditions: [],
  actions: { class: [] }, options: { class: [] },
  race: { fullName: "Human", weightSpeeds: { normal: { walk: 30 } } }
};

// ---------------------------------------------------------------------------
// Single module load — shared state, tests run in order
// ---------------------------------------------------------------------------

let dispatch;
const messages = [];
const storageData = {};
let defaultFetch;

function resetBetweenTests() {
  messages.length = 0;
  globalThis.fetch = defaultFetch;
}

before(async () => {
  const listeners = [];
  const userId = 42;
  const charId = 999;

  // Initial storage: stale cache + old Fighter list → IIFE will detect level-up
  Object.assign(storageData, {
    ddbUser: { id: userId, email: "u@u.com", displayName: "TestUser" },
    ddbCharacterList: [{ id: charId, name: "Fighter", level: 3, race: "Human", class: "Fighter", avatar: null, campaignId: "c1" }],
    ddbCacheUpdatedAt: Date.now() - 10 * 60 * 1000
  });

  globalThis.browser = {
    runtime: {
      onMessage:   { addListener(fn) { listeners.push(fn); } },
      sendMessage(msg) { messages.push(msg); }
    },
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, storageData[k]]));
          if (typeof keys === "string") return { [keys]: storageData[keys] };
          return { ...storageData };
        },
        async set(partial) { Object.assign(storageData, partial); }
      }
    }
  };
  globalThis.chrome = globalThis.browser;

  // Return the mega-menu user element (needed by extractDdbUser in ensureDdbCache)
  globalThis.document = {
    querySelector(sel) {
      if (sel === "#mega-menu-target") {
        return {
          getAttribute: (a) => ({ "user-id": String(userId), "display-name": "TestUser", "user-avatar": null, email: "u@u.com", roles: "player" }[a] ?? null)
        };
      }
      return null;
    },
    querySelectorAll: () => ({ forEach: () => {} })
  };
  globalThis.document.body = { style: {} };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.window = {};
  globalThis.location = { pathname: "/characters/12345" };
  globalThis.console = console;

  defaultFetch = globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("cobalt-token"))      return { ok: true, json: async () => ({ token: "tok" }) };
    if (u.includes("characters/list"))   return {
      ok: true,
      json: async () => ({
        data: {
          characters: [{
            id: charId, name: "Fighter", level: 4,
            raceName: "Human", classDescription: "Fighter",
            avatarUrl: null, campaignId: "c1", campaignName: "Campaign"
          }]
        }
      })
    };
    // Character detail routes: /character/12345, /character/777, /character/888
    if (u.includes("/character/12345"))  return { ok: true, json: async () => ({ data: SILK }) };
    if (u.includes("/character/777"))    return { ok: true, json: async () => ({ data: BARBARIAN }) };
    if (u.includes("/character/888"))    return { ok: true, json: async () => ({ data: WIZARD }) };
    return { ok: false, json: async () => ({}) };
  };

  const url = pathToFileURL(path.join(process.cwd(), "src/content.js")).href;
  await import(url);

  // Wait for IIFE to complete
  await new Promise(r => setTimeout(r, 100));

  assert.ok(listeners.length > 0, "Expected content listener");
  dispatch = (msg) => listeners[listeners.length - 1]?.(msg);
});

// ---------------------------------------------------------------------------
// IIFE — ensureDdbCache detects level change (checked first, runs from before())
// ---------------------------------------------------------------------------

test("ensureDdbCache detects level-up and emits character-data-updated with full payload", () => {
  const syncMsg = messages.find(m => m.type === "character-data-updated");
  assert.ok(syncMsg, "Expected character-data-updated for level change");
  assert.equal(syncMsg.payload.externalCharacterId, "999");
  assert.equal(syncMsg.payload.level, 4);
});

// ---------------------------------------------------------------------------
// handleRefetchCharacter — these share module state; each test resets messages
// and updates storageData.ddbCharacterList before dispatching
// ---------------------------------------------------------------------------

test("handleRefetchCharacter builds correct stats for Silk (AC=14, HP=23, initiative=+3)", async () => {
  resetBetweenTests();
  const characterId = 12345;
  storageData.ddbCharacterList = [{ id: characterId, name: "Silk", level: 4, race: "Elf", class: "Warlock", avatar: null, campaignId: "c1" }];

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  const msg = messages.find(m => m.type === "character-data-updated");
  assert.ok(msg, "Expected character-data-updated message");
  const { payload } = msg;

  assert.equal(payload.name, "Silk");
  assert.equal(payload.stats.ac, 14);
  assert.equal(payload.stats.hp.max, 23);
  assert.equal(payload.stats.hp.current, 23);
  assert.equal(payload.stats.hp.temp, 0);
  assert.equal(payload.stats.initiative, 3);
  assert.equal(payload.stats.passivePerception, 14);
  assert.equal(payload.stats.proficiencyBonus, 2);
  assert.equal(payload.stats.speed, 30);
  assert.deepEqual(payload.stats.abilityScores, { str: 10, dex: 16, con: 10, int: 8, wis: 14, cha: 17 });
  assert.deepEqual(payload.conditions, []);
  assert.deepEqual(payload.features, ["Eldritch Blast"]);
  assert.ok(payload.stats.pactMagic, "Expected pact magic slots");
  assert.equal(payload.stats.pactMagic.total["2"], 2);
  assert.equal(payload.stats.pactMagic.used["2"], 0);
  assert.equal(payload.stats.spellSlots, null);
  assert.equal(payload.inventory.items.length, 1);
  assert.equal(payload.inventory.items[0].name, "Leather Armor");
  assert.deepEqual(payload.inventory.currency, { cp: 5, sp: 10, gp: 50, ep: 0, pp: 1 });
});

test("handleRefetchCharacter reflects damaged HP and active conditions", async () => {
  resetBetweenTests();
  const characterId = 12345;
  storageData.ddbCharacterList = [{ id: characterId, name: "Silk", level: 4, race: "Elf", class: "Warlock", avatar: null, campaignId: "c1" }];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("cobalt-token"))      return { ok: true, json: async () => ({ token: "tok" }) };
    if (u.includes(`/character/${characterId}`)) return { ok: true, json: async () => ({ data: SILK_DAMAGED }) };
    return { ok: false, json: async () => ({}) };
  };

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  const msg = messages.find(m => m.type === "character-data-updated");
  assert.ok(msg);
  assert.equal(msg.payload.stats.hp.current, 15); // 23 - 8
  assert.deepEqual(msg.payload.conditions, ["Poisoned"]);
});

test("handleRefetchCharacter includes Exhaustion level in conditions", async () => {
  resetBetweenTests();
  const characterId = 12345;
  storageData.ddbCharacterList = [{ id: characterId, name: "Silk", level: 4, race: "Elf", class: "Warlock", avatar: null, campaignId: "c1" }];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("cobalt-token"))                return { ok: true, json: async () => ({ token: "tok" }) };
    if (u.includes(`/character/${characterId}`))   return { ok: true, json: async () => ({ data: SILK_EXHAUSTED }) };
    return { ok: false, json: async () => ({}) };
  };

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  const msg = messages.find(m => m.type === "character-data-updated");
  assert.ok(msg);
  assert.deepEqual(msg.payload.conditions, ["Exhaustion 2"]);
});

test("handleRefetchCharacter sends nothing when character is not in list", async () => {
  resetBetweenTests();
  storageData.ddbCharacterList = [];

  dispatch({ type: "refetch-character", characterId: 99999 });
  await new Promise(r => setTimeout(r, 60));

  assert.equal(messages.length, 0);
});

test("handleRefetchCharacter sends nothing when fetch throws", async () => {
  resetBetweenTests();
  const characterId = 12345;
  storageData.ddbCharacterList = [{ id: characterId, name: "Silk", level: 4, race: "Elf", class: "Warlock", avatar: null, campaignId: "c1" }];
  globalThis.fetch = async () => { throw new Error("Network error"); };

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  assert.equal(messages.length, 0);
});

test("handleRefetchCharacter computes unarmored defense AC for Barbarian", async () => {
  resetBetweenTests();
  const characterId = 777;
  storageData.ddbCharacterList = [{ id: characterId, name: "Grog", level: 1, race: "Human", class: "Barbarian", avatar: null, campaignId: "c1" }];

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  const msg = messages.find(m => m.type === "character-data-updated");
  assert.ok(msg);
  // 10 + DEX mod(+2) + CON mod(+3) = 15
  assert.equal(msg.payload.stats.ac, 15);
  // HP: base 12 + CON mod(3) × level 1 = 15
  assert.equal(msg.payload.stats.hp.max, 15);
  assert.equal(msg.payload.stats.hp.temp, 5);
});

test("handleRefetchCharacter maps standard spell slots for Wizard", async () => {
  resetBetweenTests();
  const characterId = 888;
  storageData.ddbCharacterList = [{ id: characterId, name: "Mordenkainen", level: 5, race: "Human", class: "Wizard", avatar: null, campaignId: "c1" }];

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  const slots = messages.find(m => m.type === "character-data-updated")?.payload?.stats?.spellSlots;
  assert.ok(slots, "Expected spell slots");
  assert.equal(slots.total["1"], 4);
  assert.equal(slots.used["1"],  2);
  assert.equal(slots.total["2"], 3);
  assert.equal(slots.used["2"],  1);
  assert.equal(slots.total["3"], 2);
  assert.equal(slots.used["3"],  0);
});
