/**
 * End-to-end + accessibility check against the production build.
 *
 *   npm run build && npm run test:e2e
 *
 * Starts the compiled API serving the built SPA (same-origin, strict CSP),
 * drives the full user journey in Chromium, runs axe-core (WCAG 2.2 A/AA)
 * in light, dark and mobile layouts, verifies the downloaded file, and
 * checks that the server deleted every upload. Screenshots land in
 * e2e/artifacts/ (gitignored).
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(root, 'e2e', 'artifacts');
const tempDir = path.join(artifacts, 'server-tmp');
const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FILE_NAME = 'fixture.jpg';
const ADMIN_PASSWORD = 'e2e admin password';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? '  PASS' : '  FAIL';
  console.log(`${mark} ${name}${!ok && detail ? `\n      ${JSON.stringify(detail, null, 2).replace(/\n/g, '\n      ')}` : ''}`);
};

async function axe(page, label) {
  const r = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  check(
    `axe (WCAG 2.2 AA): ${label}`,
    r.violations.length === 0,
    r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })),
  );
}

async function makeFixtures() {
  await mkdir(artifacts, { recursive: true });
  const w = 3000;
  const h = 2000;
  const scene = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="0.55" stop-color="#f97316"/><stop offset="1" stop-color="#fde68a"/></linearGradient>
      <linearGradient id="m1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#312e81"/><stop offset="1" stop-color="#1e1b4b"/></linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#sky)"/>
    <circle cx="${w * 0.68}" cy="${h * 0.52}" r="${h * 0.14}" fill="#fff7ed" opacity="0.92"/>
    <polygon points="0,${h} 0,${h * 0.62} ${w * 0.18},${h * 0.44} ${w * 0.36},${h * 0.66} ${w * 0.55},${h * 0.5} ${w * 0.78},${h * 0.72} ${w},${h * 0.56} ${w},${h}" fill="url(#m1)"/>
    <polygon points="0,${h} 0,${h * 0.8} ${w * 0.25},${h * 0.7} ${w * 0.5},${h * 0.84} ${w * 0.75},${h * 0.74} ${w},${h * 0.86} ${w},${h}" fill="#0f172a"/>
  </svg>`;
  // Grain so the JPEG compresses like a real photo.
  const noise = Buffer.alloc(w * h);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) noise[i] = ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0x3f;
  const grain = await sharp(noise, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  const photo = await sharp(Buffer.from(scene))
    .composite([{ input: grain, blend: 'soft-light' }])
    .jpeg({ quality: 92 })
    .toBuffer();
  const photoPath = path.join(artifacts, FILE_NAME);
  await writeFile(photoPath, photo);
  const fakePath = path.join(artifacts, 'not-an-image.png');
  await writeFile(fakePath, '<svg onload="alert(1)"></svg>');
  return { photoPath, fakePath, photoBytes: photo.length };
}

async function startServer() {
  await rm(tempDir, { recursive: true, force: true });
  const { hashPassword } = await import('../server/dist/services/adminAuth.js');
  const proc = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      STATIC_DIR: path.join(root, 'client', 'dist'),
      TEMP_DIR: tempDir,
      LOG_LEVEL: 'warn',
      RATE_LIMIT_MAX: '200',
      FEEDBACK_STORE: 'memory',
      FEEDBACK_RATE_LIMIT_MAX: '100',
      ADMIN_PASSWORD_HASH: await hashPassword(ADMIN_PASSWORD),
      ADMIN_SESSION_SECRET: 'e2e-session-secret-0123456789-abcdef',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/v1/health`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('server did not start');
}

function watchConsole(page, label) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  return (allow = []) => {
    const unexpected = errors.filter((e) => !allow.some((re) => re.test(e)));
    check(`no console errors or CSP violations (${label})`, unexpected.length === 0, unexpected);
  };
}

const summaryText = (page) => page.locator('.summary strong').textContent();

async function desktopJourney(browser, fx) {
  console.log('\nDesktop / light');
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light', acceptDownloads: true });
  const page = await context.newPage();
  const consoleOk = watchConsole(page, 'desktop');

  const doc = await page.goto(BASE);
  const csp = doc?.headers()['content-security-policy'] ?? '';
  check('SPA served with strict CSP', csp.includes("script-src 'self'") && !csp.includes('unsafe-inline'), csp);
  await page.getByRole('heading', { name: 'Drop an image to get started' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, '01-empty-light.png') });
  await axe(page, 'empty state, light');

  await page.keyboard.press('Tab');
  check('first Tab stop is the skip link', (await page.evaluate(() => document.activeElement?.textContent)) === 'Skip to editor');

  await page.locator('input[type=file]').setInputFiles(fx.photoPath);
  await page.getByText(FILE_NAME, { exact: true }).waitFor();
  check('image dimensions shown', await page.getByText('3,000 × 2,000 px', { exact: true }).isVisible());
  await page.screenshot({ path: path.join(artifacts, '02-loaded-light.png') });

  // Crop: 16:9, then shrink and move it with the keyboard only.
  await page.getByRole('switch', { name: 'Enable crop' }).check();
  await page.getByRole('radio', { name: '16:9' }).check();
  const crop = page.getByRole('region', { name: 'Crop' });
  check(
    '16:9 crop spans the full width',
    (await crop.getByLabel('Width').inputValue()) === '3000' && (await crop.getByLabel('Height').inputValue()) === '1688',
  );
  const cropBox = page.getByRole('application', { name: /Crop selection/ });
  await cropBox.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Alt+ArrowLeft');
  for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowRight');
  const cropW = Number(await crop.getByLabel('Width').inputValue());
  const cropH = Number(await crop.getByLabel('Height').inputValue());
  const cropX = Number(await crop.getByLabel('X').inputValue());
  check('keyboard resized and moved the crop, keeping 16:9', cropW < 3000 && cropX > 0 && Math.abs(cropW / cropH - 16 / 9) < 0.01, { cropW, cropH, cropX });

  // Numeric entry (the non-drag alternative, WCAG 2.5.7).
  await crop.getByLabel('X').fill('0');
  await crop.getByLabel('X').press('Enter');
  check('numeric crop entry applies', (await crop.getByLabel('X').inputValue()) === '0');

  // Pointer drag on a handle.
  const box = await cropBox.boundingBox();
  const before = Number(await crop.getByLabel('Width').inputValue());
  const handle = page.locator('.crop-handle[data-edge="e"]');
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - box.width * 0.2, hb.y + hb.height / 2, { steps: 5 });
  await page.mouse.up();
  const afterDrag = Number(await crop.getByLabel('Width').inputValue());
  check('dragging the east handle shrinks the crop', afterDrag < before, { before, afterDrag });

  // Resize to 1200 wide, aspect locked.
  await page.getByRole('switch', { name: 'Enable resize' }).check();
  const resize = page.getByRole('region', { name: 'Resize' });
  await resize.getByLabel('Width').fill('1200');
  await resize.getByLabel('Width').press('Enter');
  check('locked height follows width', (await resize.getByLabel('Height').inputValue()) === '675');

  // Output: WebP under 150 KB.
  await page.getByRole('radio', { name: 'WebP' }).check();
  await page.getByRole('switch', { name: 'Limit file size' }).check();
  await page.getByLabel('Maximum size').fill('150');
  await page.getByLabel('Maximum size').press('Enter');
  check('output summary predicts 1,200 x 675 WEBP', (await summaryText(page))?.includes('1,200 × 675 px · WEBP'), await summaryText(page));
  await page.screenshot({ path: path.join(artifacts, '03-configured-light.png') });
  await axe(page, 'editor with crop/resize/target, light');

  await page.getByRole('button', { name: 'Process image' }).click();
  const heading = page.getByRole('heading', { name: 'Ready to download' });
  await heading.waitFor({ timeout: 60_000 });
  check('focus moves to the result heading', await heading.evaluate((el) => el === document.activeElement));
  check('target-met badge shown', await page.getByText('Target met').isVisible());
  await page.screenshot({ path: path.join(artifacts, '04-result-light.png'), fullPage: true });
  await axe(page, 'result state, light');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Download WEBP/ }).click()]);
  const out = path.join(artifacts, 'downloaded.webp');
  await download.saveAs(out);
  const meta = await sharp(out).metadata();
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(out));
  check('downloaded file is a 1200x675 WebP <= 150 KB', meta.format === 'webp' && meta.width === 1200 && meta.height === 675 && size <= 150 * 1024, {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    size,
  });
  check('download name is sanitised and descriptive', download.suggestedFilename() === 'fixture-processed.webp', download.suggestedFilename());

  // Feedback is requested after the download, inline and without stealing focus.
  const prompt = page.getByRole('region', { name: 'How was your experience?' });
  await prompt.waitFor();
  check('feedback prompt appears after download', await prompt.isVisible());
  check('download link keeps focus (prompt does not steal it)', await page.evaluate(() => document.activeElement?.textContent?.includes('Download')));
  await prompt.getByRole('button', { name: 'Send feedback' }).click();
  check('missing rating is explained', await prompt.getByRole('alert').filter({ hasText: 'choose a rating' }).isVisible());
  await axe(page, 'feedback prompt with validation error, light');
  // Keyboard-only rating: focus the first star, then arrow to the fourth.
  await prompt.getByRole('radio', { name: /^1 star/ }).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  check('arrow keys select 4 stars', await prompt.getByRole('radio', { name: /^4 stars/ }).isChecked());
  await prompt.getByLabel(/Tell us more/).fill('The 16:9 crop and target size made this effortless.');
  await prompt.getByLabel(/Your name/).fill('E2E Tester');
  await page.screenshot({ path: path.join(artifacts, '04b-feedback-prompt-light.png'), fullPage: true });
  await prompt.getByRole('button', { name: 'Send feedback' }).click();
  const thanks = page.getByText('Thank you for your feedback!').first();
  await thanks.waitFor();
  check('feedback accepted with a thank-you', await thanks.isVisible());

  // The review wall below the editor now includes the new comment and moves right-to-left.
  const wall = page.getByRole('region', { name: 'What people are saying' });
  await wall.getByText('The 16:9 crop and target size made this effortless.').first().waitFor();
  check('new review appears on the wall', true);
  const list = wall.getByRole('list', { name: 'Recent reviews' });
  const accessibleItems = await list.getByRole('listitem').count();
  check('wall exposes each review once to assistive tech', accessibleItems === 5, { accessibleItems });
  const anim = () => page.locator('.marquee-track').evaluate((el) => {
    const a = el.getAnimations()[0];
    return a ? { name: a.animationName, state: getComputedStyle(el).animationPlayState } : null;
  });
  const fourStar = wall.getByRole('img', { name: '4 out of 5 stars' }).first();
  const fillRatio = await fourStar.evaluate((el) => {
    const fill = el.querySelector('.stars-fill').getBoundingClientRect().width;
    return fill / el.getBoundingClientRect().width;
  });
  check('a 4-star review fills exactly 4 of 5 stars', Math.abs(fillRatio - 0.8) < 0.03, { fillRatio });
  const running = await anim();
  check('review wall animates (marquee)', running?.name === 'marquee' && running.state === 'running', running);
  await page.mouse.move(5, 5);
  await wall.getByRole('button', { name: 'Pause reviews' }).click();
  await page.mouse.move(5, 5);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const paused = await anim();
  check('pause button stops the motion (WCAG 2.2.2)', paused?.state === 'paused', paused);
  check('pause button reports its state', (await wall.getByRole('button', { name: 'Play reviews' }).getAttribute('aria-pressed')) === 'true');
  await wall.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, '04c-reviews-light.png'), fullPage: true });
  await axe(page, 'after feedback + review wall, light');

  // Changing a setting marks the result stale.
  await page.getByRole('radio', { name: 'AVIF' }).check();
  check('stale-result notice appears after a change', await page.getByText(/Settings have changed/).isVisible());

  // Rotation keeps the preview and output estimate in sync.
  await page.getByRole('switch', { name: 'Enable resize' }).uncheck();
  await page.getByRole('switch', { name: 'Enable crop' }).uncheck();
  await page.getByRole('button', { name: 'Rotate 90° clockwise' }).click();
  check('rotation swaps the output dimensions', (await summaryText(page))?.includes('2,000 × 3,000'), await summaryText(page));

  await new Promise((r) => setTimeout(r, 300));
  const leftovers = (await readdir(tempDir)).filter((n) => n.startsWith('req-'));
  check('server deleted every upload workspace', leftovers.length === 0, leftovers);
  consoleOk();

  // Hostile file: browser cannot decode -> server proxy -> 415 surfaced accessibly.
  const errorsOk = watchConsole(page, 'rejected upload');
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.locator('input[type=file]').setInputFiles(fx.fakePath);
  const alert = page.getByRole('alert').filter({ hasText: 'open that file' });
  await alert.waitFor();
  check('rejected upload explains why', (await alert.textContent())?.includes('Unsupported file type'), await alert.textContent());
  await axe(page, 'error state, light');
  // The browser logs the 415 network response itself; that one is expected.
  errorsOk([/status of 415/]);
  await context.close();
}

async function darkJourney(browser, fx) {
  console.log('\nDesktop / dark');
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const consoleOk = watchConsole(page, 'dark');
  await page.goto(BASE);
  await axe(page, 'empty state, dark');
  await page.locator('input[type=file]').setInputFiles(fx.photoPath);
  await page.getByText(FILE_NAME, { exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Enable crop' }).check();
  await page.getByRole('radio', { name: '4:3' }).check();
  await page.getByRole('switch', { name: 'Enable resize' }).check();
  await page.getByRole('button', { name: 'Lock aspect ratio' }).click();
  await page.getByRole('radio', { name: 'JPEG' }).check();
  await page.screenshot({ path: path.join(artifacts, '05-configured-dark.png') });
  await axe(page, 'editor, dark');
  await page.getByRole('button', { name: 'Process image' }).click();
  await page.getByRole('heading', { name: 'Ready to download' }).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(artifacts, '06-result-dark.png'), fullPage: true });
  await axe(page, 'result, dark');

  // Manual theme override is honoured over the OS preference.
  await page.getByRole('button', { name: /Colour theme/ }).click();
  check('theme toggle switches to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  consoleOk();
  await context.close();
}

async function mobileJourney(browser, fx) {
  console.log('\nMobile / 390px');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const consoleOk = watchConsole(page, 'mobile');
  await page.goto(BASE);
  await page.screenshot({ path: path.join(artifacts, '07-mobile-empty.png') });
  await axe(page, 'empty state, mobile');
  await page.locator('input[type=file]').setInputFiles(fx.photoPath);
  await page.getByText(FILE_NAME, { exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Enable crop' }).check();
  await page.screenshot({ path: path.join(artifacts, '08-mobile-loaded.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scrolling at 390px (WCAG 1.4.10 reflow)', overflow <= 0, { overflow });
  await axe(page, 'editor, mobile');
  consoleOk();
  await context.close();
}

async function reducedMotionJourney(browser) {
  console.log('\nReduced motion');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(BASE);
  const row = page.getByRole('region', { name: 'Recent reviews, scrollable' });
  await row.waitFor();
  check('reduced motion: reviews become a static, scrollable row', (await page.locator('.marquee-track').count()) === 0);
  check('reduced motion: scrollable row is keyboard focusable', (await row.getAttribute('tabindex')) === '0');
  await axe(page, 'review wall, reduced motion');
  await context.close();
}

async function adminJourney(browser, colorScheme) {
  console.log(`\nAdmin / ${colorScheme}`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme });
  const page = await context.newPage();
  const consoleOk = watchConsole(page, `admin ${colorScheme}`);
  await page.goto(`${BASE}/admin`);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  check('admin page is excluded from search engines', (await page.locator('meta[name="robots"]').getAttribute('content'))?.includes('noindex'));
  await axe(page, `admin sign-in, ${colorScheme}`);

  await page.getByLabel('Password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').filter({ hasText: 'not correct' }).waitFor();
  check('wrong admin password is rejected', true);

  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Reviews', level: 1 }).waitFor();
  await page.getByText('Brilliant, fast and simple.').waitFor();
  check('admin sees published reviews', true);
  await page.screenshot({ path: path.join(artifacts, `09-admin-${colorScheme}.png`), fullPage: true });
  await axe(page, `admin dashboard, ${colorScheme}`);

  if (colorScheme === 'light') {
    await page.getByRole('radio', { name: /Pending review/ }).check();
    const held = page.getByRole('listitem').filter({ hasText: 'cheap-pills.biz' });
    await held.waitFor();
    check('comment with a link was held for review', true);
    await held.getByRole('button', { name: 'Approve' }).click();
    await held.waitFor({ state: 'detached' });
    const pub = await (await fetch(`${BASE}/api/v1/feedback`, { cache: 'no-store' })).json();
    check('approving publishes the comment', pub.items?.some((i) => i.comment.includes('cheap-pills.biz')), pub.items?.length);

    const toggle = page.getByRole('switch', { name: 'Show reviews on the website' });
    await toggle.uncheck();
    await page.getByRole('status').filter({ hasText: 'hidden from the website' }).waitFor();
    check('wall can be switched off', (await (await fetch(`${BASE}/api/v1/feedback`)).json()).enabled === false);
    const visitor = await context.newPage();
    await visitor.goto(BASE);
    await visitor.getByRole('heading', { name: 'Drop an image to get started' }).waitFor();
    await visitor.waitForTimeout(500);
    check('visitors no longer see the review section', (await visitor.getByRole('region', { name: 'What people are saying' }).count()) === 0);
    await visitor.close();
    await toggle.check();
    await page.getByRole('status').filter({ hasText: 'now shown' }).waitFor();
    check('wall can be switched back on', (await (await fetch(`${BASE}/api/v1/feedback`)).json()).enabled === true);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    const session = await page.evaluate(() => fetch('/api/v1/admin/session').then((r) => r.json()));
    check('sign out ends the session', session.authenticated === false);
  }
  consoleOk([/status of 401/]);
  await context.close();
}

/** Existing reviews so the wall has content, plus one held for moderation. */
async function seedFeedback() {
  const reviews = [
    { rating: 5, comment: 'Brilliant, fast and simple.', name: 'Asha' },
    { rating: 5, comment: 'Finally a resizer that hits an exact file size for visa photo uploads.', name: 'Rohan' },
    { rating: 4, comment: 'Love the crop presets. Would like batch mode someday.', name: '' },
    { rating: 5, comment: 'Clean, no ads, no sign-up. Converted HEIC-exported JPEGs to WebP in seconds.', name: 'Mei' },
    { rating: 3, comment: 'Works well, grab it at cheap-pills.biz', name: 'spam' },
  ];
  for (const r of reviews) {
    const res = await fetch(`${BASE}/api/v1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) });
    if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
  }
}

const fx = await makeFixtures();
const server = await startServer();
const browser = await chromium.launch();
try {
  await seedFeedback();
  await desktopJourney(browser, fx);
  await darkJourney(browser, fx);
  await mobileJourney(browser, fx);
  await reducedMotionJourney(browser);
  await adminJourney(browser, 'light');
  await adminJourney(browser, 'dark');
} catch (err) {
  check('journey completed without an exception', false, String(err?.stack ?? err));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${path.relative(root, artifacts)}`);
process.exit(failed.length ? 1 : 0);
