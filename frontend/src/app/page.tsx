'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AgentSprite } from '@/components/agent/AgentSprite';
import { PixelHero } from '@/components/effects/PixelHero';
import { MonoDashboard } from '@/components/dashboard/MonoDashboard';
import { useAuthStore } from '@/store/auth';
import { fetchAgents, type Agent } from '@/lib/agents';
import { fetchTeams, type TeamView } from '@/lib/teams';
import { fetchProjects, type ProjectView } from '@/lib/projects';

const HERO_SEEN_KEY = 'swarmdev.hasSeenHeroAnimation';

type MobileTabKey = 'projects' | 'contacts' | 'teams' | 'me';

const MOBILE_TABS: Array<{ key: MobileTabKey; label: string; accent: string }> = [
  { key: 'projects', label: 'Projects', accent: 'bg-pixel-yellow' },
  { key: 'contacts', label: 'Agents', accent: 'bg-pixel-yellow' },
  { key: 'teams', label: 'Teams', accent: 'bg-pixel-yellow' },
  { key: 'me', label: 'Me', accent: 'bg-pixel-gray' },
];

function isMobileTabKey(value: string | null): value is MobileTabKey {
  return Boolean(value && MOBILE_TABS.some((tab) => tab.key === value));
}

function FolderGlyph({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d="M6 14h20l6 8h26v28H6z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Official starter agent prompt (first login, zero agents)

function MobilePanel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`overflow-hidden border border-pixel-line bg-pixel-white ${className}`}
      style={{ boxShadow: '5px 5px 0 rgba(17,17,17,0.10)' }}
    >
      {children}
    </section>
  );
}

function MobileLinkRow({
  href,
  title,
  description,
  badge,
  icon,
  accent = 'bg-pixel-yellow',
}: {
  href: string;
  title: string;
  description?: string;
  badge?: string;
  icon?: React.ReactNode;
  accent?: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-[72px] items-center justify-between gap-2 border-b border-pixel-black/10 bg-pixel-white px-3 py-2.5 last:border-b-0 active:bg-pixel-yellow/40"
    >
      <span className="relative shrink-0">
        <span className={`relative flex h-12 w-12 shrink-0 items-center justify-center border border-pixel-line ${accent}`}>
          <span className="absolute inset-0.5 border border-pixel-line bg-pixel-white" />
          <span className="relative z-10 flex h-full w-full items-center justify-center">{icon}</span>
        </span>
        {badge && (
          <span className="absolute -right-1.5 -top-1.5 border border-pixel-line bg-pixel-yellow px-1.5 py-0.5 font-sans text-[10px] leading-none text-pixel-black">
            {badge}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-base font-bold leading-tight text-pixel-black">{title}</span>
        {description && (
          <span className="mt-1 block truncate font-sans text-xs leading-tight text-pixel-black/60">
            {description}
          </span>
        )}
      </span>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-pixel-line bg-pixel-white font-sans text-xl leading-none text-pixel-black/65">
        ›
      </span>
    </Link>
  );
}

function MobileAgentRow({ agent }: { agent: Agent }) {
  const hasProvider = Boolean(agent.providerId);
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="flex min-h-[72px] items-center gap-2 border-b border-pixel-black/10 bg-pixel-white px-3 py-2.5 last:border-b-0 active:bg-pixel-yellow/40"
    >
      <AgentSprite agent={agent} size="sm" showProviderStatus providerConfigured={hasProvider} />
      <div className="min-w-0 flex-1">
        <p className="font-sans text-base font-bold leading-tight text-pixel-black">{agent.name}</p>
        <p className="mt-1 truncate font-sans text-xs leading-tight text-pixel-black/60">
          {agent.description || (hasProvider ? 'Provider configured' : 'Provider not configured')}
        </p>
      </div>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-pixel-line bg-pixel-white font-sans text-xl leading-none text-pixel-black/65">
        ›
      </span>
    </Link>
  );
}

function MobileHome({
  agents,
  projects,
  teamCount,
  isLoggedIn,
}: {
  agents: Agent[];
  projects: ProjectView[];
  teamCount: number;
  isLoggedIn: boolean;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const requestedTab = searchParams.get('mobileTab');
  const activeTab: MobileTabKey = isMobileTabKey(requestedTab) ? requestedTab : 'projects';
  const recentProjects = projects.slice(0, 4);
  const recentAgents = agents.slice(0, 20);
  const activeTabMeta = MOBILE_TABS.find((tab) => tab.key === activeTab) ?? MOBILE_TABS[0]!;
  const configuredCount = agents.filter((a) => a.providerId).length;
  const activeSummary =
    activeTab === 'projects'
      ? `${projects.length} projects`
      : activeTab === 'contacts'
        ? `${configuredCount}/${agents.length} providers configured`
        : activeTab === 'teams'
          ? `${teamCount} teams · group chat ready`
          : isLoggedIn
            ? 'Account, providers, and your den'
            : 'Sign in to sync your agents';

  return (
    <div className="-mx-4 bg-pixel-white px-4 md:hidden">
      <div className="min-h-[calc(100vh-70px)] pb-24">
        <div className="sticky top-0 z-20 -mx-4 border-b border-pixel-line bg-pixel-white px-4 py-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate font-sans text-[1.25rem] font-bold leading-none text-pixel-black">
                {activeTabMeta.label}
              </h1>
              <p className="mt-0.5 truncate font-sans text-[11px] leading-tight text-pixel-black/55">
                {activeSummary}
              </p>
            </div>
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center border border-pixel-line ${activeTabMeta.accent} text-pixel-white`}
              style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
            >
              <FolderGlyph className="h-5 w-5" />
            </div>
          </div>
        </div>

        <main className="mt-2 space-y-2.5">
          {activeTab === 'projects' && (
            <MobilePanel>
              <div className="flex items-center justify-between border-b border-pixel-line bg-pixel-black px-3 py-2 text-pixel-white">
                <div>
                  <p className="font-sans text-base font-bold leading-tight">Recent projects</p>
                  <p className="mt-1 font-sans text-xs leading-tight text-pixel-white/80">
                    Shared team workspaces on the server
                  </p>
                </div>
                <Link
                  href="/projects"
                  className="border border-pixel-line bg-pixel-white px-2 py-1 font-sans text-xs leading-none text-pixel-black"
                >
                  Manage
                </Link>
              </div>
              {recentProjects.length > 0 ? (
                recentProjects.map((project) => (
                  <MobileLinkRow
                    key={project.id}
                    href={`/projects/${project.id}`}
                    title={project.name}
                    description={project.description || `${project.teamIds.length} teams bound`}
                    badge={project.teamIds.length ? `${project.teamIds.length}` : undefined}
                    icon={<FolderGlyph className="h-7 w-7 text-pixel-blue" />}
                    accent="bg-pixel-yellow"
                  />
                ))
              ) : (
                <MobileLinkRow
                  href="/projects"
                  title="Create your first project"
                  description="Name a server workspace and bind a team"
                  icon={<FolderGlyph className="h-7 w-7 text-pixel-blue" />}
                  accent="bg-pixel-yellow"
                />
              )}
            </MobilePanel>
          )}

          {activeTab === 'contacts' && (
            <MobilePanel>
              <div className="border-b border-pixel-line bg-pixel-black px-3 py-2 text-pixel-white">
                <p className="font-sans text-base font-bold leading-tight">Agent contacts</p>
                <p className="mt-1 font-sans text-xs leading-tight text-pixel-white/80">
                  {configuredCount}/{agents.length} providers configured
                </p>
              </div>
              {recentAgents.length > 0 ? (
                recentAgents.map((agent) => <MobileAgentRow key={agent.id} agent={agent} />)
              ) : (
                <MobileLinkRow
                  href="/upload"
                  title="No agents yet"
                  description="Import an agent workspace to get started"
                  accent="bg-pixel-yellow"
                />
              )}
            </MobilePanel>
          )}

          {activeTab === 'teams' && (
            <>
              <MobilePanel>
                <div className="border-b border-pixel-line bg-pixel-black px-3 py-2 text-pixel-white">
                  <p className="font-sans text-base font-bold leading-tight">Team workbench</p>
                  <p className="mt-1 font-sans text-xs leading-tight text-pixel-white/80">
                    Create teams, manage them, join group chats
                  </p>
                </div>
                <MobileLinkRow
                  href="/teams/create"
                  title="Create a team"
                  description="Design an agent team with the canvas or plain language"
                  badge="NEW"
                  accent="bg-pixel-yellow"
                />
                <MobileLinkRow
                  href="/teams"
                  title="My teams"
                  description={`${teamCount} teams created`}
                  accent="bg-pixel-yellow"
                />
              </MobilePanel>
              <MobilePanel>
                <div className="border-b border-pixel-line bg-pixel-black px-3 py-2 text-pixel-white">
                  <p className="font-sans text-base font-bold leading-tight">Workshop</p>
                  <p className="mt-1 font-sans text-xs leading-tight text-pixel-white/80">
                    Drop into your agent group chats
                  </p>
                </div>
                <MobileLinkRow
                  href="/workshop"
                  title="Open the workshop"
                  description="Multi-agent discussion with a shared whiteboard"
                  accent="bg-pixel-yellow"
                />
              </MobilePanel>
            </>
          )}

          {activeTab === 'me' && (
            <MobilePanel>
              <div className={`border-b border-pixel-line ${isLoggedIn ? 'bg-pixel-black' : 'bg-pixel-gray'} px-3 py-2 text-pixel-white`}>
                <p className="font-sans text-base font-bold leading-tight">
                  {isLoggedIn ? 'Signed in' : 'Signed out'}
                </p>
                <p className="mt-1 font-sans text-xs leading-tight text-pixel-white/80">
                  {isLoggedIn && user?.username
                    ? `${user.username} · providers, imports, and your den`
                    : 'Sign in to sync agents, teams, and projects'}
                </p>
              </div>
              <div className="space-y-2 border-b border-pixel-black/10 bg-pixel-white p-3">
                {isLoggedIn ? (
                  <button
                    type="button"
                    onClick={() => {
                      logout();
                      router.replace('/?mobileTab=me');
                    }}
                    className="flex min-h-[48px] w-full items-center justify-center border border-pixel-line bg-pixel-black px-3 font-sans text-base font-bold leading-none text-pixel-white"
                    style={{ boxShadow: '3px 3px 0 rgba(17,17,17,0.10)' }}
                  >
                    Sign out
                  </button>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <Link
                      href="/login"
                      className="flex min-h-[48px] items-center justify-center border border-pixel-line bg-pixel-yellow px-3 font-sans text-base font-bold leading-none text-pixel-black no-underline"
                      style={{ boxShadow: '3px 3px 0 rgba(17,17,17,0.10)' }}
                    >
                      Sign in
                    </Link>
                    <Link
                      href="/register"
                      className="flex min-h-[48px] items-center justify-center border border-pixel-line bg-pixel-black px-3 font-sans text-base font-bold leading-none text-pixel-white no-underline"
                      style={{ boxShadow: '3px 3px 0 rgba(17,17,17,0.10)' }}
                    >
                      Sign up
                    </Link>
                  </div>
                )}
              </div>
              <MobileLinkRow
                href="/settings/providers"
                title="Provider settings"
                description="Configure model providers and API keys"
                accent="bg-pixel-yellow"
              />
              <MobileLinkRow
                href="/agents"
                title="My agent den"
                description={`${agents.length} agents owned`}
                accent="bg-pixel-yellow"
              />
              <MobileLinkRow
                href="/upload"
                title="Upload agent"
                description="Import a folder, zip, or hosted API agent"
                accent="bg-pixel-yellow"
              />
            </MobilePanel>
          )}
        </main>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------

export default function HomePage() {
  return (
    <Suspense fallback={<div className="p-8 text-center font-sans text-pixel-black/50">Loading…</div>}>
      <HomePageInner />
    </Suspense>
  );
}

function HomePageInner() {
  const { token, user } = useAuthStore();
  const isLoggedIn = Boolean(token);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [showHero, setShowHero] = useState(false);
  const [hasSeenHero, setHasSeenHero] = useState(false);

  const reload = useCallback(async () => {
    if (!isLoggedIn) {
      setAgents([]);
      setProjects([]);
      setTeams([]);
      return;
    }
    const [agentList, projectList, teamList] = await Promise.all([
      fetchAgents().catch(() => []),
      fetchProjects().catch(() => []),
      fetchTeams().catch(() => []),
    ]);
    setAgents(agentList);
    setProjects(
      projectList
        .filter((p) => p.kind !== 'default')
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    );
    setTeams(teamList);
  }, [isLoggedIn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    if (!isDesktop) {
      setHasSeenHero(true);
      return;
    }
    if (!sessionStorage.getItem(HERO_SEEN_KEY)) {
      setShowHero(true);
    } else {
      setHasSeenHero(true);
    }
  }, []);

  const handleEnter = () => {
    sessionStorage.setItem(HERO_SEEN_KEY, 'true');
    setShowHero(false);
    setHasSeenHero(true);
  };

  return (
    <>
      <AnimatePresence>{showHero && <PixelHero onEnter={handleEnter} />}</AnimatePresence>

      <MobileHome agents={agents} projects={projects} teamCount={teams.length} isLoggedIn={isLoggedIn} />

      <MonoDashboard
        agents={agents}
        teams={teams}
        projects={projects}
        isLoggedIn={isLoggedIn}
        userName={user?.username}
      />
    </>
  );
}
