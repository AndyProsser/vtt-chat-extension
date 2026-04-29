# ROLL20 EXTENSION-INTEGRATION.md

## Character Sheet

https://app.roll20.net/characters/sheet/17043231

```JavaScript
  Object.defineProperty(window, "d20", { value: { journal: {} } });
  Object.defineProperty(window, "soundManager", { value: {} });
  Object.defineProperty(window, "allChildWindows", { value: [] });
  Object.defineProperty(window, "currentPlayer", {
    value: {
      "tddiceenabled": false,
      "disableagency": false,
      "id": 0,
      get: (key) => this[key]
    }
  });
  Object.defineProperty(window, "oauth_enabled", { value: "1", writable: false });
  Object.defineProperty(window, "hydra_access_token", { value: "************************" , writable: false });
  Object.defineProperty(window, "hydra_refresh_token", { value: "************************" , writable: false });
  Object.defineProperty(window, "hydra_expires_at", { value: "1776283398" , writable: false });

  // NOTE: Allow rendering with no current account
  Object.defineProperty(window, "d20_account_id".trim(), { value: "16646512" , writable: false });
  Object.defineProperty(window, "d20_account_role".trim(), { value: "subscriber" , writable: false });
  Object.defineProperty(window, "d20_account_email", { value: "andy.********@icloud.com" , writable: false });
  Object.defineProperty(window, "d20_demiplane_email", { value: "" , writable: false });
  Object.defineProperty(window, "d20_account_display_name", { value: "Andy " , writable: false });


  Object.defineProperty(window, "CHAT_BUNDLE_URL", { value: "https://cdn.roll20.net/vtt/jumpgate/production/latest/chat.bundle.e850fb51d03f3df182d8.js" , writable: false });
  Object.defineProperty(window, "DEMIPLANE_CHARACTER_SERVICE_URL", { value: "https://app.demiplane.com" , writable: false });
  Object.defineProperty(window, "DEMIPLANE_STYLES_URL", { value: "https://styles.demiplane.com" , writable: false });
```

## APIs

### Campaigns

https://app.roll20.net/navbar/campaigns_data

Auth: Cookies

```JSON
{
  "campaigns": [
    {
      "id": 21368117,
      "nextgame": null,
      "name": "Andy's Demo Game",
      "thumbnail": "",
      "incoldstorage": false
    }
  ]
}
```

### Characters

https://app.roll20.net/navbar/characters_data

Auth: Cookies

```JSON
{
  "characters": [
    {
      "name": "Vaelthar",
      "thumbnail": "",
      "short_name": "dnd2024byroll20",
      "id": 17043231,
      "long_name": "D&D 5e (New!) - 2024 / 2014"
    }
  ]
}
```

### Character

https://character-api.roll20.net/character/17043231

Auth: Bearer Token (window.hydra_access_token)

**Sample Data**

```JSON
{
  "status": "success",
  "data": {
    "result": {
      "character": {
        "id": 17043231,
        "json": "{\"character\":{\"id\":\"-OqFB2oDtvtbvu9ox-Ag\",\"name\":\"New Character\",\"avatar\":null,\"tags\":\"[]\",\"vault*character_id\":17043231},\"char-attribs\":null,\"char-abils\":null,\"char-blobs\":null}",
        "name": "Vaelthar",
        "avatarurl": "",
        "timestamp": 1776241520,
        "charsheettype": "dnd2024byroll20",
        "account_id": 16646512,
        "source_campaign_id": null,
        "storage_key": "-OqFB2oDtvtbvu9ox-Ag",
        "campaign_id": null,
        "sandbox_port": null,
        "compendium_override": null,
        "hadConversionCheck": false,
        "nexus_slug": null,
        "nexus_character_uuid": null
      },
      "firebaseConfig": {
        ...
      },
      "firebaseCharacter": {
        "char-attribs": {
          ...
          }
        },
        "character": {
          "avatar": "",
          "id": "-OqFB2oDtvtbvu9ox-Ag",
          "name": "Vaelthar",
          "tags": "[]",
          "vault_character_id": 17043231
        }
      },
      "playerPlanName": "free"
    }
  }
}
```
