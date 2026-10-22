import {
  classifyPushback,
  combineFilters,
  halveFilter,
  mergeInfo,
  splitFilters,
} from "./reqShaping";

const pk = (n: number) => n.toString(16).padStart(64, "0");

describe("mergeInfo", () => {
  it("merges single-field lookups without a limit", () => {
    const a = mergeInfo([{ kinds: [7], "#e": ["x"] }]);
    const b = mergeInfo([{ kinds: [7], "#e": ["y"] }]);
    expect(a?.field).toBe("#e");
    expect(a?.key).toBe(b?.key);
  });

  it("keys differ when any other field differs", () => {
    const a = mergeInfo([{ kinds: [7], "#e": ["x"] }]);
    expect(mergeInfo([{ kinds: [6], "#e": ["x"] }])?.key).not.toBe(a?.key);
    expect(mergeInfo([{ kinds: [7], "#e": ["x"], since: 5 }])?.key).not.toBe(a?.key);
  });

  it("merges ids lookups and drops their limit", () => {
    const info = mergeInfo([{ ids: ["a"], limit: 1 }]);
    expect(info).toMatchObject({ field: "ids", limit: "drop" });
    expect(combineFilters([{ ids: ["a"], limit: 1 }, { ids: ["b"], limit: 1 }], info!)).toEqual({ ids: ["a", "b"] });
  });

  it("merges replaceable-kind author lookups with a per-author limit", () => {
    const info = mergeInfo([{ kinds: [10002], authors: [pk(1)], limit: 1 }]);
    expect(info?.limit).toBe("per-author");
    const merged = combineFilters(
      [
        { kinds: [10002], authors: [pk(1)], limit: 1 },
        { kinds: [10002], authors: [pk(2)], limit: 1 },
      ],
      info!,
    );
    expect(merged).toEqual({ kinds: [10002], authors: [pk(1), pk(2)], limit: 2 });
  });

  it("never merges a 'latest N' query, multi-field filters, searches, or multi-filter REQs", () => {
    expect(mergeInfo([{ kinds: [1], authors: [pk(1)], limit: 20 }])).toBeNull();
    expect(mergeInfo([{ kinds: [1984], authors: [pk(1)], "#e": ["x"] }])).toBeNull();
    expect(mergeInfo([{ kinds: [1], search: "hi", "#t": ["a"] }])).toBeNull();
    expect(mergeInfo([{ ids: ["a"] }, { kinds: [0], authors: [pk(1)] }])).toBeNull();
  });
});

describe("splitFilters", () => {
  it("returns a fitting REQ unchanged", () => {
    const filters = [{ kinds: [1], authors: [pk(1)] }];
    expect(splitFilters(filters, 300, 60_000)).toEqual([filters]);
  });

  it("splits an oversized array into REQs under the item cap, losing nothing", () => {
    const authors = Array.from({ length: 700 }, (_, i) => pk(i));
    const parts = splitFilters([{ kinds: [1984], authors, "#e": ["x"], limit: 500 }], 300, 1e9);
    expect(parts.length).toBeGreaterThan(2);
    for (const [f] of parts) {
      expect(f.authors!.length).toBeLessThanOrEqual(300);
      expect(f["#e"]).toEqual(["x"]);
      expect(f.limit).toBe(500);
    }
    expect(parts.flatMap(([f]) => f.authors)).toEqual(authors);
  });

  it("splits by frame size too", () => {
    const authors = Array.from({ length: 200 }, (_, i) => pk(i));
    const parts = splitFilters([{ kinds: [0], authors }], 1000, 5_000);
    for (const p of parts) expect(JSON.stringify(["REQ", "s", ...p]).length).toBeLessThanOrEqual(5_000);
    expect(parts.flatMap(([f]) => f.authors)).toEqual(authors);
  });

  it("halveFilter refuses to split a single value", () => {
    expect(halveFilter({ ids: ["a"] })).toBeNull();
  });
});

describe("classifyPushback", () => {
  it.each([
    ["rate-limited: too many messages, retry in 2s", { type: "rate-limit", retryMs: 2000 }],
    ["ERROR: read bandwidth budget exhausted (1048570 bytes/min per IP) (retry in 30ms)", { type: "rate-limit", retryMs: 30 }],
    ["ERROR: too many concurrent REQs", { type: "too-many-subs", concurrent: true }],
    ["Subscription rejected: Too many subscriptions: Number of subscriptions must be less than or equal to 10", { type: "too-many-subs", limit: 10 }],
    ["blocked: Blocked by too many concurrent REQs", { type: "too-many-subs", concurrent: true }],
    ["Subscription error: Maximum concurrent subscription count reached", { type: "too-many-subs", concurrent: true }],
    ["ERROR: bad req: error parsing authors: total filter items too large", { type: "too-large" }],
    ["message too large (324687 > 262144)", { type: "too-large" }],
    ["auth-required: please authenticate before sending REQs", { type: "auth-required" }],
    ["ERROR: auth-required: requested filter requires authentication", { type: "auth-required" }],
    ["blocked: you are banned", { type: "other" }],
  ])("%s", (message, expected) => {
    expect(classifyPushback(message)).toEqual(expected);
  });
});
