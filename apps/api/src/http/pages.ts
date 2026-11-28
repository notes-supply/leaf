import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http";

import { AppConfig } from "../config.ts";

/** The policy of a page that may be framed by `ancestors` besides Leaf's own pages. */
const policyFramedBy = (...ancestors: readonly string[]) =>
  [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-src 'self'",
    ["frame-ancestors 'self'", ...ancestors].join(" "),
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

/**
 * What the game's pages may do: load and frame only what Leaf serves, talk only
 * to Leaf, and be framed only by Leaf's own pages. Their styles are partly
 * inline, their pictures are partly drawn in the page, and their font is
 * built into their styles as a `data:` address. A `<base>` may point only at
 * Leaf, a form may be sent only to Leaf, and no plugin content loads: none of
 * these falls back to `default-src`.
 */
export const PAGE_POLICY = policyFramedBy();

/**
 * Discord's own apps, which frame the raid in a call: the desktop app and the browser's at
 * discord.com, and its two test builds. On a phone the raid is the whole of Discord's view, framed by
 * nothing.
 */
export const DISCORD_FRAMES = ["https://discord.com", "https://ptb.discord.com", "https://canary.discord.com"];

/**
 * The raid's page in a Discord call: as every page, but Discord's apps may frame it too. Inside the
 * frame `'self'` is Discord's proxy for Leaf (`<client id>.discordsays.com`), which every request
 * of the page goes through.
 */
export const CALL_PAGE_POLICY = policyFramedBy(...DISCORD_FRAMES);

/** The raid's page, which is all of Leaf a Discord call opens. */
export const RAID_PAGE = "/play/battler/";

/**
 * Whether a request is Discord opening the raid in a call: its query names the frame and the
 * launch, as Discord's every launch does (and its SDK needs to start).
 */
const launchedByDiscord = (query: URLSearchParams): boolean =>
  (query.get("frame_id") ?? "") !== "" && (query.get("instance_id") ?? "") !== "";

/**
 * The policy a page is served with, chosen by its address alone: the raid's page opened by Discord
 * gets `CALL_PAGE_POLICY`, every other page `PAGE_POLICY`. Neither names a site a request can
 * choose: the most any request can do is let Discord's apps frame the raid, which a call does.
 */
export function policyOf(url: string): string {
  const at = new URL(url, "http://leaf.invalid");
  return at.pathname.startsWith(RAID_PAGE) && launchedByDiscord(at.searchParams) ? CALL_PAGE_POLICY : PAGE_POLICY;
}

/** A file whose name carries a hash of what it holds, as `bun build` names a page's script and styles. */
const HASHED = /\/index-[0-9a-z]+\.(?:js|css)$/;

/**
 * Hashed files never change under their name; anything else is asked about
 * again each time, decided by the path alone (a query names no other file).
 * A failure is never kept: while Leaf is updating, the Leaf going away has no
 * file the new pages name, and a browser keeping that 404 for a year would
 * open the page without it until then.
 */
function cacheControl(url: string, status: number): string {
  if (status >= 400) return "no-store";
  const [path = ""] = url.split("?", 1);
  return HASHED.test(path) ? "public, max-age=31536000, immutable" : "no-cache";
}

const notFound = HttpServerResponse.jsonUnsafe({ code: "not_found", message: "No such route" }, { status: 404 });
const failed = HttpServerResponse.jsonUnsafe(
  { code: "internal_error", message: "Something went wrong" },
  { status: 500 },
);

/**
 * `GET /`: the town; or, opened by Discord in a call, the raid's page, with Discord's query as it came
 * (the page reads the frame and the launch from it). Discord maps its proxy's `/` to Leaf's.
 */
const entry = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { search, searchParams } = new URL(request.url, "http://leaf.invalid");
  if (!launchedByDiscord(searchParams)) return HttpServerResponse.redirect("/play/town/", { status: 302 });
  return HttpServerResponse.redirect(`${RAID_PAGE}${search}`, {
    status: 302,
    headers: { "content-security-policy": CALL_PAGE_POLICY, "cache-control": "no-store" },
  });
});

/** The game's pages under `/play`, from the directory `root`, with `GET /` sent to the town, or the raid in a call (`entry`). */
const pagesFrom = (root: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const files = yield* HttpStaticServer.make({ root, index: "index.html" });
      const served = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const response = yield* files.pipe(
          Effect.catch((error) =>
            error.reason instanceof HttpServerError.RouteNotFound
              ? Effect.succeed(notFound)
              : Effect.logError("A page could not be served", error).pipe(Effect.as(failed)),
          ),
        );
        return HttpServerResponse.setHeaders(response, {
          "content-security-policy": policyOf(request.originalUrl),
          "cache-control": cacheControl(request.url, response.status),
        });
      });
      yield* router.prefixed("/play").add("GET", "/*", served);
      yield* router.add("GET", "/", entry);
    }),
  ).pipe(Layer.provide(BunHttpServer.layerHttpServices));

/** The game's pages, when `PUBLIC_DIR` names where they are; otherwise neither `/play` nor `/` exists. */
export const Pages = Layer.unwrap(
  Effect.gen(function* () {
    const { publicDir } = yield* AppConfig;
    return publicDir === undefined ? Layer.empty : pagesFrom(publicDir);
  }),
);
