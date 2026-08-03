// 설정 로드·저장 단일 진입점 (background·popup·options 공용).
//
// 저장 위치를 나눈다:
//   - API 키    → storage.local  (sync에 두면 Google 계정으로 다른 기기에 전파된다)
//   - 그 외 설정 → storage.sync   (기기 간 유지가 유용하고 민감하지 않음)
//
// 키는 프로바이더별로 분리한다. 하나의 apiKey를 공유하면 프로바이더를 내부 LLM으로
// 바꿨을 때 Gemini 키가 Bearer 토큰으로 그 서버에 그대로 전송된다.

export const DEFAULT_PROVIDER = 'openai'; // 기본은 로컬 — 문서가 PC 밖으로 나가지 않는 쪽
export const DEFAULT_HOSTS = ['cseoul.go.kr'];

// 레거시(v0.2 이하) sync.apiKey를 현재 프로바이더의 로컬 키로 이관하고 sync에서 지운다.
async function migrateLegacyKey(legacy, local, provider) {
  const keys = { geminiKey: local.geminiKey || '', localKey: local.localKey || '' };
  if (!legacy) return keys;
  const slot = provider === 'gemini' ? 'geminiKey' : 'localKey';
  if (!keys[slot]) {
    keys[slot] = legacy;
    await chrome.storage.local.set({ [slot]: legacy });
  }
  await chrome.storage.sync.remove('apiKey');
  return keys;
}

export async function loadConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(['provider', 'model', 'baseUrl', 'widgetHosts', 'apiKey', 'autoPreview']),
    chrome.storage.local.get(['geminiKey', 'localKey']),
  ]);
  // v0.2 이하의 기본 프로바이더는 gemini였다. provider를 저장한 적 없는 사용자가 남긴 키는
  // Gemini 키이므로, 새 기본값(로컬)으로 갈아타며 그 키를 내부 서버로 보내지 않도록 원래 값을 유지한다.
  const legacyProvider = sync.provider === undefined && sync.apiKey ? 'gemini' : undefined;
  const provider = (sync.provider ?? legacyProvider) === 'gemini' ? 'gemini' : DEFAULT_PROVIDER;
  const keys = await migrateLegacyKey(sync.apiKey, local, provider);
  if (legacyProvider) await chrome.storage.sync.set({ provider });
  const hosts = Array.isArray(sync.widgetHosts) && sync.widgetHosts.length
    ? sync.widgetHosts.map((h) => String(h).trim()).filter(Boolean)
    : DEFAULT_HOSTS;
  return {
    provider,
    model: sync.model || '',
    baseUrl: sync.baseUrl || '',
    widgetHosts: hosts,
    // 첨부 자동 분석(디버거로 미리보기 조작) — 명시적으로 켠 경우에만 동작한다
    autoPreview: sync.autoPreview === true,
    geminiKey: keys.geminiKey,
    localKey: keys.localKey,
    // llm.js가 쓰는 실제 키 — 현재 프로바이더의 것만 넘어간다
    apiKey: provider === 'gemini' ? keys.geminiKey : keys.localKey,
  };
}

export async function saveConfig({ provider, model, baseUrl, widgetHosts, autoPreview, geminiKey, localKey }) {
  await chrome.storage.sync.set({ provider, model, baseUrl, widgetHosts, autoPreview: !!autoPreview });
  await chrome.storage.local.set({ geminiKey, localKey });
  await chrome.storage.sync.remove('apiKey');
}

// 문서 전문(최대 3만 자)과 API 키가 평문으로 흐르지 않게 baseUrl을 검사한다.
// 루프백은 http 허용, 그 외 http는 호출부에서 사용자 확인을 받는다(사내망 서버 지원).
export function checkBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, plainRemote: false };
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: '주소 형식이 올바르지 않습니다 (예: http://localhost:11434).' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'http 또는 https 주소만 사용할 수 있습니다.' };
  }
  // 확장 권한(match pattern)은 IPv6 리터럴 호스트를 표현할 수 없어 접근 권한을 받을 방법이 없다.
  if (u.hostname.startsWith('[')) {
    return { ok: false, reason: 'IPv6 주소는 지원하지 않습니다 — localhost 또는 127.0.0.1을 사용하세요.' };
  }
  if (u.protocol === 'https:') return { ok: true, plainRemote: false, origin: u.origin };
  const loopback = ['localhost', '127.0.0.1'].includes(u.hostname);
  return { ok: true, plainRemote: !loopback, origin: u.origin };
}

// 호스트 문자열("cseoul.go.kr") → content script 등록용 match pattern.
// 부분 문자열 매칭(cseoul.go.kr.attacker.com)이 성립하지 않도록 경계를 고정한다.
// 사용자가 적은 호스트를 match pattern·location.hostname과 비교 가능한 형태로 정규화한다.
// URL 파서를 태워 한글 도메인(gw.기관도메인.go.kr)을 punycode로 바꾸고 포트·경로를 떼어낸다 —
// 브라우저의 location.hostname도 punycode이므로 이래야 양쪽이 맞물린다.
export function normalizeHost(h) {
  const raw = String(h || '').trim().replace(/^\*\./, '');
  if (!raw || /[/\s*]/.test(raw)) return '';
  try {
    const { hostname } = new URL(`https://${raw}`);
    return /^[a-z0-9.-]+$/i.test(hostname) && !hostname.startsWith('.') && !hostname.endsWith('.')
      ? hostname
      : '';
  } catch {
    return '';
  }
}

export function hostPatterns(hosts) {
  return hosts.flatMap((h) => {
    const host = normalizeHost(h);
    return host ? [`*://${host}/*`, `*://*.${host}/*`] : [];
  });
}
