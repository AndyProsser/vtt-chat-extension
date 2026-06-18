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
// Fixtures
// ---------------------------------------------------------------------------

// Medium armor character (armorTypeId=2 → AC = base + min(dex, 2))
// DEX=16 (+3), medium armor base AC=14 → AC = 14 + min(3,2) = 16
const MEDIUM_ARMOR_CHAR = {
  stats: [
    { id: 1, value: 14 }, { id: 2, value: 16 }, { id: 3, value: 12 },
    { id: 4, value: 10 }, { id: 5, value: 12 }, { id: 6, value: 8  }
  ],
  bonusStats: [], overrideStats: [],
  modifiers: { race: [], class: [], background: [], item: [], feat: [], condition: [] },
  classes: [{ level: 3, subclassDefinition: null }],
  baseHitPoints: 24, removedHitPoints: 0, bonusHitPoints: null, overrideHitPoints: null, temporaryHitPoints: 0,
  inventory: [{
    id: 201, equipped: true, quantity: 1, isAttuned: false, chargesUsed: 0,
    definition: { name: "Chain Shirt", filterType: "Armor", armorTypeId: 2, armorClass: 14, weight: 20, cost: 50, rarity: "Common", subType: null }
  }],
  customItems: [{ id: 301, name: "Lucky Dice", quantity: 1, weight: 0.1, cost: null, notes: "Grandpa's dice" }],
  currencies: { cp: 0, sp: 5, gp: 12, ep: 0, pp: 0 },
  spellSlots: [], pactMagic: [], conditions: [],
  actions: { class: [] }, options: { class: [] },
  race: { fullName: "Half-Orc", weightSpeeds: { normal: { walk: 30 } } }
};

// overrideStats character (override STR to 20 regardless of base)
const OVERRIDE_STATS_CHAR = {
  stats: [
    { id: 1, value: 10 }, { id: 2, value: 14 }, { id: 3, value: 12 },
    { id: 4, value: 10 }, { id: 5, value: 10 }, { id: 6, value: 10 }
  ],
  bonusStats: [{ id: 1, value: 2 }],  // +2 STR bonus (should be ignored by overrideStats)
  overrideStats: [{ id: 1, value: 20 }],  // override STR to 20
  modifiers: { race: [], class: [], background: [], item: [], feat: [], condition: [] },
  classes: [{ level: 1, subclassDefinition: null }],
  baseHitPoints: 10, removedHitPoints: 0, bonusHitPoints: null, overrideHitPoints: null, temporaryHitPoints: 0,
  inventory: [], customItems: [], currencies: { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 },
  spellSlots: [], pactMagic: [], conditions: [],
  actions: { class: [] }, options: { class: [] },
  race: { fullName: "Human", weightSpeeds: { normal: { walk: 30 } } }
};

// ---------------------------------------------------------------------------
// Single module load with Cobalt user (no mega-menu)
// ---------------------------------------------------------------------------

let dispatch;
const messages = [];
const storageData = {};
let defaultFetch;
const cobaltUserId = 55;
const charId = 111;

before(async () => {
  const listeners = [];

  // Initial storage: stale cache + old Fighter list → IIFE will detect level-up
  Object.assign(storageData, {
    ddbUser: { id: cobaltUserId, email: "cobalt@test.com", displayName: "CobaltUser" },
    ddbCharacterList: [{ id: charId, name: "Warrior", level: 2, race: "Human", class: "Fighter", avatar: null, campaignId: "c1" }],
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

  // No mega-menu element — forces extractDdbUser to try Cobalt path
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} })
  };
  globalThis.document.body = { style: {} };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.window = { Cobalt: { User: { ID: cobaltUserId, DisplayName: "CobaltUser", AvatarUrl: null, Email: "cobalt@test.com" } } };
  globalThis.location = { pathname: "/characters/12345" };
  globalThis.console = console;

  defaultFetch = globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("cobalt-token"))    return { ok: true, json: async () => ({ token: "tok" }) };
    if (u.includes("characters/list")) return {
      ok: true,
      json: async () => ({
        data: {
          characters: [{
            id: charId, name: "Warrior", level: 3,
            raceName: "Human", classDescription: "Fighter",
            avatarUrl: null, campaignId: "c1", campaignName: "Campaign"
          }]
        }
      })
    };
    if (u.includes("/character/12345")) return { ok: true, json: async () => ({ data: MEDIUM_ARMOR_CHAR }) };
    if (u.includes("/character/999"))   return { ok: true, json: async () => ({ data: OVERRIDE_STATS_CHAR }) };
    return { ok: false, json: async () => ({}) };
  };

  const url = pathToFileURL(path.join(process.cwd(), "src/content.js")).href;
  await import(url);

  await new Promise(r => setTimeout(r, 100));

  assert.ok(listeners.length > 0, "Expected content listener");
  dispatch = (msg) => listeners[listeners.length - 1]?.(msg);
});

// ---------------------------------------------------------------------------
// IIFE ran with Cobalt user (no mega-menu) — detect level change
// ---------------------------------------------------------------------------

test("ensureDdbCache uses Cobalt user when mega-menu absent", () => {
  const syncMsg = messages.find(m => m.type === "character-update-detected");
  assert.ok(syncMsg, "Expected character-update-detected from Cobalt user path");
  assert.equal(syncMsg.payload.externalCharacterId, String(charId));
  assert.equal(syncMsg.payload.level, 3);
});

// ---------------------------------------------------------------------------
// Refetch with medium armor (armorTypeId=2) — covers AC calculation branch
// ---------------------------------------------------------------------------

test("handleRefetchCharacter computes AC for medium armor (chain shirt)", async () => {
  messages.length = 0;
  const characterId = 12345;
  storageData.ddbCharacterList = [{ id: characterId, name: "Half-Orc Ranger", level: 3, race: "Half-Orc", class: "Ranger", avatar: null, campaignId: "c1" }];

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  const msg = messages.find(m => m.type === "character-data-updated");
  assert.ok(msg, "Expected character-data-updated");
  // Chain Shirt (armorTypeId=2): base 14 + min(DEX mod +3, 2) = 14 + 2 = 16
  assert.equal(msg.payload.stats.ac, 16);
  // Custom items should be included in inventory
  assert.ok(msg.payload.inventory.items.some(i => i.name === "Lucky Dice"), "Expected custom item");
  assert.equal(msg.payload.inventory.items.find(i => i.name === "Lucky Dice").notes, "Grandpa's dice");
});

// ---------------------------------------------------------------------------
// Refetch with overrideStats — STR should be 20 not 10+2=12
// ---------------------------------------------------------------------------

test("handleRefetchCharacter respects overrideStats for ability scores", async () => {
  messages.length = 0;
  const characterId = 999;
  storageData.ddbCharacterList = [{ id: characterId, name: "Override Test", level: 1, race: "Human", class: "Fighter", avatar: null, campaignId: "c1" }];

  dispatch({ type: "refetch-character", characterId });
  await new Promise(r => setTimeout(r, 60));

  const msg = messages.find(m => m.type === "character-data-updated");
  assert.ok(msg);
  // overrideStats sets STR to 20 (ignoring base 10 + bonus +2 = 12)
  assert.equal(msg.payload.stats.abilityScores.str, 20);
});
