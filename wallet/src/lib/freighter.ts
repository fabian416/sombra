/**
 * Freighter — the only live chain integration in this build.
 *
 * The API returns errors inside the result object rather than throwing, and
 * signals user rejection with SEP-0043 code -4. Both are normalised here so the
 * rest of the wallet only ever deals with thrown Errors carrying copy that is
 * safe to show a person.
 */
import {
  isConnected,
  isAllowed,
  setAllowed,
  requestAccess,
  getAddress,
  getNetwork,
} from "@stellar/freighter-api";
import type { WalletIdentity } from "./client";

export class FreighterMissingError extends Error {
  constructor() {
    super("Freighter isn't installed in this browser.");
    this.name = "FreighterMissingError";
  }
}

export class FreighterRejectedError extends Error {
  constructor() {
    super("Freighter declined the connection.");
    this.name = "FreighterRejectedError";
  }
}

const REJECTION = /reject|declin|denied|cancel/i;

function raise(error: unknown): never {
  const err = error as { code?: number; message?: string } | undefined;
  const message = err?.message ?? String(error ?? "Unknown Freighter error");
  if (err?.code === -4 || REJECTION.test(message)) {
    throw new FreighterRejectedError();
  }
  throw new Error(message);
}

export async function detectFreighter(): Promise<boolean> {
  try {
    const res = await isConnected();
    if (res.error) return false;
    return res.isConnected;
  } catch {
    return false;
  }
}

/** Full connect: detect, request permission if needed, read address + network. */
export async function connect(): Promise<WalletIdentity> {
  const installed = await detectFreighter();
  if (!installed) throw new FreighterMissingError();

  const allowed = await isAllowed();
  if (allowed.error) raise(allowed.error);
  if (!allowed.isAllowed) {
    const granted = await setAllowed();
    if (granted.error) raise(granted.error);
  }

  const access = await requestAccess();
  if (access.error) raise(access.error);
  if (!access.address) throw new FreighterRejectedError();

  const net = await getNetwork();
  if (net.error) raise(net.error);

  return {
    address: access.address,
    network: net.network || "TESTNET",
    networkPassphrase:
      net.networkPassphrase || "Test SDF Network ; September 2015",
  };
}

/**
 * Restore a session without prompting. Returns null when the wallet is locked,
 * not installed, or has never been authorised for this origin.
 */
export async function restoreSession(): Promise<WalletIdentity | null> {
  try {
    if (!(await detectFreighter())) return null;
    const allowed = await isAllowed();
    if (allowed.error || !allowed.isAllowed) return null;

    const addr = await getAddress();
    if (addr.error || !addr.address) return null;

    const net = await getNetwork();
    return {
      address: addr.address,
      network: net.network || "TESTNET",
      networkPassphrase:
        net.networkPassphrase || "Test SDF Network ; September 2015",
    };
  } catch {
    return null;
  }
}
