'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { BackButton } from '@/components/ui/BackButton';
import { PixelButton } from '@/components/ui/PixelButton';
import { deleteTeam, fetchTeams, type TeamView } from '@/lib/teams';

const TEAM_TONES = ['bg-pixel-black', 'bg-pixel-yellow'];

function TeamCard({ team, index, onDelete }: { team: TeamView; index: number; onDelete: (team: TeamView) => void }) {
  const agents = team.workflow.nodes.filter((n) => n.type === 'agent');
  const bound = agents.filter((n) => n.agentId).length;
  const conditions = team.workflow.nodes.filter((n) => n.type === 'condition').length;
  const tone = TEAM_TONES[index % TEAM_TONES.length]!;
  const yellow = tone === 'bg-pixel-yellow';

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className="group/team-card relative flex h-full flex-col border border-pixel-line bg-pixel-white"
      style={{ boxShadow: '6px 6px 0 rgba(17,17,17,0.10)' }}
    >
      <div className={`flex items-center justify-between gap-2 border-b border-pixel-line p-3 ${tone}`}>
        <h2 className={`truncate font-sans text-lg font-bold ${yellow ? 'text-pixel-black' : 'text-pixel-white'}`}>
          {team.name}
        </h2>
        <span
          className={`shrink-0 border border-pixel-line px-1.5 py-0.5 font-sans text-[10px] ${
            yellow ? 'bg-pixel-black text-pixel-white' : 'bg-pixel-white text-pixel-black'
          }`}
        >
          {team.workflow.execution.mode.toUpperCase()}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <p className="line-clamp-2 min-h-[2.5rem] font-sans text-sm text-pixel-black/65">
          {team.description || 'No description yet'}
        </p>

        <div className="mt-3 flex flex-wrap gap-1">
          <span className="border border-pixel-line bg-pixel-black px-2 py-0.5 font-sans text-xs text-pixel-white">
            {agents.length} AGENTS
          </span>
          <span
            className={`border border-pixel-line px-2 py-0.5 font-sans text-xs ${
              bound === agents.length && agents.length > 0
                ? 'bg-pixel-green text-pixel-white'
                : 'bg-pixel-yellow text-pixel-black'
            }`}
          >
            {bound} BOUND
          </span>
          {conditions > 0 && (
            <span className="border border-pixel-line bg-pixel-red px-2 py-0.5 font-sans text-xs text-pixel-white">
              {conditions} GATES
            </span>
          )}
        </div>

        {team.warnings.length > 0 && (
          <p className="mt-2 font-sans text-xs text-pixel-red">
            {team.warnings.length} warning{team.warnings.length > 1 ? 's' : ''}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <Link href={`/teams/${team.id}`}>
            <PixelButton variant="primary" size="sm">
              Open canvas
            </PixelButton>
          </Link>
          <button
            onClick={() => onDelete(team)}
            className="font-sans text-xs text-pixel-black/45 hover:text-pixel-red"
          >
            delete
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function TeamsPageInner() {
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    fetchTeams()
      .then(setTeams)
      .catch(() => setTeams([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);

  const remove = async (team: TeamView) => {
    if (!confirm(`Delete team "${team.name}"?`)) return;
    await deleteTeam(team.id);
    reload();
  };

  return (
    <div className="mx-auto max-w-6xl px-3 pb-24 md:px-4 md:pb-16">
      <div className="hidden md:block">
        <BackButton href="/" />
      </div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8 pt-3 text-center md:pt-6">
        <h1 className="brand-large mb-2 text-pixel-black">My Teams</h1>
        <p className="font-sans text-xl text-pixel-blue">AGENT TEAM ARCHITECTURES</p>
        <p className="mt-2 font-sans text-sm text-pixel-black/60">
          {teams.length} teams · design workflows on the canvas or generate them from plain language
        </p>
      </motion.div>

      <div className="mb-6 flex justify-center">
        <Link href="/teams/create">
          <PixelButton variant="primary" size="lg">
            + Create a team
          </PixelButton>
        </Link>
      </div>

      {loading ? (
        <p className="py-12 text-center font-sans text-pixel-black/50">Loading…</p>
      ) : teams.length === 0 ? (
        <div className="py-16 text-center">
          <p className="mb-6 font-sans text-base text-pixel-black/60">
            No teams yet — assemble your first agent crew.
          </p>
          <div className="flex justify-center gap-3">
            <Link href="/teams/create">
              <PixelButton variant="primary">Start from scratch</PixelButton>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 lg:grid-cols-3">
          {teams.map((team, index) => (
            <TeamCard key={team.id} team={team} index={index} onDelete={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TeamsPage() {
  return (
    <RequireAuth>
      <TeamsPageInner />
    </RequireAuth>
  );
}
