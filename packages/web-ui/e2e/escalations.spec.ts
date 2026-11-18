import { test, expect, type Page } from '@playwright/test';
import {
  connectWithToken,
  navigateTo,
  createDefaultSession,
  focusPtyTerminal,
  resetMockServer,
  sendTrustedPtyPrompt,
  sendPtyPromptRpc,
  sessionLabelNumber,
  waitForPtyTerminal,
} from './helpers.js';

async function createEscalationFromEscalationsView(page: Page): Promise<void> {
  const label = sessionLabelNumber(await createDefaultSession(page));
  await navigateTo(page, 'Escalations');
  await sendPtyPromptRpc(label, 'escalate');
}

async function createEscalationFromSessionsView(page: Page): Promise<void> {
  await createDefaultSession(page);
  await waitForPtyTerminal(page);
  await sendTrustedPtyPrompt(page, 'escalate');
}

/** Mirrors ESCALATION_ARM_DELAY_MS in escalation-modal.svelte. */
const ARM_DELAY_MS = 750;

/**
 * The escalation modal keeps Approve and Deny inert (aria-disabled) until the
 * escalation on screen has been visible for the arming delay. Playwright's
 * click() waits for that on its own; this makes the state explicit.
 */
async function expectArmed(page: Page, armed: boolean): Promise<void> {
  await expect(page.getByTestId('escalation-dialog-body')).toHaveAttribute('data-armed', String(armed), {
    timeout: ARM_DELAY_MS + 10_000,
  });
}

test.describe('Escalations', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('shows empty state when no escalations pending', async ({ page }) => {
    await navigateTo(page, 'Escalations');
    await expect(page.getByText('No pending escalations')).toBeVisible();
  });

  test('creates an escalation by sending "escalate" keyword', async ({ page }) => {
    await createEscalationFromEscalationsView(page);

    // The mock server creates an escalation for filesystem/write_file
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });
  });

  test('escalation card shows server name and tool info', async ({ page }) => {
    await createEscalationFromEscalationsView(page);

    // Wait for the escalation card to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Should show the server and tool name
    await expect(page.getByText('filesystem/filesystem__write_file')).toBeVisible();

    // Should show Approve and Deny buttons
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  });

  test('approving an escalation removes the card', async ({ page }) => {
    await createEscalationFromEscalationsView(page);

    // Wait for escalation to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Approve it
    await page.getByRole('button', { name: 'Approve' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('denying an escalation removes the card', async ({ page }) => {
    await createEscalationFromEscalationsView(page);

    // Wait for escalation to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Deny it
    await page.getByRole('button', { name: 'Deny' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('whitelist candidates are displayed and can be selected before approval', async ({ page }) => {
    await createEscalationFromEscalationsView(page);

    // Wait for the escalation card to appear
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Verify whitelist candidates section is rendered
    await expect(page.getByText('Whitelist (optional)')).toBeVisible();

    // Verify both candidate descriptions are displayed
    const candidate1 = page.getByText('Allow filesystem.write_file within /etc/');
    const candidate2 = page.getByText('Allow filesystem.write_file for this exact path: /etc/hosts');
    await expect(candidate1).toBeVisible();
    await expect(candidate2).toBeVisible();

    // Click the second whitelist candidate to select it
    await candidate2.click();

    // Approve with the whitelist selection
    await page.getByRole('button', { name: 'Approve' }).click();

    // The escalation card should disappear
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('a second click does not approve the card that moved up into the approved one’s place', async ({ page }) => {
    const label = sessionLabelNumber(await createDefaultSession(page));
    await navigateTo(page, 'Escalations');
    await sendPtyPromptRpc(label, 'escalate');
    await page.waitForTimeout(5); // distinct mock escalation ids
    await sendPtyPromptRpc(label, 'escalate');

    const approve = page.getByTestId('escalation-approve');
    await expect(approve).toHaveCount(2, { timeout: 10_000 });
    const box = await approve.first().boundingBox();
    if (!box) throw new Error('Approve button has no bounding box');
    await approve.first().click();

    // The second card now sits where the first one was; a quick follow-up
    // click on the same spot must not approve it.
    await expect(approve).toHaveCount(1, { timeout: 10_000 });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(ARM_DELAY_MS + 250);
    await expect(approve).toHaveCount(1);

    await approve.first().click();
    await expect(page.getByText('No pending escalations')).toBeVisible({ timeout: 5_000 });
  });

  test('escalation badge appears in sidebar nav', async ({ page }) => {
    await createEscalationFromSessionsView(page);

    // The nav item for Escalations should show a badge count
    // Wait for the escalation event to propagate
    await expect(
      page.getByTestId('sidebar-nav').locator('button', { hasText: 'Escalations' }).locator('.font-mono'),
    ).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe('Escalation Modal', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetMockServer(request);
    await connectWithToken(page);
  });

  test('modal auto-opens when escalation fires during sessions view', async ({ page }) => {
    await createEscalationFromSessionsView(page);

    // The modal should auto-open since we're on the Sessions view
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Modal should contain the escalation details
    await expect(modal.getByText('Write to protected system path')).toBeVisible();
    await expect(modal.getByText('Pending Escalations')).toBeVisible();
  });

  test('modal can be dismissed with Escape and sidebar badge still shows count', async ({ page }) => {
    await createEscalationFromSessionsView(page);

    // Wait for the modal to auto-open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Dismiss with Escape
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Sidebar badge should still show the count
    await expect(
      page.getByTestId('sidebar-nav').locator('button', { hasText: 'Escalations' }).locator('.font-mono'),
    ).toBeVisible();
  });

  test('approving in modal removes the escalation', async ({ page }) => {
    await createEscalationFromSessionsView(page);

    // Wait for the modal to auto-open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    // Approve and Deny work once the escalation has been visible for the
    // arming delay (see escalation-modal.svelte).
    await expectArmed(page, true);

    // Approve the escalation via the modal
    await modal.getByRole('button', { name: 'Approve' }).click();

    // Modal should close since no more escalations
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
  });

  test('a click on Approve during the arming delay does nothing', async ({ page }) => {
    await createEscalationFromSessionsView(page);

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // A real click right after the modal appeared. `force` skips Playwright's
    // wait for the aria-disabled button to become enabled. (The click lands
    // well within the 750 ms delay unless the machine is badly overloaded.)
    await modal.getByTestId('escalation-approve').click({ force: true });
    await expectArmed(page, true);
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Write to protected system path')).toBeVisible();
  });

  test('a second click does not approve the escalation that replaced the approved one', async ({ page }) => {
    const label = sessionLabelNumber(await createDefaultSession(page));
    await waitForPtyTerminal(page);
    await sendPtyPromptRpc(label, 'escalate');
    await page.waitForTimeout(5); // distinct mock escalation ids
    await sendPtyPromptRpc(label, 'escalate');

    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('tab')).toHaveCount(2, { timeout: 10_000 });
    await modal.getByTestId('escalation-approve').click();

    // The second escalation now fills the dialog; a quick follow-up click on
    // the same spot must not approve it.
    await expect(modal.getByRole('tab')).toHaveCount(0, { timeout: 10_000 });
    await modal.getByTestId('escalation-approve').click({ force: true });
    await expectArmed(page, true);
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    await modal.getByTestId('escalation-approve').click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
  });

  test('View Session link navigates to session view', async ({ page }) => {
    await createEscalationFromSessionsView(page);

    // Wait for the modal to auto-open
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Click "View Session"
    await modal.getByText('View Session').click();

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Should be on sessions view with the terminal session selected
    await expect(page.getByTestId('pty-terminal')).toBeVisible();
  });

  test('keys typed into the terminal never approve; the chord does after a click into the dialog', async ({ page }) => {
    const label = sessionLabelNumber(await createDefaultSession(page));
    await waitForPtyTerminal(page);
    await focusPtyTerminal(page);
    const terminalInput = page.locator('.xterm-helper-textarea');
    await expect(terminalInput).toBeFocused();

    // The escalation arrives while the user is typing in the terminal.
    await sendPtyPromptRpc(label, 'escalate');
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    // The modal took no focus: keys keep going to the terminal, before and
    // after the arming delay, and none of them approves.
    await page.keyboard.press('a');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expectArmed(page, true);
    await page.keyboard.press('a');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(terminalInput).toBeFocused();
    await expect(modal.getByText('Write to protected system path')).toBeVisible();

    // A click into the dialog moves focus there; bare letters still do
    // nothing and the approve chord works.
    await modal.getByText('Pending Escalations').click();
    await page.keyboard.press('a');
    await expect(modal).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Enter');

    // Modal should close since no more escalations
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Sidebar badge should be gone
    await expect(
      page.getByTestId('sidebar-nav').locator('button', { hasText: 'Escalations' }).locator('.font-mono'),
    ).not.toBeVisible();
  });

  test('modal does NOT auto-open when already on Escalations page', async ({ page }) => {
    await createEscalationFromEscalationsView(page);

    // Wait for escalation to appear on the page
    await expect(page.getByText('Write to protected system path')).toBeVisible({ timeout: 10_000 });

    // Modal should NOT be open since we're on the Escalations page
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
