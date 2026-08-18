import { world, system } from "@minecraft/server";
import { sendEvent, unwhitelist } from "./link";

function safeGet(read, fallback = null) {
    try {
        const value = read();
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

function serializeEffect(effect) {
    return {
        effectName: safeGet(() => effect.typeId) || safeGet(() => effect.type.id),
        amplifier: safeGet(() => effect.amplifier),
        duration: safeGet(() => effect.duration)
    };
}

function getPlayerEffects(player) {
    return safeGet(() => Array.from(player.getEffects()).map(serializeEffect), []);
}

function serializeEnchant(enchant) {
    return {
        id: safeGet(() => enchant.type.id) || safeGet(() => enchant.typeId),
        level: safeGet(() => enchant.level)
    };
}

function serializeItem(item) {
    if (!item) return null;
    const enchantable = safeGet(() => item.getComponent("minecraft:enchantable"));
    return {
        typeId: safeGet(() => item.typeId),
        amount: safeGet(() => item.amount),
        nameTag: safeGet(() => item.nameTag),
        lore: safeGet(() => item.getLore(), []),
        enchants: enchantable ? safeGet(() => enchantable.getEnchantments().map(serializeEnchant), []) : []
    };
}

function serializeContainer(container) {
    if (!container) return [];
    const items = [];
    const size = safeGet(() => container.size, 0);
    for (let slot = 0; slot < size; slot++) {
        const item = safeGet(() => container.getItem(slot));
        if (item) items.push({ slot, ...serializeItem(item) });
    }
    return items;
}

function getPlayerHealth(player) {
    const health = safeGet(() => player.getComponent("minecraft:health"));
    if (!health) return { health: null, maxHealth: null };
    return {
        health: safeGet(() => health.currentValue),
        maxHealth: safeGet(() => health.effectiveMax) ?? safeGet(() => health.defaultValue)
    };
}

world.beforeEvents.chatSend.subscribe((eventData) => {
    const message = eventData.message;

    sendEvent("chatSent", {
        message: eventData.message,
        sender: eventData.sender.name,
        targets: eventData.targets?.map(t => t.name) ?? null
    });

    eventData.cancel = true;

    // Keep the canonical player name in relayed events, but honor a behavior
    // pack-provided display name (including formatting) inside Minecraft chat.
    const displayName = eventData.sender.nameTag || eventData.sender.name;
    const nameFormatting = displayName.match(/^(?:§.)+/)?.[0] ?? "";
    const visibleName = displayName.slice(nameFormatting.length).replace(/§r$/, "");
    world.sendMessage({ rawtext: [{ "text": `${nameFormatting}<${visibleName}>§r ${message}` }] });
});


world.afterEvents.entityDie.subscribe((eventData) => {
    sendEvent("entityDied", {
        entity: eventData.deadEntity.id,
        entityType: eventData.deadEntity.typeId,
        entityName: eventData.deadEntity.name || eventData.deadEntity.nameTag || eventData.deadEntity.name || null,
        damagingEntity: eventData.damageSource.damagingEntity?.id || null,
        damagingEntityType: eventData.damageSource.damagingEntity?.typeId || null,
        damagingEntityName: eventData.damageSource.damagingEntity?.isValid
            ? (
                eventData.damageSource.damagingEntity?.name ||
                eventData.damageSource.damagingEntity?.nameTag ||
                null)
            : null,
        cause: eventData.damageSource.cause,
        location: eventData.deadEntity.location,
        dimension: eventData.deadEntity.dimension.id
    });
});


world.afterEvents.gameRuleChange.subscribe((eventData) => {
    sendEvent("gameruleChanged", {
        gameRule: eventData.rule,
        value: eventData.value
    });
});


world.afterEvents.playerBreakBlock.subscribe((eventData) => {
    sendEvent("playerBreakBlock", {
        player: eventData.player.name,
        block: eventData.block.typeId,
        location: eventData.block.location,
        dimension: eventData.block.dimension.id
    });
});

world.afterEvents.playerPlaceBlock.subscribe((eventData) => {
    sendEvent("playerPlaceBlock", {
        player: eventData.player.name,
        block: eventData.block.typeId,
        location: eventData.block.location,
        dimension: eventData.block.dimension.id
    });
});



world.afterEvents.playerDimensionChange.subscribe((eventData) => {
    sendEvent("playerDimensionChange", {
        player: eventData.player.name,
        from: eventData.fromDimension.id,
        origin: eventData.fromLocation,
        to: eventData.toDimension.id,
        destination: eventData.toLocation
    });
});


world.afterEvents.playerGameModeChange.subscribe((eventData) => {
    sendEvent("playerGamemodeChange", {
        player: eventData.player.name,
        from: eventData.fromGameMode,
        to: eventData.toGameMode
    });
});


world.afterEvents.weatherChange.subscribe((eventData) => {
    sendEvent("weatherChange", {
        dimension: eventData.dimension.id,
        newWeather: eventData.newWeather,
        previousWeather: eventData.previousWeather
    });
});



world.afterEvents.worldLoad.subscribe(() => {
    sendEvent("worldLoad", {});
});

system.runInterval(() => {
    const players = world.getPlayers().map(p => {
        const health = getPlayerHealth(p);
        return {
            name: p.name,
            location: p.location,
            dimension: p.dimension.id,
            gameMode: p.gameMode,
            health: health.health,
            maxHealth: health.maxHealth,
            tags: p.getTags(),
            effects: getPlayerEffects(p)
        };
    });

    if (players.length === 0) return;

    sendEvent("playerList", { players });
}, 100);


system.afterEvents.scriptEventReceive.subscribe((eventData) => {
    switch (eventData.id) {
        case "mclink:intrun": {
            const command = base64ToUtf8String(eventData.message);
            world.getDimension("overworld").runCommand(command);
            break;
        }

        case "mclink:inventory": {
            try {
                const request = JSON.parse(base64ToUtf8String(eventData.message));
                const username = String(request.username || "").trim();
                const player = world.getPlayers().find((entry) => entry.name.toLowerCase() === username.toLowerCase());
                if (!player) {
                    sendEvent("inventoryResponse", {
                        requestId: request.requestId,
                        username,
                        error: `Player ${username} is not online.`
                    });
                    break;
                }
                sendEvent("inventoryResponse", {
                    requestId: request.requestId,
                    username: player.name,
                    inventory: serializeContainer(safeGet(() => player.getComponent("minecraft:inventory").container)),
                    enderChest: serializeContainer(safeGet(() => player.getComponent("minecraft:ender_inventory").container))
                });
            } catch (e) {
                console.error(`Unable to read live player inventory: ${e}`);
            }
            break;
        }

        case "mclink:unwhitelist": {
            try {
                const content = JSON.parse(eventData.message);
                unwhitelist(content.initiator, content.target);
            } catch (e) {
                console.error(e);
            }
            break;
        }

        case "mclink:event": {
            sendEvent("event", {
                id: eventData.id,
                initiator: eventData.initiator?.name || eventData.initiator?.nameTag || null,
                message: eventData.message,
                sourceType: eventData.sourceType
            });
            break;
        }

        case "mclink:log": {
            try {
                const content = JSON.parse(eventData.message);
                sendEvent("log", content);
            } catch (e) {
                console.error(e);
            }
            break;
        }

        default:
            break;
    }
});


function base64ToUtf8String(base64) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let buffer = 0;
    let bits = 0;
    let bytes = [];

    // Base64 → bytes
    for (let i = 0; i < base64.length; i++) {
        const c = base64.charAt(i);
        if (c === "=") break;

        const v = chars.indexOf(c);
        if (v === -1) continue;

        buffer = (buffer << 6) | v;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
        }
    }

    // UTF-8 bytes → JS string
    let result = "";
    for (let i = 0; i < bytes.length;) {
        const b1 = bytes[i++];

        if (b1 <= 0x7f) {
            result += String.fromCharCode(b1);
        } else if (b1 <= 0xdf) {
            const b2 = bytes[i++];
            result += String.fromCharCode(
                ((b1 & 0x1f) << 6) | (b2 & 0x3f)
            );
        } else if (b1 <= 0xef) {
            const b2 = bytes[i++], b3 = bytes[i++];
            result += String.fromCharCode(
                ((b1 & 0x0f) << 12) |
                ((b2 & 0x3f) << 6) |
                (b3 & 0x3f)
            );
        } else {
            const b2 = bytes[i++], b3 = bytes[i++], b4 = bytes[i++];
            let cp =
                ((b1 & 0x07) << 18) |
                ((b2 & 0x3f) << 12) |
                ((b3 & 0x3f) << 6) |
                (b4 & 0x3f);

            cp -= 0x10000;
            result += String.fromCharCode(
                0xd800 + (cp >> 10),
                0xdc00 + (cp & 0x3ff)
            );
        }
    }

    return result;
}
