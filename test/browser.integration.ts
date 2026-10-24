import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureSession } from '../src/browser-auth.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ BRIGHTSPACE_AUTH_MODE: 'browser', BRIGHTSPACE_BASE_URL: 'https://school.example' });

test('Chromium captures a signed-in tenant session, extracts CSRF, and excludes SSO cookies', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      '<html><script>window.D2L={LP:{Web:{Authentication:{Xsrf:{GetXsrfToken:()=>"synthetic-csrf"}}}}}</script>Home</html>' }));
    const page = await context.newPage();
    await page.goto(`${config.baseUrl}/d2l/home/123`);
    await assert.rejects(captureSession(context, config), /No Brightspace session/);
    await context.addCookies([
      { name: 'd2lSessionVal', value: 'synthetic-cookie', domain: 'school.example', path: '/', secure: true, httpOnly: true },
      { name: 'SSO', value: 'never-save', domain: 'sso.example', path: '/', secure: true },
      { name: 'SSO-parent', value: 'never-save', domain: '.example', path: '/', secure: true },
    ]);
    const session = await captureSession(context, config);
    assert.equal(session.csrfToken, 'synthetic-csrf');
    assert.deepEqual(session.cookies.map(c => c.name), ['d2lSessionVal']);
    assert.ok(!JSON.stringify(session).includes('never-save'));
    await page.goto('https://sso.example/login');
    await assert.rejects(captureSession(context, config), /No signed-in Brightspace home/);
    await page.goto(`${config.baseUrl}/d2l/login`);
    await assert.rejects(captureSession(context, config), /No signed-in Brightspace home/);
  } finally { await browser.close(); }
});

test('Chromium falls back to the frontend CSRF meta tag', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<meta name="d2l-xsrf-token" content="meta-csrf">Home' }));
    await context.addCookies([{ name: 'd2lSessionVal', value: 'synthetic', domain: 'school.example', path: '/', secure: true }]);
    const page = await context.newPage();
    await page.goto(`${config.baseUrl}/d2l/home`);
    assert.equal((await captureSession(context, config)).csrfToken, 'meta-csrf');
  } finally { await browser.close(); }
});
