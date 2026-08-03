import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { SombraProvider, useSombra } from "./state/SombraProvider";
import { Atmosphere } from "./components/Atmosphere";
import { Shell } from "./components/Shell";
import { Connect } from "./routes/Connect";
import { Home } from "./routes/Home";
import { SendReceive } from "./routes/SendReceive";
import { Shield } from "./routes/Shield";
import { Recover } from "./routes/Recover";
import { Swap } from "./routes/Swap";

function Router() {
  const { identity } = useSombra();

  // Everything behind the wallet is gated on a connection. There is no
  // "browse anonymously" state — every screen is about one account's funds.
  if (!identity) return <Connect />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="send" element={<SendReceive />} />
        <Route path="shield" element={<Shield />} />
        <Route path="recover" element={<Recover />} />
        <Route path="swap" element={<Swap />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <HashRouter>
      <SombraProvider>
        <Atmosphere />
        <Router />
      </SombraProvider>
    </HashRouter>
  );
}
