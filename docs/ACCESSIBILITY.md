# Accessibility

**Target:** WCAG 2.2 Level AA.

**How it is verified:**

- ESLint `jsx-a11y` (strict) on every change.
- axe-core audits of 16 UI states on every CI run: the editor (empty, editing, result, error) in light, dark and 390 px mobile layouts; the feedback form with a validation error; the review wall, animated and with reduced motion; and admin sign-in and dashboard in light and dark. The current result is **0 violations**.
- Scripted keyboard-only interactions in the e2e suite.
- The manual checks listed below.

## How the main criteria are met

| Criterion | Implementation |
| --- | --- |
| **1.1.1 Non-text content** | The preview canvas is `aria-hidden` and paired with a text description (file name, dimensions, rotation and mirroring). The result image has descriptive alt text. Icons are `aria-hidden`, and every icon-only button has an `aria-label`. |
| **1.3.1 Info and relationships** | Landmarks (`header`, `main`, `aside`, `footer`), one `h1` plus section headings, `fieldset`/`legend` for grouped radios, `<label for>` on every input, a `dl` for result stats. Each panel section is a `region` named by its heading. |
| **1.3.5 Identify input purpose** | No personal-data inputs exist. |
| **1.4.1 Use of colour** | Status never relies on colour alone: badges carry an icon and text ("Target met" / "Target not reachable"), and errors carry an icon and a title. |
| **1.4.3 / 1.4.11 Contrast** | Tokens were chosen for ≥ 4.5:1 text contrast and ≥ 3:1 for control borders and focus rings in **both** themes (see `styles/tokens.css`). axe verifies them in light and dark. |
| **1.4.4 / 1.4.10 Resize and reflow** | `rem` type scale; single-column layout below 1024 px. e2e asserts no horizontal scrolling at 390 px (≈ 320 CSS px at 400% zoom behaves the same). |
| **1.4.12 Text spacing** | No fixed-height text containers; line-height 1.5. |
| **1.4.13 Content on hover or focus** | No hover-only content. Native `title` tooltips duplicate the accessible names. |
| **2.1.1 Keyboard** | Everything is operable by keyboard. The crop box can be focused: arrows move it, Shift makes larger steps, and Alt + arrows resizes it. Numeric X/Y/W/H fields offer exact entry. Ctrl/⌘ + Enter processes and Esc cancels. |
| **2.1.2 No keyboard trap** | The crop box handles only arrow keys; Tab always leaves it. |
| **2.2.2 Pause, stop, hide** | The moving review wall has a visible **Pause reviews** button (`aria-pressed`), and it also pauses on hover and while anything inside has focus. With `prefers-reduced-motion` nothing moves; reviews become a focusable, scrollable row. Admins can hide the section entirely. |
| **2.4.1 Bypass blocks** | "Skip to editor" link as the first tab stop (tested). |
| **2.4.3 Focus order** | DOM order matches visual order. After processing, focus moves to the "Ready to download" heading so the download link is next. |
| **2.4.7 / 2.4.11 Focus visible and not obscured** | A 2 px focus ring with offset on every control, never removed. The sticky header is short and the panel scrolls independently, so a focused control is never hidden. |
| **2.5.3 Label in name** | Visible labels match accessible names ("Process image", "Enable crop", …). |
| **2.5.7 Dragging movements** | Every drag has a single-pointer or non-pointer alternative: numeric crop fields, keyboard nudging, aspect presets, and a "Choose image" button instead of drag-and-drop. |
| **2.5.8 Target size (minimum)** | Buttons, inputs and switches are 24–44 px (most are 36 px or more). Crop handles show a 10 px square but have a 28 px hit area. Checkboxes can be clicked anywhere on their label; short single-line ones rely on the criterion's spacing exception, which axe's `target-size` rule verifies. |
| **3.2.1 / 3.2.2 On focus and on input** | Nothing changes context on focus or input. Settings apply only when the user presses "Process image". |
| **3.3.1 / 3.3.3 Error identification and suggestion** | Server and file errors appear in `role="alert"` with a plain-language cause, per-field details and a reference ID. Pre-flight problems (e.g. "The target size must be at least 1 KB") appear in `role="status"` and disable processing until fixed. Out-of-range numbers are clamped and the clamp is announced. |
| **4.1.2 Name, role, value** | Native controls throughout: radios for segmented controls, `role="switch"` checkboxes for toggles, `aria-pressed` for toggle buttons, `role="progressbar"` with values during upload. |
| **4.1.3 Status messages** | A polite live region announces open, upload, processing, done, cancel and remove events. The crop position is announced after keyboard moves. |

### Feedback and reviews

- **Star rating** is a native radio group inside a `fieldset` with the legend "Your rating (required)". Arrow keys move between stars, and each option is announced as, for example, "4 stars, Very good". Targets are 40 × 40 px. Filled stars use `#d97706` (3.2:1 on white) so the state is visible to low-vision users (1.4.11). The hover preview is CSS-only.
- **Validation.** Submitting without a rating moves focus to the stars and shows an error in `role="alert"`, linked with `aria-describedby`.
- **Post-download prompt** appears inline below the result. It does not steal focus from the download link; a polite live-region message says it is there.
- **Review cards** use `figure` / `blockquote` / `figcaption`. Star ratings are one `role="img"` with a text label ("4.5 out of 5 stars") rather than five images. The duplicated copies used for the seamless loop are `aria-hidden`, so each review is read once.
- **Admin page**: labelled sign-in, a native switch for "Show reviews on the website", a radio group for the status filter, and action announcements in a live region. It is audited by axe in light and dark.

## Design choices worth knowing

- **Crop box `role="application"`.** ARIA has no 2-D positioning widget. Without this role, screen readers in browse mode would swallow the arrow keys. The element has an `aria-roledescription` of "crop selection", a label giving the current size and position, and linked instructions. The numeric fields remain the most efficient path for screen-reader users.
- **Motion.** `prefers-reduced-motion` removes transitions and the indeterminate progress animation.
- **Forced colours.** In Windows High Contrast, the crop box, handles, switches and selected segments fall back to system colours.
- **Theme.** The theme follows the OS preference, with a manual override (System → Light → Dark) stored per browser.

## Manual test checklist (run before a release)

- [ ] Complete the whole journey (open → crop → resize → format → target → process → download) with **keyboard only**.
- [ ] Repeat with **NVDA + Firefox** and **VoiceOver + Safari**. Toggle announcements, crop announcements and completion should all be read.
- [ ] **400% browser zoom** at 1280 px wide: no loss of content or function, no two-axis scrolling.
- [ ] **Windows High Contrast / forced colours:** focus, crop box and selection states are visible.
- [ ] **Text-spacing bookmarklet** (WCAG 1.4.12): no clipped text.
- [ ] **Touch:** crop handles can be dragged on a phone, and all targets are comfortably tappable.

## Known limitations

- The canvas preview cannot describe image *content* (it is the user's own image). The text alternative gives its name, size and transformations instead.
- Drag-and-drop onto the drop zone is pointer-only by nature. The "Choose image" button and clipboard paste are the equivalent alternatives.
