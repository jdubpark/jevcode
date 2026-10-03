import { describe, expect, it } from "vitest";

import type { Citation } from "@jevcode/contracts";

import { buildOverviewModel } from "../../../model/index.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { linkSentence, overviewHeadline } from "./map-text.js";

const snapshot = overviewSnapshot({
  components: [
    { rootPath: "apps/web", name: "web", role: "ui" },
    { rootPath: "services/api", name: "api", role: "api" },
    { rootPath: "pkg/core-db", name: "core-db", role: "storage" },
    { rootPath: "pkg/evil", name: "evil\u202Ename", role: "domain" },
  ],
});
const overview = buildOverviewModel(snapshot, 1);
const cite = (rootPath: string): Citation => ({ kind: "component", id: componentId(rootPath) });
const link = (text: string, rootPath: string) => ({ text, componentId: componentId(rootPath) });

describe("overviewHeadline", () => {
  it("splits the count from up to three languages by file count", () => {
    const withLanguages = buildOverviewModel({ ...snapshot, counts: { ...snapshot.counts, languages: ["TypeScript", "JSON", "Python", "Go"] } }, 1);
    expect(overviewHeadline(withLanguages)).toEqual({ count: "4 components", languages: "TypeScript · JSON · Python" });
    expect(overviewHeadline(buildOverviewModel({ ...snapshot, counts: { ...snapshot.counts, languages: [] } }, 1)).languages).toBeNull();
    expect(overviewHeadline(buildOverviewModel(overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }] }), 1)).count).toBe("1 component");
  });
});

describe("linkSentence (component names are quiet links)", () => {
  it("links each cited name where it appears, ignoring case and keeping the text between", () => {
    const parts = linkSentence(
      { text: "web calls the API through core-db.", citations: [cite("apps/web"), cite("services/api"), cite("pkg/core-db")] },
      overview,
    );
    expect(parts).toEqual([
      link("web", "apps/web"),
      { text: " calls the " },
      link("API", "services/api"),
      { text: " through " },
      link("core-db", "pkg/core-db"),
      { text: "." },
    ]);
  });

  it("appends a link after a sentence that does not spell the name out, and links a name once", () => {
    expect(linkSentence({ text: "Everything runs in one process.", citations: [cite("apps/web"), cite("apps/web")] }, overview)).toEqual([
      { text: "Everything runs in one process." },
      { text: " " },
      link("web", "apps/web"),
    ]);
  });

  it("matches whole words only, so a longer word does not become a link", () => {
    expect(linkSentence({ text: "The webapp serves pages.", citations: [cite("apps/web")] }, overview)).toEqual([
      { text: "The webapp serves pages." },
      { text: " " },
      link("web", "apps/web"),
    ]);
  });

  it("ignores file citations and components missing from the map", () => {
    const parts = linkSentence({ text: "Plain.", citations: [{ kind: "file", id: "src/a.ts" }, { kind: "component", id: "cmp_000000000000" }] }, overview);
    expect(parts).toEqual([{ text: "Plain." }]);
  });

  it("shows hostile text and names through displayUntrusted", () => {
    const parts = linkSentence({ text: "Run evil\u202Ename now **bold**", citations: [cite("pkg/evil")] }, overview);
    expect(parts).toEqual([{ text: "Run " }, link("evil⟨U+202E⟩name", "pkg/evil"), { text: " now **bold**" }]);
    expect(JSON.stringify(parts)).not.toContain("\u202E");
  });
});
