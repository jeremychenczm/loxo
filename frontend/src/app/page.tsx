'use client';

import Link from 'next/link';
import { useAuthStore } from '@/store/auth';

const SECTIONS = [
  { href: '/tasks', title: 'Tasks', description: 'Assign work to agents and review what they deliver.' },
  { href: '/agents', title: 'Agents', description: 'Import coding agents and chat with them one on one.' },
  { href: '/projects', title: 'Projects', description: 'Workspaces and repositories your agents work in.' },
  { href: '/settings/providers', title: 'Providers', description: 'Model credentials your agents run on.' },
];

export default function HomePage() {
  const { token, user, hasHydrated } = useAuthStore();

  if (!hasHydrated) return null;

  if (!token) {
    return (
      <div className="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 className="text-3xl font-semibold text-pixel-black">Loxo</h1>
        <p className="mt-3 font-sans text-sm text-pixel-black/60">
          Put your coding agents to work as one team.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/login" className="bg-pixel-black px-5 py-2 font-sans text-sm text-pixel-white">
            Sign in
          </Link>
          <Link href="/register" className="border border-pixel-line px-5 py-2 font-sans text-sm text-pixel-black">
            Create account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-pixel-black">Welcome back, {user?.username}</h1>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="border border-pixel-line bg-pixel-white p-5 shadow-pixel-sm transition-colors hover:bg-pixel-cream"
          >
            <p className="font-sans text-base font-bold text-pixel-black">{section.title}</p>
            <p className="mt-1 font-sans text-sm text-pixel-black/60">{section.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
