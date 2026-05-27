/**
 * 가벼운 keyed reconciliation — 데이터 갱신 시 화면 깜박임 제거.
 *
 * 핵심 아이디어:
 *   `container.innerHTML = ''` → 다시 채우는 패턴이 컨테이너를 한 프레임 비워서
 *   깜박임을 만들고 이미지/아바타도 매번 재로드함.
 *   대신 자식 element 의 `data-key` 로 식별해서 변경된 부분만 patch.
 *
 * 사용:
 *   patchList({
 *     container: el,
 *     items: rows,
 *     key: (row) => row.id,
 *     render: (row) => createRowEl(row),
 *     update: (el, row) => fillRowEl(el, row),  // 선택, 같은 key 의 기존 el 재사용 시
 *   });
 *
 *   patchText(el, '123');  // 텍스트만 갱신, 같은 값이면 no-op
 */

export interface PatchListOptions<T> {
  container: HTMLElement;
  items: readonly T[];
  /** 항목 식별자 — 같은 key 면 같은 entity 로 간주 (DOM element 재사용) */
  key: (item: T, index: number) => string;
  /** 신규 항목에 대한 element 생성. 반환된 element 의 data-key 는 자동 설정됨. */
  render: (item: T, index: number) => HTMLElement;
  /** 기존 항목 갱신 (선택). 미지정 시 같은 key 면 손대지 않음 — 데이터 변화가 없는 경우 전제. */
  update?: (el: HTMLElement, item: T, index: number) => void;
}

export function patchList<T>(opts: PatchListOptions<T>): void {
  const { container, items, key, render, update } = opts;

  // 기존 자식들을 data-key 로 매핑
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const k = child.dataset.key;
    if (k != null) existing.set(k, child);
  }

  // 새 순서대로 element 를 container 끝으로 이동 (DOM 은 같은 child 를 appendChild 하면 위치만 옮김 — 새로 생성 안 됨)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const k = key(item, i);
    let el = existing.get(k);
    if (el) {
      existing.delete(k);
      if (update) update(el, item, i);
    } else {
      el = render(item, i);
      el.dataset.key = k;
    }
    container.appendChild(el);
  }

  // 새 items 에 없는 옛 element 는 제거
  for (const orphan of existing.values()) {
    orphan.remove();
  }
}

/** 같은 값이면 no-op — 같은 텍스트로 textContent 를 다시 set 하면 일부 브라우저가 selection/cursor 를 잃음 */
export function patchText(el: HTMLElement | null, value: string | number): void {
  if (!el) return;
  const next = String(value);
  if (el.textContent !== next) el.textContent = next;
}
