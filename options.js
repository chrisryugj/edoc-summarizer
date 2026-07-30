const $ = (id) => document.getElementById(id);

const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-pro-latest'];
const OLLAMA_FALLBACK = ['gemma4:e4b', 'gemma4:e2b'];
const CUSTOM = '__custom';

function syncProviderUI() {
  document.body.classList.toggle('openai', $('provider').value === 'openai');
}

// 프로바이더에 맞는 모델 목록으로 드롭다운 구성.
// 내부 LLM은 서버의 /v1/models(Ollama·vLLM 공통)에서 설치 모델을 실제 조회.
async function loadModels(selected) {
  const provider = $('provider').value;
  let models = [];
  let hint = '';
  if (provider === 'gemini') {
    models = GEMINI_MODELS;
    hint = 'flash-latest = 항상 최신 Flash (빠름·저렴), pro-latest = 고품질';
  } else {
    const base = ($('baseUrl').value.trim() || 'http://localhost:11434').replace(/\/+$/, '');
    try {
      const key = $('apiKey').value.trim();
      const res = await fetch(`${base}/v1/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      models = ((await res.json()).data || []).map((m) => m.id);
      hint = `${base} 서버의 설치 모델 ${models.length}개`;
    } catch { /* 서버 미기동 등 */ }
    if (!models.length) {
      models = OLLAMA_FALLBACK;
      hint = '서버 조회 실패 — 기본 목록 표시 (Ollama 실행 여부 확인)';
    }
  }
  if (selected && !models.includes(selected)) models = [selected, ...models];

  const sel = $('model');
  sel.textContent = '';
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM;
  custom.textContent = '직접 입력…';
  sel.appendChild(custom);
  sel.value = selected && models.includes(selected) ? selected : models[0];
  $('modelHint').textContent = hint;
  syncCustomUI();
}

function syncCustomUI() {
  $('modelCustom').style.display = $('model').value === CUSTOM ? 'block' : 'none';
}

document.addEventListener('DOMContentLoaded', async () => {
  const c = await chrome.storage.sync.get(['provider', 'apiKey', 'model', 'baseUrl']);
  $('provider').value = c.provider || 'gemini';
  $('apiKey').value = c.apiKey || '';
  $('baseUrl').value = c.baseUrl || '';
  syncProviderUI();
  await loadModels(c.model || '');
});

$('provider').addEventListener('change', () => {
  syncProviderUI();
  loadModels('');
});
$('baseUrl').addEventListener('change', () => {
  if ($('provider').value === 'openai') loadModels($('model').value !== CUSTOM ? $('model').value : '');
});
$('model').addEventListener('change', syncCustomUI);

$('saveBtn').addEventListener('click', async () => {
  const model = $('model').value === CUSTOM ? $('modelCustom').value.trim() : $('model').value;
  await chrome.storage.sync.set({
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    model,
    baseUrl: $('baseUrl').value.trim(),
  });
  $('saved').textContent = '저장됨 ✓';
  setTimeout(() => ($('saved').textContent = ''), 2000);
});
