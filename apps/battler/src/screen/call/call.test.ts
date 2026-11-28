import { describe, expect, test } from "bun:test";

import { command, openSitting } from "@sequoia-leaf/raid/sitting/commands.ts";
import { CLOCK } from "@sequoia-leaf/raid/sitting/sitting.ts";
import { sittingView } from "@sequoia-leaf/raid/sitting/view.ts";

import { launchOf } from "./launch.ts";
import { callLine } from "./line.ts";

/** Wednesday 25 November 2026, 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 25, 12);
const ann = { id: "10000000-0000-0000-0000-000000000001", name: "Ann" };
const bo = { id: "10000000-0000-0000-0000-000000000002", name: "Bo" };

describe("Discord's launch of the raid", () => {
  test("is read from the page's query: the launch everyone in the call shares", () => {
    expect(launchOf("?instance_id=i-1-gc-2-3&location_id=gc-2-3&launch_id=1&frame_id=f-9&platform=desktop")).toEqual({
      instance: "i-1-gc-2-3",
    });
  });

  test("is none on a page Discord did not open", () => {
    for (const search of ["", "?frame_id=f-9", "?instance_id=i-1", "?instance_id=&frame_id=f-9", "?of=someone"])
      expect(launchOf(search)).toBeNull();
  });
});

describe("the call's table in one line", () => {
  test("says the table is being found, or why there is none", () => {
    expect(callLine(null, T0, null)).toBe("Finding this call's table");
    expect(callLine(null, T0, "This table has started. Join the next one when it ends.")).toBe(
      "This table has started. Join the next one when it ends.",
    );
  });

  test("says who has sat before it starts", () => {
    const sat = command(
      openSitting({ now: T0, seed: 1, player: ann }),
      { do: "sit" },
      { now: T0, seed: 2, player: bo },
    );

    expect(callLine(sittingView(sat.sitting, bo.id), T0, null)).toBe("Waiting to start · 2 of 8 seated");
  });

  test("says the room, the stage and its seconds once it goes", () => {
    const started = command(
      openSitting({ now: T0, seed: 1, player: ann }),
      { do: "start" },
      { now: T0, seed: 2, player: ann },
    );
    const view = sittingView(started.sitting, ann.id);

    expect(view.stage.at).toBe("carousel");
    expect(callLine(view, T0, null)).toBe(`Room 1 of 15 · Carousel · ${CLOCK.together / 1000} s`);
  });

  test("says it is over once it is", () => {
    const left = command(
      openSitting({ now: T0, seed: 1, player: ann }),
      { do: "leave" },
      { now: T0, seed: 2, player: ann },
    );

    expect(callLine(sittingView(left.sitting, ann.id), T0, null)).toBe("Over");
  });
});
