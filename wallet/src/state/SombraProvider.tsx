import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { MockSombraClient } from "../lib/mockClient";
import { restoreSession } from "../lib/freighter";

export const ARCHIVE_URL: string =
  import.meta.env.VITE_ARCHIVE_URL ?? "http://localhost:3001";

/** Only "mock" ships today; "live" lands when sombra-kit is wired. */
export const CLIENT_MODE: string = import.meta.env.VITE_SOMBRA_CLIENT ?? "mock";

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
  const client = useMemo<SombraClient>(() => new MockSombraClient(), []);
  const [identity, setIdentity] = useState<WalletIdentity | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
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

  const disconnect = useCallback(() => {
    setIdentity(null);
    setBalances(EMPTY);
  }, []);

  const wipeLocalState = useCallback(() => {
    client.wipeLocalState();
    setHasLocalState(false);
    void refresh();
  }, [client, refresh]);

  // Pick the session back up silently if Freighter already trusts this origin,
  // so a reload mid-demo doesn't cost a click.
  useEffect(() => {
    let cancelled = false;
    void restoreSession().then((session) => {
      if (cancelled || !session) return;
      setIdentity(session);
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const value = useMemo<SombraContextValue>(
    () => ({
      client,
      identity,
      connecting,
      connectError,
      connect,
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
