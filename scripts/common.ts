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

import { createHash } from "node:crypto";

import { Networks, Keypair } from "@stellar/stellar-sdk";
import { frMod, fromBytesBE } from "@ctd/sdk";

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
 * The message whose signature seeds the confidential spending key. Folding in
 * the passphrase and the token contract id keeps a signature obtained for one
 * deployment from deriving keys for another, mirroring how `vk` is bound to
 * `addr_f` on-chain.
 */
export function keyDerivationMessage(networkPassphrase: string, tokenContract: string): string {
  return [
    "Sombra — confidential key derivation v1",
    "",
    "Signing this message derives your confidential spending key.",
    "",
    `Network: ${networkPassphrase}`,
    `Token contract: ${tokenContract}`,
  ].join("\n");
}

const SEP53_PREFIX = new TextEncoder().encode("Stellar Signed Message:\n");

/**
 * SEP-0053 message signature: ed25519 over `SHA-256(prefix ‖ message)`. This is
 * what a wallet's `signMessage` produces, so a browser holding the same Stellar
 * account reproduces these bytes without ever seeing the seed.
 */
export function sep53Sign(kp: Keypair, message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const payload = Buffer.concat([Buffer.from(SEP53_PREFIX), Buffer.from(body)]);
  const digest = createHash("sha256").update(payload).digest();
  return new Uint8Array(kp.sign(digest));
}

/**
 * Fold a message signature into a non-zero F_r scalar. Ed25519 signatures are
 * deterministic (RFC 8032), so this survives the loss of all local state — the
 * seed half of Sombra's recovery story. The event half is the Archive's job.
 */
export function skFromSignature(signature: Uint8Array): bigint {
  const digest = createHash("sha512").update(Buffer.from(signature)).digest();
  const sk = frMod(fromBytesBE(new Uint8Array(digest)));
  if (sk === 0n) throw new Error("degenerate key derivation (zero scalar)");
  return sk;
}

/** Derive the confidential spending secret for a Stellar account. */
export function deriveConfidentialSk(kp: Keypair, tokenContract: string): bigint {
  return skFromSignature(sep53Sign(kp, keyDerivationMessage(PASSPHRASE, tokenContract)));
}

// ---------------------------------------------------------------------------
// Persisted outputs
// ---------------------------------------------------------------------------

export interface AccountRecord {
  public: string;
  secret: string;
  /** Confidential spending secret, hex — derived, stored so tools can skip the signature. */
  ctSkHex?: string;
}

export interface DemoKeys {
  deployer: AccountRecord;
  primary?: AccountRecord;
  secondary?: AccountRecord;
  auditor?: { id: number; secretHex: string };
}

export interface TxRecord {
  hash: string;
  op: string;
  event: string;
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
  contracts: {
    token: string;
    verifier: string;
    auditor: string;
    underlying: string;
  };
  auditorId: number;
  /** `addressToField(token)`, hex — the Poseidon2 parity anchor for the key set. */
  addrF: string;
  keyDerivation: {
    scheme: string;
    message: string;
  };
  notes: string[];
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
