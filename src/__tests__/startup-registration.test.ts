import { describe, expect, it, vi } from "vitest";
import { applyStartupRegistration } from "../startup/registration.js";

type MockDb = {
  getIdentity: ReturnType<typeof vi.fn>;
  setIdentity: ReturnType<typeof vi.fn>;
};

const createDb = (initial: Record<string, string | undefined> = {}): MockDb => ({
  getIdentity: vi.fn((key: string) => initial[key]),
  setIdentity: vi.fn(),
});

describe("startup registration behavior", () => {
  it("skips registration when sovereign providers are enabled", async () => {
    const db = createDb();
    const registerAutomaton = vi.fn();

    await applyStartupRegistration({
      useSovereignProviders: true,
      platformDisabled: false,
      registrationState: "unknown",
      db,
      registerAutomaton,
      payload: { automatonId: "a-1" },
    });

    expect(registerAutomaton).not.toHaveBeenCalled();
    expect(db.setIdentity).not.toHaveBeenCalledWith("conwayRegistrationStatus", expect.anything());
  });

  it("skips registration when platform is disabled (BYOK mode)", async () => {
    const db = createDb();
    const registerAutomaton = vi.fn();

    await applyStartupRegistration({
      useSovereignProviders: false,
      platformDisabled: true,
      registrationState: "unknown",
      db,
      registerAutomaton,
      payload: { automatonId: "a-2" },
    });

    expect(registerAutomaton).not.toHaveBeenCalled();
    expect(db.setIdentity).not.toHaveBeenCalledWith("conwayRegistrationStatus", expect.anything());
  });

  it("runs registration in legacy mode when status is not registered", async () => {
    const db = createDb();
    const registerAutomaton = vi.fn().mockResolvedValue({ automaton: {} });

    await applyStartupRegistration({
      useSovereignProviders: false,
      platformDisabled: false,
      registrationState: "failed",
      db,
      registerAutomaton,
      payload: { automatonId: "a-3" },
    });

    expect(registerAutomaton).toHaveBeenCalledTimes(1);
    expect(db.setIdentity).toHaveBeenCalledWith("conwayRegistrationStatus", "registered");
  });

  it("records conflict status on 409 and failed on generic errors", async () => {
    const conflictDb = createDb();
    const conflictError = Object.assign(new Error("conflict"), { status: 409 });
    const conflictRegister = vi.fn().mockRejectedValue(conflictError);

    await applyStartupRegistration({
      useSovereignProviders: false,
      platformDisabled: false,
      registrationState: "unknown",
      db: conflictDb,
      registerAutomaton: conflictRegister,
      payload: { automatonId: "a-4" },
    });

    expect(conflictDb.setIdentity).toHaveBeenCalledWith("conwayRegistrationStatus", "conflict");

    const failedDb = createDb();
    const failedRegister = vi.fn().mockRejectedValue(new Error("boom"));

    await applyStartupRegistration({
      useSovereignProviders: false,
      platformDisabled: false,
      registrationState: "unknown",
      db: failedDb,
      registerAutomaton: failedRegister,
      payload: { automatonId: "a-5" },
    });

    expect(failedDb.setIdentity).toHaveBeenCalledWith("conwayRegistrationStatus", "failed");
  });

  it("does not mutate automatonId when registration is skipped", async () => {
    const db = createDb({ automatonId: "persisted-id" });
    const registerAutomaton = vi.fn();

    await applyStartupRegistration({
      useSovereignProviders: true,
      platformDisabled: true,
      registrationState: "unknown",
      db,
      registerAutomaton,
      payload: { automatonId: "persisted-id" },
    });

    expect(registerAutomaton).not.toHaveBeenCalled();
    expect(db.setIdentity).not.toHaveBeenCalledWith("automatonId", expect.anything());
  });
});
