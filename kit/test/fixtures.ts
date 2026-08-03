/**
 * Fixture loading for the conformance suite.
 *
 * SDK.md §6.1 is explicit that a test suite MUST **read** `testdata/*.json`
 * rather than transcribe the values into source, "so that a change to the Noir
 * library's `print_fixtures` output becomes a test failure rather than a silent
 * divergence". So this module does exactly one thing: find the directory and
 * parse the files. No expected value appears anywhere in `kit/`.
 *
 * The directory lives in the sibling `stellar-contracts` clone, which is
 * reference material and never vendored (README.md). If it is missing the
 * suite fails loudly rather than skipping — a silently skipped conformance
 * suite is worse than none, since it reports green.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `kit/test` → `sombra/kit` → `sombra` → the clone root. Overridable so CI can
 * point at a checkout in a different layout.
 */
export const TESTDATA_DIR = resolve(
  process.env.CT_TESTDATA_DIR ??
    join(
      HERE,
      "..",
      "..",
      "..",
      "stellar-contracts",
      "packages",
      "tokens",
      "src",
      "confidential",
      "circuits",
      "lib",
      "testdata",
    ),
);

export interface Fixture<I = Record<string, unknown>, O = unknown> {
  primitive: string;
  design_doc_refs?: string[];
  description: string;
  vectors: { inputs: I; output: O }[];
}

export function testdataAvailable(): boolean {
  return existsSync(TESTDATA_DIR);
}

/** Every fixture file name in the directory, sorted. Drives the coverage test. */
export function fixtureNames(): string[] {
  return readdirSync(TESTDATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function loadFixture<I = Record<string, unknown>, O = unknown>(
  name: string,
): Fixture<I, O> {
  const path = join(TESTDATA_DIR, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `conformance fixture ${name}.json not found at ${path}. ` +
        "The sibling stellar-contracts clone is required to run this suite; " +
        "set CT_TESTDATA_DIR to override the location.",
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Fixture<I, O>;
}

/** Fixture scalars are `0x`-prefixed hex; points are `{x, y}` of the same. */
export function fx(hex: string): bigint {
  return BigInt(hex);
}

export function fxPoint(p: { x: string; y: string }): { x: bigint; y: bigint } {
  return { x: fx(p.x), y: fx(p.y) };
}
