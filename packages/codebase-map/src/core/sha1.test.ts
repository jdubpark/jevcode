import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sha1Hex, utf8ByteLength, utf8Bytes } from "./sha1.js";

const nodeSha1 = (text: string): string => createHash("sha1").update(text, "utf8").digest("hex");

describe("sha1Hex", () => {
  it("matches the FIPS 180 test vectors", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    );
  });

  it("matches node:crypto across the 64-byte block boundaries", () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120, 128, 1_000, 100_000]) {
      const text = "a".repeat(length);
      expect(sha1Hex(text)).toBe(nodeSha1(text));
    }
  });

  it("matches node:crypto for any string, including astral characters and lone surrogates", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        expect(sha1Hex(text)).toBe(nodeSha1(text));
      }),
      { numRuns: 300 },
    );
  });
});

describe("utf8Bytes and utf8ByteLength", () => {
  it("encode like Buffer, writing a lone surrogate as U+FFFD", () => {
    expect(Array.from(utf8Bytes("a\ud800"))).toEqual([0x61, 0xef, 0xbf, 0xbd]);
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (text) => {
        const expected = Buffer.from(text, "utf8");
        expect(Array.from(utf8Bytes(text))).toEqual(Array.from(expected));
        expect(utf8ByteLength(text)).toBe(expected.length);
      }),
      { numRuns: 300 },
    );
  });
});
