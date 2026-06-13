// 1767 사이트 상단 메뉴 정의 — 두 서비스 (KvK 설문 / 캐슬 전투) 만 노출.
// Header.astro 가 이 배열을 읽어 탭을 렌더.
import { ko } from '@/i18n/ko';

export type NavTab = {
  id: string;
  /** 한국어 라벨 — SSR 기본값. 클라이언트 swap 은 titleKey 로. */
  title: string;
  /** i18n 키 (data-i18n attr 으로 swap 대상). */
  titleKey: string;
  /** 탭 진입 경로. */
  path: string;
  /** path 활성 판정용 prefix (URL 이 이 값으로 시작하면 active). */
  pathPrefix: string;
};

export const tabs: NavTab[] = [
  {
    id: 'kvk',
    title: ko.nav.kvk,
    titleKey: 'nav.kvk',
    path: '/survey/',
    pathPrefix: '/survey/',
  },
  // 캐슬 전투 — 서비스 준비 중으로 상단 메뉴 숨김. 페이지(/castle-battle/) 자체는 살아있음.
  // 재오픈 시 아래 주석 해제.
  // {
  //   id: 'castle',
  //   title: ko.nav.castle,
  //   titleKey: 'nav.castle',
  //   path: '/castle-battle/',
  //   pathPrefix: '/castle-battle/',
  // },
];

/** 현재 URL 경로에 매칭되는 탭. 매칭 없으면 null (홈 등). */
export function findActiveTab(pathname: string): NavTab | null {
  return tabs.find((t) => pathname.startsWith(t.pathPrefix)) ?? null;
}
