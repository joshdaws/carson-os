# Design System -- CarsonOS

## Product Context
- **What this is:** Household staff powered by AI. Parents define their family's values, CarsonOS assigns agents to help the family live them out.
- **Who it's for:** Busy parents managing kids, carpools, calendars, homework, activities. Not just homeschool families.
- **Space/industry:** Family tech / household management / personal AI agents. Competitors (OpenClaw, Hermes, Paperclip) target individuals or businesses. CarsonOS is the only household-focused platform.
- **Project type:** Web app (React + Vite + Tailwind, pnpm monorepo)

## Aesthetic Direction
- **Direction:** Luxury/Refined -- warm competence, not cold precision
- **Decoration level:** Intentional -- subtle warmth through borders, background tints, and surface hierarchy. Not minimal (too cold) and not expressive (too busy for parents at 9pm).
- **Mood:** A well-run home. Walking into a hotel lobby where someone already knows your name. Every pixel should feel cared for, like someone pressed the linens. The butler runs the house with quiet authority.
- **Reference sites:** None directly. The Downton Abbey butler metaphor is conceptual. The aesthetic should be warm and competent, not literally period-drama.

## Typography
- **Display/Hero:** Instrument Serif -- warm, modern serif for mission statements, page headings, constitution documents. The butler earns a serif. Not stuffy. Adds gravitas to the moments that matter.
- **Body:** DM Sans -- clean, geometric, slightly rounder than Inter. Excellent readability at small sizes. Pairs with Instrument Serif without clashing.
- **UI/Labels:** DM Sans (same as body)
- **Data/Tables:** DM Sans (tabular-nums feature for numeric alignment)
- **Code:** JetBrains Mono (if ever needed)
- **Loading:** Google Fonts CDN
  ```html
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  ```
- **Scale:**
  - xs: 12px / 0.75rem (labels, timestamps)
  - sm: 14px / 0.875rem (secondary text, captions)
  - base: 16px / 1rem (body text)
  - lg: 18px / 1.125rem (emphasized body)
  - xl: 20px / 1.25rem (section headings, DM Sans)
  - 2xl: 24px / 1.5rem (page subheadings, DM Sans)
  - 3xl: 30px / 1.875rem (page headings, Instrument Serif)
  - 4xl: 36px / 2.25rem (hero headings, Instrument Serif)
  - 5xl: 48px / 3rem (mission statement reveal, Instrument Serif)

## Color

- **Approach:** Restrained -- 1 accent (navy) + warm neutrals. Color is rare and meaningful.

### CSS Custom Properties
```css
:root {
  /* Primary */
  --carson-navy:     #1a1f2e;  /* primary actions, buttons, headers, Carson avatar */
  --carson-cream:    #e8dfd0;  /* text on dark backgrounds, warm highlight */

  /* Surfaces */
  --carson-ivory:    #faf7f2;  /* page background, "the room" */
  --carson-white:    #ffffff;  /* card and surface backgrounds */

  /* Borders */
  --carson-border:   #ddd5c8;  /* warm borders, dividers, input outlines */

  /* Text */
  --carson-text:     #2d2a26;  /* primary body text, warm near-black */
  --carson-muted:    #6b6358;  /* secondary text, timestamps, captions (WCAG AA) */

  /* Semantic */
  --carson-success:  #3d7a5f;  /* confirmed, complete, active, online */
  --carson-warning:  #c4882f;  /* attention needed, pending, due soon */
  --carson-error:    #b54a4a;  /* failed, blocked, error, overdue */

  /* Derived */
  --carson-hover:    #141825;  /* navy darkened for hover states */
  --carson-focus:    #1a1f2e33; /* navy at 20% opacity for focus rings */
}
```

- **Dark mode:** Not planned for MVP. The ivory-on-white palette is the identity. If added later: navy becomes the surface, ivory becomes the background, reduce saturation 10-20% on semantic colors.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable -- generous padding, breathing room. Parents scanning between carpools.
- **Scale:**
  - 2xs: 2px (hairline gaps)
  - xs: 4px (tight internal padding)
  - sm: 8px (standard internal padding, icon gaps)
  - md: 16px (card padding, section gaps)
  - lg: 24px (between cards, section spacing)
  - xl: 32px (major section divisions)
  - 2xl: 48px (page-level vertical rhythm)
  - 3xl: 64px (hero spacing)

## Layout
- **Approach:** Grid-disciplined -- predictable, calm. Consistent card patterns, clear navigation.
- **Sidebar:** Fixed left navigation, 240px width, collapsible to 64px on mobile
- **Content area:** Max 1200px, centered with side padding
- **Dashboard zones:** Horizontal stacking (family top, staff middle, internal bottom)
- **Border radius:**
  - sm: 4px (inputs, small elements)
  - md: 8px (cards, buttons, badges)
  - lg: 12px (modals, panels, toast notifications)
  - full: 9999px (avatars, pills, status dots)

## Motion
- **Approach:** Intentional -- subtle entrance animations, meaningful state transitions. The mission statement reveal is a designed moment. No gratuitous bounce.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:**
  - micro: 75ms (hover states, toggles)
  - short: 150ms (button press, input focus)
  - medium: 300ms (card entrance, tab switch, confirm state)
  - long: 500ms (modal open, mission statement reveal, phase transition)
- **Designed moments:**
  - Mission statement reveal: fade-in from opacity 0, slight upward motion (8px), 1s delay after Carson's lead-in
  - Member confirmation: button transforms to checkmark with medium duration
  - Phase transitions: counter pill fades in/out with short duration
  - Constitution generation: phased loading messages with medium entrance timing

## Component Patterns

### Carson Avatar
- Circle, 32px, background: var(--carson-navy), text: var(--carson-cream)
- Bold single letter "C" (or agent initial)
- Used in chat bubbles, staff cards, activity feed

### Chat Bubble
- Assistant (left): white bg, warm border, Carson avatar
- User (right): navy bg, cream text, no avatar
- Rich content: interactive components render below text, inside the bubble boundary

### Cards
- Background: var(--carson-white)
- Border: 1px solid var(--carson-border)
- Border radius: md (8px)
- Padding: md (16px)
- Shadow: none (borders provide hierarchy, not shadows)

### Status Dots
- 8px circle, border-radius full
- Active/Online: var(--carson-success)
- Pending/Idle: var(--carson-warning)
- Error/Paused: var(--carson-error)

### Buttons
- Primary: bg var(--carson-navy), text var(--carson-cream), radius md
- Secondary: bg transparent, border 1px var(--carson-border), text var(--carson-text), radius md
- Ghost: bg transparent, no border, text var(--carson-muted), radius md
- Disabled: opacity 0.5, cursor not-allowed
- Touch target minimum: 44px height

### CRUD Table (in-chat data entry)
- Standard table rows with name, value columns
- Pencil icon for edit, trash icon for delete
- +Add row button below (text-style, not prominent)
- Confirm button at bottom (primary button style)
- Locks to read-only after confirmation (remove icons, mute text slightly)

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-07 | Initial design system created | Created by /design-consultation. Butler aesthetic formalized from implicit codebase patterns. |
| 2026-04-07 | Instrument Serif for display | Serif earns the butler's gravitas. Mission statements and page headings feel like documents, not UI. Unusual for tech but intentional. |
| 2026-04-07 | Ivory page background (#faf7f2) | Makes the app feel like a room, not a screen. Competitors use white/gray. Ivory is warmer. Contrast ratios verified. |
| 2026-04-07 | Secondary text #6b6358 | Corrected from #8a8070 (failed WCAG AA at 3.5:1). #6b6358 passes at 4.6:1 while keeping the warm tone. |
| 2026-04-07 | DM Sans for body | Clean, geometric, slightly rounder than Inter. Pairs with Instrument Serif. Not overused like Inter/Roboto. |
| 2026-04-07 | No shadows, borders only | Cards use warm borders for hierarchy. Shadows feel cold/techy. Borders feel domestic. |
| 2026-04-07 | CRUD table over card grid | For data entry in chat (member lists), user prefers standard table rows with pencil/trash icons over card-based layouts. The aesthetic comes from the palette, not the grid format. |
