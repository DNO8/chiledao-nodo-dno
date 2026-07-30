# Proposal: ChileDAO Nodo DNO — evidence-first cooperative website

## Intent

The two existing community sites fail the same test: neither proves the
ChileDAO precooperative operates. `Chiledao-Micoh-node` illustrates Chile with
stock landscape photos (`peter_mcnally-mountain-8412880.jpg`).
`landing_ChileDAO` carries all the substance — 9 strategic objectives, 8
execution milestones, 9 services, 14 members, 5 institutional partners — but
has no imagery at all, and its `testimonios` section is entirely commented out.
Meanwhile 7.6 GB of real material exists: 19 event flyers, 391 photos and 89
videos of actual workshops, bootcamps and hackathons.

The strongest verifiable claim is already written down and unillustrated: three
hackathons co-organized with named institutions (Web3 Chile with Campus On
Chain, Vendimia Tech Chile with Open Beauchef and Vendimia Tech, Dev3Pack Chile
with USACH and Dev3Pack). This change pairs that record with the visual proof.

## Scope

### In Scope

- Astro site with Tailwind, React islands only where interaction demands it
- Design tokens extracted from `Chiledao-Micoh-node/assets/styles.css`
- Narrative sections reusing `landing_ChileDAO` copy architecture
- Curated material: max 40 photos, max 5 videos, supplied by the user
- Build-time image optimization to AVIF/WebP via `astro:assets`
- Two separate credibility tiers, never merged: `alianzas` (the 5 named
  institutional partners) and `protocolos` (chains we teach: Avalanche,
  Stellar, Polkadot)
- Deploy to Vercel

### Out of Scope

- Supabase (deferred: 1 GB cap, 50 MB upload limit, pausing on inactivity)
- GSAP (deferred until the ported vanilla scrollytelling proves insufficient)
- The `ImageSpotlight` component (blurs content on touch devices)
- CMS, i18n, wallet connection, on-chain features
- Migrating or deprecating either existing repository

## Capabilities

### New Capabilities

- `design-system`: tokens, typography scale, layout primitives
- `asset-pipeline`: naming convention, manifest, optimization, budgets
- `landing-narrative`: section order and the evidence each section carries
- `media-gallery`: curated photo gallery as a React island

### Modified Capabilities

- None. This is a new repository.

## Approach

Astro ships zero JS by default; the site is ~95% static copy, so only the
gallery hydrates. Critical assets live in the repo so Astro fingerprints and
optimizes them and Vercel's CDN serves them — no external egress quota, no
dependency that can pause. Long-form video goes to YouTube with a lazy facade.
Micoh-node's scrollytelling is already vanilla JS plus CSS sticky; it is ported
as Astro components with inline scripts rather than rebuilt in React.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `chiledao-nodo-dno/` | New | Entire repository |
| `src/styles/tokens.css` | New | Tokens ported from Micoh-node |
| `src/content/` | New | Curated material + manifest |
| Existing repos | Unchanged | Read-only references |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Overclaiming partnerships: flyers show bootcamps *about* Avalanche/Polkadot, not partnerships *with* them. Placing those logos under "alianzas" fabricates institutional endorsement | High | Chain logos appear only under "protocolos que enseñamos", visually distinct from `alianzas`, which lists only the 5 entities with documented agreements |
| Claiming cooperative status while legally a precooperative (milestone 01: DAES/SII pending) | Med | Copy says "precooperativa" until the legal flow closes |
| Filename encoding breaks builds (NFC/NFD, `.JPG` case, spaces) | High | Normalize to ASCII kebab-case with an auditable old-to-new mapping before any reference |
| Hero video inflates LCP | Med | Budget 3 MB, muted loop, `poster` fallback, `preload="none"` |
| Motion causes vestibular discomfort | Med | Honor `prefers-reduced-motion` in every animated component |
| Vercel Hobby forbids commercial use | Med | Confirm plan before promoting advisory services |

## Rollback Plan

New repository with no consumers: revert the PR, or delete the deployment.
Neither existing site is touched, so both remain live throughout.

## Dependencies

- Curated material delivered by the user (40 photos, 5 videos)
- Vercel project
- Node 20+, `sharp` (bundled with `astro:assets`)

## Success Criteria

- [ ] All 5 institutional partners appear under `alianzas`; no chain logo does
- [ ] Zero stock photography
- [ ] No image over 300 KB; total initial payload under 1.5 MB
- [ ] Lighthouse performance and accessibility both at or above 90 on mobile
- [ ] Site renders and is navigable with JavaScript disabled
- [ ] `prefers-reduced-motion` disables all non-essential motion
