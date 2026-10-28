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

const selectSetting = async (page, id, value) => {
  await page.locator(`#${id}-trigger`).click();
  await page.locator(`#${id}-options [data-value="${value}"]`).click();
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

test('clicking a note has no outline and screen font is reduced without shrinking notes', async ({ page }) => {
  const paper = await printText(page, '字号和焦点回归测试');
  await paper.click();
  await expect(paper).toHaveCSS('outline-style', 'none');
  await expect(page.locator('#input')).toHaveCSS('font-size', '20px');
  await expect(page.locator('.paper-text')).toHaveCSS('font-size', '14px');
  await paper.focus();
  await expect(paper).toHaveCSS('outline-style', 'none');
});

test('three themes cover printer, notes, screen and background; overrides and text persist', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await printText(page, '为纸张换一件外衣。');
  await page.getByRole('button', { name: '声音与设置', exact: true }).click();
  await page.getByRole('tab', { name: '主题配色' }).click();
  await expect(page.locator('.theme-card')).toHaveCount(3);
  await page.getByRole('button', { name: '晴空蓝', exact: true }).click();
  await expect(page.locator('.machine')).toHaveCSS('background-color', 'rgb(164, 212, 237)');
  await expect(page.locator('.screen')).toHaveCSS('background-color', 'rgb(29, 35, 69)');
  await expect(page.locator('.paper')).toHaveCSS('background-color', 'rgb(239, 250, 255)');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(131, 182, 231)');
  await page.getByRole('button', { name: '鼠尾草绿', exact: true }).click();
  await expect(page.locator('.machine')).toHaveCSS('background-color', 'rgb(190, 205, 184)');
  await page.getByRole('button', { name: '晴空蓝', exact: true }).click();
  for (const [key, value] of Object.entries({ paper: '#ffeedd', background: '#ddeeff', header: '#123456', footer: '#654321' })) {
    await page.locator('#theme-color-' + key).evaluate((element, color) => { element.value = color; element.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  }
  await page.locator('#header-text').fill('我的蓝色桌面');
  await page.locator('#footer-text').fill('KEEP THE LITTLE THINGS');
  await page.locator('#paper-header-text').fill('NOTE / {id}');
  await page.locator('#paper-footer-text').fill('WITH LOVE');
  await expect(page.locator('.paper-footer span')).toHaveText('WITH LOVE');
  await expect(page.locator('.paper-header span')).toContainText('NOTE /');
  await page.reload();
  await expect(page.locator('.signature')).toHaveText('我的蓝色桌面');
  await expect(page.locator('#hint')).toHaveText('KEEP THE LITTLE THINGS');
  await expect(page.locator('.paper')).toHaveCSS('background-color', 'rgb(255, 238, 221)');
  await expect(page.locator('.paper-header')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect(page.locator('.paper-footer span')).toHaveCSS('color', 'rgb(101, 67, 33)');
  await expect(page.locator('.paper-footer span')).toHaveText('WITH LOVE');
  await page.getByRole('button', { name: '声音与设置', exact: true }).click();
  await page.getByRole('tab', { name: '主题配色' }).click();
  await expect(page.getByRole('button', { name: '晴空蓝', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '恢复当前主题默认颜色' }).click();
  await expect(page.locator('.paper')).toHaveCSS('background-color', 'rgb(239, 250, 255)');
  expect(errors).toEqual([]);
});

test('heart and print use the unified poetry/lyrics contract and configurable lyrics search', async ({ page, request }) => {
  const urls = [];
  await page.route('**/api/print/random?**', async route => {
    const url = new URL(route.request().url()); urls.push(url);
    const poetry = url.searchParams.get('type') === 'poetry';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: poetry ? 'poetry' : 'lyrics', title: poetry ? '静夜思' : '测试歌曲', author: poetry ? '李白' : '测试歌手', content: poetry ? '床前明月光，疑是地上霜。' : '这是测试中的原创歌词。', source: poetry ? 'poetry' : 'lrclib' }) });
  });
  await page.getByRole('button', { name: '声音与设置', exact: true }).click();
  await selectSetting(page, 'inspiration-kind', 'poetry');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.locator('#inspire').click();
  await expect(page.locator('#inspire')).toBeEnabled();
  expect(await page.locator('#input').inputValue()).toContain('李白《静夜思》');
  await page.getByRole('button', { name: '声音与设置', exact: true }).click();
  await selectSetting(page, 'inspiration-kind', 'lyrics');
  await expect(page.locator('#lyrics-query')).toBeVisible();
  await page.locator('#lyrics-query').fill('测试歌手');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.locator('#inspire').click();
  await expect(page.locator('#inspire')).toBeEnabled();
  expect(await page.locator('#input').inputValue()).toContain('测试歌手《测试歌曲》');
  expect(urls.at(-1).searchParams.get('q')).toBe('测试歌手');
  await page.locator('#print').click();
  await expect.poll(async () => (await (await request.get('/api/notes')).json())[0].source).toBe('web:lrclib');
});

test('extra indicator dots are removed and physical buttons and toolbar SVGs align', async ({ page }) => {
  await expect(page.locator('.reset-led')).toHaveCount(0);
  await expect(page.locator('#connection')).toHaveCSS('clip-path', 'inset(50%)');
  const clear = await page.locator('#clear').boundingBox();
  const heart = await page.locator('#inspire').boundingBox();
  expect(clear.y + clear.height / 2).toBeCloseTo(heart.y + heart.height / 2, 1);
  const icons = await page.locator('.toolbar .tool svg').evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect(); return { y: r.y + r.height / 2, width: r.width, height: r.height };
  }));
  expect(icons).toHaveLength(3);
  expect(Math.max(...icons.map(i => i.y)) - Math.min(...icons.map(i => i.y))).toBeLessThan(.1);
  expect(icons.every(icon => icon.width === 18 && icon.height === 18)).toBe(true);
  await page.locator('#sound-toggle').click();
  await expect(page.locator('#sound-toggle svg')).toHaveCount(1);
  await expect(page.locator('#sound-toggle')).toHaveClass(/is-muted/);
  await page.getByRole('button', { name: '声音与设置', exact: true }).click();
  await page.getByRole('tab', { name: '主题配色' }).click();
  await expect(page.getByText('给你的打印机换件外衣')).toHaveCount(0);
});

test('both custom dropdowns always open below their trigger, with keyboard and modal support', async ({ page }) => {
  await page.getByRole('button', { name: '声音与设置', exact: true }).click();
  for (const size of [{ width: 1200, height: 800 }, { width: 390, height: 667 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    for (const id of ['sound-preset', 'inspiration-kind']) {
      const trigger = page.locator(`#${id}-trigger`);
      await trigger.scrollIntoViewIfNeeded(); await trigger.click();
      const menu = page.locator(`#${id}-options`);
      await expect(menu).toBeVisible();
      const a = await trigger.boundingBox(), b = await menu.boundingBox();
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
      expect(b.y + b.height).toBeLessThanOrEqual(size.height);
      await trigger.press('Escape');
      await expect(menu).not.toBeVisible();
      await expect(page.locator('#settings-dialog')).toBeVisible();
    }
  }
  await selectSetting(page, 'sound-preset', 'thermal');
  await expect(page.locator('#sound-preset')).toHaveValue('thermal');
  const source = page.locator('#inspiration-kind-trigger');
  await source.press('End'); await source.press('Enter');
  await expect(page.locator('#inspiration-kind')).toHaveValue('lyrics');
  await expect(page.locator('#lyrics-query')).toBeVisible();
  await source.click(); await page.locator('#settings-title').click();
  await expect(page.locator('#inspiration-kind-options')).not.toBeVisible();
});

test('failed print preserves input and reports an error', async ({ page }) => {
  await page.route('**/api/print', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary failure"}' }));
  await page.locator('#input').fill('Do not lose this.');
  await page.locator('#print').click();
  await expect(page.locator('#toast')).toContainText('文字已为你保留');
  await expect(page.locator('#input')).toHaveValue('Do not lose this.');
});
