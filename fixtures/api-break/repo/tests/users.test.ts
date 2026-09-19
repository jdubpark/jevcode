import { describe, expect, it } from "vitest";

import { handleGetUser } from "../src/routes/users";

describe("GET /users/:id", () => {
  it("returns the user when found", () => {
    const result = handleGetUser(1);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ user: { id: 1, email: "a@example.com" } });
  });

  it("returns 404 when the user is missing", () => {
    expect(() => handleGetUser(999)).toThrowError("user 999 not found");
  });
});
