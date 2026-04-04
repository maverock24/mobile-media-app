import { test, expect } from '@playwright/test';

test('debug hydration marker', async ({ page }) => {
    const logs: string[] = [];
    const errors: string[] = [];
    
    page.on('console', msg => {
        if (msg.type() !== 'warning') logs.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', err => errors.push(err.message));
    
    await page.goto('/');
    
    // Wait for tabs to appear (we know from screenshot they appear)
    await page.waitForSelector('[role="tab"]', { timeout: 10000 });
    
    const tabCount = await page.locator('[role="tab"]').count();
    console.log('Tab count after tabs visible:', tabCount);
    
    const hydrated1 = await page.evaluate(() => document.body.dataset.hydrated);
    console.log('body.dataset.hydrated right after tabs visible:', hydrated1);
    
    // Wait a bit more
    await page.waitForTimeout(2000);
    
    const hydrated2 = await page.evaluate(() => document.body.dataset.hydrated);
    console.log('body.dataset.hydrated after 2 more seconds:', hydrated2);
    
    // Check if kit is initialized
    const skGlobals = await page.evaluate(() => {
        const keys = Object.keys(window).filter(k => k.startsWith('__sveltekit'));
        return keys.map(k => `${k}=${typeof (window as any)[k]}`).join(', ');
    });
    console.log('SvelteKit globals:', skGlobals);
    
    // Try to manually trigger it
    const manualSet = await page.evaluate(() => {
        document.body.dataset.testmanual = '1';
        return document.body.dataset.testmanual;
    });
    console.log('Manual dataset set works:', manualSet);
    
    console.log('=== Console logs ===');
    console.log(logs.slice(0, 20).join('\n'));
    console.log('=== Page errors ===');  
    console.log(errors.join('\n'));
});
