'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { BrandMark, Header } from '@/components/layout/Header';
import { MobileAppNav } from '@/components/layout/MobileAppNav';
import { useAuthStore } from '@/store/auth';
import { fetchProjects, deleteProject, type ProjectView } from '@/lib/projects';

type SidebarIcon = 'home' | 'agents' | 'teams' | 'workshop' | 'projects' | 'settings';

const SIDEBAR_WIDTH_STORAGE_KEY = 'swarmdev.sidebarWidth';
const SIDEBAR_OPEN_STORAGE_KEY = 'swarmdev.sidebarOpen';
const SIDEBAR_DEFAULT_WIDTH = 292;
const SIDEBAR_MIN_WIDTH = 236;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_WORKSPACE_GAP = 10;

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

function SidebarIconGlyph({ icon, className = 'h-5 w-5' }: { icon: SidebarIcon; className?: string }) {
  const paths: Record<SidebarIcon, string> = {
    home: 'M12 3 3 9v12h7v-6h4v6h7V9Zm0 2.5L18 10v9h-2v-6H8v6H6v-9Z',
    agents: 'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 9a8 8 0 0 1 16 0H4Z',
    teams: 'M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5',
    workshop:
      'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm0 14H6l-2 2V4h16ZM7 9h10v2H7Zm0-3h10v2H7Z',
    projects: 'M4 5h7l2 3h7v11H4V5Zm2 5v7h12v-7H6Z',
    settings:
      'M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.4-2.4 1a8.7 8.7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.6A8.7 8.7 0 0 0 7 6.6l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.4 2.4-1a8.7 8.7 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8.7 8.7 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z',
  };
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="currentColor" d={paths[icon]} />
    </svg>
  );
}

function TraditionalSidebar({
  open,
  pathname,
  width,
  projects,
  onWidthChange,
  onToggle,
  onDeleteProject,
}: {
  open: boolean;
  pathname: string;
  width: number;
  projects: ProjectView[];
  onWidthChange: (width: number) => void;
  onToggle: () => void;
  onDeleteProject: (project: ProjectView) => void;
}) {
  const navItems: Array<{ href: string; label: string; icon: SidebarIcon; exact?: boolean }> = [
    { href: '/', label: 'Home', icon: 'home', exact: true },
    { href: '/issues', label: 'Issues', icon: 'teams' },
    { href: '/goals', label: 'Goals', icon: 'workshop' },
    { href: '/agents', label: 'My Agents', icon: 'agents' },
    { href: '/workshop', label: 'Workshop', icon: 'workshop' },
    { href: '/settings/providers', label: 'Providers', icon: 'settings' },
    { href: '/settings/machines', label: 'Machines', icon: 'settings' },
  ];
  const recentProjects = projects
    .filter((p) => p.kind !== 'default')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 7);

  const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      onWidthChange(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
  };

  return (
    <>
      <aside
        aria-hidden={!open}
        className="fixed left-0 top-0 z-[40] hidden h-screen flex-col border-r border-[#E4E4E4] bg-white text-[#111] transition-[left,opacity] duration-300 ease-out md:flex"
        style={{
          width,
          left: open ? 0 : -width,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div className="border-b border-[#F0F0F0] px-4 py-4">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex min-w-0 flex-1 items-center gap-3 no-underline">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-[#111]">
                <BrandMark className="h-5 w-5 text-white" />
              </span>
              <span className="min-w-0">
                <span className="brand-large block truncate text-[#111]">Loxo</span>
                <span className="block truncate font-sans text-xs uppercase tracking-widest leading-none text-[#9B9B9B]">
                  Agent team platform
                </span>
              </span>
            </Link>
            <motion.button
              type="button"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              onClick={onToggle}
              whileHover={{ x: -1 }}
              whileTap={{ x: -2, scale: 0.96 }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-[#E4E4E4] bg-white text-[#6B6B6B] transition-colors hover:border-[#111] hover:text-[#111]"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" shapeRendering="crispEdges">
                <path fill="currentColor" d="M14 5 7 12l7 7v-5h7v-4h-7V5Z" />
              </svg>
            </motion.button>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navItems.map((item, index) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <motion.div
                key={item.href}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.035 * index }}
              >
                <Link
                  href={item.href}
                  className={`flex min-h-[44px] items-center gap-3 rounded-sm px-3 font-sans text-base no-underline transition-colors ${
                    active
                      ? 'bg-[#111] text-white'
                      : 'text-[#6B6B6B] hover:bg-[#F5F5F5] hover:text-[#111]'
                  }`}
                >
                  <SidebarIconGlyph icon={item.icon} className="h-5 w-5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              </motion.div>
            );
          })}

          {recentProjects.length > 0 && (
            <div className="pt-2">
              <div className="my-3 h-px bg-[#E4E4E4]" aria-hidden="true" />
              <p className="mb-2 px-3 font-sans text-[10px] uppercase tracking-[0.16em] leading-none text-[#9B9B9B]">
                Recent projects
              </p>
              <div className="space-y-1">
                {recentProjects.map((project, index) => {
                  const href = `/projects/${project.id}`;
                  const active = pathname === href;
                  return (
                    <motion.div
                      key={project.id}
                      initial={{ opacity: 0, x: -16 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.035 * (navItems.length + index) }}
                    >
                      <div className="group/sidebar-project relative">
                        <Link
                          href={href}
                          className={`flex min-h-[44px] items-center gap-2.5 rounded-sm px-3 font-sans text-sm no-underline transition-colors ${
                            active
                              ? 'bg-[#111] text-white'
                              : 'text-[#6B6B6B] hover:bg-[#F5F5F5] hover:text-[#111]'
                          }`}
                          title={project.name}
                        >
                          <SidebarIconGlyph icon="projects" className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate leading-tight">{project.name}</span>
                            <span className="block truncate text-[10px] leading-tight opacity-60">
                              {project.teamIds.length} teams · {project.agentIds.length} agents
                            </span>
                          </span>
                        </Link>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onDeleteProject(project);
                          }}
                          className="pointer-events-none absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm border border-[#C9C9C9] bg-white font-sans text-xs leading-none text-[#6B6B6B] opacity-0 transition-opacity hover:border-[#111] hover:text-[#111] group-hover/sidebar-project:pointer-events-auto group-hover/sidebar-project:opacity-100"
                          aria-label={`Delete project ${project.name}`}
                          title="Delete project"
                        >
                          ×
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}
        </nav>

        <div className="border-t border-[#F0F0F0] p-3">
          <p className="font-sans text-xs leading-tight text-[#9B9B9B]">v0.1.0 · Loxo Labs</p>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
          onPointerDown={handleResizePointerDown}
          className="absolute right-[-6px] top-0 h-full w-3 cursor-col-resize bg-[#E4E4E4] opacity-0 transition-opacity hover:opacity-100"
        />
      </aside>

      {!open && (
        <motion.button
          type="button"
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={onToggle}
          initial={{ x: -8, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          whileHover={{ x: 2 }}
          whileTap={{ x: 0, scale: 0.96 }}
          className="fixed left-0 top-[96px] z-[45] hidden h-14 w-8 items-center justify-center rounded-r-sm bg-[#111] text-white transition-colors hover:bg-[#333] md:flex"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" shapeRendering="crispEdges">
            <path fill="currentColor" d="M10 5v5H3v4h7v5l7-7-7-7Z" />
          </svg>
        </motion.button>
      )}
    </>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { token, hasHydrated } = useAuthStore();
  const [isDesktopViewport, setIsDesktopViewport] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [projects, setProjects] = useState<ProjectView[]>([]);

  const isPublicPath = pathname === '/' || pathname === '/login' || pathname === '/register';
  const isRouteGuardBlocking = !isPublicPath && (!hasHydrated || !token);
  const isChatRoute = /^\/agents\/[^/]+$/.test(pathname) || pathname.startsWith('/workshop');
  const isProjectDetailRoute = /^\/projects\/[^/]+/.test(pathname);

  const mainClassName = isChatRoute
    ? 'max-w-none bg-pixel-cream p-0 md:mx-auto md:min-h-[calc(100vh-120px)] md:w-full md:max-w-none md:bg-pixel-white md:p-0'
    : 'mx-auto min-h-screen bg-pixel-white p-4 pb-0 md:min-h-[calc(100vh-120px)] md:w-full md:max-w-none md:p-0';

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const syncViewport = () => {
      setIsDesktopViewport(media.matches);
      if (media.matches) {
        document.body.dataset.traditionalDesktopMode = 'true';
      } else {
        delete document.body.dataset.traditionalDesktopMode;
      }
    };
    syncViewport();
    media.addEventListener('change', syncViewport);
    return () => {
      media.removeEventListener('change', syncViewport);
      delete document.body.dataset.traditionalDesktopMode;
    };
  }, []);

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsedWidth = storedWidth ? Number(storedWidth) : NaN;
    if (Number.isFinite(parsedWidth)) setSidebarWidth(clampSidebarWidth(parsedWidth));
    const storedOpen = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (storedOpen === 'closed') setSidebarOpen(false);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, sidebarOpen ? 'open' : 'closed');
  }, [sidebarOpen]);

  const reloadProjects = useCallback(() => {
    if (!token) {
      setProjects([]);
      return;
    }
    fetchProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [token]);

  useEffect(() => {
    reloadProjects();
  }, [reloadProjects, pathname]);

  const traditionalShellActive = isDesktopViewport;
  const sidebarEnabled = traditionalShellActive && !isRouteGuardBlocking;
  const effectiveSidebarOpen = sidebarEnabled && sidebarOpen;
  const sidebarOffset = effectiveSidebarOpen ? sidebarWidth + SIDEBAR_WORKSPACE_GAP : 0;
  const contentStyle = sidebarEnabled
    ? { paddingLeft: sidebarOffset, boxSizing: 'border-box' as const }
    : undefined;
  const innerClassName = isProjectDetailRoute
    ? 'px-3 py-4 lg:px-4 xl:px-5'
    : 'px-8 py-6 xl:px-10 2xl:px-12';

  return (
    <>
      <div className="hidden md:block">
        <Header
          traditionalMode
          traditionalSidebarOpen={effectiveSidebarOpen}
          traditionalSidebarWidth={sidebarOffset}
        />
      </div>
      <main data-app-main="true" className={mainClassName}>
        {traditionalShellActive ? (
          <div className="hidden md:block">
            <div className="relative min-h-[calc(100vh-76px)]">
              {sidebarEnabled && (
                <TraditionalSidebar
                  open={sidebarOpen}
                  pathname={pathname}
                  width={sidebarWidth}
                  projects={projects}
                  onWidthChange={setSidebarWidth}
                  onToggle={() => setSidebarOpen((open) => !open)}
                  onDeleteProject={async (project) => {
                    const ok = window.confirm(
                      `Delete project "${project.name}"? This removes its configuration and workspace.`
                    );
                    if (!ok) return;
                    await deleteProject(project.id);
                    reloadProjects();
                  }}
                />
              )}
              <div
                className="min-h-[calc(100vh-76px)] min-w-0 overflow-x-hidden transition-[padding] duration-300 ease-out"
                style={contentStyle}
              >
                <div className={innerClassName}>{children}</div>
              </div>
            </div>
          </div>
        ) : (
          children
        )}
      </main>
      <footer className="hidden border-t border-pixel-line bg-pixel-white py-3 transition-[padding] duration-300 ease-out md:block" style={effectiveSidebarOpen ? { paddingLeft: sidebarOffset } : undefined}>
        <div
          className="mx-0 w-full max-w-none px-8 text-center font-sans text-xs text-pixel-gray xl:px-10 2xl:px-12"
        >
          <p>Loxo — Efficient AI Team Collaboration</p>
          <p className="mt-1 uppercase tracking-widest text-[#9B9B9B]">Ready.</p>
        </div>
      </footer>
      <Suspense fallback={null}>
        <MobileAppNav />
      </Suspense>
    </>
  );
}
