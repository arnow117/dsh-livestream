export type StrictMode = "" | "user" | "bot";

/** Preserve the native profile override and otherwise the global policy. */
export function effectiveStrictMode(
  globalValue: unknown,
  profileValue: unknown,
): StrictMode {
  const chosen =
    profileValue === undefined || profileValue === null
      ? globalValue
      : profileValue;
  if (chosen === undefined || chosen === null || chosen === "") return "";
  if (chosen === "user" || chosen === "bot") return chosen;
  throw new Error("invalid_strict_mode");
}

/** The original mode is never rewritten; bot-only cannot dispatch a user operation. */
export function requireUserAllowed(mode: StrictMode): void {
  if (mode === "bot") throw new Error("user_identity_forbidden");
}
