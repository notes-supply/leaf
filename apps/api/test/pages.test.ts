import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { playerId } from "@sequoia-leaf/core";

import { API_POLICY } from "../src/http/headers.ts";
import { CALL_PAGE_POLICY, PAGE_POLICY } from "../src/http/pages.ts";
import { fakeBackend, sessionOf, testLeaf } from "./support.ts";

const alice = playerId("10000000-0000-0000-0000-000000000001");

/** Built pages as `bun build` leaves them: an index and its hashed script and styles, for each app. */
let publicDir: string;

beforeAll(() => {
  publicDir = mkdtempSync(join(tmpdir(), "leaf-pages-"));
  for (const app of ["town", "works", "battler"]) {
    mkdirSync(join(publicDir, app));
    writeFileSync(
      join(publicDir, app, "index.html"),
      `<!doctype html><link rel="stylesheet" href="./index-78k15kx1.css"><script src="./index-meamkakx.js"></script>`,
    );
    writeFileSync(join(publicDir, app, "index-meamkakx.js"), `console.log("${app}")`);
    writeFileSync(join(publicDir, app, "index-78k15kx1.css"), "body { margin: 0 }");
  }
  writeFileSync(join(publicDir, "guard.js"), "void 0");
});

afterAll(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

function leafServing(dir: string | undefined) {
  const { fetcher } = fakeBackend({ "alice-token": () => Response.json(sessionOf(alice, "Alice")) });
  return testLeaf({ now: 0 }, fetcher, { publicDir: dir }).app();
}

describe("the game's pages, with PUBLIC_DIR set", () => {
  it("lets a page use only what Leaf serves, its inline styles, drawn pictures and built-in font", () => {
    expect(PAGE_POLICY).toBe(
      "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
  });

  it("serves each app's page as HTML, with the policy, asked about again each time", async () => {
    const app = leafServing(publicDir);

    for (const page of ["town", "works", "battler"]) {
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      const response = await app.request(`/play/${page}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Content-Security-Policy")).toBe(PAGE_POLICY);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      expect(await response.text()).toContain("./index-meamkakx.js");
    }
    await app.dispose();
  });

  it("lets browsers keep the hashed script and styles for a year", async () => {
    const app = leafServing(publicDir);

    const script = await app.request("/play/town/index-meamkakx.js");
    const styles = await app.request("/play/works/index-78k15kx1.css");

    expect(await script.text()).toBe('console.log("town")');
    expect(script.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(styles.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(styles.headers.get("Content-Security-Policy")).toBe(PAGE_POLICY);
    await app.dispose();
  });

  it("decides what browsers keep by the path alone, never the query", async () => {
    const app = leafServing(publicDir);

    const answers = await Promise.all(
      ["/play/town/index.html?/index-meamkakx.js", "/play/town/?x=/index-meamkakx.js"].map(async (path) => {
        const response = await app.request(path);
        return [path, response.status, response.headers.get("Cache-Control")];
      }),
    );
    const script = await app.request("/play/town/index-meamkakx.js?v=2");

    expect(answers).toEqual([
      ["/play/town/index.html?/index-meamkakx.js", 200, "no-cache"],
      ["/play/town/?x=/index-meamkakx.js", 200, "no-cache"],
    ]);
    expect(script.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    await app.dispose();
  });

  it("never lets a browser keep a hashed file that is not there", async () => {
    const app = leafServing(publicDir);

    const missing = await app.request("/play/battler/index-zzzzzzzz.css");
    const guard = await app.request("/play/guard.js");

    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(guard.status).toBe(200);
    expect(guard.headers.get("Cache-Control")).toBe("no-cache");
    await app.dispose();
  });

  it("sends / to the town, and a page's address without its slash to the one with it", async () => {
    const app = leafServing(publicDir);

    const root = await app.request("/");
    const town = await app.request("/play/town");

    expect(root.status).toBe(302);
    expect(root.headers.get("Location")).toBe("/play/town/");
    expect(town.status).toBe(301);
    expect(town.headers.get("Location")).toBe("/play/town/");
    await app.dispose();
  });

  it("answers a file that is not there, and anything outside the directory, with the JSON 404", async () => {
    const app = leafServing(publicDir);

    const answers = await Promise.all(
      ["/play/town/nope.js", "/play/../package.json", "/play/%2e%2e/package.json", "/play/"].map(async (path) => {
        const response = await app.request(path);
        return [path, response.status, await response.json()];
      }),
    );

    expect(answers).toEqual(
      ["/play/town/nope.js", "/play/../package.json", "/play/%2e%2e/package.json", "/play/"].map((path) => [
        path,
        404,
        { code: "not_found", message: "No such route" },
      ]),
    );
    await app.dispose();
  });

  it("still answers the API as before: JSON, and the JSON 404 for a route that does not exist", async () => {
    const app = leafServing(publicDir);

    const me = await app.request("/v1/me", { headers: { Authorization: "Bearer alice-token" } });
    const nope = await app.request("/v1/nope");
    const health = await app.request("/healthz");

    expect(me.headers.get("Content-Type")).toBe("application/json");
    expect(await me.json()).toMatchObject({ player: { id: alice } });
    expect(nope.status).toBe(404);
    expect(await nope.json()).toEqual({ code: "not_found", message: "No such route" });
    expect(await health.json()).toEqual({ status: "ok" });
    await app.dispose();
  });

  it("sends every API answer, errors and the JSON 404 included, with nosniff and a policy that allows nothing", async () => {
    const app = leafServing(publicDir);

    const answers = await Promise.all(
      [
        app.request("/v1/me", { headers: { Authorization: "Bearer alice-token" } }),
        app.request("/v1/me"),
        app.request("/v1/nope"),
        app.request("/healthz"),
        app.request("/openapi.json"),
        app.request("/"),
      ].map(async (answer) => {
        const response = await answer;
        return [response.headers.get("Content-Security-Policy"), response.headers.get("X-Content-Type-Options")];
      }),
    );

    expect(API_POLICY).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(answers).toEqual(Array.from({ length: 6 }, () => [API_POLICY, "nosniff"]));
    await app.dispose();
  });
});

describe("the raid in a Discord call", () => {
  /** Discord's launch query, as its frame opens the raid. */
  const LAUNCH = "?instance_id=i-1-gc-2-3&location_id=gc-2-3&launch_id=1&frame_id=f-9&platform=desktop";

  it("lets Discord's own apps frame the raid's page, besides Leaf's own pages, and nothing else", () => {
    expect(CALL_PAGE_POLICY).toBe(
      PAGE_POLICY.replace(
        "frame-ancestors 'self'",
        "frame-ancestors 'self' https://discord.com https://ptb.discord.com https://canary.discord.com",
      ),
    );
  });

  it("sends Discord's launch of / to the raid's page, with its query as it came", async () => {
    const app = leafServing(publicDir);

    const entry = await app.request(`/${LAUNCH}`);

    expect(entry.status).toBe(302);
    expect(entry.headers.get("Location")).toBe(`/play/battler/${LAUNCH}`);
    expect(entry.headers.get("Content-Security-Policy")).toBe(CALL_PAGE_POLICY);
    expect(entry.headers.get("Cache-Control")).toBe("no-store");
    await app.dispose();
  });

  it("sends / to the town for anything but Discord's launch", async () => {
    const app = leafServing(publicDir);

    for (const query of ["", "?frame_id=f-9", "?instance_id=i-1", "?frame_id=&instance_id=i-1"]) {
      // oxlint-disable-next-line no-await-in-loop -- one address after another
      const response = await app.request(`/${query}`);
      expect(response.headers.get("Location")).toBe("/play/town/");
      expect(response.headers.get("Content-Security-Policy")).not.toBe(CALL_PAGE_POLICY);
    }
    await app.dispose();
  });

  it("serves the raid's page opened by Discord with Discord's frames allowed, and every other page as ever", async () => {
    const app = leafServing(publicDir);
    const policies = await Promise.all(
      [
        `/play/battler/${LAUNCH}`,
        `/play/battler/index.html${LAUNCH}`,
        "/play/battler/",
        "/play/battler/?frame_id=f-9",
        `/play/town/${LAUNCH}`,
        `/play/works/${LAUNCH}`,
        "/play/battler/index-meamkakx.js",
      ].map(async (path) => [path, (await app.request(path)).headers.get("Content-Security-Policy")]),
    );

    expect(policies).toEqual([
      [`/play/battler/${LAUNCH}`, CALL_PAGE_POLICY],
      [`/play/battler/index.html${LAUNCH}`, CALL_PAGE_POLICY],
      ["/play/battler/", PAGE_POLICY],
      ["/play/battler/?frame_id=f-9", PAGE_POLICY],
      [`/play/town/${LAUNCH}`, PAGE_POLICY],
      [`/play/works/${LAUNCH}`, PAGE_POLICY],
      // A script is framed by nothing: its policy says nothing a frame needs.
      ["/play/battler/index-meamkakx.js", PAGE_POLICY],
    ]);
    await app.dispose();
  });
});

describe("without PUBLIC_DIR", () => {
  it("has no /play and no page at /", async () => {
    const app = leafServing(undefined);

    const answers = await Promise.all(
      ["/", "/play/town/", "/play/town/index-meamkakx.js"].map(async (path) => {
        const response = await app.request(path);
        return [response.status, await response.json()];
      }),
    );

    expect(answers).toEqual([
      [404, { code: "not_found", message: "No such route" }],
      [404, { code: "not_found", message: "No such route" }],
      [404, { code: "not_found", message: "No such route" }],
    ]);
    await app.dispose();
  });
});
