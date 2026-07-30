const $ = (id) => document.getElementById(id);

function syncProviderUI() {
  document.body.classList.toggle('openai', $('provider').value === 'openai');
}

document.addEventListener('DOMContentLoaded', async () => {
  const c = await chrome.storage.sync.get(['provider', 'apiKey', 'model', 'baseUrl']);
  $('provider').value = c.provider || 'gemini';
  $('apiKey').value = c.apiKey || '';
  $('model').value = c.model || '';
  $('baseUrl').value = c.baseUrl || '';
  syncProviderUI();
});

$('provider').addEventListener('change', syncProviderUI);

$('saveBtn').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    baseUrl: $('baseUrl').value.trim(),
  });
  $('saved').textContent = '저장됨 ✓';
  setTimeout(() => ($('saved').textContent = ''), 2000);
});
