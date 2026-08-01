// ── 전자문서 시스템 DOM 구조 덤프 스니펫 ──
// 사용법:
// 1. 전자문서 "열람 화면"을 띄운 상태에서 F12 → Console 탭
// 2. 이 파일 내용 전체를 붙여넣고 Enter
// 3. "클립보드에 복사됨"이 뜨면 메모장에 붙여넣어 dom-dump.json으로 저장
// 4. 만약 결과의 frames가 1개뿐이고 본문이 안 보이면: Console 좌상단 컨텍스트
//    드롭다운("top")에서 본문 프레임을 선택한 뒤 다시 붙여넣어 실행 (크로스오리진 프레임 대응)
//
// ⚠ 이 덤프는 셀렉터 구조(경로·길이)만 담고 문서 내용은 담지 않는다.
//    본문 일부가 필요하면 SHOW_SAMPLE을 true로 바꾸되, 공유하기 전에 반드시 직접 열어
//    발신처·수신자·주민번호·연락처 등 개인정보를 지울 것. 실제 공문 내용은 제3자에게 보내지 말 것.
// ⚠ 콘솔에 남이 준 스크립트를 붙여넣는 것은 일반적으로 위험한 행동이다. 이 파일의 내용을
//    직접 읽어 무엇을 하는지 확인한 뒤에만 실행할 것.
(() => {
  const SHOW_SAMPLE = false; // 본문 미리보기 포함 여부 — 기본은 개인정보 유출 방지를 위해 끔

  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 6; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += '#' + e.id;
      else if (e.classList.length) p += '.' + [...e.classList].slice(0, 3).join('.');
      parts.unshift(p);
    }
    return parts.join(' > ');
  };

  const scanDoc = (doc, frameUrl) => {
    // innerText가 긴 요소 상위 15개 (본문 후보)
    const candidates = [...doc.querySelectorAll('div, td, article, section, iframe, embed, object, canvas')]
      .map((el) => ({
        el,
        len: el.tagName === 'IFRAME' || el.tagName === 'EMBED' || el.tagName === 'OBJECT' || el.tagName === 'CANVAS'
          ? -1 : (el.innerText || '').trim().length,
      }))
      .filter((c) => c.len > 100 || c.len === -1)
      .sort((a, b) => b.len - a.len)
      .slice(0, 15)
      .map((c) => ({
        path: path(c.el),
        textLen: c.len,
        src: c.el.src || undefined,
        sample: SHOW_SAMPLE && c.len > 0 ? c.el.innerText.trim().slice(0, 150) : undefined,
      }));
    return { frameUrl, title: doc.title, candidates };
  };

  const frames = [{ doc: document, url: location.href }];
  // same-origin 하위 프레임까지 수집 (cross-origin은 접근 불가 → catch)
  document.querySelectorAll('iframe, frame').forEach((f) => {
    try {
      if (f.contentDocument) frames.push({ doc: f.contentDocument, url: f.src || '(inline)' });
    } catch { /* cross-origin */ }
  });

  const dump = {
    url: location.href,
    userAgent: navigator.userAgent,
    frameCount: frames.length,
    frames: frames.map((f) => scanDoc(f.doc, f.url)),
  };

  const json = JSON.stringify(dump, null, 2);
  console.log(json);
  try { copy(json); console.log('%c✓ 클립보드에 복사됨', 'color:green;font-weight:bold'); }
  catch { console.log('copy() 실패 — 위 JSON을 직접 드래그 복사하세요'); }
})();
