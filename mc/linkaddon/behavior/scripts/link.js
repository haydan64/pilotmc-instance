import * as NET from "@minecraft/server-net";

const LOCAL_AGENT_URL = '__PILOTMC_LOCAL_AGENT_URL__';

export const sendEvent = async function(event, content) {
    const req = new NET.HttpRequest(`${LOCAL_AGENT_URL}/mclink/event`);

    req.body = JSON.stringify({
        event: event,
        content: content
    });
    req.method = NET.HttpRequestMethod.Post;
    req.headers = [
        new NET.HttpHeader('Content-Type', 'application/json')
    ];

    await NET.http.request(req);
}

export const unwhitelist = async function(initiator, target) {
    const req = new NET.HttpRequest(`${LOCAL_AGENT_URL}/mclink/unwhitelist`);

    req.body = JSON.stringify({
        initiator,
        target
    });
    req.method = NET.HttpRequestMethod.Post;
    req.headers = [
        new NET.HttpHeader('Content-Type', 'application/json')
    ];

    await NET.http.request(req);
}
