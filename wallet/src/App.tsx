import { SombraProvider, useSombra } from "./state/SombraProvider";
import { Connect } from "./routes/Connect";

function Router() {
  const { identity } = useSombra();
  if (!identity) return <Connect />;
  return <Connect />;
}

export function App() {
  return (
    <SombraProvider>
      <div className="horizon-glow" aria-hidden />
      <Router />
    </SombraProvider>
  );
}
