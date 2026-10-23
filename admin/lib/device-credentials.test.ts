import { describe, expect, it } from "vitest";

import { revokedCredentialsMessage } from "./device-credentials";

describe("revokedCredentialsMessage", () => {
  it("counts what was revoked, for the user's email", () => {
    expect(revokedCredentialsMessage("ann@example.com", 2)).toBe("Revoked 2 device credentials for ann@example.com");
    expect(revokedCredentialsMessage("ann@example.com", 1)).toBe("Revoked 1 device credential for ann@example.com");
    expect(revokedCredentialsMessage("ann@example.com", 1200)).toBe("Revoked 1,200 device credentials for ann@example.com");
  });

  it("says when there was none", () => {
    expect(revokedCredentialsMessage("ann@example.com", 0)).toBe("No device credentials to revoke for ann@example.com");
  });

  it("names the user without an email", () => {
    expect(revokedCredentialsMessage(null, 3)).toBe("Revoked 3 device credentials for the user");
    expect(revokedCredentialsMessage(null, 0)).toBe("No device credentials to revoke for the user");
  });
});
