import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { BLINDED_POINTER_PREFIX, blindedPointer } from "./blindedPointer";

const VIEW_PUBKEY = "a".repeat(64);
const COORDINATE = `32301:${"b".repeat(64)}:board-1`;

describe("blindedPointer", () => {
  it("matches the doc 05 §2 derivation, verified against an independent sha256", () => {
    const expected = createHash("sha256")
      .update(`nip100e:v1:${VIEW_PUBKEY}:${COORDINATE}`, "utf8")
      .digest("hex");
    expect(blindedPointer(VIEW_PUBKEY, COORDINATE)).toBe(expected);
  });

  it("pins the wire format with a fixed vector", () => {
    expect(blindedPointer(VIEW_PUBKEY, COORDINATE)).toBe(
      "49df2e56f535a34722b27644c618bb004105fcec56f6434ea73895334be9476d",
    );
  });

  it("returns 64 lowercase hex characters", () => {
    const pointer = blindedPointer(VIEW_PUBKEY, COORDINATE);
    expect(pointer).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the view key changes — this is what unlinks a rotated board", () => {
    expect(blindedPointer(`${"a".repeat(63)}b`, COORDINATE)).toBe(
      "20ba603c54fa9f0dcbbb37ecea1c00016b16154d81a9d65f5fa66a43487da344",
    );
  });

  it("changes when the coordinate changes — two boards under one key stay unlinkable", () => {
    expect(blindedPointer(VIEW_PUBKEY, `32301:${"b".repeat(64)}:board-2`)).toBe(
      "648ee4d51772403bb6f880d6718f9f77c5a2bdb7d4cfcb97561981d01ea3d1c5",
    );
  });

  it("normalizes the view pubkey to lowercase so case cannot split a board's cards", () => {
    expect(blindedPointer(VIEW_PUBKEY.toUpperCase(), COORDINATE)).toBe(
      blindedPointer(VIEW_PUBKEY, COORDINATE),
    );
  });

  it("exposes the domain-separation prefix", () => {
    expect(BLINDED_POINTER_PREFIX).toBe("nip100e:v1");
  });
});
