import { describe, expect, it } from "vitest";

import { isNotAuthorized, isPublicPath } from "./auth";

describe("isPublicPath", () => {
  it("lets the sign-in page and the OAuth callback through", () => {
    expect(isPublicPath("/sign-in")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
  });

  it("gates every portal page", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/users")).toBe(false);
    expect(isPublicPath("/users/de300000-0000-4000-8000-000000000001")).toBe(false);
    expect(isPublicPath("/plans")).toBe(false);
  });

  it("doesn't match paths that only start with the same letters", () => {
    expect(isPublicPath("/sign-inx")).toBe(false);
    expect(isPublicPath("/authors")).toBe(false);
  });
});

describe("isNotAuthorized", () => {
  it("is true for require_admin's 42501", () => {
    expect(isNotAuthorized({ code: "42501" })).toBe(true);
  });

  it("is false for other errors and no error", () => {
    expect(isNotAuthorized({ code: "P0001" })).toBe(false);
    expect(isNotAuthorized({ code: null })).toBe(false);
    expect(isNotAuthorized({})).toBe(false);
    expect(isNotAuthorized(null)).toBe(false);
    expect(isNotAuthorized(undefined)).toBe(false);
  });
});
