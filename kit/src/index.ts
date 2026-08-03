/**
 * sombra-kit — the recovery engine for Stellar Confidential Token accounts.
 *
 * Reconstructing a spendable commitment opening from a signer plus a durable
 * event archive, with the result verified against on-chain state. Scoped
 * deliberately: **no proving.** DESIGN.md §5.2 steps 1–7 need a checkpoint
 * lookup, two Poseidon2 hashes, an ECDH per incoming transfer, field addition
 * and two Pedersen re-commitments — no circuit, no witness, no bb.js, no WASM.
 * Creating history needs proofs; recovering it does not. That is what lets this
 * package run in a browser with no bundler archaeology.
 *
 * Everything here is original work built against the published specifications
 * (`DESIGN.md`, `DESIGN_cont.md`, `SDK.md`, `INDEXER.md`), with `@noble/curves`,
 * `@noble/hashes` and `@zkpassport/poseidon2` as the only runtime dependencies.
 * Every primitive is pinned byte-for-byte against the language-agnostic
 * fixtures in `circuits/lib/testdata/`, read at test time rather than
 * transcribed, as SDK.md §6.1 requires.
 *
 * The usual entry point is {@link recoverFromSigner}.
 */

// ---------------------------------------------------------------- primitives
export {
  FR,
  FQ,
  VALUE_BOUND,
  assertCanonicalFr,
  bytesEqual,
  concatBytes,
  fqAdd,
  fqMod,
  frAdd,
  frMod,
  frSub,
  fromBytesBE,
  fromBytesLE,
  fromHex,
  hexToBigInt,
  isCanonicalFr,
  toBytes4LE,
  toBytes32BE,
  toHex,
  toHex32,
} from "./crypto/field.js";

export {
  G,
  H,
  IDENTITY,
  type EcdhRule,
  type Point,
  assertOnCurve,
  commit,
  ecdh,
  isIdentity,
  isOnCurve,
  pointAdd,
  pointFromBytes,
  pointNegate,
  pointToBytes,
  pointsEqual,
  publicViewingKey,
  scalarMul,
  spendingPublicKey,
} from "./crypto/grumpkin.js";

export {
  DOMAIN,
  decryptAmount,
  decryptBalance,
  deriveAllowR,
  deriveEphemeralScalar,
  deriveSpendR,
  deriveTransferBlinding,
  dvkFromVkOp,
  encryptAllowance,
  encryptAmount,
  encryptAuditorSenderBalance,
  encryptBalance,
  encryptEscrowedDvk,
  poseidonWithDomain,
  sponge,
  spongeSqueeze2,
  vkFromSk,
} from "./crypto/poseidon2.js";

export {
  type AddressKind,
  type DecodedStrkey,
  addressToField,
  decodeStrkey,
  encodeStrkey,
  isValidStrkey,
} from "./crypto/address.js";

// -------------------------------------------------------------------- keys
export {
  type ConfidentialKeys,
  type DerivationContext,
  type MessageSigner,
  type RootForm,
  type SignerDerivationOptions,
  SIGNER_MESSAGE_LENGTH,
  SIGNING_KEY_DISCLOSURE,
  SEP53_PREFIX,
  SK_LABEL,
  deriveKeysFromEd25519Secret,
  deriveKeysFromRawRoot,
  deriveKeysFromRoot,
  deriveKeysFromSigner,
  ed25519Signer,
  keysFromSpendingKey,
  sep53Digest,
  signerMessage,
} from "./keys.js";

// ------------------------------------------------------------------- events
export {
  type ConfidentialEvent,
  type ConfidentialEventType,
  type CheckpointPayload,
  type EventPosition,
  type IncomingTransferPayload,
  type RawEvent,
  CHECKPOINT_TYPES,
  EVENT_SPEC,
  RECOVERY_EVENT_TYPES,
  UnknownEventType,
  checkpointPayload,
  compareEvents,
  creditsAccount,
  decodeEvent,
  decodeEvents,
  dedupeEvents,
  depositAmount,
  eventSalt,
  incomingTransferPayload,
  isCheckpointFor,
  isConfidentialEventType,
  isSelfTransfer,
  participant,
  registerAuditorId,
  sortEvents,
} from "./events.js";

// ------------------------------------------------------------------- replay
export {
  type OnChainAccount,
  type Opening,
  type ReplayAnchor,
  type ReplayInput,
  type ReplayResult,
  type VerificationResult,
  ZERO_OPENING,
  findLatestCheckpoint,
  replay,
  resolveT0,
  verifyAgainstChain,
  verifySpendingKey,
} from "./replay.js";

// ------------------------------------------------------------------ sources
export {
  type ArchiveCoverage,
  type ArchiveHealth,
  type CheckpointResponse,
  type EventPage,
  type HistoryQuery,
  type LedgerRange,
  ArchiveClient,
  ArchiveError,
} from "./archive.js";

export {
  type GetEventsQuery,
  type RpcHealth,
  RpcClient,
  RpcError,
  positionOfRpcEvent,
} from "./chain.js";

export {
  type Seam,
  type SeamOptions,
  type SyncLeg,
  type SyncOptions,
  type SyncRequest,
  type SyncResult,
  DEFAULT_SEAM_MARGIN,
  IncompleteHistoryError,
  SeamNotCoveredError,
  computeSeam,
  syncAccountHistory,
} from "./seam.js";

// ----------------------------------------------------------------- recovery
export {
  type RecoverOptions,
  type RecoveryPhase,
  type RecoveryProgress,
  type RecoveryResult,
  type RestoredBalance,
  RecoveryError,
  recoverFromSigner,
  recoverWithKeys,
} from "./recover.js";

// ---------------------------------------------------------------------- xdr
export {
  type ScVal,
  type ScMapEntry,
  type ContractDataEntry,
  accountEntryKey,
  contractDataLedgerKey,
  decodeContractDataEntry,
  decodeScVal,
  encodeScVal,
  scAddress,
  scBytes,
  scInt,
  scMapFields,
  scSymbol,
  scU32,
} from "./xdr/scval.js";

export { base64Decode, base64Encode, XdrReader, XdrWriter } from "./xdr/codec.js";
