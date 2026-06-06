# Nordflo Systems — Premium Himling Website

## Client
Nordflo Systems (Ingus Sapiega)
Org: 927933330

## Objective
Dominate Google Norway for himling-related searches with a premium luxury website that converts visitors to leads.

## Source Brief
Ingus' 27-section prompt (2026-05-16) covering design, SEO, content, and conversion requirements.

## Status: BUILD COMPLETE — AWAITING INGUS DATA
- [x] Brief received and analyzed
- [x] Gap analysis vs existing v4 (different product — new build required)
- [x] Execution plan drafted (8 phases)
- [x] Research: competitors, keywords, design (3 reports in research/)
- [x] Phase 1: Foundation + design system
- [x] Phase 2: Home page (10 sections)
- [x] Phase 3: Core pages (om-oss, produkter, kontakt, hvorfor-oss)
- [x] Phase 4: Portfolio + blog engine
- [x] Phase 5: 8 SEO landing pages (8000+ words)
- [x] Phase 6: 8 blog articles (13 000+ words)
- [x] Phase 7: SEO infrastructure + performance
- [x] Phase 8: Local SEO + launch prep
- [ ] Ingus NAP data (phone, email, address)
- [ ] Real project photos
- [ ] og-image.jpg (1200x630)
- [ ] Contact form backend
- [ ] Deploy

## Deliverables
- 66 files, 32 static pages, clean build (87 kB shared JS)
- Location: orgs/westside-hq/agents/nordflo-dev/deliverables/nordflo-himling/

## Critical Research Findings
1. **nordflo.eu already has "tekstil himling" in nav — but it 404s!** Fixing this alone = instant SEO win
2. **"Tekstil himling" is uncontested** — no Norwegian company owns this keyword
3. **No competitor has strong visual content** — Nordflo can dominate with quality design
4. **Content gap: pricing guide** — "hva koster himling per m2" has NO good Norwegian result
5. **Recommended stack addition**: Aceternity UI components (Spotlight, Hero Parallax, 3D Card, Text Generate)
6. **Animation budget**: max 3 Framer Motion effects per viewport to maintain 95+ PageSpeed

## Key Decisions

| Decision | Status | Choice |
|----------|--------|--------|
| Stack | Decided | Next.js 14 + Tailwind + Framer Motion |
| Domain | Pending | Research nordflo.eu current state |
| Hosting | Recommended | Vercel (SSR/ISR native, edge, analytics) |
| Content source | Decided | AI-draft → Ingus review |
| Images | Pending | Need Ingus/Nordflo project photos |
| Monolith site | Decided | Keep separate (different product) |

## Team
- **kaptein**: Project management, research, coordination
- **nordflo-dev**: Build, deploy, technical execution
- **Max**: Oversight, client relationship
- **Ingus**: Domain expert, content review, final approval

## Phases
1. Foundation + Design System (~2d)
2. Home Page — 10 sections (~2d)
3. Core Pages: About, Products, Contact, Why Us (~3d)
4. Portfolio + Blog Engine (~2d)
5. SEO Landing Pages x8 (~3d)
6. Blog Content x8 (~2d)
7. SEO Infrastructure + Performance (~2d)
8. Local SEO + Launch (~1d)

## Questions for Ingus
- [ ] Do you have project photos we can use? (installations, before/after, team)
- [ ] Google Business Profile — do you have login? Or should we set up?
- [ ] Current nordflo.eu — keep, redirect, or replace?
- [ ] Any specific client testimonials to feature?
- [ ] NAP details: exact address, phone, email for consistency

## Files
- `research/` — competitor analysis, SEO keyword data, domain research
- `design/` — color palette, typography, component specs
- `content/` — page copy drafts, blog articles
- `seo/` — keyword mapping, schema templates, meta strategy
- `assets/` — images, videos, brand assets
- `deliverables/` — build output, deployment artifacts
