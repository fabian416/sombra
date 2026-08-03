/**
 * Shared plumbing for the Sombra Node scripts.
 *
 * Everything the scripts need from the upstream confidential-token demo is
 * reached through the `@ctd/sdk` path dependency declared in package.json —
 * never through a hard-coded path into the sibling clone. Contract WASM and
 * verification keys are located relative to the resolved package root, so
 * moving or re-pinning the dependency needs no edit here.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Networks } from "@stellar/stellar-sdk";

export const NETWORK = "testnet";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const PASSPHRASE = Networks.TESTNET;
export const FRIENDBOT = "https://friendbot.stellar.org";

/** Auditor id registered by deploy.ts and used by every confidential op. */
export const AUDITOR_ID = 0;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT_FILE = join(HERE, "deployment.json");
export const KEYS_FILE = join(HERE, ".demo-keys.json");

/** Absolute path of a file inside the resolved `@ctd/sdk` package. */
function sdkFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

/** Root directory of the resolved `@ctd/sdk` package (…/packages/sdk). */
export function sdkRoot(): string {
  // The package's "." export points at dist/index.js.
  return join(dirname(sdkFile("@ctd/sdk")), "..");
}

/** Path to one of the demo's prebuilt contract WASM artifacts. */
export function wasmPath(name: string): string {
  const p = join(sdkRoot(), "contracts", `${name}.wasm`);
  if (!existsSync(p)) {
    throw new Error(`missing ${p} — run scripts/build-contracts.sh in the demo repo first`);
  }
  return p;
}

/** Bytes of a circuit verification key, as registered in the verifier contract. */
export function readVk(name: string): Uint8Array {
  return new Uint8Array(readFileSync(sdkFile(`@ctd/sdk/circuits/vks/${name}.vk.bin`)));
}

/** Compiled ACIR artifact for a circuit, for `proverFromArtifact`. */
export function readCircuit(name: "register" | "withdraw" | "transfer"): { bytecode: string } & Record<string, unknown> {
  const path = sdkFile(`@ctd/sdk/circuits/${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as { bytecode: string } & Record<string, unknown>;
}

/**
 * The `stellar` CLI binary. Must be ≥ 25.2: the contracts are built against
 * soroban-sdk 27 and older CLIs reject their spec XDR with "cannot parse WASM
 * file". Override with `STELLAR_CLI=/path/to/stellar` when the CLI on PATH is
 * older than that.
 */
const STELLAR_CLI = process.env.STELLAR_CLI ?? "stellar";

/** Run the `stellar` CLI, returning trimmed stdout. Throws on non-zero exit. */
export function stellar(args: string[]): string {
  return execFileSync(STELLAR_CLI, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Like {@link stellar}, but reports failure instead of throwing. */
export function stellarSoft(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: stellar(args) };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    return {
      ok: false,
      out: (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? err.message ?? ""),
    };
  }
}

/** Fund a testnet account from friendbot. Tolerates "already funded". */
export async function friendbotFund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Confidential key derivation
// ---------------------------------------------------------------------------

/**
 * Identifies the derivation an account was enrolled under, recorded per account
 * in `.demo-keys.json`. `register` is single-use, so an account enrolled under
 * one derivation can never be moved to another: the tag is what lets the
 * scripts notice a stale account and mint a fresh one instead of failing at
 * `register` with a confusing on-chain error.
 *
 * The derivation itself is in `derive.ts` — SDK.md §5.1 + §5.2, normative.
 */
export const DERIVATION_ID = "SDK.md-5.1+5.2/hkdf-sha512/sep53-signer-root";

// ---------------------------------------------------------------------------
// Persisted outputs
// ---------------------------------------------------------------------------

export interface AccountRecord {
  public: string;
  secret: string;
  /** Confidential spending secret, hex — derived, stored so tools can skip the signature. */
  ctSkHex?: string;
  /**
   * Which derivation enrolled this account ({@link DERIVATION_ID}). An account
   * whose tag does not match the current derivation cannot be reused: its
   * `register` is spent under keys the current code no longer produces.
   */
  derivation?: string;
  /** SDK.md §5's root form — `signer` here, `import` under an `sk` override. */
  rootForm?: string;
}

export interface DemoKeys {
  deployer: AccountRecord;
  primary?: AccountRecord;
  secondary?: AccountRecord;
  auditor?: { id: number; secretHex: string };
}

export interface TxRecord {
  hash: string;
  ledger: number;
  /** Contract method invoked. */
  op: string;
  /** On-chain event the call emitted (the Archive's ingestion unit). */
  event: string;
  /** Account the event is attributed to, per its topics. */
  account: string;
  note?: string;
}

export interface Deployment {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** The confidential token — the contract the Archive indexes. */
  contractId: string;
  /** Ledger the token contract was created in. Safe `START_LEDGER` for the Archive. */
  deployLedger: number;
  deployerPublic: string;
  primaryAccountPublic: string | null;
  secondaryAccountPublic: string | null;
  txHashes: TxRecord[];
  /** Ledger span covered by the scripted history, once it has been created. */
  historyLedgers?: { from: number; to: number };
  contracts: {
    token: string;
    verifier: string;
    auditor: string;
    underlying: string;
  };
  auditorId: number;
  /** `addressToField(token)`, hex — the Poseidon2 parity anchor for the key set. */
  addrF: string;
  /**
   * Exact parameters of the normative derivation (SDK.md §5.1 + §5.2), plus a
   * shared test vector. Recorded because every client serving these accounts
   * must reproduce it bit for bit — `register` is single-use, so a client that
   * derives differently cannot be corrected after the fact.
   */
  keyDerivation: KeyDerivationRecord;
  /**
   * Accounts registered under a superseded derivation. Their events are still
   * on-chain and the Archive still ingests them; they are recorded so a reader
   * finding extra registered accounts on this contract knows why they exist and
   * that nothing points at them.
   */
  supersededAccounts?: { public: string; scheme: string; reason: string }[];
  notes: string[];
}

export interface KeyDerivationRecord {
  /** Normative source, section-precise. */
  spec: string;
  /** The derivation in one line. */
  scheme: string;
  /** §5.2 root: how the HKDF input keying material is obtained. */
  root: {
    form: string;
    /** The §5.2 message template, with `{contract}` / `{account}` placeholders. */
    messageTemplate: string;
    messageLength: number;
    sep53Prefix: string;
    digest: string;
    signature: string;
  };
  /** §5.1 HKDF parameters. */
  hkdf: {
    hash: string;
    ikm: string;
    salt: string;
    info: string;
    outputBytes: number;
  };
  /** §5.1's `RS` — the §4.7 rejection procedure. */
  rejection: string;
  /** DESIGN.md §4, the hierarchy below `sk`. */
  belowSk: string;
  /**
   * A published input both implementations run, so parity is demonstrated
   * rather than asserted. The seed is a constant, not a funded account.
   */
  testVector: {
    note: string;
    seedHex: string;
    contract: string;
    account: string;
    message: string;
    sep53DigestHex: string;
    rootSignatureHex: string;
    addrF: string;
    acctF: string;
    rejectionCounter: number;
    sk: string;
    vk: string;
    Y: [string, string];
    PVK: [string, string];
    verifiedBy: string[];
  };
  /**
   * Per-account derivation outputs for the accounts this history actually uses.
   *
   * Only the values that are already public on-chain: `Y` and `PVK` are what
   * `register` published, so publishing them here discloses nothing. `sk` and
   * `vk` are secret — `vk` decrypts both channels — and stay in the gitignored
   * `.demo-keys.json`, where a client that wants a full byte-parity test can
   * read them locally.
   *
   * This is the stronger of the two vectors: it ties the derivation to the
   * accounts that are really registered, so an implementation that reproduces
   * `Y` from a signature has proven it can enrol *this* history's accounts,
   * not merely that it agrees on a synthetic input.
   */
  accountVectors?: AccountVector[];
}

export interface AccountVector {
  label: string;
  account: string;
  /** `address_to_field(account)` — §5.1's `acct_f`. */
  acctF: string;
  /**
   * The rejection counter that produced this account's `sk`. Non-zero values
   * are the interesting ones: a client that ignores `j` derives a different
   * `sk` and cannot recover the account at all.
   */
  rejectionCounter: number;
  rootForm: string;
  /** `Y = sk·H`, as published on-chain by `register`. */
  Y: [string, string];
  /** `PVK = vk·H`, as published on-chain by `register`. */
  PVK: [string, string];
}

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`no deployment at ${DEPLOYMENT_FILE} — run \`npm run deploy\` first`);
  }
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
}

export function saveDeployment(d: Deployment): void {
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(d, null, 2)}\n`);
}

export function loadKeys(): DemoKeys {
  if (!existsSync(KEYS_FILE)) {
    throw new Error(`no keys at ${KEYS_FILE} — run \`npm run deploy\` first`);
  }
  return JSON.parse(readFileSync(KEYS_FILE, "utf8")) as DemoKeys;
}

export function saveKeys(k: DemoKeys): void {
  writeFileSync(KEYS_FILE, `${JSON.stringify(k, null, 2)}\n`, { mode: 0o600 });
}
