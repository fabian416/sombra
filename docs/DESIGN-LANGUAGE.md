# Sombra Design Language — extracted from the team's Lunarys-Bridge brand

Source: `../Lunarys-Bridge/frontend` (read-only reference — tokens and composition patterns only, no markup copied). This supersedes the earlier "pure black + hsl(180 100% 50%)" reading of `globals.css`: the shipped pages are richer than the CSS variables suggest.

## Canvas

- Background: `#020617` (deep navy-black, slate-950) — NOT pure black. Space, not terminal.
- Text: white; secondary `gray-300` / `gray-400`; muted `gray-500`.

## The accent

- Brand cyan: **`#38E2FF`** — `rgba(56,226,255)` in every glow.
- Primary CTA: gradient `from-cyan-400 via-sky-400 to-blue-500`, **black text**, glow `shadow-[0_0_45px_rgba(56,226,255,0.45)]`, `hover:-translate-y-0.5`.
- Secondary accent: indigo/violet (`indigo-500/25`, `violet-500/25`) — used only in atmosphere orbs, never on controls.

## Atmosphere (stacked in this order, all `absolute` behind `z-10` content)

1. Floating orbs: ~2 per page, `h/w ≈ 440–520px`, `rounded-full`, `bg-cyan-500/20` or `bg-indigo-500/25`, `blur-[140px]`–`blur-[160px]`, offset partly off-canvas.
2. Radial wash from top: `bg-[radial-gradient(circle_at_top,rgba(56,226,255,0.12),transparent_55%)]` (bridge page pushes it to 0.25).
3. Animated constellation: particle field with connecting lines (Lunarys uses ~220 particles, maxLineDistance 200). Sombra equivalent: our own canvas starfield — thematically ours (sombra/eclipse) — implement independently.
4. Content plane: glassmorphism.

## Surfaces (glassmorphism)

- Card: `rounded-2xl border border-white/10 bg-white/5 backdrop-blur` + cyan glow shadow.
- Glow shadow family (pick by prominence): `shadow-[0_20px_60px_-28px_rgba(56,226,255,0.45)]` (subtle) → `shadow-[0_45px_140px_-80px_rgba(56,226,255,0.8)]` (hero). Everything that matters glows.
- Nav: floating pill — `rounded-full border border-white/5 bg-white/5 backdrop-blur-xl`, links `text-gray-200 hover:text-white`.
- Inputs/outline buttons: `border-white/20 bg-white/5 backdrop-blur`, hover `border-white/40 bg-white/10`.

## Type & radii

- Hero type scale: `text-4xl → sm:text-6xl → lg:text-7xl`, `leading-[1.05]`, tight tracking on wordmark.
- Radius: generous — `rounded-2xl` cards, `rounded-full` pills; base radius 0.75rem.

## Motion / cinematic pattern

- **Full-screen phase overlays** during crypto operations: fixed inset overlay on `#020617`, matrix-style text animating letter-by-letter ("Encrypting…"). 
- **Sombra application — the Recover flow**: one overlay per phase: `Deriving keys` → `Fetching checkpoint from Archive` → `Replaying N events` → `Verifying against chain` → `Funds restored`, with live counts where real. Implement our own letter-cascade animation (do not copy matrix-text.tsx).
- Micro-motion: CTAs lift on hover (`-translate-y-0.5`), arrow icons slide (`group-hover:translate-x-1.5`).

## Semantic mapping (Sombra-specific)

- Cyan `#38E2FF` = confidential/private (brand). Rationale: cyan is the chromatic complement of Stellar's yellow — deliberate contrast: private ≠ public.
- Neutral gray/white = public/on-chain.
- Violet/indigo = atmosphere only.
- Red/magenta = destructive/risk only.
- Eclipse plate: black disc + neon-cyan corona over the starfield.

## Rules

- Tokens and composition patterns from Lunarys (the team's own brand) — components, markup, and effect implementations are Sombra-original.
- All fonts/assets self-hosted; the app must render fully offline except RPC/Archive calls.
