import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Keep every test independent while preserving history to exercise real storage.
test.beforeEach(async ({ request, page }) => {
  const response = await request.get('/api/notes?archived=false&limit=100');
  for (const note of await response.json()) await request.patch('/api/notes/' + note.id, { data: { archived: true } });
  await page.goto('/');
  await expect(page.locator('#connection')).toHaveClass(/online/);
  await page.evaluate(() => document.fonts.ready);
});
const printText = async (page, text) => {
  await page.getByRole('textbox', { name: '要打印的文字' }).fill(text);
  await page.getByRole('button', { name: 'PRINT', exact: true }).click();
  await expect(page.locator('.paper-position.printing')).toBeVisible();
  await expect(page.locator('.paper-position.printing')).toHaveCount(0, { timeout: 10_000 });
  return page.locator('.paper-position').last();
};

test('specified materials, typing, ejection, dragging and persistent position', async ({ page, request }) => {
  await expect(page.locator('.machine')).toHaveCSS('background-color', 'rgb(229, 225, 214)');
  await expect(page.locator('#print')).toHaveCSS('background-color', 'rgb(195, 102, 73)');
  await expect(page.locator('#print')).toBeDisabled();
  const paper = await printText(page, '我也很喜欢《深蓝》\nKeep a little love on paper.');
  await expect(paper).toContainText('Keep a little love on paper.');
  const id = await paper.getAttribute('data-id');
  const box = await paper.boundingBox();
  await page.mouse.move(box.x + 80, box.y + 60);
  await page.mouse.down(); await page.mouse.move(190, 160, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await (await request.get('/api/notes')).json()).find(n => n.id === id).x).toBeCloseTo(110, 0);
  await page.reload();
  const restored = page.locator('[data-id="' + id + '"]');
  await expect(restored).toBeVisible();
  expect((await restored.boundingBox()).x).toBeCloseTo(110, 0);
});

test('heart types generated text; clear and keyboard print work', async ({ page }) => {
  await page.getByRole('button', { name: '随机生成文字' }).click();
  await expect(page.locator('#inspire')).toBeEnabled({ timeout: 15_000 });
  expect((await page.locator('#input').inputValue()).length).toBeGreaterThan(5);
  await page.getByRole('button', { name: '清空文字' }).click();
  await expect(page.locator('#input')).toHaveValue('');
  await page.locator('#input').fill('A keyboard-sized moment.');
  await page.locator('#input').press('Control+Enter');
  await expect(page.locator('.paper-text')).toContainText('A keyboard-sized moment.');
});

test('HTTP and CLI print commands arrive live, queue once, and render plain text safely', async ({ page, request }) => {
  const first = await request.post('/api/print', { data: { text: 'HTTP <script>window.pwned=true</script>', source: 'test:http' } });
  const a = await first.json();
  const cli = JSON.parse(execFileSync('target/debug/lovely-printer', ['print', 'Hello from terminal.', '--server', 'http://127.0.0.1:3918'], { encoding: 'utf8' }));
  await expect(page.locator('[data-id="' + a.id + '"]')).toBeVisible();
  await expect(page.locator('[data-id="' + cli.id + '"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.paper-position')).toHaveCount(2);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(cli.source).toBe('cli');
});

test('closing a note archives it and history can restore or reprint it', async ({ page, request }) => {
  const paper = await printText(page, 'Always worth keeping.');
  const id = await paper.getAttribute('data-id');
  await paper.getByRole('button', { name: '收起便签到历史' }).click();
  await expect(page.locator('[data-id="' + id + '"]')).toHaveCount(0);
  expect((await (await request.get('/api/notes')).json()).find(n => n.id === id).archived).toBe(true);
  await page.getByRole('button', { name: '打印历史', exact: true }).click();
  let row = page.locator('.history-item').filter({ hasText: 'Always worth keeping.' }).first();
  await row.getByRole('button', { name: '放回桌面' }).click();
  await expect(page.locator('[data-id="' + id + '"]')).toBeVisible();
  await page.getByRole('button', { name: '打印历史', exact: true }).click();
  row = page.locator('.history-item').filter({ hasText: 'Always worth keeping.' }).first();
  await row.getByRole('button', { name: '再打印', exact: true }).click();
  await expect(page.locator('.paper-position')).toHaveCount(2);
});

test('long notes remain entirely inside desktop and phone canvas', async ({ page, request }) => {
  // Reduce motion for this layout test rather than waiting 40 seconds for a long print.
  await page.evaluate(() => localStorage.setItem('motopager-settings', JSON.stringify({ reducedMotion: true })));
  await page.reload();
  const response = await request.post('/api/print', { data: { text: '想把今天的风，和一句喜欢你一起寄给你。\n'.repeat(30) } });
  const { id } = await response.json();
  const paper = page.locator('[data-id="' + id + '"] .paper');
  await expect(paper).toBeVisible();
  for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
    const box = await paper.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('custom sound is persisted locally and both synthesized modes produce audio', async ({ page }) => {
  await page.getByRole('button', { name: '声音与设置' }).click();
  // A valid little PCM WAV generated in the test, no external fixture or network.
  const samples = 8000, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 8000 * Math.PI * 440) * 5000), 44 + i * 2);
  await page.locator('#sound-file').setInputFiles({ name: 'my-printer.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.locator('#custom-name')).toContainText('my-printer.wav');
  await page.reload();
  await page.getByRole('button', { name: '声音与设置' }).click();
  await expect(page.locator('#custom-name')).toContainText('my-printer.wav');
  await expect(page.locator('#sound-preset')).toHaveValue('custom');
  // Inspect actual waveform energy, not just whether a button handler ran.
  await page.getByRole('button', { name: '试听音效' }).click();
  const levels = await page.evaluate(async () => {
    const { PrinterAudio } = await import('/audio.js');
    const engine = new PrinterAudio({ volume: .5, muted: false, typingSound: true, preset: 'puff' });
    await engine.unlock();
    const analyser = engine.ctx.createAnalyser(); analyser.fftSize = 2048; analyser.connect(engine.ctx.destination);
    const original = engine.bus.bind(engine);
    engine.bus = () => { const gain = original(); gain.disconnect(); gain.connect(analyser); return gain; };
    const result = {};
    for (const preset of ['puff', 'thermal']) {
      engine.settings.preset = preset;
      const stop = engine.print(1000);
      await new Promise(r => setTimeout(r, 180));
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      result[preset] = Math.sqrt(samples.reduce((n, x) => n + x*x, 0) / samples.length);
      stop();
    }
    await engine.ctx.close(); return result;
  });
  expect(levels.puff).toBeGreaterThan(.0001);
  expect(levels.thermal).toBeGreaterThan(.0001);
});

test('touch dragging persists on a phone-sized canvas', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const paper = await printText(page, '一张可以用手指移动的小纸条。');
  const id = await paper.getAttribute('data-id');
  const box = await paper.boundingBox();
  const session = await page.context().newCDPSession(page);
  const x = box.x + 80, y = box.y + 60;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 25, y: y + 60, id: 1 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await (await request.get('/api/notes')).json()).find(n => n.id === id).y).toBeCloseTo(box.y + 60, 0);
  await session.detach();
});

test('a new connection recovers notes printed while the page was closed', async ({ page, request }) => {
  await page.goto('about:blank');
  const response = await request.post('/api/print', { data: { text: 'Waiting for you, even when offline.' } });
  const note = await response.json();
  await page.goto('/');
  await expect(page.locator('[data-id="' + note.id + '"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.paper-position')).toHaveCount(1);
});

test('failed print preserves input and reports an error', async ({ page }) => {
  await page.route('**/api/print', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary failure"}' }));
  await page.locator('#input').fill('Do not lose this.');
  await page.locator('#print').click();
  await expect(page.locator('#toast')).toContainText('文字已为你保留');
  await expect(page.locator('#input')).toHaveValue('Do not lose this.');
});
