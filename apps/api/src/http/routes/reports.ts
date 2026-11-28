import { Clock, Effect, Metric, Redacted } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Allowance, Allowances } from "../../allowance.ts";
import { LeafApi, SessionCookie } from "../../api/api.ts";
import { BadOrigin } from "../../api/errors.ts";
import { Identities } from "../../auth/session.ts";
import { AppConfig, fromLeafPage } from "../../config.ts";
import { pageErrors, pageErrorsDropped } from "../../metrics.ts";
import { sessionCookies } from "./middleware.ts";

/** How many reports a player's pages may make: ten a minute. Pages not signed in share one such allowance. */
const PER_PLAYER = { rate: 10 / 60, burst: 10 } as const;
/** How many reports Leaf keeps from everybody together: sixty a minute. */
const OVERALL = { rate: 1, burst: 60 } as const;
/** How many players' allowances are kept before those filled up again are let go. */
const KEPT = 1000;

/** Counts a report let go of past a limit. */
const drop = (limit: "player" | "overall") => Metric.update(pageErrorsDropped({ limit }), 1);

/**
 * A page's report of its own failure (`PageError` in core), from Leaf's own pages only. Each is logged
 * as `page_error`, a warning, with who the player is when their session says so (a page that could not
 * sign in reports too), and counted by page and kind; past the player's allowance or Leaf's overall
 * one it is let go of, and counted as dropped. The page is answered the same either way.
 */
export const GameReportsHandlers = HttpApiBuilder.group(LeafApi, "gameReports", (handlers) =>
  Effect.gen(function* () {
    const identities = yield* Identities;
    const settings = yield* AppConfig;
    const cookie = HttpApiBuilder.securityDecode(SessionCookie);
    const overall = new Allowance(OVERALL, yield* Clock.currentTimeMillis);
    const players = new Allowances([PER_PLAYER], KEPT);
    return handlers.handle("pageError", ({ payload }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!fromLeafPage(settings, request.headers["origin"])) {
          return yield* new BadOrigin({ code: "bad_origin", message: "Leaf takes this only from its own pages" });
        }
        // Counted against everybody's allowance before the session is asked about, so that reports
        // with made-up sessions ask the backend no more often than that.
        const now = yield* Clock.currentTimeMillis;
        if (!overall.take(now)) return yield* drop("overall");
        // With two session cookies, neither is believed (`sessionChecks`): the report is nobody's.
        const token = sessionCookies(request.headers["cookie"]) === 1 ? Redacted.value(yield* cookie) : "";
        const who = token === "" ? null : yield* identities.identify(token);
        const player = who?.status === "ok" ? who.identity.playerId : null;
        if (!players.take(player ?? "", now, [1])) return yield* drop("player");
        yield* Metric.update(pageErrors({ page: payload.page, kind: payload.kind }), 1);
        yield* Effect.logWarning("page_error").pipe(Effect.annotateLogs({ player, ...payload }));
      }),
    );
  }),
);
