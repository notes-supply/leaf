import { expect, test } from "bun:test";

import { readRows } from "@sequoia-leaf/figures/rows.ts";
import { BOON_IDS } from "@sequoia-leaf/raid/content/boons.ts";
import { COMPONENT_IDS, FINISHED_IDS, isEmblemId } from "@sequoia-leaf/raid/content/items.ts";
import { TOOL_IDS } from "@sequoia-leaf/raid/content/tools.ts";
import { TRAIT_IDS } from "@sequoia-leaf/raid/content/traits.ts";
import { RULE_IDS } from "@sequoia-leaf/raid/content/wilds.ts";

import { GLYPHS } from "./icons.ts";

const read = async (): Promise<ReadonlyMap<string, readonly string[]>> =>
  readRows(await Bun.file(new URL("icons.txt", import.meta.url)).text());

test("icons.txt has a picture for every trait, item, tool, held component, kind of room, rule and sign, a boon's own for each that is not a charm, a number for each level, and nothing else", async () => {
  const named = [...(await read()).keys()];
  const wanted = [
    ...TRAIT_IDS.map((id) => `trait ${id}`),
    ...[...COMPONENT_IDS, ...FINISHED_IDS, ...TOOL_IDS].map((id) => `item ${id}`),
    ...COMPONENT_IDS.map((id) => `held ${id}`),
    ...BOON_IDS.filter((id) => !isEmblemId(id)).map((id) => `boon ${id}`),
    ...["trouble", "spar", "boss"].map((kind) => `room ${kind}`),
    ...RULE_IDS.map((id) => `rule ${id}`),
    ...GLYPHS.map((id) => `glyph ${id}`),
    ...[1, 2, 3, 4, 5, 6].map((level) => `level ${level}`),
  ];
  expect(named.toSorted()).toEqual(wanted.toSorted());
});

test("every rule's picture is the same size, 28 by 17, so no place it is shown moves for the rule", async () => {
  const rows = await read();
  for (const id of RULE_IDS) {
    const r = rows.get(`rule ${id}`) ?? [];
    expect([r.length, ...new Set(r.map((line) => line.length))]).toEqual([17, 28]);
  }
});
