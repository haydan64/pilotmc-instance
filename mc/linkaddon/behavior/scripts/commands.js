import {world, system, CommandPermissionLevel, CustomCommandParamType} from "@minecraft/server";
import { sendEvent } from "./link";

system.beforeEvents.startup.subscribe((init) => {
    const reloadCommand = {
        name: "mclink:reloadbds",
        description: "Reloads all addons on the server.",
        permissionLevel: CommandPermissionLevel.GameDirectors
    };
    init.customCommandRegistry.registerCommand(reloadCommand, (commandSource, commandArgs) => {
        sendEvent("reload")
    });


    const stopCommand = {
        name: "mclink:stopbds",
        description: "Stops the bds server.",
        permissionLevel: CommandPermissionLevel.GameDirectors
    };
    init.customCommandRegistry.registerCommand(stopCommand, (commandSource, commandArgs) => {
        sendEvent("stop");
    });
    
    
    const restartCommand = {
        name: "mclink:restartbds",
        description: "Restarts the bds server.",
        permissionLevel: CommandPermissionLevel.GameDirectors
    };
    init.customCommandRegistry.registerCommand(restartCommand, (commandSource, commandArgs) => {
        sendEvent("restart");
    });

    console.log("MCLINK Custom Commands Registered.");
});