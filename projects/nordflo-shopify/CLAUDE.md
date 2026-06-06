# Nordflo Shopify — Prosjektbrief

## Hva er dette

Nordflo (nordflo.eu) selger Monolith mikrosement og tekstil-himling via Shopify. Eier: Ingus. Max (WDA) hjelper med nettside-forbedring og content-strategi.

## Pivot-beslutning (20. mai 2026)

Opprinnelig plan var ny standalone-side. Endret til: **forbedre eksisterende nordflo.eu Shopify-butikk**. Shopify-tilgang trengs for kode-review og endringer.

## Produktet — Monolith mikrosement

- Produsent: Loggia Industria Vernici (Italia)
- Teknologi: LCS (Loggia Carbon System) med karbon-nanorør (CNT) — énkomponent, bruksklart
- 4-lags system: primer → base (2 lag) → finish + PU-lakk
- Nordflo er ENESTE leverandør som inkluderer glassfibernett + 2K PU-lakk i alle pakker
- Pris: 850 kr/m² (premium-segment, konkurrenter 275-900+ kr/m²)

## Hovedfunn fra research (3059 linjer i research/)

### Kritiske mangler på nåværende side
1. **Null kundeanmeldelser** — for produkter til 17-53k kr er dette tillitsbrudd (5+ reviews = 270% høyere konvertering)
2. **Pakkenavn villeder** — "4 m² pakke" dekker faktisk 21 m². Kundene tror de kjøper for 4 m²
3. **Ingen mengdekalkulator** — kunden vet ikke hvilken pakke de trenger
4. **Ingen video i kjøpsflyten** — videoer mangler helt fra produktsider (Cemento har YouTube men IKKE embedded i butikk)
5. **Kognitiv overload** — pakker (50k kr) og enkeltprodukter (400 kr) blandet i samme grid
6. **Frykten for feil ikke adressert** — DIY-guiden er i bloggen, ikke på produktsidene

### Hva Nordflo kan eie
- Embedded video direkte i produktsiden (ingen norsk konkurrent gjør dette)
- "Alt inkludert"-badge (glassfibernett + PU-lakk i ALLE pakker)
- LCS/CNT teknologi-differensiering
- Norsk support under påføring
- Transparent totalpris (ikke "fra X kr" + skjulte tillegg)

### Konkurranselandskap
- Cemento = hovedkonkurrent i Norge, har YouTube men abandonert siden 2022
- 10 produkter sammenlignet (se research/product-comparison.md)
- Nordflo er premium men har sterkest "alt inkludert"-konsept

## Content-plan — 3 leveranser (oppdatert 21. mai)

Se filming-plan.md for fullstendig plan. Tre leveranser:
1. **PDF** — superdetaljert tutorial med dos/donts (som New Design sin, men bedre)
2. **Tutorial-video** — følger PDF-stiene (referanse: New Design 4:04 visuell)
3. **Brand-video** — presenter-stil à la Loggia (referanse: Giacomo 5:04)

Seedance 2.0 / Higgsfield vurderes for lifestyle/mood-shots. Planlegges med Max.
Filming helgen 24-25. mai, pre-staging paneler onsdag-torsdag.

## Filer i workspace

| Fil | Innhold |
|-----|---------|
| research/nordflo-complete-research.md | Alt samlet (3059 linjer) — browser-audit, UX, produkt, YouTube, content, psykologi |
| research/ux-research.md | UX best practices + filming-plan + benchmarks |
| research/product-comparison.md | Monolith deep-dive + 10 konkurrenter + 5 pakker |
| research/cemento-youtube-deep-dive.md | Cemento YouTube kanal-analyse |
| research/organic-content-analysis.md | Organisk content, USA/EU suksesser |
| research/ecommerce-design-psychology.md | Konverteringspsykologi, kognitiv load |
| audit/browser-audit.md | Side-for-side gjennomgang av 30 URLer |
| filming-plan.md | Content-plan: 3 leveranser, referanseanalyse, pre-staging, filming-helg |

## Hva som gjenstår

1. **Shopify-tilgang** — hente tema-kode (shopify theme pull)
2. **Kode-review** — gå gjennom Liquid/CSS/JS, identifiser endringer
3. **Implementere endringer** — basert på research-funn
4. **Filme videoer** — helgen 24-25. mai
5. **Legge inn video** — embedded i produktsider
