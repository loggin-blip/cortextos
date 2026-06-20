# Design Research Brief -- Nordflo Himling

## Reference Websites

1. **Norm Architects** (normcph.com) -- Light minimalism, massive whitespace, sans-serif type, content-first grid. Photography carries the brand. Navigation almost invisible.
2. **Snohetta** (snohetta.com) -- Dark/light toggle, full-bleed project tiles, modular grid, performance-conscious (simplified/low-res modes). Clean sans-serif hierarchy.
3. **Claesson Koivisto Rune** (claessonkoivistorune.se) -- Full-viewport hero image, zero visible UI chrome. Imagery IS the interface.
4. **Lund Hagem** (lundhagem.no) -- Minimal horizontal nav, high-res responsive images via imgix, professional restraint. Modern browser requirement signals tech confidence.

**Common pattern:** All four treat photography as the primary design element. Navigation is quiet. Typography is sans-serif with generous spacing. No decorative clutter.

## Design Patterns for Nordflo

**Color (from brief):** Matte Black #121212 base, Dark Grey #1E1E1E cards, Charcoal #2A2A2A elevated surfaces, Warm White #F8F8F8 text, Gold #D4AF37 accents. Use gold sparingly -- CTAs, hover states, dividers, active nav indicators only.

**Typography:** Montserrat 600/700 for headings (wide letter-spacing), Inter 400 for body. Large heading sizes (clamp-based fluid type). Generous line-height (1.6-1.8 body).

**Layout:** Full-bleed hero sections. 12-column grid with max-w-7xl container. Asymmetric image/text splits (60/40). Vertical rhythm via consistent spacing scale.

**Glassmorphism:** Reserve for floating nav bar and quote-request modal. backdrop-blur-xl + bg-white/5 + border border-white/10. Do not overuse -- one glass layer per viewport.

**Animation (Framer Motion):**
- Hero: parallax layers via useScroll + useTransform (background 0.3x, foreground 1.2x speed)
- Sections: scroll-triggered fade-up with staggerChildren (0.1s delay per item)
- Gold hover: scale(1.02) + boxShadow with #D4AF37 glow on project cards
- Text: TextGenerateEffect for hero headline reveal
- Page transitions: AnimatePresence with opacity + y-translate

## Recommended Component Libraries

1. **Aceternity UI** (ui.aceternity.com) -- Best fit. Spotlight, Hero Parallax, Aurora Background, 3D Card Effect, Glare Card, Sticky Scroll Reveal, Text Generate Effect. Free tier covers all needs. Built on Framer Motion + Tailwind.
2. **Magic UI** (magicui.design) -- Animated backgrounds, text effects, interactive cards. Same copy-paste model as shadcn.
3. **shadcn/ui** -- Base layer for forms, dialogs, nav, accordion. Dark mode via next-themes + CSS variables. Pair with Aceternity for motion.

## Actionable Recommendations

1. Start with Next.js 15 + Tailwind v4 + shadcn/ui as foundation
2. Copy in Aceternity's Spotlight, Hero Parallax, and Text Generate Effect for hero section
3. Build project gallery with Aceternity's 3D Card Effect + gold glow hover (#D4AF37 box-shadow)
4. Use glassmorphism only on floating navbar and modal overlays -- not cards
5. All project photography full-bleed, WebP/AVIF, served via imgix or next/image with blur placeholder
6. Implement dark-first: design in #121212, treat light mode as secondary/optional
7. Keep animation budget under 3 Framer Motion effects per viewport to maintain 95+ PageSpeed
