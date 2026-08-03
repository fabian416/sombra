/**
 * Create real on-chain confidential history for the Sombra demo.
 *
 * Recovery is what Sombra demonstrates, and recovery is only meaningful against
 * history it did not author. So this script produces the substrate offline, in
 * Node, ahead of the demo: genuine UltraHonk proofs, genuine transactions,
 * genuine events in genuine ledgers. The browser wallet then only has to *read*
 * them back — no proving in the browser at all, which keeps the two riskiest
 * integrations in the stack (bb.js worker resolution, keccak transcript) off the
 * demo's critical path entirely.
 *
 * The primary account ends up with one of every event recovery depends on
 * (INDEXER.md §3.2):
 *
 *   register            start of history, bounds the replay window
 *   deposit             receiving-side replay, commits with zero blinding
 *   transfer ×3 (in)    receiving-side replay, ECDH-decrypted from the event
 *   merge               folds receiving into spendable — the T_0 anchor
 *   transfer (out)      checkpoint: publishes (b_tilde, sigma)
 *   withdraw            checkpoint, the latest one
 *   transfer (in)       arrives after that checkpoint
 *   merge               and is folded in after it too — the T_0 trap
 *
 * That tail is the point. With a merge *after* the latest checkpoint, recovery
 * must resolve T_0 as "the last merge at or before the checkpoint" rather than
 * "the last merge" (INDEXER.md:21). A wallet that gets it wrong starts its
 * replay too late and reconstructs a spendable balance short by exactly the
 * amount that merge folded in — the single easiest way to build a silently
 * wrong wallet, made loud here instead of latent.
 *
 * After every step the local state is re-synced from events alone and
 * re-committed against the on-chain Pedersen points, so a green run is itself
 * evidence that the emitted history is replayable.
 *
 * Usage: npm run history   (after `npm run deploy`; expect several minutes)
 * Env:   SOMBRA_PRIMARY_SK / SOMBRA_SECONDARY_SK — hex spending secrets that
 *        override the signature-derived ones, for pinning a different wallet
 *        key-derivation scheme.
 */

import { Keypair } from "@stellar/stellar-sdk";
import {
  ChainClient,
  MemoryStore,
  StateEngine,
  addressToField,
  buildRegisterWitness,
  buildTransferWitness,
  buildWithdrawWitness,
  keypairSigner,
  proverFromArtifact,
  submitDeposit,
  submitMerge,
  submitRegister,
  submitTransfer,
  submitWithdraw,
  toHex32,
  type KeyPair,
  type Point,
  type Signer,
} from "@ctd/sdk";

import {
  AUDITOR_ID,
  DERIVATION_ID,
  PASSPHRASE,
  RPC_URL,
  friendbotFund,
  loadDeployment,
  loadKeys,
  readCircuit,
  saveDeployment,
  saveKeys,
  type AccountRecord,
  type Deployment,
  type TxRecord,
} from "./common.js";
import {
  accountVector,
  deriveForAccount,
  keyDerivationRecord,
  keysFromSpendingKey,
  type NormativeKeys,
} from "./derive.js";

/** Stroops. Small on purpose — the demo is about events, not amounts. */
const PRIMARY_DEPOSIT = 1_000n;
const SECONDARY_DEPOSIT = 3_000n;
const INCOMING = [700n, 500n, 300n] as const;
const OUTGOING = 250n;
const WITHDRAWAL = 400n;
const LATE_INCOMING = 600n;

interface Actor {
  label: string;
  kp: Keypair;
  signer: Signer;
  keys: NormativeKeys;
  engine: StateEngine;
  /** True when this run had to mint the account rather than reuse a recorded one. */
  fresh: boolean;
}

async function main(): Promise<void> {
  const deployment = loadDeployment();
  const keys = loadKeys();
  const token = deployment.contractId;
  console.log(`token = ${token} (deployed in ledger ${deployment.deployLedger})`);

  const client = new ChainClient({
    rpcUrl: RPC_URL,
    networkPassphrase: PASSPHRASE,
    contracts: {
      token,
      verifier: deployment.contracts.verifier,
      auditor: deployment.contracts.auditor,
    },
  });

  const addrF = addressToField(token);
  const kAud: Point = await client.auditorKey(AUDITOR_ID);
  const txs: TxRecord[] = [];

  // One backend per circuit: initialising bb.js loads WASM and derives the CRS,
  // which dwarfs the per-proof cost.
  const provers = {
    register: proverFromArtifact(readCircuit("register")),
    transfer: proverFromArtifact(readCircuit("transfer")),
    withdraw: proverFromArtifact(readCircuit("withdraw")),
  };

  try {
    console.log("\n[accounts]");
    const primary = await makeActor("primary", keys.primary, token, addrF, client, deployment, "SOMBRA_PRIMARY_SK");
    const secondary = await makeActor("secondary", keys.secondary, token, addrF, client, deployment, "SOMBRA_SECONDARY_SK");

    saveKeys({
      ...keys,
      primary: record(primary),
      secondary: record(secondary),
    });

    console.log("\n[register]");
    for (const actor of [primary, secondary]) {
      const witness = buildRegisterWitness(actor.keys);
      const { proof } = await timed(`register ${actor.label}`, () => provers.register.prove(witness.inputs));
      const res = await submitRegister(client, actor.signer, actor.kp.publicKey(), AUDITOR_ID, witness, proof);
      txs.push(await landed(client, res.hash, "register", "register", actor.kp.publicKey(), `${actor.label} account created`));
      await assertDerivationMatchesChain(client, actor);
    }

    console.log("\n[deposit] public XLM → confidential receiving balance");
    for (const [actor, amount] of [
      [primary, PRIMARY_DEPOSIT],
      [secondary, SECONDARY_DEPOSIT],
    ] as const) {
      const res = await submitDeposit(client, actor.signer, actor.kp.publicKey(), actor.kp.publicKey(), amount);
      txs.push(await landed(client, res.hash, "deposit", "deposit", actor.kp.publicKey(), `${actor.label} +${amount} (zero blinding)`));
    }

    // The secondary must merge before it can send: received value is not
    // spendable until it is folded into the spendable commitment.
    console.log("\n[merge] secondary");
    {
      const res = await submitMerge(client, secondary.signer, secondary.kp.publicKey());
      txs.push(await landed(client, res.hash, "merge", "merge", secondary.kp.publicKey(), "receiving → spendable"));
      await settle(secondary, { spendable: SECONDARY_DEPOSIT });
    }
    await settle(primary, { receiving: PRIMARY_DEPOSIT });

    console.log("\n[incoming transfers] secondary → primary");
    for (const amount of INCOMING) {
      const state = await secondary.engine.current();
      const witness = buildTransferWitness({
        keys: secondary.keys,
        v: state.spendable.v,
        r: state.spendable.r,
        amount,
        pvkB: primary.keys.PVK,
        kAudR: kAud,
        kAudS: kAud,
      });
      const { proof } = await timed(`transfer ${amount}`, () => provers.transfer.prove(witness.inputs));
      const res = await submitTransfer(client, secondary.signer, secondary.kp.publicKey(), primary.kp.publicKey(), witness, proof);
      txs.push(
        await landed(client, res.hash, "confidential_transfer", "transfer", primary.kp.publicKey(),
          `${amount} secondary → primary (checkpoint for secondary, incoming for primary)`),
      );
      await settle(secondary, {});
    }
    const received = INCOMING.reduce((a, b) => a + b, 0n);
    await settle(primary, { receiving: PRIMARY_DEPOSIT + received });

    console.log("\n[merge] primary — the T_0 anchor");
    {
      const res = await submitMerge(client, primary.signer, primary.kp.publicKey());
      txs.push(await landed(client, res.hash, "merge", "merge", primary.kp.publicKey(), "T_0 anchor: deposit + 3 transfers → spendable"));
      await settle(primary, { spendable: PRIMARY_DEPOSIT + received, receiving: 0n });
    }

    console.log("\n[outgoing transfer] primary → secondary");
    {
      const state = await primary.engine.current();
      const witness = buildTransferWitness({
        keys: primary.keys,
        v: state.spendable.v,
        r: state.spendable.r,
        amount: OUTGOING,
        pvkB: secondary.keys.PVK,
        kAudR: kAud,
        kAudS: kAud,
      });
      const { proof } = await timed(`transfer ${OUTGOING}`, () => provers.transfer.prove(witness.inputs));
      const res = await submitTransfer(client, primary.signer, primary.kp.publicKey(), secondary.kp.publicKey(), witness, proof);
      txs.push(
        await landed(client, res.hash, "confidential_transfer", "transfer", primary.kp.publicKey(),
          `${OUTGOING} primary → secondary — first checkpoint after the merge`),
      );
      await settle(primary, { spendable: PRIMARY_DEPOSIT + received - OUTGOING });
    }

    console.log("\n[withdraw] primary → public XLM");
    {
      const state = await primary.engine.current();
      const witness = buildWithdrawWitness({
        keys: primary.keys,
        v: state.spendable.v,
        r: state.spendable.r,
        amount: WITHDRAWAL,
        kAudS: kAud,
      });
      const { proof } = await timed(`withdraw ${WITHDRAWAL}`, () => provers.withdraw.prove(witness.inputs));
      const res = await submitWithdraw(client, primary.signer, primary.kp.publicKey(), primary.kp.publicKey(), WITHDRAWAL, witness, proof);
      txs.push(
        await landed(client, res.hash, "withdraw", "withdraw", primary.kp.publicKey(),
          `${WITHDRAWAL} → public; latest checkpoint (b_tilde, sigma)`),
      );
      await settle(primary, { spendable: PRIMARY_DEPOSIT + received - OUTGOING - WITHDRAWAL });
    }

    // Deliberately last: an incoming transfer and a merge that land AFTER the
    // withdraw checkpoint. This is the shape INDEXER.md:21 warns about — the
    // spendable value published by the checkpoint predates this merge, so a
    // wallet that takes T_0 as "the last merge" instead of "the last merge at
    // or before the checkpoint" starts its replay too late and reconstructs a
    // spendable balance short by exactly LATE_INCOMING. It is the one recovery
    // bug that is invisible without a history built to expose it.
    console.log("\n[late incoming + merge] after the checkpoint — the T_0 trap");
    {
      const state = await secondary.engine.current();
      const witness = buildTransferWitness({
        keys: secondary.keys,
        v: state.spendable.v,
        r: state.spendable.r,
        amount: LATE_INCOMING,
        pvkB: primary.keys.PVK,
        kAudR: kAud,
        kAudS: kAud,
      });
      const { proof } = await timed(`transfer ${LATE_INCOMING}`, () => provers.transfer.prove(witness.inputs));
      const res = await submitTransfer(client, secondary.signer, secondary.kp.publicKey(), primary.kp.publicKey(), witness, proof);
      txs.push(
        await landed(client, res.hash, "confidential_transfer", "transfer", primary.kp.publicKey(),
          `${LATE_INCOMING} secondary → primary, after primary's latest checkpoint`),
      );

      const merge = await submitMerge(client, primary.signer, primary.kp.publicKey());
      txs.push(await landed(client, merge.hash, "merge", "merge", primary.kp.publicKey(), "merge AFTER the checkpoint — T_0 must not advance to here"));
      await settle(primary, {
        spendable: PRIMARY_DEPOSIT + received - OUTGOING - WITHDRAWAL + LATE_INCOMING,
        receiving: 0n,
      });
    }

    const ledgers = txs.map((t) => t.ledger);
    const finalState = await primary.engine.current();

    // An account this run replaced is not deleted from the record: its events
    // are still on-chain and the Archive still ingests them, so a reader who
    // finds extra registered accounts on this contract needs to know they are
    // deliberate residue rather than a second live history.
    const superseded = [...(deployment.supersededAccounts ?? [])];
    for (const [actor, previous] of [
      [primary, keys.primary],
      [secondary, keys.secondary],
    ] as const) {
      if (actor.fresh && previous && previous.public !== actor.kp.publicKey()) {
        superseded.push({
          public: previous.public,
          scheme: previous.derivation ?? "sk = SHA-512(SEP-0053 signature) mod r (the CT demo app's shortcut)",
          reason:
            "register is single-use, so this account is permanently bound to keys the normative " +
            "SDK.md §5 derivation does not produce. Replaced rather than reused; its events remain on-chain.",
        });
      }
    }

    const updated: Deployment = {
      ...deployment,
      primaryAccountPublic: primary.kp.publicKey(),
      secondaryAccountPublic: secondary.kp.publicKey(),
      txHashes: txs,
      historyLedgers: { from: Math.min(...ledgers), to: Math.max(...ledgers) },
      keyDerivation: keyDerivationRecord(token, [
        accountVector("primary", primary.keys, primary.kp.publicKey()),
        accountVector("secondary", secondary.keys, secondary.kp.publicKey()),
      ]),
      ...(superseded.length > 0 ? { supersededAccounts: superseded } : {}),
      notes: [
        deployment.notes[0] ?? "",
        `Primary history: register → deposit → 3 incoming transfers → merge → outgoing transfer → withdraw ` +
          `→ late incoming transfer → merge. Final spendable = ${finalState.spendable.v} stroops, ` +
          `receiving = ${finalState.receiving.v}.`,
        `The final merge lands AFTER the primary's latest checkpoint (the withdraw), which is the case ` +
          `INDEXER.md:21 warns about: recovery must resolve T_0 as the last merge at or BEFORE that checkpoint. ` +
          `A wallet that takes the last merge overall reconstructs spendable = ` +
          `${finalState.spendable.v - LATE_INCOMING} instead of ${finalState.spendable.v}, and its ` +
          `re-commitment against the on-chain point fails. This history exists to make that bug loud.`,
        "Every proof was generated with the keccak transcript and accepted by the on-chain UltraHonk verifier.",
        "Both accounts were enrolled under the normative SDK.md §5.1 + §5.2 derivation, and the on-chain " +
          "spending_public_key and public viewing key were read back and compared against the derived Y and " +
          "PVK immediately after each register. A browser client implementing §5 therefore reaches the same " +
          "keys from a SEP-0053 signature alone — which is what makes this history recoverable rather than " +
          "merely replayable. See keyDerivation.testVector for the shared parity vector.",
      ].filter(Boolean),
    };
    saveDeployment(updated);

    console.log(`\n✅ history complete — ${txs.length} transactions, ledgers ${updated.historyLedgers?.from}–${updated.historyLedgers?.to}`);
    console.log(`   primary   ${primary.kp.publicKey()}`);
    console.log(`   secondary ${secondary.kp.publicKey()}`);
  } finally {
    await Promise.all(Object.values(provers).map((p) => p.destroy()));
  }
}

/**
 * Load or create an actor.
 *
 * A recorded account is reused only when it was enrolled under the derivation
 * this script currently implements. That condition is not bureaucracy: `sk` is
 * what `register` binds `Y` and `PVK` to, `register` is single-use
 * (DESIGN_cont.md §11), and there is no update path. So an account registered
 * under a superseded derivation is spent — re-registering it fails on-chain,
 * and forcing the new keys onto it would produce a history the wallet cannot
 * decrypt, since the wallet derives `PVK` from the spec and would find every
 * incoming ciphertext addressed to a viewing key it does not hold.
 *
 * Minting a fresh account is therefore the only repair, and doing it
 * automatically is better than failing: the alternative is a confusing
 * `register` revert several minutes into a proving run.
 */
async function makeActor(
  label: string,
  existing: AccountRecord | undefined,
  token: string,
  addrF: bigint,
  client: ChainClient,
  deployment: Deployment,
  skEnvVar: string,
): Promise<Actor> {
  const stale = existing !== undefined && existing.derivation !== DERIVATION_ID;
  if (stale) {
    console.log(
      `  ${label}: recorded account ${existing!.public} was enrolled under ` +
        `"${existing!.derivation ?? "an untagged (pre-§5) derivation"}" — its register is spent ` +
        "under keys this script no longer derives, so it cannot be reused. Minting a fresh account.",
    );
  }
  const kp = existing && !stale ? Keypair.fromSecret(existing.secret) : Keypair.random();
  await friendbotFund(kp.publicKey());

  // SDK.md §5.2 for the normal path; an explicit `sk` is §5.3's direct import,
  // which is conformant but reproducible only from the stored value.
  const override = process.env[skEnvVar];
  const ctKeys = override
    ? keysFromSpendingKey(BigInt(override), { contractId: token, account: kp.publicKey() })
    : await deriveForAccount(kp, token);

  if (ctKeys.addrF !== addrF) {
    throw new Error(`${label}: derived addr_f does not match the deployment's — wrong contract?`);
  }
  console.log(
    `  ${label} = ${kp.publicKey()}  (${ctKeys.rootForm} root, j=${ctKeys.rejectionCounter}` +
      `${override ? `, sk from ${skEnvVar}` : ""})`,
  );

  return {
    label,
    kp,
    signer: keypairSigner(kp.secret(), PASSPHRASE),
    keys: ctKeys,
    engine: new StateEngine({
      client,
      store: new MemoryStore(),
      keys: ctKeys,
      address: kp.publicKey(),
      fromLedger: deployment.deployLedger,
    }),
    fresh: !existing || stale,
  };
}

const record = (a: Actor): AccountRecord => ({
  public: a.kp.publicKey(),
  secret: a.kp.secret(),
  ctSkHex: toHex32(a.keys.sk),
  derivation: DERIVATION_ID,
  rootForm: a.keys.rootForm,
});

/**
 * Compare the derived `Y` and `PVK` against what `register` actually published.
 *
 * This is the check SDK.md §5.2 turns into a diagnostic rule: a `Y` mismatch
 * means the account uses a root the client does not hold, not that the
 * derivation is broken. Running it here — one read, immediately after register
 * — is what makes the browser wallet's identical check meaningful, because it
 * establishes that these two points came from the spec's derivation and not
 * from whatever the enroling script happened to compute.
 */
async function assertDerivationMatchesChain(client: ChainClient, actor: Actor): Promise<void> {
  const onChain = await client.confidentialBalance(actor.kp.publicKey());
  if (!onChain) throw new Error(`${actor.label}: register landed but the account reads back as unregistered`);

  const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
  if (!same(onChain.spendingKey, actor.keys.Y)) {
    throw new Error(
      `${actor.label}: on-chain spending_public_key does not match the derived Y — ` +
        "the enrolled root is not the one SDK.md §5.2 derives from this account's signer",
    );
  }
  if (!same(onChain.viewingPublicKey, actor.keys.PVK)) {
    throw new Error(`${actor.label}: on-chain public viewing key does not match the derived PVK`);
  }
  console.log(`    ${actor.label}: on-chain Y and PVK match the §5 derivation ✓`);
}

/**
 * Confirm a submitted transaction really landed and capture its ledger. The
 * client already polls to SUCCESS, but the ledger number is what the Archive
 * and the wallet's seam logic key on, so it is worth reading back explicitly.
 */
async function landed(
  client: ChainClient,
  hash: string,
  op: string,
  event: string,
  account: string,
  note: string,
): Promise<TxRecord> {
  const res = await client.server.getTransaction(hash);
  if (res.status !== "SUCCESS") throw new Error(`tx ${hash} (${op}) is ${res.status}, expected SUCCESS`);
  console.log(`  ✓ ${op} → ${event} @ ledger ${res.ledger} (${hash.slice(0, 12)}…) ${note}`);
  return { hash, ledger: res.ledger, op, event, account, note };
}

/**
 * Re-derive the actor's balances from on-chain events alone and re-commit them
 * against the contract's Pedersen points. `expect` asserts the plaintext the
 * replay should have recovered.
 */
async function settle(actor: Actor, expect: { spendable?: bigint; receiving?: bigint }): Promise<void> {
  const state = await actor.engine.sync();
  const check = await actor.engine.verifyAgainstChain();
  if (!check.ok) {
    throw new Error(`${actor.label}: reconstructed state does not match chain — ${JSON.stringify(check)}`);
  }
  if (expect.spendable !== undefined && state.spendable.v !== expect.spendable) {
    throw new Error(`${actor.label}: spendable ${state.spendable.v}, expected ${expect.spendable}`);
  }
  if (expect.receiving !== undefined && state.receiving.v !== expect.receiving) {
    throw new Error(`${actor.label}: receiving ${state.receiving.v}, expected ${expect.receiving}`);
  }
  console.log(`    ${actor.label}: spendable ${state.spendable.v}, receiving ${state.receiving.v} (re-committed, matches chain ✓)`);
}

async function timed<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  process.stdout.write(`  proving ${what}… `);
  const out = await fn();
  console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
  return out;
}

main().catch((e) => {
  console.error("\n❌", e);
  process.exit(1);
});
