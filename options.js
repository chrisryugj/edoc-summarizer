import { testConnection } from './llm.js';
import { loadConfig, saveConfig, checkBaseUrl, hostPatterns, DEFAULT_HOSTS } from './config.js';

const $ = (id) => document.getElementById(id);

const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-pro-latest'];
const OLLAMA_FALLBACK = ['gemma4:e4b', 'gemma4:e2b'];
const CUSTOM = '__custom';

// 키는 프로바이더별로 따로 보관한다. 하나를 공유하면 프로바이더를 내부 LLM으로 바꿨을 때
// Gemini 키가 Bearer 토큰으로 그 서버에 그대로 전송된다.
const keys = { gemini: '', openai: '' };
let shownProvider = 'openai';

function stashKey() {
  keys[shownProvider] = $('apiKey').value.trim();
}

function syncProviderUI() {
  const provider = $('provider').value;
  document.body.classList.toggle('openai', provider === 'openai');
  if (provider !== shownProvider) {
    stashKey();
    shownProvider = provider;
    $('apiKey').value = keys[provider] || '';
  }
  $('apiKey').placeholder = provider === 'gemini' ? 'AIza...' : '내부 서버가 요구할 때만 입력';
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
    const raw = $('baseUrl').value.trim();
    const check = checkBaseUrl(raw);
    if (!check.ok) {
      hint = check.reason;
    } else {
      const base = (raw || 'http://localhost:11434').replace(/\/+$/, '');
      try {
        const res = await fetch(`${base}/v1/models`, {
          // 내부 LLM 키만 보낸다 — Gemini 키가 임의 서버로 새지 않게
          headers: keys.openai ? { Authorization: `Bearer ${keys.openai}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        models = ((await res.json()).data || []).map((m) => m.id);
        hint = `${base} 서버의 설치 모델 ${models.length}개`;
      } catch { /* 서버 미기동 등 */ }
      if (!models.length) {
        models = OLLAMA_FALLBACK;
        hint = '서버 조회 실패 — 기본 목록 표시 (Ollama 실행 여부 확인)';
      }
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
  const c = await loadConfig();
  keys.gemini = c.geminiKey;
  keys.openai = c.localKey;
  shownProvider = c.provider;
  $('provider').value = c.provider;
  $('apiKey').value = keys[c.provider] || '';
  $('baseUrl').value = c.baseUrl;
  $('widgetHosts').value = c.widgetHosts.join(', ');
  syncProviderUI();
  await loadModels(c.model);
});

$('provider').addEventListener('change', () => {
  syncProviderUI();
  loadModels('');
});
$('apiKey').addEventListener('input', stashKey);
$('baseUrl').addEventListener('change', () => {
  if ($('provider').value === 'openai') loadModels($('model').value !== CUSTOM ? $('model').value : '');
});
$('model').addEventListener('change', syncCustomUI);

// <all_urls>를 걷어냈으므로 내부 LLM 주소는 사용자가 지정할 때 그 출처만 권한을 받는다.
// (루프백은 매니페스트에 이미 있어 요청이 필요 없다.)
async function ensureOriginPermission(origin) {
  // 루프백은 manifest의 host_permissions로 이미 커버된다
  if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const origins = [`${origin}/*`];
  if (await chrome.permissions.contains({ origins }).catch(() => false)) return true;
  return chrome.permissions.request({ origins }).catch(() => false);
}

function currentForm() {
  stashKey();
  const provider = $('provider').value;
  const model = $('model').value === CUSTOM ? $('modelCustom').value.trim() : $('model').value;
  return {
    provider,
    model,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: keys[provider] || '',
    widgetHosts: $('widgetHosts').value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
  };
}

// 저장 전에 현재 폼 값으로 실제 왕복 확인 (모델 목록 + 초소형 챗 호출)
$('testBtn').addEventListener('click', async () => {
  const config = currentForm();
  const out = $('testResult');
  const check = checkBaseUrl(config.baseUrl);
  if (!check.ok) {
    out.textContent = '✗ ' + check.reason;
    return;
  }
  if (config.provider === 'openai' && !(await ensureOriginPermission(check.origin))) {
    out.textContent = '✗ 해당 주소에 접근할 권한이 없습니다 — 권한 요청을 허용해야 연결할 수 있습니다.';
    return;
  }
  out.textContent = '연결 확인 중…';
  $('testBtn').disabled = true;
  try {
    out.textContent = '✓ ' + (await testConnection(config));
  } catch (e) {
    out.textContent = '✗ ' + e.message;
  } finally {
    $('testBtn').disabled = false;
  }
});

$('saveBtn').addEventListener('click', async () => {
  const form = currentForm();
  const saved = $('saved');

  // 문서 전문(최대 3만 자)과 키가 평문 HTTP로 나가는 설정은 사용자 확인을 받는다
  const check = checkBaseUrl(form.baseUrl);
  if (!check.ok) {
    saved.textContent = '✗ ' + check.reason;
    return;
  }
  if (form.provider === 'openai' && check.plainRemote) {
    const ok = confirm(
      `${check.origin} 는 암호화되지 않은 http 주소입니다.\n`
      + '문서 본문 전체와 API 키가 네트워크에 평문으로 전송됩니다.\n\n'
      + '내부망 서버가 맞다면 계속하고, 아니라면 https 주소를 사용하세요.\n\n계속할까요?'
    );
    if (!ok) { saved.textContent = '저장 취소됨'; return; }
  }

  // 내부 LLM 주소 접근 권한 (서비스워커·팝업의 fetch가 이 권한으로 CORS 없이 나간다)
  if (form.provider === 'openai' && !(await ensureOriginPermission(check.origin))) {
    saved.textContent = '✗ LLM 주소 접근 권한이 거부되어 저장하지 않았습니다.';
    return;
  }

  // ✨ 플로팅 버튼은 사용자가 승인한 호스트에만 주입된다 — 저장 시점에 권한을 요청한다.
  const patterns = hostPatterns(form.widgetHosts);
  if (form.widgetHosts.length && !patterns.length) {
    saved.textContent = '✗ 표시 주소 형식이 올바르지 않습니다 (호스트만 입력하세요 — 예: gw.기관도메인.go.kr)';
    return;
  }
  let granted = true;
  if (patterns.length) {
    granted = await chrome.permissions.contains({ origins: patterns }).catch(() => false)
      || await chrome.permissions.request({ origins: patterns }).catch(() => false);
  }

  await saveConfig({
    provider: form.provider,
    model: form.model,
    baseUrl: form.baseUrl,
    widgetHosts: form.widgetHosts,
    geminiKey: keys.gemini,
    localKey: keys.openai,
  });
  saved.textContent = granted
    ? '저장됨 ✓'
    : '저장됨 ✓ (권한 미승인 — ✨ 버튼은 표시되지 않습니다. 우클릭 메뉴·툴바 아이콘은 정상 동작)';
  setTimeout(() => (saved.textContent = ''), granted ? 2000 : 8000);
});

$('widgetHosts').placeholder = DEFAULT_HOSTS.join(', ');
