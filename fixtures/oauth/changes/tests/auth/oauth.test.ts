import { describe, expect, it } from "vitest";

import { findOrCreateIdentity, linkIdentityToUser } from "../src/auth/identity";

describe("oauth account linking", () => {
  it("links a Google identity to an existing account by email", async () => {
    const identity = await findOrCreateIdentity({ provider: "google", subject: "google-42" });
    await linkIdentityToUser(identity.id, 7);
    expect(identity.userId).toBe(7);
  });

  it("creates a distinct identity per provider subject", async () => {
    const first = await findOrCreateIdentity({ provider: "google", subject: "google-42" });
    const second = await findOrCreateIdentity({ provider: "password", subject: "a@example.com" });
    expect(first.id).not.toBe(second.id);
  });
});
