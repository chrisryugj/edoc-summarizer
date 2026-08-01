// 페이지(모든 프레임)에 주입되어 본문 텍스트를 추출한다.
// background.js / popup.js에서 chrome.scripting.executeScript({ files: ['extractor.js'], allFrames: true })로 실행.
// IIFE의 반환값이 executeScript 결과로 전달된다.
(() => {
  // 사이트별 본문 셀렉터. exclude: 해당 컨테이너 안에서 제거할 노이즈 요소.
  // cseoul(서울시 전자문서): 문서관리카드 메타정보 = #DIV_ENF_DOC, #tdTask는 레거시 JS가
  // 텍스트로 렌더링되는 노이즈 덩어리라 제외. 공문 실제 본문은 hwpctrl 뷰어 프레임에 있음(아래 isHwpViewer).
  const SITE_RULES = [
    { host: /(^|\.)cseoul\.go\.kr$/, selectors: [{ sel: '#DIV_ENF_DOC', exclude: ['#tdTask'] }] },
  ];

  // 레거시 페이지에서 스크립트 코드가 텍스트로 렌더링되는 경우 제거
  const stripJs = (s) =>
    (s || '')
      .replace(/document\.write\([^)]*\);?/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !/^(function[\s(]|var\s|let\s|const\s|try\s*\{|catch\s*\(|while\s*\(|for\s*\(|if\s*\(|else\b|return[\s;]|[}{)\];.]+$)/.test(l))
      .join('\n');

  const clean = (s) => stripJs(s).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // 컨테이너에서 script/style/폼요소 + exclude 대상을 걷어낸 텍스트
  const textOf = (el, exclude = []) => {
    const clone = el.cloneNode(true);
    const kill = ['script', 'style', 'noscript', 'select', 'textarea', ...exclude];
    clone.querySelectorAll(kill.join(',')).forEach((n) => n.remove());
    return clean(clone.textContent);
  };

  // 1순위: 사용자가 드래그 선택한 텍스트
  const selection = clean(window.getSelection?.().toString());

  // 2순위: 사이트별 셀렉터 매칭
  let ruleText = '';
  for (const rule of SITE_RULES) {
    if (!rule.host.test(location.host)) continue;
    for (const { sel, exclude } of rule.selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = textOf(el, exclude);
      if (t.length > 50) { ruleText = t; break; }
    }
    if (ruleText) break;
  }

  // 3순위: 프레임 전체 텍스트 (호출부에서 프레임별 결과를 조합)
  const bodyText = clean(document.body?.innerText);

  // HWP 뷰어(한컴 웹한글) 내부 프레임 여부 — 전자문서 공문 본문이 여기 렌더링됨.
  // 본문은 뷰어 안의 about:blank inline 프레임에 있을 수 있어 부모 체인까지 검사.
  let isHwpViewer = /hwpctrl/i.test(location.href);
  try {
    for (let w = window; !isHwpViewer && w !== w.parent; w = w.parent) {
      if (/hwpctrl/i.test(w.parent.location.href)) isHwpViewer = true;
    }
  } catch { /* cross-origin 부모는 판정 불가 */ }

  return {
    selection,
    ruleText,
    bodyText,
    isHwpViewer,
    title: document.title,
    url: location.href,
    // 크로스오리진 프레임 본문을 걸러내기 위한 실효 출처.
    // about:blank·srcdoc 프레임은 전역 origin이 부모 출처를 상속하므로 location.origin("null")이 아닌
    // self.origin을 봐야 뷰어 내부 inline 프레임이 같은 출처로 정상 판정된다.
    origin: (typeof self !== 'undefined' && self.origin) || location.origin || '',
    isTop: window === window.top,
  };
})();
