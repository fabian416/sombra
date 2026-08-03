/**
 * Deploy a fresh confidential token to Stellar testnet, owned by Sombra.
 *
 * Why a fresh deployment rather than reusing the demo's: the Sombra Archive
 * claims to hold an account's *full* history, and it can only do that by
 * construction if it starts ingesting at the contract's own deploy ledger.
 * Attaching to a token deployed months ago would leave a permanent hole — RPC
 * retains ~7 days, so the older events are simply unobtainable.
 *
 * Steps, mirroring the upstream demo's documented deploy procedure:
 *   1. Fresh deployer keypair, funded by friendbot.
 *   2. Native XLM Stellar Asset Contract as the underlying SEP-41 asset.
 *   3. Deploy verifier + auditor, then the token (its constructor wires them).
 *   4. Register all six circuit verification keys in the verifier.
 *   5. Register one auditor Grumpkin key at id 0.
 *   6. Assert the contract's stored address-as-field matches the SDK's
 *      `addressToField(token)` — if Poseidon2 diverged, every register proof
 *      would be rejected on-chain and this is where we find out.
 *   7. Write deployment.json (public) and .demo-keys.json (secret, gitignored).
 *
 * Usage: npm run deploy
 */

import { Keypair, xdr, Address } from "@stellar/stellar-sdk";
import {
  ChainClient,
  keypairSigner,
  addressToField,
  randomScalar,
  toHex32,
  fromBytesBE,
  scalarMul,
  pointToBytes,
  H,
  CIRCUIT_TYPE,
} from "@ctd/sdk";

import {
  AUDITOR_ID,
  NETWORK,
  PASSPHRASE,
  RPC_URL,
  DEPLOYMENT_FILE,
  KEYS_FILE,
  friendbotFund,
  readVk,
  saveDeployment,
  saveKeys,
  stellar,
  stellarSoft,
  wasmPath,
  type Deployment,
} from "./common.js";
import { keyDerivationRecord } from "./derive.js";

/** vk.bin basename → the `CircuitType` discriminant the verifier stores it under. */
const VK_FILES: ReadonlyArray<[string, number]> = [
  ["register", CIRCUIT_TYPE.Register],
  ["withdraw", CIRCUIT_TYPE.Withdraw],
  ["transfer", CIRCUIT_TYPE.Transfer],
  ["spender_transfer", CIRCUIT_TYPE.SpenderTransfer],
  ["set_spender", CIRCUIT_TYPE.SetSpender],
  ["revoke_spender", CIRCUIT_TYPE.RevokeSpender],
];

/** Deploy a WASM with the CLI and return the contract id. */
function deployContract(deployerSecret: string, wasm: string, ctorArgs: string[]): string {
  const out = stellar([
    "contract",
    "deploy",
    "--wasm",
    wasm,
    "--source",
    deployerSecret,
    "--network",
    NETWORK,
    "--",
    ...ctorArgs,
  ]);
  const id = out.split(/\s+/).filter(Boolean).pop();
  if (!id?.startsWith("C")) throw new Error(`unexpected deploy output: ${out}`);
  return id;
}

async function main(): Promise<void> {
  const deployer = Keypair.random();
  console.log(`deployer = ${deployer.publicKey()}`);
  await friendbotFund(deployer.publicKey());

  // The native SAC is normally already deployed on testnet; asking for it again
  // is harmless and makes a fresh network work too.
  stellarSoft(["contract", "asset", "deploy", "--asset", "native", "--source", deployer.secret(), "--network", NETWORK]);
  const underlying = stellar(["contract", "id", "asset", "--asset", "native", "--network", NETWORK]);
  console.log(`underlying (native SAC) = ${underlying}`);

  const verifier = deployContract(deployer.secret(), wasmPath("confidential_verifier"), [
    "--admin", deployer.publicKey(),
    "--manager", deployer.publicKey(),
  ]);
  console.log(`verifier = ${verifier}`);

  const auditor = deployContract(deployer.secret(), wasmPath("confidential_auditor"), [
    "--admin", deployer.publicKey(),
    "--manager", deployer.publicKey(),
  ]);
  console.log(`auditor  = ${auditor}`);

  const client = new ChainClient({
    rpcUrl: RPC_URL,
    networkPassphrase: PASSPHRASE,
    contracts: { token: "", verifier, auditor },
  });
  // Captured before the deploy lands, so the token's own construction events are
  // guaranteed to be at or after it — a safe floor for an Archive backfill.
  const ledgerBeforeToken = await client.latestLedger();

  const token = deployContract(deployer.secret(), wasmPath("confidential_token"), [
    "--underlying_asset", underlying,
    "--verifier", verifier,
    "--auditor", auditor,
  ]);
  client.cfg.contracts.token = token;
  console.log(`token    = ${token}`);

  const signer = keypairSigner(deployer.secret(), PASSPHRASE);

  for (const [name, circuitType] of VK_FILES) {
    const vk = readVk(name);
    await client.invoke(
      verifier,
      "register_verification_key",
      [
        xdr.ScVal.scvU32(circuitType),
        xdr.ScVal.scvBytes(Buffer.from(vk)),
        new Address(deployer.publicKey()).toScVal(),
      ],
      signer,
    );
    console.log(`  registered vk ${name} (circuit ${circuitType}, ${vk.length}B)`);
  }

  // K_aud = a·H. The auditor persona is not part of the Sombra demo, but the
  // token requires a registered auditor id for every confidential operation.
  const auditorSecret = randomScalar();
  await client.invoke(
    auditor,
    "register_key",
    [
      xdr.ScVal.scvU32(AUDITOR_ID),
      xdr.ScVal.scvBytes(Buffer.from(pointToBytes(scalarMul(auditorSecret, H)))),
      new Address(deployer.publicKey()).toScVal(),
    ],
    signer,
  );
  console.log(`  registered auditor key id ${AUDITOR_ID}`);

  const sdkAddrF = addressToField(token);
  const onChain = await readAddressAsField(client, ledgerBeforeToken);
  if (onChain === null) {
    throw new Error("no address_as_field_set event found — cannot confirm Poseidon2 parity");
  }
  if (onChain.addrF !== sdkAddrF) {
    throw new Error(
      `addr_f MISMATCH — SDK ${toHex32(sdkAddrF)} != contract ${toHex32(onChain.addrF)}; ` +
        "Poseidon2 implementations diverge and register proofs would be rejected",
    );
  }
  console.log(`  addr_f parity OK: ${toHex32(sdkAddrF)}`);
  console.log(`  token created in ledger ${onChain.ledger}`);

  const deployment: Deployment = {
    network: NETWORK,
    rpcUrl: RPC_URL,
    networkPassphrase: PASSPHRASE,
    contractId: token,
    deployLedger: onChain.ledger,
    deployerPublic: deployer.publicKey(),
    primaryAccountPublic: null,
    secondaryAccountPublic: null,
    txHashes: [],
    contracts: { token, verifier, auditor, underlying },
    auditorId: AUDITOR_ID,
    addrF: toHex32(sdkAddrF),
    keyDerivation: keyDerivationRecord(token),
    notes: [
      "Fresh deployment so the Sombra Archive can hold full history by construction: " +
        `start ingestion at ledger ${onChain.ledger}.`,
      "History has not been created yet — run `npm run history`.",
    ],
  };
  saveDeployment(deployment);
  saveKeys({
    deployer: { public: deployer.publicKey(), secret: deployer.secret() },
    auditor: { id: AUDITOR_ID, secretHex: toHex32(auditorSecret) },
  });

  console.log(`\nwrote ${DEPLOYMENT_FILE}`);
  console.log(`wrote ${KEYS_FILE} (secret — gitignored)`);
}

/**
 * Find the token's `address_as_field_set` construction event: it confirms the
 * contract's Poseidon2 agrees with the SDK's and pins the exact deploy ledger.
 */
async function readAddressAsField(
  client: ChainClient,
  fromLedger: number,
): Promise<{ addrF: bigint; ledger: number } | null> {
  // The typed `fetchEvents` skips config events, so scan raw. One page is
  // enough: the event fires during construction, right after `fromLedger`.
  const resp = await client.server.getEvents({
    startLedger: fromLedger,
    filters: [{ type: "contract", contractIds: [client.cfg.contracts.token] }],
    limit: 50,
  });
  for (const ev of resp.events) {
    if (ev.topic[0]?.sym().toString() !== "address_as_field_set") continue;
    for (const entry of ev.value.map() ?? []) {
      if (entry.key().sym().toString() === "address_as_field") {
        return { addrF: fromBytesBE(new Uint8Array(entry.val().bytes())), ledger: ev.ledger };
      }
    }
  }
  return null;
}

main().catch((e) => {
  console.error("\n❌", e);
  process.exit(1);
});
