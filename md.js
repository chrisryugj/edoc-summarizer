// 복사·내보내기용 마크다운 생성 (background·popup 공용).

export function buildMarkdown(r) {
  const lines = [`# [${r.doc_type || '문서'}] ${r.title || r.one_line || ''}`];
  if (r.title && r.one_line) lines.push(`> ${r.one_line}`);
  const info = [];
  if (r.doc_no) info.push(`**문서번호**: ${r.doc_no}`);
  if (r.sent_date) info.push(`**시행일**: ${r.sent_date}`);
  if (r.sender) info.push(`**발신**: ${r.sender}`);
  if (r.receiver) info.push(`**수신**: ${r.receiver}`);
  if (info.length) lines.push('', info.join(' · '));
  if (r.deadline) lines.push(`\n**기한**: ${r.deadline}`);
  if (r.key_points?.length) lines.push('\n## 핵심 내용', ...r.key_points.map((k) => `- ${k}`));
  if (r.actions?.length) lines.push('\n## 조치 사항', ...r.actions.map((a) => `- [ ] ${a}`));
  if (r.cautions?.length) lines.push('\n## 주의', ...r.cautions.map((c) => `- ⚠ ${c}`));
  lines.push(`\n---\n_${new Date().toLocaleString('ko-KR')} · 전자문서 AI 요약 (AI 생성 — 원문 확인 필요)_`);
  return lines.join('\n');
}

export function buildReviewMarkdown(v) {
  const lines = [`# [AI 검토] ${v.status}`];
  if (v.summary) lines.push('', v.summary);
  const sec = (title, items) => {
    if (items?.length) lines.push(`\n## ${title}`, ...items.map((i) => `- ${i.title ? `**${i.title}** — ` : ''}${i.content}`));
  };
  sec('잘 작성된 부분', v.strengths);
  sec('보완이 필요한 부분', v.improvements);
  sec('결재 전 확인사항', v.checks);
  if (v.typos?.length) {
    lines.push('\n## 오탈자·표기',
      ...v.typos.map((t) => `- ~~${t.before}~~ → **${t.after}**${t.reason ? ` (${t.reason})` : ''}`));
  }
  lines.push(`\n---\n_${new Date().toLocaleString('ko-KR')} · 전자문서 AI 검토 (AI 참고용 — 결재 판단 근거 아님)_`);
  return lines.join('\n');
}

// 요약 결과 파일명 — 경로 조작·구분자 제거
export function resultFileName(prefix, title) {
  const safe = String(title || '문서').slice(0, 40).replace(/[\\/:*?"<>|\s]/g, '_');
  return `${prefix}_${safe}_${new Date().toISOString().slice(0, 10)}.md`;
}
