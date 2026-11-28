/**
 * Builds the game's pages into a folder (`bun packages/kit/tools/build-pages.ts <out>`), as the
 * image does: each app with an `index.html` by `bun build index.html --minify` into `<out>/<app>/`
 * (`--splitting` too for those in `SPLIT`),
 * and the pages' guard (`src/guard-page.ts`) into `<out>/guard.js`, under the same name in every
 * build. Each page gets the guard's tag first in its head, before its styles and script, with the
 * page and the version of its rules on it.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { GAME_OF, type Page, PAGES } from "@sequoia-leaf/core";
import { rulesVersions } from "@sequoia-leaf/core/build/rules.ts";

const root = resolve(import.meta.dir, "..", "..", "..");

/**
 * The pages built in parts: what only some players load is a file of its own, fetched when they
 * need it. The raid's Discord sign-in is loaded only in a Discord call. (The town's own `import()`
 * is not split: it waits on nothing it would fetch.)
 */
const SPLIT: ReadonlySet<Page> = new Set(["battler"]);

/** The guard's tag for `page`, built with rules of `version`. */
export function guardTag(page: Page, version: string): string {
  return `<script src="../guard.js" data-guard data-page="${page}" data-version="${version.replace(/[^\w.-]/g, "")}"></script>`;
}

/** A built page with the guard's tag first in its head. A page with no head, or two, stops the build. */
export function withGuard(html: string, tag: string): string {
  const heads = html.match(/<head(\s[^>]*)?>/gi) ?? [];
  if (heads.length !== 1) throw new Error(`A page needs one <head> for its guard, and has ${heads.length}`);
  return html.replace(/<head(\s[^>]*)?>/i, (head) => head + tag);
}

function run(command: string[], cwd: string): void {
  const done = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (done.exitCode === 0) return;
  console.error(`${command.join(" ")} in ${cwd} failed:`);
  console.error(done.stdout.toString(), done.stderr.toString());
  process.exit(1);
}

if (import.meta.main) {
  const [to] = process.argv.slice(2);
  if (to === undefined) throw new Error("Usage: bun packages/kit/tools/build-pages.ts <out>");
  const out = resolve(to);
  const versions = rulesVersions();
  const apps = readdirSync(join(root, "apps")).filter((app) => {
    try {
      return statSync(join(root, "apps", app, "index.html")).isFile();
    } catch {
      return false;
    }
  });
  for (const app of apps) {
    const page = PAGES.find((p) => p === app);
    if (page === undefined) throw new Error(`apps/${app} has a page Leaf does not know: add it to PAGES`);
    const split = SPLIT.has(page) ? ["--splitting"] : [];
    run(
      [process.execPath, "build", "index.html", "--outdir", join(out, app), "--minify", ...split],
      join(root, "apps", app),
    );
    const html = join(out, app, "index.html");
    writeFileSync(html, withGuard(readFileSync(html, "utf8"), guardTag(page, versions[GAME_OF[page]])));
  }
  const guard = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "src", "guard-page.ts")],
    target: "browser",
    format: "iife",
    minify: true,
  });
  const [code] = guard.outputs;
  if (!guard.success || code === undefined) throw new AggregateError(guard.logs, "The guard did not build");
  writeFileSync(join(out, "guard.js"), await code.text());
  console.log(`Built the pages ${apps.join(", ")} and their guard into ${out}.`);
}
