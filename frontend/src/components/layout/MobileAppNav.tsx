'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

type MobileTabKey = 'projects' | 'agents' | 'teams' | 'me';

const MOBILE_TABS: Array<{ key: MobileTabKey; label: string; accent: string; href: string }> = [
  { key: 'projects', label: 'Projects', accent: 'bg-pixel-yellow', href: '/?mobileTab=projects' },
  { key: 'agents', label: 'Agents', accent: 'bg-pixel-yellow', href: '/?mobileTab=contacts' },
  { key: 'teams', label: 'Teams', accent: 'bg-pixel-yellow', href: '/?mobileTab=teams' },
  { key: 'me', label: 'Me', accent: 'bg-pixel-gray', href: '/?mobileTab=me' },
];

function MobileNavIcon({ tab }: { tab: MobileTabKey }) {
  const common = 'h-[22px] w-[22px]';
  if (tab === 'agents') {
    return (
      <svg viewBox="0 0 24 24" className={common} aria-hidden="true">
        <path fill="currentColor" d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 9a8 8 0 0 1 16 0H4Z" />
      </svg>
    );
  }
  if (tab === 'teams') {
    return (
      <svg viewBox="0 0 24 24" className={common} aria-hidden="true">
        <path fill="currentColor" d="M12 3 3 8l9 5 9-5-9-5Zm-7 9 7 4 7-4v5l-7 4-7-4v-5Z" />
      </svg>
    );
  }
  if (tab === 'me') {
    return (
      <svg viewBox="0 0 24 24" className={common} aria-hidden="true">
        <path fill="currentColor" d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={common} aria-hidden="true">
      <path fill="currentColor" d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z" />
    </svg>
  );
}

const TAB_QUERY_KEYS: Record<string, MobileTabKey> = {
  projects: 'projects',
  contacts: 'agents',
  teams: 'teams',
  me: 'me',
};

function activeTabForRoute(pathname: string, searchTab: string | null): MobileTabKey {
  if (pathname === '/' && searchTab && TAB_QUERY_KEYS[searchTab]) return TAB_QUERY_KEYS[searchTab]!;
  if (pathname.startsWith('/teams') || pathname.startsWith('/workshop')) return 'teams';
  if (pathname.startsWith('/agents') || pathname.startsWith('/upload')) return 'agents';
  if (pathname.startsWith('/settings')) return 'me';
  return 'projects';
}

export function MobileAppNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Full-screen chat routes hide the tab bar.
  if (pathname.startsWith('/login') || pathname.startsWith('/register') || pathname.startsWith('/agents/')) {
    return null;
  }

  const activeKey = activeTabForRoute(pathname, searchParams.get('mobileTab'));

  return (
    <nav
      data-mobile-app-nav="true"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-pixel-line bg-pixel-white shadow-[0_-4px_0_0_rgba(17,17,17,0.10)] md:hidden"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0px)' }}
    >
      {MOBILE_TABS.map((tab) => {
        const active = activeKey === tab.key;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={`relative flex min-h-[62px] flex-col items-center justify-center gap-0.5 border-r border-pixel-black/10 px-0 pb-1 pt-1.5 font-sans text-[0.66rem] last:border-r-0 ${
              active ? 'bg-pixel-black text-pixel-white' : 'text-pixel-black/70'
            }`}
          >
            {active && (
              <span className={`absolute left-2 right-2 top-1 h-1 border border-pixel-line ${tab.accent}`} />
            )}
            <span
              data-mobile-nav-icon="true"
              className={`flex h-[28px] w-[28px] items-center justify-center border border-pixel-line ${
                active ? tab.accent : 'bg-pixel-white'
              }`}
              style={{ boxShadow: active ? '2px 2px 0 rgba(17,17,17,0.10)' : '1px 1px 0 rgba(16,16,16,0.35)' }}
            >
              <MobileNavIcon tab={tab.key} />
            </span>
            <span data-mobile-nav-label="true" className="max-w-full whitespace-nowrap text-center leading-none">
              {tab.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
