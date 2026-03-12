type IdentityDb = {
  setIdentity: (key: string, value: string) => void;
};

type RegistrationResult =
  | "skipped"
  | "already_registered"
  | "registered"
  | "conflict"
  | "failed";

type ApplyStartupRegistrationInput = {
  useSovereignProviders: boolean;
  platformDisabled: boolean;
  registrationState: string | undefined;
  db: IdentityDb;
  registerAutomaton: (payload: unknown) => Promise<unknown>;
  payload: unknown;
};

export async function applyStartupRegistration(
  input: ApplyStartupRegistrationInput,
): Promise<RegistrationResult> {
  const {
    useSovereignProviders,
    platformDisabled,
    registrationState,
    db,
    registerAutomaton,
    payload,
  } = input;

  if (useSovereignProviders || platformDisabled) return "skipped";
  if (registrationState === "registered") return "already_registered";

  try {
    await registerAutomaton(payload);
    db.setIdentity("conwayRegistrationStatus", "registered");
    return "registered";
  } catch (error: any) {
    if (error?.status === 409) {
      db.setIdentity("conwayRegistrationStatus", "conflict");
      return "conflict";
    }
    db.setIdentity("conwayRegistrationStatus", "failed");
    return "failed";
  }
}
