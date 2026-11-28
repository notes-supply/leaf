/**
 * The raid in a Discord call, on this machine, with stand-ins for Discord:
 *
 *   bun apps/api/test/play-call.ts <port> <public-dir>
 *
 * It runs the real app on a database in memory, with a Discord application set (`activity`), and
 * serves `<public-dir>` (the built pages) under `/play`. Discord's API is a stand-in: the code
 * `as-<name>` is the Discord account `<name>`, made the first time it is asked for. And so is
 * Discord's own app: `/test/discord/?as=<name>&instance=<launch>` is a page that frames the raid as
 * Discord does (`/` with Discord's launch query), and answers the raid's SDK as Discord's app would:
 * greeted, it says it is ready; asked to sign in, it gives the code for `<name>`; handed the token,
 * it says who that is. Opening that page puts `<name>` in the call `<launch>`, as Discord has
 * everyone who opens a launch in it, and Discord's API says so when Leaf asks who is in it (with the
 * bot's token). Nothing leaves the machine. SIGTERM or Ctrl-C stops it.
 */
import { resolve } from "node:path";

import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { DISCORD_API } from "../src/config.ts";
import { fakeBackend, type Fetcher, type TestClock, testLeaf } from "./support.ts";

const CLIENT = "1576204968619417712";
const BOT = "standing-in-bot";
const [portText = "", publicDirText = ""] = process.argv.slice(2);
const port = Number(portText);
if (!Number.isInteger(port) || port <= 0 || port > 65_535 || publicDirText === "") {
  console.error("Usage: bun apps/api/test/play-call.ts <port> <public-dir>");
  process.exit(2);
}
// localhost, not 127.0.0.1: browsers keep a `Secure` cookie from it over plain http, as the frame's is.
const origin = `http://localhost:${port}`;

/** Discord's accounts, by name, each with an id of its own, made the first time a code names it. */
const accounts = new Map<string, string>();
const idOf = (name: string): string => {
  const id = accounts.get(name) ?? `3${String(accounts.size + 1).padStart(17, "0")}`;
  accounts.set(name, id);
  return id;
};

/** Who is in each call, by launch: everyone who opened Discord's stand-in page for it. */
const calls = new Map<string, Set<string>>();
const LAUNCH = new RegExp(`^${DISCORD_API}/applications/${CLIENT}/activity-instances/([^/]+)$`);

/**
 * Discord's API as Leaf asks it: a code `as-<name>` traded for `<name>`'s token, who a token is, and
 * who is in a launch.
 */
const discord =
  (backend: Fetcher): Fetcher =>
  async (url, init) => {
    if (!url.startsWith(`${DISCORD_API}/`)) return backend(url, init);
    const request = new Request(url, init);
    const launch = LAUNCH.exec(url)?.[1];
    if (launch !== undefined && request.headers.get("Authorization") === `Bot ${BOT}`) {
      const users = calls.get(decodeURIComponent(launch));
      return users === undefined
        ? Response.json({ message: "404: Not Found", code: 0 }, { status: 404 })
        : Response.json({ instance_id: launch, users: [...users].map(idOf) });
    }
    if (url.endsWith("/oauth2/token")) {
      const code = new URLSearchParams(await request.text()).get("code") ?? "";
      if (!code.startsWith("as-")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `token-${code.slice(3)}`, token_type: "Bearer", expires_in: 604800 });
    }
    const name = /^Bearer token-(.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (url.endsWith("/users/@me") && name !== undefined)
      return Response.json({ id: idOf(name), username: name, discriminator: "0", global_name: null, avatar: null });
    return Response.json({ message: "401: Unauthorized" }, { status: 401 });
  };

/** Discord's app, as far as the raid can tell: its frame, and its answers to the raid's SDK. */
const DISCORD_APP = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discord, standing in</title>
<style>html, body { margin: 0; height: 100%; background: #000 } iframe { display: block; border: 0; width: 100vw; height: 100vh }</style>
</head>
<body>
<iframe id="raid" title="The Little Raid"></iframe>
<script>
const query = new URLSearchParams(location.search);
const as = query.get("as") || "ann";
const frame = document.getElementById("raid");
frame.src = "/?" + new URLSearchParams({
  instance_id: query.get("instance") || "i-1-gc-1-1", location_id: "gc-1-1", launch_id: "1",
  channel_id: "1", guild_id: "1", frame_id: "f-" + as, platform: "desktop",
});
const said = (window.said = []);
const send = (payload) => frame.contentWindow.postMessage([1, payload], location.origin);
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || !Array.isArray(event.data)) return;
  const [op, asked] = event.data;
  said.push(op === 0 ? "HANDSHAKE" : asked.cmd);
  if (op === 0) {
    send({ cmd: "DISPATCH", evt: "READY", nonce: null,
      data: { v: 1, config: { api_endpoint: "//discord.com/api", environment: "production" } } });
  } else if (asked.cmd === "AUTHORIZE") {
    send({ cmd: "AUTHORIZE", evt: null, nonce: asked.nonce, data: { code: "as-" + as } });
  } else if (asked.cmd === "AUTHENTICATE") {
    send({ cmd: "AUTHENTICATE", evt: null, nonce: asked.nonce, data: {
      access_token: asked.args.access_token,
      user: { id: "1", username: as, discriminator: "0", public_flags: 0, avatar: null, global_name: null },
      scopes: ["identify"], expires: new Date(Date.now() + 6048e5).toISOString(),
      application: { id: "${CLIENT}", name: "Leaf", description: "" },
    } });
  } else {
    send({ cmd: asked.cmd, evt: null, nonce: asked.nonce, data: null });
  }
});
</script>
</body>
</html>`;

const { fetcher } = fakeBackend();
/** Leaf's clock, the machine's. */
const clock: TestClock = {
  get now() {
    return Date.now();
  },
};
const leaf = testLeaf(clock, discord(fetcher), {
  publicDir: resolve(publicDirText),
  publicOrigin: origin,
  activity: { clientId: CLIENT, clientSecret: Redacted.make("standing-in"), botToken: Redacted.make(BOT), origin },
});
const served = await leaf.serve(
  port,
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/test/discord/",
      Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
        // Opening the raid in a call puts you in it, as far as Discord is concerned.
        const query = new URL(request.url, origin).searchParams;
        const launch = query.get("instance") || "i-1-gc-1-1";
        const into = calls.get(launch) ?? new Set<string>();
        calls.set(launch, into.add(query.get("as") || "ann"));
        return HttpServerResponse.text(DISCORD_APP, {
          contentType: "text/html",
          headers: {
            "content-security-policy":
              "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'",
          },
        });
      }),
    ),
  ),
);
console.log(`The raid in a Discord call, standing in: ${origin}/test/discord/?as=ann&instance=i-1-gc-1-1`);

const stop = (): void => {
  void served.close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
