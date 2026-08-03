import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ConfidentialBalance,
  PublicBalance,
  ShieldedBalance,
  SombraClient,
  WalletIdentity,
} from "../lib/client";
import { DEMO_ADDRESS, MockSombraClient } from "../lib/mockClient";
import { LiveSombraClient } from "../lib/liveClient";
import { restoreSession } from "../lib/freighter";

export const ARCHIVE_URL: string =
  import.meta.env.VITE_ARCHIVE_URL ?? "http://localhost:8787";

export type ClientMode = "mock" | "live";

/**
 * `live` runs sombra-kit against the real Archive, the real RPC and the real
 * contract; `mock` is the scripted stand-in. Both env names are accepted
 * because `.env.example` shipped one and the build scripts use the other, and a
 * flag that silently ignores the spelling you used is worse than either.
 *
 * The default stays `mock`: live mode needs a registered account on
 * `VITE_CT_CONTRACT_ID` and a reachable Archive, and a visitor who has neither
 * should get the demo rather than an error page.
 */
const REQUESTED_MODE =
  import.meta.env.VITE_CLIENT_MODE ?? import.meta.env.VITE_SOMBRA_CLIENT;

export const CLIENT_MODE: ClientMode = REQUESTED_MODE === "live" ? "live" : "mock";

/** The one place an implementation is chosen. */
function createClient(mode: ClientMode): SombraClient {
  return mode === "live" ? new LiveSombraClient(ARCHIVE_URL) : new MockSombraClient();
}

interface Balances {
  public: PublicBalance | null;
  confidential: ConfidentialBalance | null;
  shielded: ShieldedBalance | null;
}

interface SombraContextValue {
  client: SombraClient;
  identity: WalletIdentity | null;
  connecting: boolean;
  connectError: string | null;
  connect: () => Promise<void>;
  /** Open the wallet on demo data, for anyone without Freighter installed. */
  enterPreview: () => void;
  preview: boolean;
  disconnect: () => void;
  balances: Balances;
  loadingBalances: boolean;
  refresh: () => Promise<void>;
  /** False after a wipe: the openings are gone and recovery is the only path. */
  hasLocalState: boolean;
  wipeLocalState: () => void;
}

const SombraContext = createContext<SombraContextValue | null>(null);

const EMPTY: Balances = { public: null, confidential: null, shielded: null };

export function SombraProvider({ children }: { children: ReactNode }) {
  const client = useMemo<SombraClient>(() => createClient(CLIENT_MODE), []);
  const [identity, setIdentity] = useState<WalletIdentity | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [balances, setBalances] = useState<Balances>(EMPTY);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [hasLocalState, setHasLocalState] = useState(() =>
    client.hasLocalState(),
  );

  const refresh = useCallback(async () => {
    setLoadingBalances(true);
    try {
      const [pub, conf, shielded] = await Promise.all([
        client.getPublicBalance(),
        client.getConfidentialBalance(),
        client.getShieldedBalance(),
      ]);
      setBalances({ public: pub, confidential: conf, shielded });
      setHasLocalState(client.hasLocalState());
    } finally {
      setLoadingBalances(false);
    }
  }, [client]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const next = await client.connectFreighter();
      setIdentity(next);
      await refresh();
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Freighter didn't respond.",
      );
    } finally {
      setConnecting(false);
    }
  }, [client, refresh]);

  const enterPreview = useCallback(() => {
    setPreview(true);
    setConnectError(null);
    const previewIdentity: WalletIdentity = {
      address: DEMO_ADDRESS,
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
    };
    setIdentity(previewIdentity);
    client.adoptIdentity?.(previewIdentity);
    refresh().catch((err: unknown) => {
      setConnectError(err instanceof Error ? err.message : "Could not read balances.");
    });
  }, [client, refresh]);

  const disconnect = useCallback(() => {
    setIdentity(null);
    setPreview(false);
    setBalances(EMPTY);
  }, []);

  const wipeLocalState = useCallback(() => {
    client.wipeLocalState();
    setHasLocalState(false);
    void refresh();
  }, [client, refresh]);

  // Pick the session back up silently if Freighter already trusts this origin,
  // so a reload mid-demo doesn't cost a click. Runs once, and never overrides a
  // session the person has already chosen.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    let cancelled = false;
    void restoreSession().then((session) => {
      if (cancelled || !session) return;
      setIdentity((current) => (current ? current : session));
      client.adoptIdentity?.(session);
      refresh().catch((err: unknown) => {
        setConnectError(err instanceof Error ? err.message : "Could not read balances.");
      });
    });
    return () => {
      cancelled = true;
    };
  }, [client, refresh]);

  const value = useMemo<SombraContextValue>(
    () => ({
      client,
      identity,
      connecting,
      connectError,
      connect,
      enterPreview,
      preview,
      disconnect,
      balances,
      loadingBalances,
      refresh,
      hasLocalState,
      wipeLocalState,
    }),
    [
      client,
      identity,
      connecting,
      connectError,
      connect,
      enterPreview,
      preview,
      disconnect,
      balances,
      loadingBalances,
      refresh,
      hasLocalState,
      wipeLocalState,
    ],
  );

  return (
    <SombraContext.Provider value={value}>{children}</SombraContext.Provider>
  );
}

export function useSombra(): SombraContextValue {
  const ctx = useContext(SombraContext);
  if (!ctx) throw new Error("useSombra must be used inside <SombraProvider>.");
  return ctx;
}
