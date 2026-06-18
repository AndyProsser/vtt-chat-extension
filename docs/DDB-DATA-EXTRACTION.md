# D&D Beyond Data Extraction

This document describes how the extension extracts user, character, and campaign data from D&D Beyond (DDB) to support VTT-Chat onboarding and session sync.

For the reverse direction — pushing currency changes from VTT-Chat back to DDB — see the experimental, unofficial write path documented in [DDB-CURRENCY-WRITEBACK.md](DDB-CURRENCY-WRITEBACK.md). That endpoint is undocumented by DDB and likely violates their ToS; read the caution banner before building anything against it.

---

## User Extraction

The extension attempts to extract the logged-in user from multiple sources in order:

1. **Mega Menu DOM** — reads attributes from `#mega-menu-target` (`user-id`, `display-name`, `user-avatar`, `email`, `roles`).
2. **Cobalt Object** — reads from `window.Cobalt.User` if available.
3. **Next.js Flight Script** — parses embedded JSON from `<script>` tags containing user info.

The first source to return a non-null result wins.

---

## Character List

```text
POST https://auth-service.dndbeyond.com/v1/cobalt-token    → JWT
GET  https://character-service.dndbeyond.com/character/v5/characters/list?userId=<id>
```

Response path: `data.characters[]`

Normalised fields used: `id`, `name`, `level`, `raceName`, `classDescription`, `avatarUrl`, `campaignId`, `campaignName`.

---

## Character Details

```text
GET https://character-service.dndbeyond.com/character/v5/character/:id?includeCustomItems=true
```

All stat calculations in the sections below are derived from `response.data` (referred to as `char` below). Cross-validated against two sample characters:

| Stat                              | Silk (Elf Warlock L4)      | Liath (Aasimar Sorcerer L4) |
| --------------------------------- | -------------------------- | --------------------------- |
| STR / DEX / CON / INT / WIS / CHA | 10 / 16 / 10 / 8 / 14 / 17 | 8 / 16 / 12 / 10 / 14 / 16  |
| HP (max / current)                | 23 / 23                    | 26 / 16                     |
| AC                                | 14                         | 16                          |

---

## Ability Score Calculation

Each of the six ability scores (STR, DEX, CON, INT, WIS, CHA) is computed from three layers:

### 1. Raw base values

```text
char.stats[]         — base rolled/point-buy scores
char.bonusStats[]    — a separate flat bonus per stat (usually null; set via character builder)
char.overrideStats[] — if non-null, overrides the total completely (DM override)
```

Each array contains six objects keyed by `id` → stat:

| id  | stat |
| --- | ---- |
| 1   | STR  |
| 2   | DEX  |
| 3   | CON  |
| 4   | INT  |
| 5   | WIS  |
| 6   | CHA  |

### 2. Modifier bonuses from `char.modifiers`

`char.modifiers` has six category buckets: `race`, `class`, `background`, `item`, `feat`, `condition`. Flatten all six and collect every entry where:

```text
type === "bonus"
subType ∈ { "strength-score", "dexterity-score", "constitution-score",
            "intelligence-score", "wisdom-score", "charisma-score" }
```

Sum their `value` (or `fixedValue` if `value` is null) per stat.

> **Background feat grants** — in the 2024 rules, backgrounds grant two ability score improvements via `grantedFeats`. These are represented as `type: "bonus"` entries in `modifiers.feat` with the same subType pattern. They are collected automatically by the flat scan above — no special handling needed.

### 3. Final formula

```text
if overrideStats[stat] != null:
    final = overrideStats[stat]
else:
    final = stats[stat] + (bonusStats[stat] || 0) + sum(modifiers bonus for stat)
```

### Verified example — Silk (Warlock L4)

| Stat | base (`stats`) | `modifiers` bonus     | Final  |
| ---- | -------------- | --------------------- | ------ |
| STR  | 10             | 0                     | **10** |
| DEX  | 15             | +1 (feat)             | **16** |
| CON  | 10             | 0                     | **10** |
| INT  | 8              | 0                     | **8**  |
| WIS  | 14             | 0                     | **14** |
| CHA  | 14             | +3 (+2 feat, +1 feat) | **17** |

The +2 CHA and +1 DEX came from the Charlatan background's `grantedFeats` (feat ID `1789122`), appearing as `type: "bonus"` entries in `modifiers.feat`.

---

## Proficiency Bonus

```js
const totalLevel = char.classes.reduce((sum, cls) => sum + cls.level, 0);
const proficiencyBonus = Math.floor((totalLevel - 1) / 4) + 2;
```

| Total Level | Proficiency Bonus |
| ----------- | ----------------- |
| 1–4         | +2                |
| 5–8         | +3                |
| 9–12        | +4                |
| 13–16       | +5                |
| 17–20       | +6                |

---

## HP

`baseHitPoints` stores only the raw hit dice total — it does **not** include CON modifier or per-level feature bonuses. Both must be applied manually.

```js
const CON_MOD = Math.floor((conScore - 10) / 2);

const hpPerLevelBonus = flatModifiers
  .filter((m) => m.type === "bonus" && m.subType === "hit-points-per-level")
  .reduce((sum, m) => sum + (m.value || m.fixedValue || 0), 0);

const maxHp =
  char.overrideHitPoints ??
  char.baseHitPoints +
    CON_MOD * totalLevel +
    hpPerLevelBonus * totalLevel +
    (char.bonusHitPoints || 0);

const currentHp = Math.max(0, maxHp - (char.removedHitPoints || 0));
const tempHp = char.temporaryHitPoints || 0;
```

| Field                           | Meaning                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| `baseHitPoints`                 | Hit dice average only — no CON, no per-level bonuses              |
| `CON_MOD × totalLevel`          | Standard CON HP bonus per level                                   |
| `hit-points-per-level` modifier | Per-level bonus from subclass features (e.g. Draconic Resilience) |
| `bonusHitPoints`                | Manual bonus added on top (usually `null`)                        |
| `overrideHitPoints`             | Replaces all of the above when non-null                           |
| `removedHitPoints`              | Damage taken — subtract from max for current HP                   |
| `temporaryHitPoints`            | Tracked separately, never reduces max                             |

### Verified examples

| Character                   | `baseHitPoints` | CON mod × level | per-level bonus × level          | Max HP |
| --------------------------- | --------------- | --------------- | -------------------------------- | ------ |
| Silk (Warlock L4, CON 10)   | 23              | +0 × 4 = 0      | none                             | **23** |
| Liath (Sorcerer L4, CON 12) | 18              | +1 × 4 = 4      | +1 × 4 = 4 (Draconic Resilience) | **26** |

---

## Armour Class

AC depends on what the character is wearing. The full algorithm:

### 1. Scan equipped items

```js
const equippedArmor = char.inventory.find(
  (i) =>
    i.equipped &&
    i.definition?.filterType === "Armor" &&
    i.definition?.armorTypeId !== 4,
);
const equippedShield = char.inventory.find(
  (i) => i.equipped && i.definition?.armorTypeId === 4,
);
```

`armorTypeId` values:

| armorTypeId | Type         |
| ----------- | ------------ |
| 1           | Light armor  |
| 2           | Medium armor |
| 3           | Heavy armor  |
| 4           | Shield       |

### 2. Compute base AC

```js
const STAT_ID = { 1: "str", 2: "dex", 3: "con", 4: "int", 5: "wis", 6: "cha" };
const DEX_MOD = Math.floor((abilityScores.dex - 10) / 2);
const statMod = (stat) => Math.floor((abilityScores[stat] - 10) / 2);

let baseAC;
if (equippedArmor) {
  const armorBase = equippedArmor.definition.armorClass;
  const typeId = equippedArmor.definition.armorTypeId;
  if (typeId === 1)
    baseAC = armorBase + DEX_MOD; // light
  else if (typeId === 2)
    baseAC = armorBase + Math.min(DEX_MOD, 2); // medium
  else baseAC = armorBase; // heavy
} else {
  // Check for Unarmored Defense (Barbarian, Monk, Draconic Sorcerer, etc.)
  // modifier: type "set", subType "unarmored-armor-class", statId = extra stat to add
  const unarmoredMod = flatModifiers.find(
    (m) =>
      m.type === "set" &&
      m.subType === "unarmored-armor-class" &&
      m.statId != null,
  );
  if (unarmoredMod) {
    const extraStat = STAT_ID[unarmoredMod.statId];
    baseAC = 10 + DEX_MOD + statMod(extraStat);
  } else {
    baseAC = 10 + DEX_MOD; // plain unarmored
  }
}
```

The `statId` field on the set modifier identifies which extra ability score is added to `10 + DEX`:

| Class feature               | statId  | Formula        |
| --------------------------- | ------- | -------------- |
| Barbarian Unarmored Defense | 3 (CON) | 10 + DEX + CON |
| Monk Unarmored Defense      | 5 (WIS) | 10 + DEX + WIS |
| Draconic Resilience (2024)  | 6 (CHA) | 10 + DEX + CHA |

### 3. Add shield and bonus modifiers

```js
const shieldBonus = equippedShield ? 2 : 0;

const acBonusFromMods = flatModifiers
  .filter((m) => m.type === "bonus" && m.subType === "armor-class")
  .reduce((sum, m) => sum + (m.value || m.fixedValue || 0), 0);

const ac = baseAC + shieldBonus + acBonusFromMods;
```

### Verified AC examples

| Character | Armor                      | Formula                          | AC     |
| --------- | -------------------------- | -------------------------------- | ------ |
| Silk      | Leather (light, base 11)   | 11 + DEX mod (+3)                | **14** |
| Liath     | None — Draconic Resilience | 10 + DEX mod (+3) + CHA mod (+3) | **16** |

> **`value` is always `null`** on `unarmored-armor-class` set modifiers — the formula is always `10 + DEX + statId stat`, never a bare numeric override. The `statId` field is the sole discriminator; when it is `null`, fall back to plain `10 + DEX`.

---

## Initiative

```js
const DEX_MOD = Math.floor((dexScore - 10) / 2);

const initiativeBonus = flatModifiers
  .filter((m) => m.type === "bonus" && m.subType === "initiative")
  .reduce((sum, m) => sum + (m.value || m.fixedValue || 0), 0);

const initiative = DEX_MOD + initiativeBonus;
```

Common sources of `bonus: initiative` modifiers:

- **Alert feat** — adds +5 to initiative (`modifiers.feat`)
- **Bard's Jack of All Trades** — half proficiency to initiative

Both characters verified with no initiative modifiers: initiative = DEX mod.

---

## Passive Perception

```js
const WIS_MOD = Math.floor((wisScore - 10) / 2);

const hasPerceptionProficiency = flatModifiers.some(
  (m) => m.type === "proficiency" && m.subType === "perception",
);

const passivePerception =
  10 + WIS_MOD + (hasPerceptionProficiency ? proficiencyBonus : 0);
```

| Character | WIS | WIS mod | Perception prof | Passive Perception |
| --------- | --- | ------- | --------------- | ------------------ |
| Silk      | 14  | +2      | Yes (race)      | **14**             |
| Liath     | 14  | +2      | No              | **12**             |

> **Expertise** in Perception (e.g. Rogue/Bard) doubles the proficiency bonus. Check for `type: "double-proficiency", subType: "perception"` in the flat modifier list; if present, apply `2 × proficiencyBonus` instead of `proficiencyBonus`.

---

## Speed

```js
const speed = char.race?.weightSpeeds?.normal?.walk ?? 30;
```

`weightSpeeds.normal` also has `fly`, `swim`, `climb`, `burrow` but `walk` is the primary value used for the sync payload.

---

## Spell Slots

Spell slots are tracked at the character level in two separate arrays depending on the class:

### Standard spell slots (all casters except Warlock)

```text
char.spellSlots[]  →  [ { level: 1, used: N, available: N }, … { level: 9, … } ]
```

- `available` = slots currently remaining at that level
- `used` = slots expended
- `total` at level N = `available + used`

### Pact Magic (Warlock)

```text
char.pactMagic[]  →  [ { level: 1, used: N, available: N }, … { level: 5, … } ]
```

Same structure as `spellSlots` but tracks Pact Magic slots separately. A multiclass character may have both.

### Mapping to the sync payload

```js
// Build the spellSlots object for the VTT-Chat sync API
function buildSpellSlots(char) {
  const source = isWarlock(char) ? char.pactMagic : char.spellSlots;
  const total = {},
    used = {};
  for (const slot of source) {
    const slotTotal = (slot.available || 0) + (slot.used || 0);
    if (slotTotal > 0) {
      total[String(slot.level)] = slotTotal;
      used[String(slot.level)] = slot.used || 0;
    }
  }
  return Object.keys(total).length ? { total, used } : null;
}
```

> Note: `available` being 0 with `used` also 0 at a given level means no slots exist at that level, **or** that the character has converted all slots (e.g. Sorcerer using Flexible Casting). The `total = available + used` rule still holds.

---

## Conditions

Active conditions are stored in `char.conditions[]`. Each entry has at minimum:

```json
{ "id": 1, "level": null }
```

Where `id` maps to the standard D&D condition list:

| id  | Condition     |
| --- | ------------- |
| 1   | Blinded       |
| 2   | Charmed       |
| 3   | Deafened      |
| 4   | Exhaustion    |
| 5   | Frightened    |
| 6   | Grappled      |
| 7   | Incapacitated |
| 8   | Invisible     |
| 9   | Paralyzed     |
| 10  | Petrified     |
| 11  | Poisoned      |
| 12  | Prone         |
| 13  | Restrained    |
| 14  | Stunned       |
| 15  | Unconscious   |

The `level` field is used for Exhaustion (levels 1–6); all other conditions leave it `null`.

```js
const CONDITIONS = {
  1: "Blinded",
  2: "Charmed",
  3: "Deafened",
  4: "Exhaustion",
  5: "Frightened",
  6: "Grappled",
  7: "Incapacitated",
  8: "Invisible",
  9: "Paralyzed",
  10: "Petrified",
  11: "Poisoned",
  12: "Prone",
  13: "Restrained",
  14: "Stunned",
  15: "Unconscious",
};

const conditions = (char.conditions || []).map((c) => {
  const name = CONDITIONS[c.id] || `Condition ${c.id}`;
  return c.level ? `${name} ${c.level}` : name;
});
```

Both sample characters had empty condition arrays.

---

## Class Features (for `features` field)

Active class features that are displayed on the character sheet come from:

```text
char.classes[].classFeatures[].definition.name
```

Filter out features that are hidden in the sheet builder:

```js
const features = char.classes
  .flatMap((cls) => cls.classFeatures || [])
  .filter((f) => !f.definition?.hideInSheet)
  .map((f) => f.definition?.name)
  .filter(Boolean);
```

> This is a first-pass implementation. Not all entries in `classFeatures` represent discrete in-session features (some are passive proficiencies). Further filtering may be needed.

---

## Campaign Details

```text
GET https://api.dndbeyond.com/campaigns/v1/details/:id
```

Used to determine DM, members, and active characters.

- `data.dmId` — DDB user ID of the DM
- `data.activeCharacters[]` — member characters in the campaign

---

## Flat Modifier Helper

Several calculations above require scanning `char.modifiers` across all six buckets. A helper that flattens them:

```js
const flatModifiers = Object.values(char.modifiers).flat();
```

The six buckets are: `race`, `class`, `background`, `item`, `feat`, `condition`.

---

## Player Inventory

Source: the character detail endpoint (same response as all stat data above).

- `char.inventory[]` — standard items with full DDB definitions
- `char.customItems[]` — freeform items entered manually (campaign props, custom gear)
- `char.currencies` — character's personal coin purse

### Currency

```js
const { cp, sp, gp, ep, pp } = char.currencies;
// cp=copper, sp=silver, gp=gold, ep=electrum, pp=platinum
```

### Inventory item fields

Each entry in `char.inventory[]`:

| Field                     | Type         | Notes                                                    |
| ------------------------- | ------------ | -------------------------------------------------------- |
| `id`                      | number       | Unique instance ID                                       |
| `equipped`                | boolean      | Currently worn/held                                      |
| `quantity`                | number       | Stack size                                               |
| `isAttuned`               | boolean      | Attunement active                                        |
| `chargesUsed`             | number       | Charges consumed (magic items)                           |
| `definition.name`         | string       | Item name                                                |
| `definition.filterType`   | string       | Category — see table below                               |
| `definition.type`         | string       | Specific type (e.g. `"Dagger"`, `"Light Armor"`)         |
| `definition.subType`      | string\|null | Sub-category (e.g. `"Arcane Focus"`, `"Ammunition"`)     |
| `definition.rarity`       | string\|null | `"Common"`, `"Uncommon"`, `"Rare"`, etc. (null = custom) |
| `definition.weight`       | number       | Weight in lbs                                            |
| `definition.cost`         | number\|null | Cost in gp (null for magic/custom items)                 |
| `definition.armorTypeId`  | number\|null | 1=Light, 2=Medium, 3=Heavy, 4=Shield                     |
| `definition.armorClass`   | number\|null | Base AC (armor only)                                     |
| `definition.damage`       | object\|null | `{diceCount, diceValue, diceString}` (weapons only)      |
| `definition.damageType`   | string\|null | e.g. `"Piercing"`, `"Bludgeoning"`                       |
| `definition.range`        | number\|null | Range in feet (ranged weapons)                           |
| `definition.properties[]` | string[]     | Weapon/item tags, e.g. `"Finesse"`, `"Versatile"`        |
| `definition.canAttune`    | boolean      | Whether attunement is possible                           |

### filterType categories

| filterType        | Contents                                                         |
| ----------------- | ---------------------------------------------------------------- |
| `"Armor"`         | Armor and shields (use `armorTypeId` and `armorClass`)           |
| `"Weapon"`        | Weapons (use `damage`, `damageType`, `range`, `properties`)      |
| `"Potion"`        | Consumable potions                                               |
| `"Wand"`          | Wands (track charges via `chargesUsed`)                          |
| `"Scroll"`        | Spell scrolls                                                    |
| `"Wondrous item"` | Miscellaneous magic items                                        |
| `"Other Gear"`    | General equipment, tools, focuses, ammunition                    |
| `null`            | Custom/campaign items — no DDB definition, treat as flavour text |

### Custom items

`char.customItems[]` are freeform entries without a DDB definition. Fields: `id`, `name`, `description`, `weight`, `cost`, `quantity`, `notes`. These are typically campaign-specific props or improvised gear added by the player or DM.

---

## Party Inventory

```text
GET https://character-service.dndbeyond.com/character/v5/party/inventory/:campaignId
```

Requires authentication. Returns shared items and currency visible to the whole party.

### Response structure

- `data.partyItems[]` — items shared across the party
- `data.currency` — shared party coin purse (`cp`, `sp`, `gp`, `ep`, `pp`)

### Party item fields

Each entry in `data.partyItems[]` follows the same `definition` shape as `char.inventory[]`, plus:

| Field                   | Notes                                                                             |
| ----------------------- | --------------------------------------------------------------------------------- |
| `id`                    | Unique party-item instance ID                                                     |
| `quantity`              | Stack size                                                                        |
| `ownerId`               | `userId` of the character who deposited the item (may be null for DM-added items) |
| `definition.name`       | Item name                                                                         |
| `definition.filterType` | Same categories as player inventory                                               |
| `definition.rarity`     | Rarity string                                                                     |

### Campaign members

The character detail response includes lightweight roster data at `char.campaign.characters[]` — useful for mapping `ownerId` to a character name:

| Field           | Notes            |
| --------------- | ---------------- |
| `userId`        | DDB user ID      |
| `username`      | DDB display name |
| `characterId`   | Character ID     |
| `characterName` | Character name   |
| `avatarUrl`     | Portrait URL     |
| `campaignId`    | Campaign ID      |

---

## Live Sync via `webRequest`

The extension listens for write operations to the DDB character service using `chrome.webRequest.onCompleted` in the background service worker. Detection is always active, but a DDB re-fetch only occurs when all pre-conditions are met — by design, we prefer hitting our own backend over DDB.

### Trigger

```text
PUT | POST | DELETE  https://character-service.dndbeyond.com/character/v5/character/:id
```

GET requests to the same URL are ignored (they occur on page load and during read-only polling).

### What triggers these writes

| Player action          | Method      |
| ---------------------- | ----------- |
| Take damage / heal     | PUT         |
| Add / remove condition | PUT         |
| Equip / unequip armor  | PUT         |
| Add / remove inventory | POST/DELETE |
| Level up               | PUT         |
| Short / long rest      | PUT         |

### Debounce

DDB autosaves after many small interactions. A 2-second debounce per `tabId:characterId` key coalesces rapid saves (e.g. equipping an item and updating currency in one action) into a single sync cycle.

### Pre-conditions (all must pass before DDB is contacted)

After the debounce window the background runs four checks in order. If any fails, the cycle is abandoned with no outbound requests.

| #   | Check                       | Detail                                                                                                                         |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Active VTT-Chat session** | `guestSession.token` and `campaignId` must be present — character has connected to VTT-Chat                                    |
| 2   | **Correct character**       | Character ID in the request URL must match the character that authenticated with VTT-Chat                                      |
| 3   | **Character sheet open**    | The tab must be on `dndbeyond.com/characters/:id` for that exact character — campaign pages and other DDB pages do not qualify |
| 4   | **Players connected**       | Backend `session-status` endpoint must return an active (non-`IDLE`) campaign state — no sync if nobody is in session          |

### Re-fetch and sync flow

1. Background receives `webRequest.onCompleted` for a matching non-GET URL.
2. After the debounce window, all four pre-conditions are evaluated.
3. If all pass, background sends `{ type: "refetch-character", characterId }` to the content script in that tab.
4. The content script fetches the character detail endpoint (authenticated via the user's DDB session cookie) and builds a full payload via `buildFullCharacterPayload`.
5. The payload is returned as `{ type: "character-data-updated", payload }`.
6. The background calls `syncCharacterAndCampaign`, pushing the update to the VTT-Chat sync API.

### Fields updated by this path

All fields derived from the character detail endpoint are refreshed on each sync cycle:

| Field                        | Driven by                                |
| ---------------------------- | ---------------------------------------- |
| `stats.hp`                   | `removedHitPoints`, `temporaryHitPoints` |
| `stats.ac`                   | Currently equipped armor and shield      |
| `stats.initiative`           | DEX mod + initiative modifiers           |
| `stats.spellSlots`           | `spellSlots[]` / `pactMagic[]`           |
| `conditions`                 | `char.conditions[]`                      |
| `features`                   | Class action features                    |
| `level`, `class`, `subclass` | `char.classes[]`                         |

> **Note:** `inventory` is extracted by `buildFullCharacterPayload` but is not currently included in the VTT-Chat sync payload sent by `syncCharacterAndCampaign`.

---

## Caching

All extracted data is cached in `browser.storage.local` with a 5-minute TTL (`ddbCacheUpdatedAt`). Keys: `ddbUser`, `ddbCharacterList`, `ddbCacheUpdatedAt`.
