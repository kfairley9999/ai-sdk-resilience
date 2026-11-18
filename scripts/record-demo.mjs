import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4391';
await mkdir('docs/media', { recursive: true });
await mkdir('/tmp/demo-video', { recursive: true });

const browser = await chromium.launch({ headless: true });
const desktop = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: '/tmp/demo-video', size: { width: 1280, height: 900 } },
});
const page = await desktop.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(base, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: /Chaos/ }).waitFor();
await page.getByText('mock providers only').waitFor();
await page.locator('#providers article').nth(0).locator('input[data-key="failure"]').fill('80');
await page.locator('#providers article').nth(0).locator('input[data-key="latency"]').fill('160');
await page.locator('#batch').fill('6');
await page.getByRole('button', { name: 'Run batch' }).click();
await page.waitForFunction(() => {
  const node = document.querySelector('#s-rate');
  return node && node.textContent && node.textContent !== '–';
}, null, { timeout: 45_000 });
await page.locator('.chip').first().waitFor();
await page.locator('#timeline').scrollIntoViewIfNeeded();
const rate = await page.locator('#s-rate').innerText();
const retries = await page.locator('#s-retry').innerText();
if (errors.length) throw new Error(errors.join('\n'));
console.log('desktop', { rate, retries, chips: await page.locator('.chip').count() });
await page.waitForTimeout(1600);
const video = page.video();
await page.close();
await desktop.close();
const videoPath = await video.path();
console.log('video', videoPath);

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const phone = await mobile.newPage();
const phoneErrors = [];
phone.on('pageerror', (error) => phoneErrors.push(error.message));
await phone.goto(base, { waitUntil: 'networkidle' });
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await phone.getByRole('button', { name: 'Run batch' }).click();
await phone.waitForFunction(() => {
  const node = document.querySelector('#s-rate');
  return node && node.textContent && node.textContent !== '–';
}, null, { timeout: 30_000 });
console.log('phone', { overflow, rate: await phone.locator('#s-rate').innerText(), errors: phoneErrors });
if (overflow > 8) throw new Error(`horizontal overflow ${overflow}px`);
if (phoneErrors.length) throw new Error(phoneErrors.join('\n'));
await mobile.close();
await browser.close();
console.log('ok');
