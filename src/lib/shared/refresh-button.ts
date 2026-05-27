/**
 * 공통 새로고침 버튼 wiring 헬퍼.
 *
 * - 클릭 시 .is-loading 토글 → CSS spinner 애니메이션 표시 (사용자 피드백)
 * - data 변경 없어도 "클릭 인식" 명확 (sync fetch 라도 최소 표시 시간 보장)
 * - 사용자 fn 이 Promise 든 sync 든 모두 OK
 *
 * @example
 *   bindRefreshButton('bl-refresh-btn', () => loadEntries());
 */

const MIN_SPIN_MS = 350; // 너무 빨리 사라져 사용자가 못 보는 케이스 방지

export function bindRefreshButton(
  id: string,
  fn: () => unknown | Promise<unknown>,
): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('is-loading')) return;
    btn.classList.add('is-loading');
    const start = performance.now();
    try {
      await fn();
    } finally {
      const elapsed = performance.now() - start;
      const remain = Math.max(0, MIN_SPIN_MS - elapsed);
      window.setTimeout(() => btn.classList.remove('is-loading'), remain);
    }
  });
}
