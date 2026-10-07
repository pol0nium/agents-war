// Brings https://superchallenge.io/play/SUPERCHALLENGE-JAWVUX from the landing page to the "The race" screen, where the
// Turnstile widget is loaded (needed by the chase launcher). Run right after (re)loading the page. Does NOT start a run:
// the form email/nickname are placeholders; the chase uses its own throwaway accounts.
// Waits for each element (the page sometimes loads slowly). Expected result: {"race":true,"ts":true}.
(async () => {
  const wait = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); } return null; };
  (await wait(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Start a game')))?.click();
  const em = await wait(() => document.querySelector('input[type=email]')), nk = await wait(() => document.querySelector('input[placeholder="PhishHunter"]'));
  if (!em || !nk) return 'form not ready';
  const setv = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  setv(em, 'pz9999.burner@example.com'); setv(nk, 'practice');
  const cbs = [...document.querySelectorAll('input[type=checkbox]')];
  if (cbs[0]?.checked) cbs[0].click();            // first checkbox: leave unchecked
  if (cbs[1] && !cbs[1].checked) cbs[1].click();  // second checkbox: required consent
  [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Start')?.click();
  await wait(() => window.turnstile && document.body.innerText.includes('Start the race'));
  return JSON.stringify({ race: document.body.innerText.includes('Start the race'), ts: !!window.turnstile });
})();
