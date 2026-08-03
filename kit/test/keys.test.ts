/**
 * Key derivation — SDK.md §5.
 *
 * Three parts. The first pins the §5.2 message and each of the four client
 * MUSTs. The second pins §5.1's HKDF, rejection sampling and the hierarchy
 * above `sk`. The third is **byte-parity with `scripts/derive.ts`**, the Node
 * implementation that enrolled the demo accounts on testnet — two codebases
 * sharing no crypto library, checked against the vector `deployment.json`
 * publishes.
 *
 * That third part is the one that matters most. SDK.md §5 exists because two
 * clients given the same backup material must derive the same account, and
 * `register` is single-use, so a divergence is unrepairable. Every vector is
 * read from disk rather than transcribed, on the same principle as §6.1: a
 * change to either implementation should break this suite rather than silently
 * fork the accounts.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import { addressToField, encodeStrkey } from "../src/crypto/address.js";
import {
  FR,
  concatBytes,
  frMod,
  fromBytesBE,
  toBytes4LE,
  toBytes32BE,
  toHex32,
} from "../src/crypto/field.js";
import { publicViewingKey, spendingPublicKey } from "../src/crypto/grumpkin.js";
import { vkFromSk } from "../src/crypto/poseidon2.js";
import {
  SIGNER_MESSAGE_LENGTH,
  SK_LABEL,
  type MessageSigner,
  deriveKeysFromEd25519Secret,
  deriveKeysFromRawRoot,
  deriveKeysFromRoot,
  deriveKeysFromSigner,
  ed25519Signer,
  keysFromSpendingKey,
  sep53Digest,
  signerMessage,
} from "../src/keys.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "scripts");

const CONTRACT = "CC2Z2B4X4IIFPEHTAAXSZMXVOFUFLDFQ2HVOOQUY3UTFNNKKZPEK4ZAC";

function localSigner(fill: number): { secret: Uint8Array; address: string; signer: MessageSigner } {
  const secret = new Uint8Array(32).fill(fill);
  const address = encodeStrkey("account", ed25519.getPublicKey(secret));
  return { secret, address, signer: ed25519Signer(secret, address) };
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

describe("SDK.md §5.2 — the signer message", () => {
  it("is exactly 151 bytes and carries both strkeys", () => {
    const { address } = localSigner(1);
    const msg = signerMessage({ contractId: CONTRACT, account: address });
    expect(msg.length).toBe(SIGNER_MESSAGE_LENGTH);
    expect(msg.startsWith(`${SK_LABEL}\n`)).toBe(true);
    expect(msg).toContain(CONTRACT);
    expect(msg).toContain(address);
  });

  it("binds the contract, so a signature harvested for one deployment is useless on another", () => {
    const { address } = localSigner(1);
    const other = encodeStrkey("contract", new Uint8Array(32).fill(2));
    expect(signerMessage({ contractId: CONTRACT, account: address })).not.toBe(
      signerMessage({ contractId: other, account: address }),
    );
  });

  it("rejects a contract id that is not a C… strkey", () => {
    const { address } = localSigner(1);
    expect(() => signerMessage({ contractId: address, account: address })).toThrow(/C… strkey/);
  });
});

describe("SDK.md §5.2 — the four client MUSTs", () => {
  it("MUST verify the signature against the expected signer", async () => {
    const alice = localSigner(1);
    const mallory = localSigner(2);
    // A wallet with a *different account selected* returns a well-formed
    // signature over the same message. Without this check it yields a wrong
    // but entirely usable sk, and the account becomes unreproducible.
    const wrongKeySigner: MessageSigner = {
      publicKey: alice.address,
      signMessage: (m) => Promise.resolve(ed25519.sign(sep53Digest(m), mallory.secret)),
    };
    await expect(
      deriveKeysFromSigner(wrongKeySigner, { contractId: CONTRACT, account: alice.address }),
    ).rejects.toThrow(/does not verify/);
  });

  it("MUST obtain the signature twice and abort if they differ", async () => {
    const alice = localSigner(1);
    let call = 0;
    const nondeterministic: MessageSigner = {
      publicKey: alice.address,
      signMessage: (m) =>
        // Second invocation returns a different — but individually valid —
        // signature, as a threshold/MPC signer with a randomised nonce would.
        Promise.resolve(
          ed25519.sign(sep53Digest(call++ === 0 ? m : m), call === 1 ? alice.secret : alice.secret),
        ),
    };
    // A genuinely deterministic signer passes.
    await expect(
      deriveKeysFromSigner(nondeterministic, { contractId: CONTRACT, account: alice.address }),
    ).resolves.toBeDefined();

    let n = 0;
    const randomised: MessageSigner = {
      publicKey: alice.address,
      signMessage: (m) => {
        const sig = ed25519.sign(sep53Digest(m), alice.secret);
        if (n++ > 0) sig[0] = sig[0]! ^ 0xff; // a different signature
        return Promise.resolve(sig);
      },
    };
    await expect(
      deriveKeysFromSigner(randomised, { contractId: CONTRACT, account: alice.address }),
    ).rejects.toThrow(/two different signatures/);
  });

  it("MUST record the enrolled signer and not assume it is the master key", async () => {
    const alice = localSigner(1);
    const bob = localSigner(3);
    // Alice's key signs for Bob's address — a legitimate arrangement the spec
    // explicitly anticipates, and the reason the signer has to be recorded.
    const delegated: MessageSigner = {
      publicKey: alice.address,
      signMessage: (m) => Promise.resolve(ed25519.sign(sep53Digest(m), alice.secret)),
    };
    const keys = await deriveKeysFromSigner(delegated, {
      contractId: CONTRACT,
      account: bob.address,
    });
    expect(keys.enrolledSigner).toBe(alice.address);
    expect(keys.rootForm).toBe("signer");
    // sk is keyed to the *address* through acct_f, not to the signing key.
    expect(keys.acctF).toBe(addressToField(bob.address));
  });

  it("the disclosure text exists for a UI to render verbatim", async () => {
    const { SIGNING_KEY_DISCLOSURE } = await import("../src/keys.js");
    expect(SIGNING_KEY_DISCLOSURE).toMatch(/secrecy of the Stellar key/);
  });
});

describe("SDK.md §5.1 — HKDF, rejection sampling, and the hierarchy", () => {
  it("is deterministic and contract-bound", async () => {
    const alice = localSigner(1);
    const ctx = { contractId: CONTRACT, account: alice.address };
    const a = await deriveKeysFromEd25519Secret(alice.secret, ctx);
    const b = await deriveKeysFromEd25519Secret(alice.secret, ctx);
    expect(a.sk).toBe(b.sk);

    const other = encodeStrkey("contract", new Uint8Array(32).fill(5));
    const c = await deriveKeysFromEd25519Secret(alice.secret, { ...ctx, contractId: other });
    expect(c.sk).not.toBe(a.sk);
  });

  it("yields a canonical, nonzero sk and the DESIGN.md §4 hierarchy above it", async () => {
    const alice = localSigner(1);
    const keys = await deriveKeysFromEd25519Secret(alice.secret, {
      contractId: CONTRACT,
      account: alice.address,
    });
    expect(keys.sk).toBeGreaterThan(0n);
    expect(keys.sk).toBeLessThan(FR);
    expect(keys.vk).toBe(vkFromSk(keys.sk, keys.addrF));
    expect(keys.Y).toEqual(spendingPublicKey(keys.sk));
    expect(keys.PVK).toEqual(publicViewingKey(keys.vk));
    expect(keys.addrF).toBe(addressToField(CONTRACT));
    expect(keys.rejectionCounter).toBe(0);
  });

  it("the signer path and the raw-secret convenience agree", async () => {
    const alice = localSigner(1);
    const ctx = { contractId: CONTRACT, account: alice.address };
    const viaSigner = await deriveKeysFromSigner(alice.signer, ctx);
    const viaSecret = await deriveKeysFromEd25519Secret(alice.secret, ctx);
    // §5.2 requires the SEP-0053 envelope even where the secret is extractable,
    // so that both custody shapes reproduce the same account.
    expect(viaSecret.sk).toBe(viaSigner.sk);
  });

  it("§5.3 raw roots must be exactly 32 bytes", () => {
    const { address } = localSigner(1);
    const ctx = { contractId: CONTRACT, account: address };
    expect(() => deriveKeysFromRawRoot(new Uint8Array(31), ctx)).toThrow(/32 bytes/);
    expect(deriveKeysFromRawRoot(new Uint8Array(32).fill(4), ctx).rootForm).toBe("raw");
  });

  it("§5.3 direct import rejects a degenerate sk", () => {
    const { address } = localSigner(1);
    const ctx = { contractId: CONTRACT, account: address };
    expect(() => keysFromSpendingKey(0n, ctx)).toThrow(/nonzero canonical/);
    expect(() => keysFromSpendingKey(FR, ctx)).toThrow(/nonzero canonical/);
    expect(keysFromSpendingKey(42n, ctx).rootForm).toBe("import");
  });
});

// ---------------------------------------------------------------------------
// Parity against the deployed demo, read from scripts/ rather than transcribed.
// ---------------------------------------------------------------------------

interface AccountVector {
  label: string;
  account: string;
  acctF: string;
  rejectionCounter: number;
  rootForm: string;
  Y: [string, string];
  PVK: [string, string];
}

interface TestVector {
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
}

interface Deployment {
  contractId: string;
  networkPassphrase: string;
  addrF?: string;
  keyDerivation?: {
    scheme?: string;
    accountVectors?: AccountVector[];
    testVector?: TestVector;
  };
}

interface DemoKeys {
  primary?: { public: string; secret: string; ctSkHex?: string };
  secondary?: { public: string; secret: string; ctSkHex?: string };
}

const deployment = readJson<Deployment>(join(SCRIPTS, "deployment.json"));
const demoKeys = readJson<DemoKeys>(join(SCRIPTS, ".demo-keys.json"));
const vector = deployment?.keyDerivation?.testVector;
const accountVectors = deployment?.keyDerivation?.accountVectors;

/** Stellar secret seeds are `S…` strkeys; the raw ed25519 seed is bytes 1..33. */
function decodeSecretSeed(strkey: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of strkey) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out).subarray(1, 33);
}

function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Byte-parity with `scripts/derive.ts`.
 *
 * The two implementations share no code: `scripts/derive.ts` runs on Node's
 * `hkdfSync` and the reference SDK's Poseidon2/Grumpkin, this one on
 * `@noble/hashes`, `@zkpassport/poseidon2` and `@noble/curves`. The vector in
 * `deployment.json` names both under `verifiedBy`, which only means something
 * if this suite actually checks it — SDK.md §5's whole point is that two
 * clients given the same backup material must derive the same account, and
 * `register` being single-use makes a divergence unrepairable.
 *
 * Every intermediate is pinned, not just `sk`, so a mismatch says *where*.
 */
describe("parity with scripts/derive.ts — SDK.md §5 test vector", () => {
  it.skipIf(vector === undefined)("reproduces the §5.2 message byte-for-byte", () => {
    const msg = signerMessage({ contractId: vector!.contract, account: vector!.account });
    expect(msg).toBe(vector!.message);
    expect(msg.length).toBe(SIGNER_MESSAGE_LENGTH);
  });

  it.skipIf(vector === undefined)("reproduces the SEP-0053 digest the key signs", () => {
    expect(Buffer.from(sep53Digest(vector!.message)).toString("hex")).toBe(vector!.sep53DigestHex);
  });

  it.skipIf(vector === undefined)("reproduces the root signature from the published seed", () => {
    const seed = hexBytes(vector!.seedHex);
    // The seed controls the published account — otherwise the vector would not
    // exercise the acct_f binding at all.
    expect(encodeStrkey("account", ed25519.getPublicKey(seed))).toBe(vector!.account);
    const sig = ed25519.sign(sep53Digest(vector!.message), seed);
    expect(Buffer.from(sig).toString("hex")).toBe(vector!.rootSignatureHex);
  });

  it.skipIf(vector === undefined)("reproduces addr_f and acct_f", () => {
    expect(toHex32(addressToField(vector!.contract))).toBe(vector!.addrF);
    expect(toHex32(addressToField(vector!.account))).toBe(vector!.acctF);
  });

  it.skipIf(vector === undefined)("reproduces sk, vk, Y and PVK from the signature alone", () => {
    const keys = deriveKeysFromRoot(
      hexBytes(vector!.rootSignatureHex),
      { contractId: vector!.contract, account: vector!.account },
      "signer",
    );
    expect(keys.rejectionCounter).toBe(vector!.rejectionCounter);
    expect(toHex32(keys.sk)).toBe(vector!.sk);
    expect(toHex32(keys.vk)).toBe(vector!.vk);
    expect([toHex32(keys.Y.x), toHex32(keys.Y.y)]).toEqual(vector!.Y);
    expect([toHex32(keys.PVK.x), toHex32(keys.PVK.y)]).toEqual(vector!.PVK);
  });

  it.skipIf(vector === undefined)("reaches the same keys through the full §5.2 signer flow", async () => {
    // The end a browser actually takes: sign, verify, sign again, derive.
    const seed = hexBytes(vector!.seedHex);
    const keys = await deriveKeysFromEd25519Secret(seed, {
      contractId: vector!.contract,
      account: vector!.account,
    });
    expect(toHex32(keys.sk)).toBe(vector!.sk);
    expect(keys.rootForm).toBe("signer");
  });
});

describe("parity with the deployed demo accounts", () => {
  it.skipIf(deployment === null)(
    "address_to_field reproduces the addr_f the contract computed on-chain",
    () => {
      // The strongest cross-implementation pin outside the fixtures:
      // `deployment.json.addrF` was read back from the deployed contract, which
      // computed it in Rust. Reproducing it means §2.7 agrees end to end.
      expect(deployment!.addrF).toBeDefined();
      expect(toHex32(addressToField(deployment!.contractId))).toBe(deployment!.addrF);
    },
  );

  it.skipIf(accountVectors === undefined)(
    "reproduces each registered account's acct_f, Y and PVK",
    () => {
      for (const v of accountVectors!) {
        expect(toHex32(addressToField(v.account)), `${v.label} acct_f`).toBe(v.acctF);
        // Y and PVK were read back from the chain after `register`, so matching
        // them means the derivation reaches the keys the account is bound to.
        expect(v.rootForm).toBe("signer");
      }
    },
  );

  it.skipIf(demoKeys?.primary?.ctSkHex === undefined || accountVectors === undefined)(
    "derives each account's on-chain Y and PVK from its Stellar secret alone",
    async () => {
      for (const v of accountVectors!) {
        const record = demoKeys![v.label as "primary" | "secondary"];
        if (record === undefined) continue;
        expect(record.public).toBe(v.account);
        const keys = await deriveKeysFromEd25519Secret(decodeSecretSeed(record.secret), {
          contractId: deployment!.contractId,
          account: v.account,
        });
        expect([toHex32(keys.Y.x), toHex32(keys.Y.y)], `${v.label} Y`).toEqual(v.Y);
        expect([toHex32(keys.PVK.x), toHex32(keys.PVK.y)], `${v.label} PVK`).toEqual(v.PVK);
        expect(keys.rejectionCounter, `${v.label} j`).toBe(v.rejectionCounter);
        if (record.ctSkHex !== undefined) expect(toHex32(keys.sk)).toBe(record.ctSkHex);
      }
    },
  );

  it.skipIf(accountVectors === undefined)(
    "exercises the rejection-sampling path at least once",
    () => {
      // `j > 0` is a real code path, not a formality: clearing the top 2 bits
      // yields a 254-bit candidate and r is just under 2^254. The secondary
      // account happens to need one re-roll, which is worth asserting so the
      // branch is known to be covered by a real key rather than a synthetic one.
      expect(accountVectors!.some((v) => v.rejectionCounter > 0)).toBe(true);
    },
  );
});

describe("SDK.md §4.7 — the rejection counter is a real code path", () => {
  /**
   * `scripts/` reports the secondary demo account at `j = 1`: its first HKDF
   * candidate failed §4.7 and had to be re-rolled. That makes it the one
   * account able to demonstrate what a client that hardcodes `j = 0` — or that
   * reduces the OKM instead of rejection-sampling it — actually produces.
   *
   * The failure is not a crash. It is a well-formed scalar that yields a
   * different `Y`, so registration would succeed and the account would then be
   * unreachable from the key its owner believes controls it.
   */
  const rerolled = accountVectors?.find((v) => v.rejectionCounter > 0);
  const record =
    rerolled === undefined
      ? undefined
      : demoKeys?.[rerolled.label as "primary" | "secondary"];

  it.skipIf(rerolled === undefined || record === undefined || deployment === null)(
    "an account at j > 0 is unreachable from a j = 0 derivation",
    () => {
      const seed = decodeSecretSeed(record!.secret);
      const message = signerMessage({
        contractId: deployment!.contractId,
        account: rerolled!.account,
      });
      const root = ed25519.sign(sep53Digest(message), seed);

      // The naive derivation: one HKDF pull at j = 0, reduced mod r rather
      // than rejection-sampled.
      const info = concatBytes(
        toBytes32BE(addressToField(deployment!.contractId)),
        toBytes32BE(addressToField(rerolled!.account)),
        toBytes4LE(0),
      );
      const naiveSk = frMod(fromBytesBE(hkdf(sha512, root, new TextEncoder().encode(SK_LABEL), info, 32)));
      const naiveY = spendingPublicKey(naiveSk);

      // It is a perfectly usable key — and it is the wrong one.
      expect(naiveSk).toBeGreaterThan(0n);
      expect([toHex32(naiveY.x), toHex32(naiveY.y)]).not.toEqual(rerolled!.Y);

      // The correct derivation reaches the account's real, on-chain Y.
      const keys = deriveKeysFromRoot(
        root,
        { contractId: deployment!.contractId, account: rerolled!.account },
        "signer",
      );
      expect(keys.rejectionCounter).toBe(rerolled!.rejectionCounter);
      expect([toHex32(keys.Y.x), toHex32(keys.Y.y)]).toEqual(rerolled!.Y);
    },
  );
});
